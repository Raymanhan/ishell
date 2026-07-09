use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
#[cfg(not(russh_backend))]
use std::{
    io::{self, Read, Write},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    models::{
        DiskMount, NetworkSample, ServerInput, ServerRecord, ServerStatus, SftpEntry,
        UploadProgress,
    },
    openssh,
    pool::SshPool,
    store::{get_server, read_secret},
    time::{now, now_fractional},
};

/// Collect every status metric in a single remote command to avoid paying a
/// round trip per metric. Sections are delimited by `@@KEY@@` markers.
const STATUS_SCRIPT: &str = "A=\"$(uname -srmo 2>/dev/null || uname -a)\"; \
if [ -r /proc/uptime ]; then B=\"$(cat /proc/uptime 2>/dev/null)\"; else BOOT=\"$(sysctl -n kern.boottime 2>/dev/null | sed 's/.*sec = \\([0-9][0-9]*\\).*/\\1/')\"; NOW=\"$(date +%s 2>/dev/null)\"; if [ -n \"$BOOT\" ] && [ -n \"$NOW\" ]; then B=\"$((NOW - BOOT)).00\"; else B=\"\"; fi; fi; \
C=\"$(cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null || uptime 2>/dev/null)\"; \
if [ -r /proc/meminfo ]; then D=\"$(awk '/MemTotal|MemAvailable|SwapTotal|SwapFree/{print $1,$2}' /proc/meminfo 2>/dev/null)\"; elif command -v vm_stat >/dev/null 2>&1; then D=\"$(TOTAL=$(sysctl -n hw.memsize 2>/dev/null); PAGE=$(vm_stat 2>/dev/null | awk '/page size of/{print $8}' | tr -d '.'); [ -z \"$PAGE\" ] && PAGE=$(pagesize 2>/dev/null); vm_stat 2>/dev/null | awk -v total=\"$TOTAL\" -v page=\"$PAGE\" '/Pages free/{free=$3} /Pages inactive/{inactive=$3} /Pages speculative/{spec=$3} END {gsub(/\\./,\"\",free); gsub(/\\./,\"\",inactive); gsub(/\\./,\"\",spec); if (total > 0) printf \"MemTotal: %d\\n\", total / 1024; if (page > 0) printf \"MemAvailable: %d\\n\", (free + inactive + spec) * page / 1024}')\"; else D=\"$(TOTAL=$(sysctl -n hw.physmem 2>/dev/null || sysctl -n hw.memsize 2>/dev/null); AVAIL=$(sysctl -n hw.usermem 2>/dev/null); [ -n \"$TOTAL\" ] && printf 'MemTotal: %s\\n' $((TOTAL / 1024)); [ -n \"$AVAIL\" ] && printf 'MemAvailable: %s\\n' $((AVAIL / 1024)))\"; fi; \
E=\"$(awk 'NR==1{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null; sleep 0.2; awk 'NR==1{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null)\"; \
F=\"$(ps -e --no-headers 2>/dev/null | wc -l || ps -ax 2>/dev/null | wc -l)\"; \
G=\"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)\"; \
printf '@@OS@@\\n%s\\n@@UP@@\\n%s\\n@@LOAD@@\\n%s\\n@@MEM@@\\n%s\\n@@CPU@@\\n%s\\n@@PROC@@\\n%s\\n@@CORES@@\\n%s\\n' \
\"$A\" \"$B\" \"$C\" \"$D\" \"$E\" \"$F\" \"$G\"";

const DISK_SCRIPT: &str = "df -Pk 2>/dev/null | tail -n +2";

const NETWORK_SCRIPT: &str = r#"if [ -d /sys/class/net ]; then
  NET_BYTES="$(
    for iface in /sys/class/net/*; do
      name=${iface##*/}
      [ "$name" = "lo" ] && continue
      [ -r "$iface/statistics/rx_bytes" ] && [ -r "$iface/statistics/tx_bytes" ] || continue
      printf '%s %s\n' "$(cat "$iface/statistics/rx_bytes" 2>/dev/null)" "$(cat "$iface/statistics/tx_bytes" 2>/dev/null)"
    done | awk '{rx += $1; tx += $2; seen = 1} END {if (seen) printf "%s %s\n", rx+0, tx+0}'
  )"
  if [ -n "$NET_BYTES" ]; then
    printf '%s\n' "$NET_BYTES"
    exit 0
  fi
fi
if [ -r /proc/net/dev ]; then
  awk 'NR>2 {iface=$1; sub(/:/, "", iface); if (iface != "lo") {rx += $2; tx += $10}} END {printf "%s %s\n", rx+0, tx+0}' /proc/net/dev 2>/dev/null
else
  netstat -ibn 2>/dev/null | awk 'NR>1 && $1 !~ /^lo/ {rx += $7; tx += $10} END {printf "%s %s\n", rx+0, tx+0}'
fi"#;

const MAX_TEXT_EDIT_BYTES: u64 = 1024 * 1024;

const LIST_SCRIPT: &str = r#"import grp
import json
import os
import pwd
import stat
import sys

path = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "/"
items = []
with os.scandir(path) as entries:
    for entry in entries:
        try:
            st = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        is_symlink = stat.S_ISLNK(st.st_mode)
        target_is_dir = False
        link_target = None
        if is_symlink:
            try:
                target = entry.stat(follow_symlinks=True)
                target_is_dir = stat.S_ISDIR(target.st_mode)
            except OSError:
                target_is_dir = False
            try:
                link_target = os.readlink(entry.path)
            except OSError:
                link_target = None
        try:
            owner = pwd.getpwuid(st.st_uid).pw_name
        except KeyError:
            owner = None
        try:
            group = grp.getgrgid(st.st_gid).gr_name
        except KeyError:
            group = None
        full_path = ("/" + entry.name) if path == "/" else path.rstrip("/") + "/" + entry.name
        items.append({
            "name": entry.name,
            "path": full_path,
            "isDir": stat.S_ISDIR(st.st_mode) or target_is_dir,
            "isSymlink": is_symlink,
            "linkTarget": link_target,
            "targetIsDir": target_is_dir if is_symlink else None,
            "size": st.st_size,
            "uid": st.st_uid,
            "gid": st.st_gid,
            "owner": owner,
            "group": group,
            "permissions": st.st_mode,
            "modifiedAt": int(st.st_mtime),
        })
print(json.dumps(items, ensure_ascii=False, separators=(",", ":")))
"#;

pub fn test_connection(
    app: &AppHandle,
    input: ServerInput,
    password: Option<String>,
) -> Result<(), String> {
    let saved_id = input.id.clone();
    let id = format!("test-{}", now());
    let server = ServerRecord {
        id: id.clone(),
        name: input.name.trim().to_string(),
        host: input.host.trim().to_string(),
        port: input.port,
        username: input.username.trim().to_string(),
        group: input.group.trim().to_string(),
        tags: input.tags,
        auth_type: input.auth_type,
        key_path: input.key_path.filter(|path| !path.trim().is_empty()),
        color: input.color,
        notes: input.notes,
        sort_order: input.sort_order.unwrap_or_else(now),
        created_at: now(),
        updated_at: now(),
        last_connected_at: None,
    };
    let secret = password
        .filter(|value| !value.is_empty())
        .or_else(|| {
            saved_id
                .as_deref()
                .and_then(|server_id| read_secret(app, server_id).ok())
        })
        .filter(|value| !value.is_empty());
    test_connection_with_server(&server, secret.as_deref())
}

#[cfg(not(russh_backend))]
fn test_connection_with_server(server: &ServerRecord, secret: Option<&str>) -> Result<(), String> {
    let helper_path = if secret.is_some() {
        Some(create_askpass_helper(&server.id)?)
    } else {
        None
    };
    let mut command = Command::new(openssh::ssh_binary());
    if let (Some(secret), Some(path)) = (secret, helper_path.as_ref()) {
        command.env("SSH_ASKPASS", path);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("ISHELL_SSH_PASSWORD", secret);
        command.env("DISPLAY", "ishell:0");
    }
    for arg in openssh::common_ssh_args(server) {
        command.arg(arg);
    }
    for arg in openssh::auth_ssh_args(server, secret.is_some()) {
        command.arg(arg);
    }
    command.arg("-o");
    command.arg("ConnectTimeout=10");
    if secret.is_none() {
        command.arg("-o");
        command.arg("BatchMode=yes");
    }
    command.arg(&server.host);
    command.arg("printf ishell-test");
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let output = command
        .output()
        .map_err(|err| format!("无法启动 OpenSSH：{err}"));
    cleanup_askpass_helper(helper_path.as_ref());
    let output = output?;
    if !output.status.success() {
        return Err(format_process_error("测试连接失败", &output.stderr));
    }
    Ok(())
}

#[cfg(russh_backend)]
fn test_connection_with_server(server: &ServerRecord, secret: Option<&str>) -> Result<(), String> {
    let result = crate::russh_transport::run_command(server, secret, "printf ishell-test", None)
        .map_err(|err| format!("测试连接失败：{err}"))
        .map(|_| ());
    crate::russh_transport::invalidate(&server.id);
    result
}

pub fn fetch_status(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    include_disk: bool,
) -> Result<ServerStatus, String> {
    let raw = run_remote_shell(app, id, STATUS_SCRIPT)?;
    let sections = split_sections(&raw);
    let section = |key: &str| sections.get(key).map(String::as_str).unwrap_or("");

    let (load1, load5, load15) = parse_load(section("LOAD"));
    let cpu_cores = parse_cpu_cores(section("CORES"));
    let cpu_percent = parse_cpu_percent(section("CPU"))
        .unwrap_or_else(|| cpu_percent_from_load(load1, cpu_cores));
    let (memory_total_mb, memory_available_mb, swap_total_mb, swap_free_mb) =
        parse_memory(section("MEM"));
    let disk_mounts = if include_disk {
        let raw_disk = run_remote_shell(app, id, DISK_SCRIPT)?;
        parse_disk_mounts(&raw_disk)
    } else {
        Vec::new()
    };
    let root_disk = disk_mounts
        .iter()
        .find(|mount| mount.mount_point == "/")
        .or_else(|| disk_mounts.first());
    let processes = section("PROC").trim().parse::<u64>().ok();

    Ok(ServerStatus {
        id: id.to_string(),
        os: section("OS").trim().to_string(),
        uptime_seconds: parse_uptime(section("UP")),
        load1,
        load5,
        load15,
        cpu_cores,
        cpu_percent,
        memory_total_mb,
        memory_available_mb,
        swap_total_mb,
        swap_free_mb,
        disk_used_percent: root_disk.map(|mount| mount.used_percent),
        disk_used_gb: root_disk.map(|mount| mount.used_gb),
        disk_total_gb: root_disk.map(|mount| mount.total_gb),
        disk_mounts,
        processes,
        sampled_at: now(),
    })
}

pub fn fetch_network_sample(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
) -> Result<NetworkSample, String> {
    let raw = run_remote_shell(app, id, NETWORK_SCRIPT)?;
    let mut parts = raw.split_whitespace();
    let rx_bytes = parts
        .next()
        .and_then(|part| part.parse::<u64>().ok())
        .unwrap_or(0);
    let tx_bytes = parts
        .next()
        .and_then(|part| part.parse::<u64>().ok())
        .unwrap_or(0);

    Ok(NetworkSample {
        rx_bytes,
        tx_bytes,
        sampled_at: now_fractional(),
    })
}

pub fn list_sftp(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
) -> Result<Vec<SftpEntry>, String> {
    let current_path = if path.trim().is_empty() {
        "/"
    } else {
        path.trim()
    };
    let raw = run_remote_python(app, id, LIST_SCRIPT, &[current_path])?;
    let mut mapped: Vec<SftpEntry> =
        serde_json::from_str(&raw).map_err(|err| format!("无法解析远程目录列表：{err}"))?;
    mapped.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(mapped)
}

/// Stream the stdout of `remote_command` into `local`, emitting throttled
/// progress events keyed by `transfer_id`. Shared by single-file downloads
/// and the folder download modes below, across both transport backends.
fn stream_remote_to_file(
    app: &AppHandle,
    id: &str,
    remote_command: &str,
    total: u64,
    transfer_id: &str,
    local: &mut fs::File,
    is_canceled: &dyn Fn() -> bool,
) -> Result<(), String> {
    #[cfg(not(russh_backend))]
    {
        let (mut child, helper_path) = spawn_remote(app, id, remote_command, false, true, false)?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取 OpenSSH 下载输出".to_string())?;
        let progress = ProgressConfig::new(
            app,
            total,
            transfer_id,
            "sftp-download-progress",
            "下载已停止",
            is_canceled,
        );
        let copy_result = copy_with_progress(&mut stdout, local, progress);
        if copy_result.is_err() {
            let _ = child.kill();
        }
        let output = child
            .wait_with_output()
            .map_err(|err| format!("等待 OpenSSH 下载结束失败：{err}"));
        cleanup_askpass_helper(helper_path.as_ref());
        match copy_result {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {
                return Err("下载已停止".to_string());
            }
            Err(err) => return Err(format!("下载失败：{err}")),
        }
        let output = output?;
        if !output.status.success() {
            return Err(format_process_error("下载失败", &output.stderr));
        }
        Ok(())
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        emit_progress(app, "sftp-download-progress", transfer_id, 0, total, false);
        let mut last_emit = Instant::now();
        let mut on_progress = |transferred: u64| {
            if last_emit.elapsed() >= Duration::from_millis(80) {
                emit_progress(
                    app,
                    "sftp-download-progress",
                    transfer_id,
                    transferred,
                    total,
                    false,
                );
                last_emit = Instant::now();
            }
        };
        let result = crate::russh_transport::download(
            &server,
            secret.as_deref(),
            remote_command,
            local,
            is_canceled,
            &mut on_progress,
        );
        result.map_err(|err| match err {
            crate::russh_transport::TransferError::Canceled => "下载已停止".to_string(),
            crate::russh_transport::TransferError::Failed(msg) => format!("下载失败：{msg}"),
        })
    }
}

/// Pick a local file path under `dir` that doesn't collide with an existing
/// entry, appending " (n)" before the extension as needed.
fn unique_file_path(dir: &Path, file_name: &str) -> PathBuf {
    let mut candidate = dir.join(file_name);
    let mut counter = 1;
    while candidate.exists() {
        let stem = Path::new(file_name)
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".to_string());
        let ext = Path::new(file_name)
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy()))
            .unwrap_or_default();
        candidate = dir.join(format!("{stem} ({counter}){ext}"));
        counter += 1;
    }
    candidate
}

/// Pick a local directory path under `dir` that doesn't collide with an
/// existing entry, appending " (n)" as needed.
fn unique_dir_path(dir: &Path, name: &str) -> PathBuf {
    let mut candidate = dir.join(name);
    let mut counter = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{name} ({counter})"));
        counter += 1;
    }
    candidate
}

pub fn download_file(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    remote_path: &str,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let file_name = Path::new(remote_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let total = remote_file_size(app, id, remote_path).unwrap_or(0);

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|err| format!("无法定位下载目录：{err}"))?;
    fs::create_dir_all(&download_dir).ok();

    let local_path = unique_file_path(&download_dir, &file_name);
    let mut local =
        fs::File::create(&local_path).map_err(|err| format!("无法创建本地文件：{err}"))?;
    let remote_command = format!("cat -- {}", openssh::shell_quote(remote_path));

    if let Err(err) =
        stream_remote_to_file(app, id, &remote_command, total, transfer_id, &mut local, is_canceled)
    {
        drop(local);
        let _ = fs::remove_file(&local_path);
        return Err(err);
    }

    emit_progress(
        app,
        "sftp-download-progress",
        transfer_id,
        total,
        total,
        true,
    );
    Ok(local_path.to_string_lossy().to_string())
}

/// Download a remote directory either as a compressed archive (`mode ==
/// "archive"`, saved as `<name>.tar.gz`) or "as-is" (`mode == "raw"`,
/// streamed as an uncompressed tar and unpacked locally to preserve the
/// original folder structure).
pub fn download_folder(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    remote_path: &str,
    transfer_id: &str,
    mode: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let trimmed = remote_path.trim_end_matches('/');
    let remote = if trimmed.is_empty() { "/" } else { trimmed };
    let parent = Path::new(remote)
        .parent()
        .map(|value| {
            let text = value.to_string_lossy().to_string();
            if text.is_empty() { "/".to_string() } else { text }
        })
        .unwrap_or_else(|| "/".to_string());
    let base_name = Path::new(remote)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .ok_or_else(|| "无效的远程路径".to_string())?;

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|err| format!("无法定位下载目录：{err}"))?;
    fs::create_dir_all(&download_dir).ok();

    match mode {
        "archive" => {
            let local_path = unique_file_path(&download_dir, &format!("{base_name}.tar.gz"));
            let mut local =
                fs::File::create(&local_path).map_err(|err| format!("无法创建本地文件：{err}"))?;
            let remote_command = format!(
                "tar czf - -C {} -- {}",
                openssh::shell_quote(&parent),
                openssh::shell_quote(&base_name)
            );
            if let Err(err) =
                stream_remote_to_file(app, id, &remote_command, 0, transfer_id, &mut local, is_canceled)
            {
                drop(local);
                let _ = fs::remove_file(&local_path);
                return Err(err);
            }
            let total = local.metadata().map(|meta| meta.len()).unwrap_or(0);
            emit_progress(app, "sftp-download-progress", transfer_id, total, total, true);
            Ok(local_path.to_string_lossy().to_string())
        }
        "raw" => {
            let tmp_path = download_dir.join(format!(".{base_name}-{transfer_id}.tar.tmp"));
            let mut tmp_file =
                fs::File::create(&tmp_path).map_err(|err| format!("无法创建临时文件：{err}"))?;
            let remote_command = format!(
                "tar cf - -C {} -- {}",
                openssh::shell_quote(&parent),
                openssh::shell_quote(&base_name)
            );
            if let Err(err) = stream_remote_to_file(
                app,
                id,
                &remote_command,
                0,
                transfer_id,
                &mut tmp_file,
                is_canceled,
            ) {
                drop(tmp_file);
                let _ = fs::remove_file(&tmp_path);
                return Err(err);
            }
            let total = tmp_file.metadata().map(|meta| meta.len()).unwrap_or(0);
            drop(tmp_file);

            // The tar stream already contains `<base_name>/...` as its top-level
            // entry, so unpack into a scratch root first and then move that
            // extracted folder into its final, collision-free destination name.
            let extract_root = download_dir.join(format!(".ishell-extract-{transfer_id}"));
            let extract_result = fs::File::open(&tmp_path)
                .map_err(|err| format!("无法打开临时归档：{err}"))
                .and_then(|tar_file| {
                    tar::Archive::new(tar_file)
                        .unpack(&extract_root)
                        .map_err(|err| format!("解压失败：{err}"))
                });
            let _ = fs::remove_file(&tmp_path);
            if let Err(err) = extract_result {
                let _ = fs::remove_dir_all(&extract_root);
                return Err(err);
            }

            let extracted = extract_root.join(&base_name);
            let dest_dir = unique_dir_path(&download_dir, &base_name);
            let move_result = fs::rename(&extracted, &dest_dir)
                .map_err(|err| format!("无法移动解压结果：{err}"));
            let _ = fs::remove_dir_all(&extract_root);
            move_result?;

            emit_progress(app, "sftp-download-progress", transfer_id, total, total, true);
            Ok(dest_dir.to_string_lossy().to_string())
        }
        other => Err(format!("未知的下载模式：{other}")),
    }
}

pub fn upload_file(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    local_path: &str,
    remote_dir: &str,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let file_name = Path::new(local_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "无效的本地文件路径".to_string())?;
    let remote_path = if remote_dir == "/" {
        format!("/{file_name}")
    } else {
        format!("{}/{}", remote_dir.trim_end_matches('/'), file_name)
    };

    let mut local = fs::File::open(local_path).map_err(|err| format!("无法打开本地文件：{err}"))?;
    let total = local.metadata().map(|meta| meta.len()).unwrap_or(0);
    let remote_command = format!("cat > {}", openssh::shell_quote(&remote_path));

    #[cfg(not(russh_backend))]
    {
        let (mut child, helper_path) = spawn_remote(app, id, &remote_command, true, false, false)?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法写入 OpenSSH 上传输入".to_string())?;
        let progress = ProgressConfig::new(
            app,
            total,
            transfer_id,
            "sftp-upload-progress",
            "上传已停止",
            is_canceled,
        );
        let copy_result = copy_with_progress(&mut local, &mut stdin, progress);
        drop(stdin);
        if copy_result.is_err() {
            let _ = child.kill();
        }
        let output = child
            .wait_with_output()
            .map_err(|err| format!("等待 OpenSSH 上传结束失败：{err}"));
        cleanup_askpass_helper(helper_path.as_ref());
        match copy_result {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {
                let _ = remove_remote_file(app, id, &remote_path);
                return Err("上传已停止".to_string());
            }
            Err(err) => return Err(format!("上传失败：{err}")),
        }
        let output = output?;
        if !output.status.success() {
            let _ = remove_remote_file(app, id, &remote_path);
            return Err(format_process_error("上传失败", &output.stderr));
        }
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        emit_progress(app, "sftp-upload-progress", transfer_id, 0, total, false);
        let mut last_emit = Instant::now();
        let mut on_progress = |transferred: u64| {
            if last_emit.elapsed() >= Duration::from_millis(80) {
                emit_progress(
                    app,
                    "sftp-upload-progress",
                    transfer_id,
                    transferred,
                    total,
                    false,
                );
                last_emit = Instant::now();
            }
        };
        let result = crate::russh_transport::upload(
            &server,
            secret.as_deref(),
            &remote_command,
            &mut local,
            is_canceled,
            &mut on_progress,
        );
        if let Err(err) = result {
            let _ = remove_remote_file(app, id, &remote_path);
            return match err {
                crate::russh_transport::TransferError::Canceled => Err("上传已停止".to_string()),
                crate::russh_transport::TransferError::Failed(msg) => {
                    Err(format!("上传失败：{msg}"))
                }
            };
        }
    }

    emit_progress(app, "sftp-upload-progress", transfer_id, total, total, true);
    Ok(remote_path)
}

/// Stream the file in chunks, emitting throttled progress events (at most every
/// ~80ms) so the UI can render a live progress bar without being flooded by one
/// event per chunk on large transfers.
#[cfg(not(russh_backend))]
struct ProgressConfig<'a> {
    app: &'a AppHandle,
    total: u64,
    transfer_id: &'a str,
    event_name: &'a str,
    stop_message: &'a str,
    is_canceled: &'a dyn Fn() -> bool,
}

#[cfg(not(russh_backend))]
impl<'a> ProgressConfig<'a> {
    fn new(
        app: &'a AppHandle,
        total: u64,
        transfer_id: &'a str,
        event_name: &'a str,
        stop_message: &'a str,
        is_canceled: &'a dyn Fn() -> bool,
    ) -> Self {
        Self {
            app,
            total,
            transfer_id,
            event_name,
            stop_message,
            is_canceled,
        }
    }
}

#[cfg(not(russh_backend))]
fn copy_with_progress(
    reader: &mut impl Read,
    writer: &mut impl Write,
    progress: ProgressConfig<'_>,
) -> io::Result<()> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();
    emit_progress(
        progress.app,
        progress.event_name,
        progress.transfer_id,
        0,
        progress.total,
        false,
    );

    loop {
        if (progress.is_canceled)() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                progress.stop_message.to_string(),
            ));
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if (progress.is_canceled)() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                progress.stop_message.to_string(),
            ));
        }
        writer.write_all(&buffer[..read])?;
        transferred += read as u64;

        if last_emit.elapsed() >= Duration::from_millis(80) {
            emit_progress(
                progress.app,
                progress.event_name,
                progress.transfer_id,
                transferred,
                progress.total,
                false,
            );
            last_emit = Instant::now();
        }
    }

    Ok(())
}

fn emit_progress(
    app: &AppHandle,
    event_name: &str,
    transfer_id: &str,
    transferred: u64,
    total: u64,
    done: bool,
) {
    app.emit(
        event_name,
        UploadProgress {
            transfer_id: transfer_id.to_string(),
            transferred,
            total,
            done,
        },
    )
    .ok();
}

pub fn make_directory(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
) -> Result<(), String> {
    run_remote_shell(
        app,
        id,
        &format!("mkdir -p -- {}", openssh::shell_quote(path)),
    )
    .map(|_| ())
    .map_err(|err| format!("无法创建目录：{err}"))
}

pub fn remove_entry(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let command = if is_dir {
        format!("rm -rf -- {}", openssh::shell_quote(path))
    } else {
        format!("rm -f -- {}", openssh::shell_quote(path))
    };
    run_remote_shell(app, id, &command)
        .map(|_| ())
        .map_err(|err| format!("无法删除：{err}"))
}

pub fn rename_entry(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    run_remote_shell(
        app,
        id,
        &format!(
            "mv -f -- {} {}",
            openssh::shell_quote(from),
            openssh::shell_quote(to)
        ),
    )
    .map(|_| ())
    .map_err(|err| format!("无法重命名：{err}"))
}

pub fn read_text_file(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
) -> Result<String, String> {
    let size = remote_file_size(app, id, path)?;
    if size > MAX_TEXT_EDIT_BYTES {
        return Err(format!(
            "文件超过可编辑大小限制（最大 {}）",
            format_bytes(MAX_TEXT_EDIT_BYTES)
        ));
    }

    let raw = read_remote_file_bytes(app, id, path)?;
    if raw.len() as u64 > MAX_TEXT_EDIT_BYTES {
        return Err(format!(
            "文件超过可编辑大小限制（最大 {}）",
            format_bytes(MAX_TEXT_EDIT_BYTES)
        ));
    }
    text_from_bytes(raw)
}

pub fn write_text_file(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
    content: &str,
) -> Result<(), String> {
    if content.as_bytes().len() as u64 > MAX_TEXT_EDIT_BYTES {
        return Err(format!(
            "内容超过可编辑大小限制（最大 {}）",
            format_bytes(MAX_TEXT_EDIT_BYTES)
        ));
    }
    if content.as_bytes().contains(&0) {
        return Err("仅支持保存文本内容".to_string());
    }
    let size = remote_file_size(app, id, path).map_err(|err| format!("无法确认远程文件：{err}"))?;
    if size > MAX_TEXT_EDIT_BYTES {
        return Err(format!(
            "文件超过可编辑大小限制（最大 {}）",
            format_bytes(MAX_TEXT_EDIT_BYTES)
        ));
    }
    text_from_bytes(read_remote_file_bytes(app, id, path)?)?;
    let remote_command = format!("cat > {}", openssh::shell_quote(path));
    run_remote_command(app, id, &remote_command, Some(content.as_bytes()))
        .map(|_| ())
        .map_err(|err| format!("保存文件失败：{err}"))
}

fn run_remote_shell(app: &AppHandle, id: &str, script: &str) -> Result<String, String> {
    run_remote_command(
        app,
        id,
        &format!("sh -lc {}", openssh::shell_quote(script)),
        None,
    )
}

fn run_remote_python(
    app: &AppHandle,
    id: &str,
    script: &str,
    args: &[&str],
) -> Result<String, String> {
    let quoted_args = args
        .iter()
        .map(|arg| openssh::shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let command = if quoted_args.is_empty() {
        "python3 -".to_string()
    } else {
        format!("python3 - {quoted_args}")
    };
    run_remote_command(app, id, &command, Some(script.as_bytes()))
}

#[cfg(not(russh_backend))]
fn run_remote_command(
    app: &AppHandle,
    id: &str,
    remote_command: &str,
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    let (mut child, helper_path) =
        spawn_remote(app, id, remote_command, stdin.is_some(), true, true)?;
    if let Some(input) = stdin {
        let mut child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法写入 OpenSSH 输入".to_string())?;
        child_stdin
            .write_all(input)
            .map_err(|err| format!("写入 OpenSSH 输入失败：{err}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|err| format!("等待 OpenSSH 命令结束失败：{err}"));
    cleanup_askpass_helper(helper_path.as_ref());
    let output = output?;
    if !output.status.success() {
        return Err(format_process_error("OpenSSH 命令失败", &output.stderr));
    }
    String::from_utf8(output.stdout).map_err(|err| format!("OpenSSH 输出不是 UTF-8：{err}"))
}

#[cfg(russh_backend)]
fn run_remote_command(
    app: &AppHandle,
    id: &str,
    remote_command: &str,
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    let server = get_server(app, id)?;
    let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
    let stdout =
        crate::russh_transport::run_command(&server, secret.as_deref(), remote_command, stdin)
            .map_err(|err| format!("SSH 命令失败：{err}"))?;
    String::from_utf8(stdout).map_err(|err| format!("SSH 输出不是 UTF-8：{err}"))
}

#[cfg(not(russh_backend))]
fn spawn_remote(
    app: &AppHandle,
    id: &str,
    remote_command: &str,
    stdin_piped: bool,
    stdout_piped: bool,
    stderr_piped: bool,
) -> Result<(std::process::Child, Option<PathBuf>), String> {
    let server = get_server(app, id)?;
    let saved_secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
    let helper_path = if saved_secret.is_some() {
        Some(create_askpass_helper(id)?)
    } else {
        None
    };
    let mut command = Command::new(openssh::ssh_binary());
    if let (Some(secret), Some(path)) = (saved_secret.as_deref(), helper_path.as_ref()) {
        command.env("SSH_ASKPASS", path);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("ISHELL_SSH_PASSWORD", secret);
        command.env("DISPLAY", "ishell:0");
    }
    for arg in openssh::common_ssh_args(&server) {
        command.arg(arg);
    }
    for arg in openssh::auth_ssh_args(&server, saved_secret.is_some()) {
        command.arg(arg);
    }
    if saved_secret.is_none() {
        command.arg("-o");
        command.arg("BatchMode=yes");
    }
    command.arg(&server.host);
    command.arg(remote_command);
    command.stdin(if stdin_piped {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(if stdout_piped {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stderr(if stderr_piped {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    match command.spawn() {
        Ok(child) => Ok((child, helper_path)),
        Err(err) => {
            cleanup_askpass_helper(helper_path.as_ref());
            Err(format!("无法启动 OpenSSH：{err}"))
        }
    }
}

#[cfg(not(russh_backend))]
fn create_askpass_helper(id: &str) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("ishell-ssh-askpass-{id}.sh"));
    fs::write(
        &path,
        "#!/bin/sh\nprintf '%s\\n' \"$ISHELL_SSH_PASSWORD\"\n",
    )
    .map_err(|err| format!("无法创建 SSH_ASKPASS helper：{err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o700);
        fs::set_permissions(&path, permissions)
            .map_err(|err| format!("无法设置 SSH_ASKPASS helper 权限：{err}"))?;
    }
    Ok(path)
}

#[cfg(not(russh_backend))]
fn cleanup_askpass_helper(path: Option<&PathBuf>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

#[cfg(not(russh_backend))]
fn format_process_error(prefix: &str, stderr: &[u8]) -> String {
    let message = String::from_utf8_lossy(stderr).trim().to_string();
    if message.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}：{message}")
    }
}

fn remote_file_size(app: &AppHandle, id: &str, remote_path: &str) -> Result<u64, String> {
    let quoted = openssh::shell_quote(remote_path);
    let raw = run_remote_shell(
        app,
        id,
        &format!("stat -c %s -- {quoted} 2>/dev/null || stat -f %z -- {quoted} 2>/dev/null || wc -c < {quoted}"),
    )?;
    raw.split_whitespace()
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "无法读取远程文件大小".to_string())
}

fn read_remote_file_bytes(app: &AppHandle, id: &str, remote_path: &str) -> Result<Vec<u8>, String> {
    let command = format!("cat -- {}", openssh::shell_quote(remote_path));

    #[cfg(not(russh_backend))]
    {
        let (child, helper_path) = spawn_remote(app, id, &command, false, true, true)?;
        let output = child
            .wait_with_output()
            .map_err(|err| format!("等待 OpenSSH 命令结束失败：{err}"));
        cleanup_askpass_helper(helper_path.as_ref());
        let output = output?;
        if !output.status.success() {
            return Err(format_process_error("读取远程文件失败", &output.stderr));
        }
        Ok(output.stdout)
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        crate::russh_transport::run_command(&server, secret.as_deref(), &command, None)
            .map_err(|err| format!("读取远程文件失败：{err}"))
    }
}

fn remove_remote_file(app: &AppHandle, id: &str, path: &str) -> Result<(), String> {
    run_remote_shell(app, id, &format!("rm -f -- {}", openssh::shell_quote(path))).map(|_| ())
}

fn text_from_bytes(raw: Vec<u8>) -> Result<String, String> {
    if raw.contains(&0) {
        return Err("仅支持编辑文本文件，当前文件像是二进制文件".to_string());
    }
    String::from_utf8(raw).map_err(|_| "仅支持编辑 UTF-8 文本文件".to_string())
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{} MB", bytes / 1024 / 1024)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

/// Split the combined status output into a map keyed by the `@@KEY@@` markers.
fn split_sections(raw: &str) -> std::collections::HashMap<String, String> {
    let mut sections = std::collections::HashMap::new();
    let mut current: Option<String> = None;
    let mut buffer = String::new();

    for line in raw.lines() {
        if let Some(key) = line
            .strip_prefix("@@")
            .and_then(|rest| rest.strip_suffix("@@"))
        {
            if let Some(previous) = current.take() {
                sections.insert(previous, buffer.trim().to_string());
                buffer.clear();
            }
            current = Some(key.to_string());
        } else if current.is_some() {
            buffer.push_str(line);
            buffer.push('\n');
        }
    }
    if let Some(previous) = current.take() {
        sections.insert(previous, buffer.trim().to_string());
    }

    sections
}

fn parse_load(raw: &str) -> (f64, f64, f64) {
    let values: Vec<f64> = raw
        .split(|ch: char| ch.is_whitespace() || ch == '{' || ch == '}')
        .filter_map(|part| part.trim_end_matches(',').parse::<f64>().ok())
        .collect();

    (
        values.first().copied().unwrap_or(0.0),
        values.get(1).copied().unwrap_or(0.0),
        values.get(2).copied().unwrap_or(0.0),
    )
}

fn parse_uptime(raw: &str) -> Option<u64> {
    raw.split_whitespace()
        .next()
        .and_then(|part| part.parse::<f64>().ok())
        .map(|seconds| seconds as u64)
}

fn parse_cpu_cores(raw: &str) -> Option<u64> {
    raw.split_whitespace()
        .find_map(|part| part.parse::<u64>().ok())
        .filter(|cores| *cores > 0)
}

fn parse_cpu_percent(raw: &str) -> Option<f64> {
    let samples: Vec<Vec<u64>> = raw
        .lines()
        .map(|line| {
            line.split_whitespace()
                .filter_map(|part| part.parse::<u64>().ok())
                .collect::<Vec<_>>()
        })
        .filter(|values| values.len() >= 4)
        .collect();

    let first = samples.first()?;
    let second = samples.get(1)?;
    let total_a: u64 = first.iter().sum();
    let total_b: u64 = second.iter().sum();
    let idle_a = first.get(3).copied().unwrap_or(0) + first.get(4).copied().unwrap_or(0);
    let idle_b = second.get(3).copied().unwrap_or(0) + second.get(4).copied().unwrap_or(0);
    let total_delta = total_b.checked_sub(total_a)?;
    if total_delta == 0 {
        return None;
    }
    let idle_delta = idle_b.saturating_sub(idle_a);
    let busy_delta = total_delta.saturating_sub(idle_delta);

    Some(((busy_delta as f64 / total_delta as f64) * 100.0).clamp(0.0, 100.0))
}

fn cpu_percent_from_load(load1: f64, cpu_cores: Option<u64>) -> f64 {
    let cores = cpu_cores.unwrap_or(4).max(1) as f64;
    ((load1 / cores) * 100.0).clamp(0.0, 100.0)
}

fn parse_memory(raw: &str) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    let mut total = None;
    let mut available = None;
    let mut swap_total = None;
    let mut swap_free = None;

    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or_default().trim_end_matches(':');
        let value = parts.next().and_then(|part| part.parse::<u64>().ok());

        match key {
            "MemTotal" => total = value.map(|kb| kb / 1024),
            "MemAvailable" => available = value.map(|kb| kb / 1024),
            "SwapTotal" => swap_total = value.map(|kb| kb / 1024),
            "SwapFree" => swap_free = value.map(|kb| kb / 1024),
            _ => {}
        }
    }

    (total, available, swap_total, swap_free)
}

fn parse_disk_mounts(raw: &str) -> Vec<DiskMount> {
    raw.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 6 {
                return None;
            }

            let total_kb = parts.get(1)?.parse::<f64>().ok()?;
            let used_kb = parts.get(2)?.parse::<f64>().ok()?;
            let used_percent = parts.get(4)?.trim_end_matches('%').parse::<f64>().ok()?;

            Some(DiskMount {
                filesystem: parts.first()?.to_string(),
                mount_point: parts[5..].join(" "),
                used_percent,
                used_gb: used_kb / 1024.0 / 1024.0,
                total_gb: total_kb / 1024.0 / 1024.0,
            })
        })
        .collect()
}
