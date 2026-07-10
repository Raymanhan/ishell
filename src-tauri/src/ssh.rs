#[cfg(any(windows, test))]
use sha2::{Digest, Sha256};
#[cfg(not(russh_backend))]
use std::process::{Command, Stdio};
use std::{
    fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
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
    for arg in openssh::common_ssh_args(server, true) {
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
        let (mut child, helper_path) =
            spawn_remote_ex(app, id, remote_command, false, true, false, false)?;
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

fn remote_basename(path: &str) -> Option<&str> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
}

fn remote_parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", _)) | None => "/".to_string(),
        Some((parent, _)) => parent.to_string(),
    }
}

#[cfg(windows)]
fn local_download_name(name: &str) -> String {
    sanitize_windows_file_name(name)
}

#[cfg(not(windows))]
fn local_download_name(name: &str) -> String {
    name.to_string()
}

#[cfg(any(windows, test))]
fn sanitize_windows_file_name(name: &str) -> String {
    let characters = name.chars().collect::<Vec<_>>();
    let trailing_start = characters
        .iter()
        .rposition(|character| !matches!(character, ' ' | '.'))
        .map(|index| index + 1)
        .unwrap_or(0);
    let mut sanitized = String::new();
    for (index, character) in characters.into_iter().enumerate() {
        let must_encode = character < '\u{20}'
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
            || (index >= trailing_start && matches!(character, ' ' | '.'));
        if must_encode {
            sanitized.push_str(&format!("~{:04X}~", character as u32));
        } else if character == '~' {
            // Escape the marker itself so the mapping remains collision-free.
            sanitized.push_str("~~");
        } else {
            sanitized.push(character);
        }
    }
    if sanitized.is_empty() {
        sanitized = "_".to_string();
    }

    let stem = sanitized
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        sanitized.insert_str(0, "~DEV~");
    }

    const MAX_SAFE_UTF16_UNITS: usize = 180;
    if sanitized.encode_utf16().count() > MAX_SAFE_UTF16_UNITS {
        let digest = Sha256::digest(name.as_bytes());
        let suffix = format!(
            "~{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7]
        );
        let suffix_units = suffix.encode_utf16().count();
        let mut shortened = String::new();
        let mut used_units = 0;
        for character in sanitized.chars() {
            let units = character.len_utf16();
            if used_units + units + suffix_units > MAX_SAFE_UTF16_UNITS {
                break;
            }
            shortened.push(character);
            used_units += units;
        }
        shortened.push_str(&suffix);
        sanitized = shortened;
    }

    sanitized
}

#[cfg(any(windows, test))]
fn windows_safe_archive_path(raw: &[u8], allow_parent: bool) -> Result<PathBuf, String> {
    let raw = String::from_utf8_lossy(raw).replace('\\', "/");
    let mut path = PathBuf::new();
    for component in raw.split('/') {
        match component {
            "" | "." => {}
            ".." if allow_parent => path.push(".."),
            ".." => return Err("归档包含不安全的上级目录路径".to_string()),
            value => path.push(sanitize_windows_file_name(value)),
        }
    }
    if path.as_os_str().is_empty() {
        return Err("归档包含空路径".to_string());
    }
    Ok(path)
}

#[cfg(any(windows, test))]
fn sanitize_archive_for_windows(source: &Path, destination: &Path) -> Result<(), String> {
    let input = fs::File::open(source).map_err(|err| format!("无法打开待转换归档：{err}"))?;
    let output = fs::File::create(destination).map_err(|err| format!("无法创建兼容归档：{err}"))?;
    let mut archive = tar::Archive::new(input);
    let mut builder = tar::Builder::new(output);
    let entries = archive
        .entries()
        .map_err(|err| format!("无法读取归档条目：{err}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|err| format!("无法读取归档条目：{err}"))?;
        let safe_path = windows_safe_archive_path(entry.path_bytes().as_ref(), false)?;
        let mut header = entry.header().clone();
        header
            .set_path(&safe_path)
            .map_err(|err| format!("无法转换 Windows 文件名：{err}"))?;
        if let Some(link_name) = entry.link_name_bytes() {
            let safe_link = windows_safe_archive_path(link_name.as_ref(), true)?;
            header
                .set_link_name(&safe_link)
                .map_err(|err| format!("无法转换归档链接：{err}"))?;
        }
        header.set_cksum();
        builder
            .append(&header, &mut entry)
            .map_err(|err| format!("无法写入兼容归档：{err}"))?;
    }

    builder
        .finish()
        .map_err(|err| format!("无法完成兼容归档：{err}"))
}

fn prepare_archive_for_local_unpack(source: &Path, transfer_id: &str) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let destination = source.with_file_name(format!(".ishell-safe-{transfer_id}.tar.tmp"));
        sanitize_archive_for_windows(source, &destination)?;
        Ok(destination)
    }

    #[cfg(not(windows))]
    {
        let _ = transfer_id;
        Ok(source.to_path_buf())
    }
}

pub fn download_file(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    remote_path: &str,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let file_name = remote_basename(remote_path)
        .map(local_download_name)
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

    if let Err(err) = stream_remote_to_file(
        app,
        id,
        &remote_command,
        total,
        transfer_id,
        &mut local,
        is_canceled,
    ) {
        drop(local);
        let _ = fs::remove_file(&local_path);
        return Err(err);
    }

    let actual = local.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    if total > 0 && actual != total {
        drop(local);
        let _ = fs::remove_file(&local_path);
        return Err(format!(
            "下载文件大小不一致：预期 {total} 字节，实际 {actual} 字节"
        ));
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
    let parent = remote_parent(remote);
    let base_name = remote_basename(remote)
        .map(str::to_string)
        .ok_or_else(|| "无效的远程路径".to_string())?;
    let local_base_name = local_download_name(&base_name);

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|err| format!("无法定位下载目录：{err}"))?;
    fs::create_dir_all(&download_dir).ok();

    match mode {
        "archive" => {
            let local_path = unique_file_path(&download_dir, &format!("{local_base_name}.tar.gz"));
            let mut local =
                fs::File::create(&local_path).map_err(|err| format!("无法创建本地文件：{err}"))?;
            let remote_command = format!(
                "tar czf - -C {} -- {}",
                openssh::shell_quote(&parent),
                openssh::shell_quote(&base_name)
            );
            if let Err(err) = stream_remote_to_file(
                app,
                id,
                &remote_command,
                0,
                transfer_id,
                &mut local,
                is_canceled,
            ) {
                drop(local);
                let _ = fs::remove_file(&local_path);
                return Err(err);
            }
            let total = local.metadata().map(|meta| meta.len()).unwrap_or(0);
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
        "raw" => {
            let tmp_path = download_dir.join(format!(".ishell-{transfer_id}.tar.tmp"));
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

            let unpack_path = match prepare_archive_for_local_unpack(&tmp_path, transfer_id) {
                Ok(path) => path,
                Err(err) => {
                    let _ = fs::remove_file(&tmp_path);
                    return Err(err);
                }
            };

            // The tar stream already contains `<base_name>/...` as its top-level
            // entry, so unpack into a scratch root first and then move that
            // extracted folder into its final, collision-free destination name.
            let extract_root = download_dir.join(format!(".ishell-extract-{transfer_id}"));
            let extract_result = fs::File::open(&unpack_path)
                .map_err(|err| format!("无法打开临时归档：{err}"))
                .and_then(|tar_file| {
                    tar::Archive::new(tar_file)
                        .unpack(&extract_root)
                        .map_err(|err| format!("解压失败：{err}"))
                });
            let _ = fs::remove_file(&tmp_path);
            if unpack_path != tmp_path {
                let _ = fs::remove_file(&unpack_path);
            }
            if let Err(err) = extract_result {
                let _ = fs::remove_dir_all(&extract_root);
                return Err(err);
            }

            let extracted = extract_root.join(&local_base_name);
            let dest_dir = unique_dir_path(&download_dir, &local_base_name);
            let move_result =
                fs::rename(&extracted, &dest_dir).map_err(|err| format!("无法移动解压结果：{err}"));
            let _ = fs::remove_dir_all(&extract_root);
            move_result?;

            emit_progress(
                app,
                "sftp-download-progress",
                transfer_id,
                total,
                total,
                true,
            );
            Ok(dest_dir.to_string_lossy().to_string())
        }
        other => Err(format!("未知的下载模式：{other}")),
    }
}

const UPLOAD_TARGET_DIRECTORY_MARKER: &str = "__ISHELL_UPLOAD_TARGET_IS_DIRECTORY__";
const UPLOAD_TARGET_UNSUPPORTED_MARKER: &str = "__ISHELL_UPLOAD_TARGET_UNSUPPORTED__";
const UPLOAD_TARGET_CHANGED_MARKER: &str = "__ISHELL_UPLOAD_TARGET_CHANGED__";
const UPLOAD_WRITE_FAILED_MARKER: &str = "__ISHELL_UPLOAD_WRITE_FAILED__";
const UPLOAD_COMMIT_FAILED_MARKER: &str = "__ISHELL_UPLOAD_COMMIT_FAILED__";
const UPLOAD_FOLDER_CONFLICT_MARKER: &str = "__ISHELL_UPLOAD_FOLDER_CONFLICT__";
const UPLOAD_FOLDER_UNSAFE_MARKER: &str = "__ISHELL_UPLOAD_FOLDER_UNSAFE__";
const UPLOAD_FOLDER_EXTRACT_FAILED_MARKER: &str = "__ISHELL_UPLOAD_FOLDER_EXTRACT_FAILED__";
const UPLOAD_FOLDER_COMMIT_FAILED_MARKER: &str = "__ISHELL_UPLOAD_FOLDER_COMMIT_FAILED__";
const UPLOAD_FOLDER_CHANGED_MARKER: &str = "__ISHELL_UPLOAD_FOLDER_CHANGED__";
const UPLOAD_HEARTBEAT_MARKER: &str = "__ISHELL_UPLOAD_HEARTBEAT__";

const FOLDER_TARGET_PROBE_SCRIPT: &str = r#"
import hashlib
import os
import re
import stat
import sys
import time

HEARTBEAT = "__ISHELL_UPLOAD_HEARTBEAT__"
last_heartbeat = 0.0


class ProbeFailure(Exception):
    pass


def heartbeat():
    global last_heartbeat
    current = time.monotonic()
    if current - last_heartbeat >= 5.0:
        print(HEARTBEAT, file=sys.stderr, flush=True)
        last_heartbeat = current


def system_mount_points():
    points = set()
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8", errors="surrogateescape") as source:
            for line in source:
                fields = line.split(" - ", 1)[0].split()
                if len(fields) < 5:
                    continue
                decoded = re.sub(
                    r"\\([0-7]{3})",
                    lambda match: chr(int(match.group(1), 8)),
                    fields[4],
                )
                points.add(os.path.abspath(decoded))
    except OSError:
        pass
    return points


def is_mount_point(path, mount_points):
    return os.path.abspath(path) in mount_points or os.path.ismount(path)


def directory_snapshots(path):
    revision = hashlib.sha256()
    rename_stable = hashlib.sha256()
    mount_points = system_mount_points()
    if is_mount_point(path, mount_points):
        raise ProbeFailure("destination-is-mount-point")
    root_device = os.lstat(path).st_dev

    def visit(current, relative):
        heartbeat()
        value = os.lstat(current)
        if stat.S_ISLNK(value.st_mode):
            raise ProbeFailure("destination-symbolic-link")
        if not stat.S_ISDIR(value.st_mode):
            raise ProbeFailure("destination-not-directory")
        revision_fields = (
            relative, value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns, value.st_nlink,
        )
        stable_fields = (
            relative, value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, None if not relative else value.st_ctime_ns, value.st_nlink,
        )
        revision.update(repr(revision_fields).encode("utf-8", "surrogateescape"))
        rename_stable.update(repr(stable_fields).encode("utf-8", "surrogateescape"))
        with os.scandir(current) as entries:
            ordered = sorted(entries, key=lambda entry: entry.name)
        for entry in ordered:
            entry_path = os.path.join(current, entry.name)
            entry_relative = entry.name if not relative else relative + "/" + entry.name
            entry_value = os.lstat(entry_path)
            fields = (
                entry_relative, entry_value.st_dev, entry_value.st_ino,
                entry_value.st_mode, entry_value.st_size, entry_value.st_mtime_ns,
                entry_value.st_ctime_ns, entry_value.st_nlink,
            )
            encoded = repr(fields).encode("utf-8", "surrogateescape")
            revision.update(encoded)
            rename_stable.update(encoded)
            if stat.S_ISLNK(entry_value.st_mode):
                link_target = os.fsencode(os.readlink(entry_path))
                revision.update(link_target)
                rename_stable.update(link_target)
            elif stat.S_ISDIR(entry_value.st_mode):
                if entry_value.st_dev != root_device or is_mount_point(entry_path, mount_points):
                    raise ProbeFailure("destination-contains-mount-point")
                visit(entry_path, entry_relative)

    visit(path, "")
    return revision.hexdigest(), rename_stable.hexdigest()

remote_dir, folder_name, include_revision = sys.argv[1:4]
if include_revision not in ("0", "1"):
    print("changed invalid-probe-mode")
    sys.exit(0)
target = os.path.join(remote_dir, folder_name)
try:
    value = os.lstat(target)
except FileNotFoundError:
    print("missing")
else:
    if stat.S_ISLNK(value.st_mode):
        print("unsupported symbolic-link")
    elif stat.S_ISDIR(value.st_mode):
        if include_revision == "0":
            print("directory")
        else:
            try:
                revision, rename_stable = directory_snapshots(target)
                print("directory " + revision + " " + rename_stable)
            except ProbeFailure as error:
                print("unsupported " + str(error))
            except OSError as error:
                print("changed " + str(error))
    else:
        print("unsupported non-directory")
"#;

const FOLDER_UPLOAD_ARTIFACT_CLEANUP_SCRIPT: &str = r#"
import os
import re
import stat
import sys


def lstat_optional(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def system_mount_points():
    points = set()
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8", errors="surrogateescape") as source:
            for line in source:
                fields = line.split(" - ", 1)[0].split()
                if len(fields) < 5:
                    continue
                decoded = re.sub(
                    r"\\([0-7]{3})",
                    lambda match: chr(int(match.group(1), 8)),
                    fields[4],
                )
                points.add(os.path.abspath(decoded))
    except OSError:
        pass
    return points


def is_mount_point(path, mount_points):
    return os.path.abspath(path) in mount_points or os.path.ismount(path)


def remove_tree(path, root_device=None, mount_points=None):
    value = lstat_optional(path)
    if value is None:
        return
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        os.unlink(path)
        return
    if mount_points is None:
        mount_points = system_mount_points()
    if is_mount_point(path, mount_points):
        return
    if root_device is None:
        root_device = value.st_dev
    elif value.st_dev != root_device:
        return
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    with os.scandir(path) as entries:
        children = list(entries)
    for entry in children:
        child = os.path.join(path, entry.name)
        child_value = os.lstat(child)
        if stat.S_ISDIR(child_value.st_mode) and not stat.S_ISLNK(child_value.st_mode):
            if child_value.st_dev != root_device or is_mount_point(child, mount_points):
                continue
            remove_tree(child, root_device, mount_points)
        else:
            os.unlink(child)
    try:
        os.rmdir(path)
    except OSError:
        pass


archive_path, staging_path = sys.argv[1:3]
archive_value = lstat_optional(archive_path)
if archive_value is not None and not stat.S_ISDIR(archive_value.st_mode):
    try:
        os.unlink(archive_path)
    except OSError:
        pass
try:
    remove_tree(staging_path)
except OSError:
    pass
"#;

const TRANSACTIONAL_UPLOAD_SCRIPT: &str = r#"
import os
import shutil
import signal
import stat
import sys

SIZE_MISMATCH = "__ISHELL_UPLOAD_SIZE_MISMATCH__"
TARGET_DIRECTORY = "__ISHELL_UPLOAD_TARGET_IS_DIRECTORY__"
TARGET_UNSUPPORTED = "__ISHELL_UPLOAD_TARGET_UNSUPPORTED__"
TARGET_CHANGED = "__ISHELL_UPLOAD_TARGET_CHANGED__"
WRITE_FAILED = "__ISHELL_UPLOAD_WRITE_FAILED__"
COMMIT_FAILED = "__ISHELL_UPLOAD_COMMIT_FAILED__"


class UploadFailure(Exception):
    def __init__(self, code):
        self.code = code


def fail(marker, detail="", code=1):
    message = marker if not detail else marker + " " + detail
    print(message, file=sys.stderr, flush=True)
    raise UploadFailure(code)


def target_stat(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def target_signature(value):
    if value is None:
        return None
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def validate_target(value):
    if value is None:
        return
    if stat.S_ISDIR(value.st_mode):
        fail(TARGET_DIRECTORY, code=73)
    if stat.S_ISLNK(value.st_mode):
        fail(TARGET_UNSUPPORTED, "symbolic-link", 73)
    if not stat.S_ISREG(value.st_mode):
        fail(TARGET_UNSUPPORTED, "non-regular-file", 73)
    if value.st_nlink != 1:
        fail(TARGET_UNSUPPORTED, "hard-links=" + str(value.st_nlink), 73)


def interrupted(_signum, _frame):
    fail(WRITE_FAILED, "interrupted", 130)


for signal_name in ("SIGHUP", "SIGINT", "SIGTERM"):
    signal_value = getattr(signal, signal_name, None)
    if signal_value is not None:
        signal.signal(signal_value, interrupted)


final_path, temp_path, expected_text = sys.argv[1:4]
expected = int(expected_text)
committed = False
temp_created = False

try:
    initial = target_stat(final_path)
    validate_target(initial)
    initial_signature = target_signature(initial)

    try:
        descriptor = os.open(
            temp_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o666,
        )
        temp_created = True
        with os.fdopen(descriptor, "wb", buffering=0) as output:
            transferred = 0
            while True:
                chunk = sys.stdin.buffer.read(64 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = output.write(view)
                    if written is None:
                        written = len(view)
                    if written <= 0:
                        raise OSError("remote temporary file accepted no data")
                    transferred += written
                    view = view[written:]
    except UploadFailure:
        raise
    except Exception as error:
        fail(WRITE_FAILED, str(error), 74)

    if transferred != expected:
        fail(
            SIZE_MISMATCH,
            "expected=" + str(expected) + " actual=" + str(transferred),
            75,
        )

    current = target_stat(final_path)
    validate_target(current)
    if target_signature(current) != initial_signature:
        fail(TARGET_CHANGED, code=76)

    if initial is not None:
        try:
            temp_stat = os.lstat(temp_path)
            if (temp_stat.st_uid, temp_stat.st_gid) != (initial.st_uid, initial.st_gid):
                os.chown(temp_path, initial.st_uid, initial.st_gid)
            shutil.copystat(final_path, temp_path, follow_symlinks=False)
            os.utime(temp_path, None, follow_symlinks=False)
        except Exception as error:
            fail(COMMIT_FAILED, "metadata: " + str(error), 77)

        if target_signature(target_stat(final_path)) != initial_signature:
            fail(TARGET_CHANGED, code=76)
    elif target_stat(final_path) is not None:
        fail(TARGET_CHANGED, code=76)

    try:
        os.replace(temp_path, final_path)
        committed = True
    except Exception as error:
        fail(COMMIT_FAILED, str(error), 77)
except UploadFailure as error:
    sys.exit(error.code)
except Exception as error:
    print(COMMIT_FAILED + " " + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
finally:
    if temp_created and not committed:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        except OSError:
            pass
"#;

const TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT: &str = r#"
import ctypes
import errno
import hashlib
import os
import re
import signal
import stat
import sys
import tarfile
import time
from pathlib import PurePosixPath

SIZE_MISMATCH = "__ISHELL_UPLOAD_SIZE_MISMATCH__"
WRITE_FAILED = "__ISHELL_UPLOAD_WRITE_FAILED__"
CONFLICT = "__ISHELL_UPLOAD_FOLDER_CONFLICT__"
UNSAFE = "__ISHELL_UPLOAD_FOLDER_UNSAFE__"
EXTRACT_FAILED = "__ISHELL_UPLOAD_FOLDER_EXTRACT_FAILED__"
COMMIT_FAILED = "__ISHELL_UPLOAD_FOLDER_COMMIT_FAILED__"
CHANGED = "__ISHELL_UPLOAD_FOLDER_CHANGED__"
HEARTBEAT = "__ISHELL_UPLOAD_HEARTBEAT__"
last_heartbeat = 0.0
commit_phase = False
pending_interrupt = False


class UploadFailure(Exception):
    def __init__(self, code):
        self.code = code


def fail(marker, detail="", code=1):
    message = marker if not detail else marker + " " + detail
    print(message, file=sys.stderr, flush=True)
    raise UploadFailure(code)


def heartbeat():
    global last_heartbeat
    current = time.monotonic()
    if current - last_heartbeat >= 5.0:
        try:
            print(HEARTBEAT, file=sys.stderr, flush=True)
        except BrokenPipeError:
            if not globals().get("upload_committed", False):
                raise
        last_heartbeat = current


def lstat_optional(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def system_mount_points():
    points = set()
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8", errors="surrogateescape") as source:
            for line in source:
                fields = line.split(" - ", 1)[0].split()
                if len(fields) < 5:
                    continue
                decoded = re.sub(
                    r"\\([0-7]{3})",
                    lambda match: chr(int(match.group(1), 8)),
                    fields[4],
                )
                points.add(os.path.abspath(decoded))
    except OSError:
        pass
    return points


def is_mount_point(path, mount_points):
    return os.path.abspath(path) in mount_points or os.path.ismount(path)


def require_safe_directory(path, label):
    value = lstat_optional(path)
    if value is None:
        fail(UNSAFE, label + "-missing", 73)
    if stat.S_ISLNK(value.st_mode):
        fail(UNSAFE, label + "-symbolic-link", 73)
    if not stat.S_ISDIR(value.st_mode):
        fail(UNSAFE, label + "-not-directory", 73)


def require_safe_ancestors(path):
    absolute = os.path.abspath(path)
    if not absolute.startswith(os.sep):
        fail(UNSAFE, "remote-directory-not-absolute", 73)
    current = os.sep
    for component in [part for part in absolute.split(os.sep) if part]:
        current = os.path.join(current, component)
        value = lstat_optional(current)
        if value is None:
            fail(UNSAFE, "remote-directory-missing", 73)
        if stat.S_ISLNK(value.st_mode):
            fail(UNSAFE, "remote-directory-symbolic-link", 73)
        if not stat.S_ISDIR(value.st_mode):
            fail(UNSAFE, "remote-directory-component-not-directory", 73)


def directory_snapshots(path):
    revision = hashlib.sha256()
    rename_stable = hashlib.sha256()
    mount_points = system_mount_points()
    if is_mount_point(path, mount_points):
        fail(UNSAFE, "destination-is-mount-point", 73)
    root_device = os.lstat(path).st_dev

    def visit(current, relative):
        heartbeat()
        value = os.lstat(current)
        if stat.S_ISLNK(value.st_mode):
            fail(UNSAFE, "destination-symbolic-link", 73)
        if not stat.S_ISDIR(value.st_mode):
            fail(UNSAFE, "destination-not-directory", 73)
        revision_fields = (
            relative, value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns, value.st_nlink,
        )
        stable_fields = (
            relative, value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, None if not relative else value.st_ctime_ns, value.st_nlink,
        )
        revision.update(repr(revision_fields).encode("utf-8", "surrogateescape"))
        rename_stable.update(repr(stable_fields).encode("utf-8", "surrogateescape"))
        with os.scandir(current) as entries:
            ordered = sorted(entries, key=lambda entry: entry.name)
        for entry in ordered:
            entry_path = os.path.join(current, entry.name)
            entry_relative = entry.name if not relative else relative + "/" + entry.name
            entry_value = os.lstat(entry_path)
            fields = (
                entry_relative, entry_value.st_dev, entry_value.st_ino,
                entry_value.st_mode, entry_value.st_size, entry_value.st_mtime_ns,
                entry_value.st_ctime_ns, entry_value.st_nlink,
            )
            encoded = repr(fields).encode("utf-8", "surrogateescape")
            revision.update(encoded)
            rename_stable.update(encoded)
            if stat.S_ISLNK(entry_value.st_mode):
                link_target = os.fsencode(os.readlink(entry_path))
                revision.update(link_target)
                rename_stable.update(link_target)
            elif stat.S_ISDIR(entry_value.st_mode):
                if entry_value.st_dev != root_device or is_mount_point(entry_path, mount_points):
                    fail(UNSAFE, "destination-contains-mount-point", 73)
                visit(entry_path, entry_relative)

    visit(path, "")
    return revision.hexdigest(), rename_stable.hexdigest()


def try_exchange_directories(first, second):
    libc = ctypes.CDLL(None, use_errno=True)
    first_bytes = os.fsencode(first)
    second_bytes = os.fsencode(second)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is not None:
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, first_bytes, -100, second_bytes, 2)
    else:
        renamex_np = getattr(libc, "renamex_np", None)
        if renamex_np is None:
            return False
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        result = renamex_np(first_bytes, second_bytes, 2)
    if result == 0:
        return True
    error_number = ctypes.get_errno()
    unsupported = {
        errno.ENOSYS,
        errno.EINVAL,
        errno.EXDEV,
        getattr(errno, "ENOTSUP", errno.EINVAL),
        getattr(errno, "EOPNOTSUPP", errno.EINVAL),
    }
    if error_number in unsupported:
        return False
    raise OSError(error_number, os.strerror(error_number))


def safe_member_parts(member):
    raw = member.name
    if not raw or raw.startswith("/"):
        fail(UNSAFE, "archive-absolute-or-empty-path", 73)
    parts = [part for part in PurePosixPath(raw).parts if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        fail(UNSAFE, "archive-parent-path", 73)
    if member.issym() or member.islnk():
        fail(UNSAFE, "archive-link", 73)
    if not (member.isdir() or member.isfile()):
        fail(UNSAFE, "archive-special-file", 73)
    return parts


def extract_archive(archive_path, staging_path):
    try:
        with tarfile.open(archive_path, mode="r:") as archive:
            members = archive.getmembers()
            seen = set()
            prepared = []
            for member in members:
                heartbeat()
                parts = safe_member_parts(member)
                key = tuple(parts)
                if key in seen:
                    fail(UNSAFE, "archive-duplicate-path", 73)
                seen.add(key)
                prepared.append((member, parts))

            directory_attributes = []
            for member, parts in prepared:
                heartbeat()
                target = os.path.join(staging_path, *parts)
                if os.path.commonpath((staging_path, target)) != staging_path:
                    fail(UNSAFE, "archive-path-escape", 73)
                if member.isdir():
                    os.makedirs(target, exist_ok=True)
                    directory_attributes.append((target, member.mode, member.mtime))
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(target, flags, member.mode & 0o777)
                source = archive.extractfile(member)
                if source is None:
                    os.close(descriptor)
                    fail(EXTRACT_FAILED, "missing-file-data", 74)
                with source, os.fdopen(descriptor, "wb", buffering=0) as output:
                    while True:
                        chunk = source.read(64 * 1024)
                        if not chunk:
                            break
                        view = memoryview(chunk)
                        while view:
                            written = output.write(view)
                            if written is None:
                                written = len(view)
                            if written <= 0:
                                fail(EXTRACT_FAILED, "short-write", 74)
                            view = view[written:]
                        heartbeat()
                if os.lstat(target).st_size != member.size:
                    fail(EXTRACT_FAILED, "member-size-mismatch", 74)
                os.chmod(target, member.mode & 0o777)
                os.utime(target, (member.mtime, member.mtime))
            for target, mode, modified in reversed(directory_attributes):
                os.chmod(target, mode & 0o777)
                os.utime(target, (modified, modified))
    except UploadFailure:
        raise
    except Exception as error:
        fail(EXTRACT_FAILED, str(error), 74)


def remove_staging(path, root_device=None, mount_points=None):
    value = lstat_optional(path)
    if value is None:
        return
    if mount_points is None:
        mount_points = system_mount_points()
    if root_device is None:
        if is_mount_point(path, mount_points):
            raise OSError("refusing to remove mounted directory")
        root_device = value.st_dev
    elif value.st_dev != root_device or is_mount_point(path, mount_points):
        raise OSError("refusing to remove mounted directory")
    heartbeat()
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        os.unlink(path)
        return
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    with os.scandir(path) as entries:
        children = list(entries)
    for entry in children:
        child = os.path.join(path, entry.name)
        child_value = os.lstat(child)
        if stat.S_ISDIR(child_value.st_mode) and not stat.S_ISLNK(child_value.st_mode):
            if child_value.st_dev != root_device or is_mount_point(child, mount_points):
                raise OSError("refusing to remove mounted directory")
            remove_staging(child, root_device, mount_points)
        else:
            os.unlink(child)
        heartbeat()
    os.rmdir(path)


def interrupted(_signum, _frame):
    global pending_interrupt
    if commit_phase or globals().get("upload_committed", False):
        pending_interrupt = True
        return
    fail(WRITE_FAILED, "interrupted", 130)


for signal_name in ("SIGHUP", "SIGINT", "SIGTERM"):
    signal_value = getattr(signal, signal_name, None)
    if signal_value is not None:
        signal.signal(signal_value, interrupted)


def valid_snapshot_token(value):
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


(
    remote_dir,
    folder_name,
    archive_path,
    staging_path,
    expected_text,
    root_mode_text,
    replace_text,
    expected_destination_revision,
    expected_destination_stable,
) = sys.argv[1:10]
expected = int(expected_text)
root_mode = int(root_mode_text, 8)
replace_existing = replace_text == "1"
archive_created = False
staging_created = False
placeholder_created = False
placeholder_signature = None
staging_contains_old = False
preserve_staging = False
upload_committed = False
destination = None

try:
    if replace_text not in ("0", "1"):
        fail(UNSAFE, "invalid-replace-flag", 73)
    if folder_name in ("", ".", "..") or "/" in folder_name or "\x00" in folder_name:
        fail(UNSAFE, "invalid-folder-name", 73)
    require_safe_ancestors(remote_dir)
    require_safe_directory(remote_dir, "remote-directory")
    remote_dir = os.path.abspath(remote_dir)
    remote_dir_value = os.lstat(remote_dir)
    remote_dir_signature = (remote_dir_value.st_dev, remote_dir_value.st_ino, remote_dir_value.st_mode)
    if os.path.dirname(os.path.abspath(archive_path)) != remote_dir:
        fail(UNSAFE, "archive-outside-remote-directory", 73)
    if os.path.dirname(os.path.abspath(staging_path)) != remote_dir:
        fail(UNSAFE, "staging-outside-remote-directory", 73)

    destination = os.path.join(remote_dir, folder_name)
    initial_destination = lstat_optional(destination)
    initial_destination_identity = None
    initial_destination_snapshot = None
    if initial_destination is not None:
        if stat.S_ISLNK(initial_destination.st_mode):
            fail(UNSAFE, "destination-symbolic-link", 73)
        if not stat.S_ISDIR(initial_destination.st_mode):
            fail(UNSAFE, "destination-not-directory", 73)
    if not replace_existing:
        if initial_destination is not None:
            fail(CONFLICT, "destination-already-exists", 73)
    elif expected_destination_revision == "missing":
        if expected_destination_stable != "missing":
            fail(UNSAFE, "invalid-missing-revision", 73)
        if initial_destination is not None:
            fail(CHANGED, "destination-created-after-confirmation", 76)
    else:
        if not (
            valid_snapshot_token(expected_destination_revision)
            and valid_snapshot_token(expected_destination_stable)
        ):
            fail(UNSAFE, "invalid-destination-revision", 73)
        if initial_destination is None:
            fail(CHANGED, "destination-removed-after-confirmation", 76)
        initial_destination_identity = (
            initial_destination.st_dev,
            initial_destination.st_ino,
            initial_destination.st_mode,
        )

    try:
        descriptor = os.open(archive_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        archive_created = True
        with os.fdopen(descriptor, "wb", buffering=0) as output:
            transferred = 0
            while True:
                chunk = sys.stdin.buffer.read(64 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = output.write(view)
                    if written is None:
                        written = len(view)
                    if written <= 0:
                        raise OSError("remote archive accepted no data")
                    transferred += written
                    view = view[written:]
    except UploadFailure:
        raise
    except Exception as error:
        fail(WRITE_FAILED, str(error), 74)

    if transferred != expected:
        fail(SIZE_MISMATCH, "expected=" + str(expected) + " actual=" + str(transferred), 75)

    try:
        os.mkdir(staging_path, 0o700)
        staging_created = True
    except Exception as error:
        fail(EXTRACT_FAILED, "staging: " + str(error), 74)

    extract_archive(archive_path, staging_path)
    heartbeat()
    current_remote_dir = os.lstat(remote_dir)
    if (current_remote_dir.st_dev, current_remote_dir.st_ino, current_remote_dir.st_mode) != remote_dir_signature:
        fail(UNSAFE, "remote-directory-changed", 73)

    current_destination = lstat_optional(destination)
    if expected_destination_revision == "missing" or not replace_existing:
        if current_destination is not None:
            if stat.S_ISLNK(current_destination.st_mode):
                fail(UNSAFE, "destination-symbolic-link", 73)
            if not stat.S_ISDIR(current_destination.st_mode):
                fail(UNSAFE, "destination-not-directory", 73)
            if replace_existing:
                fail(CHANGED, "destination-created-during-upload", 76)
            fail(CONFLICT, "destination-already-exists", 73)
    else:
        if current_destination is None:
            fail(CHANGED, "destination-removed-during-upload", 76)
        if stat.S_ISLNK(current_destination.st_mode):
            fail(UNSAFE, "destination-symbolic-link", 73)
        if not stat.S_ISDIR(current_destination.st_mode):
            fail(UNSAFE, "destination-not-directory", 73)
        current_identity = (
            current_destination.st_dev,
            current_destination.st_ino,
            current_destination.st_mode,
        )
        if current_identity != initial_destination_identity:
            fail(CHANGED, "destination-replaced-during-upload", 76)
        try:
            current_revision, initial_destination_snapshot = directory_snapshots(destination)
        except UploadFailure:
            raise
        except OSError as error:
            fail(CHANGED, "snapshot: " + str(error), 76)
        if (
            current_revision != expected_destination_revision
            or initial_destination_snapshot != expected_destination_stable
        ):
            fail(CHANGED, "destination-content-changed-during-upload", 76)

    os.chmod(staging_path, root_mode)

    commit_phase = True
    try:
        if expected_destination_revision == "missing" or not replace_existing:
            try:
                os.mkdir(destination, 0o700)
                placeholder_created = True
                placeholder_value = os.lstat(destination)
                placeholder_signature = (placeholder_value.st_dev, placeholder_value.st_ino)
            except FileExistsError:
                raced_destination = lstat_optional(destination)
                if (
                    raced_destination is not None
                    and stat.S_ISDIR(raced_destination.st_mode)
                    and not stat.S_ISLNK(raced_destination.st_mode)
                    and not replace_existing
                ):
                    fail(CONFLICT, "destination-already-exists", 73)
                fail(CHANGED, "destination-created-during-commit", 76)
            except UploadFailure:
                raise
            except Exception as error:
                fail(COMMIT_FAILED, "reservation: " + str(error), 77)
            try:
                os.replace(staging_path, destination)
            except Exception as error:
                try:
                    os.chmod(staging_path, 0o700)
                except OSError:
                    pass
                fail(COMMIT_FAILED, str(error), 77)
            staging_created = False
            placeholder_created = False
            upload_committed = True
        else:
            staging_value = os.lstat(staging_path)
            staging_identity = (staging_value.st_dev, staging_value.st_ino, staging_value.st_mode)
            try:
                _, staging_snapshot = directory_snapshots(staging_path)
            except UploadFailure:
                raise
            except OSError as error:
                fail(COMMIT_FAILED, "staging-snapshot: " + str(error), 77)
            if not try_exchange_directories(destination, staging_path):
                fail(COMMIT_FAILED, "atomic-directory-exchange-unavailable", 77)
            staging_contains_old = True

            exchanged_destination = os.lstat(destination)
            exchanged_old = os.lstat(staging_path)
            exchanged_destination_identity = (
                exchanged_destination.st_dev,
                exchanged_destination.st_ino,
                exchanged_destination.st_mode,
            )
            exchanged_old_identity = (
                exchanged_old.st_dev,
                exchanged_old.st_ino,
                exchanged_old.st_mode,
            )
            old_changed = (
                exchanged_destination_identity != staging_identity
                or exchanged_old_identity != initial_destination_identity
            )
            if not old_changed:
                try:
                    _, exchanged_old_snapshot = directory_snapshots(staging_path)
                    old_changed = exchanged_old_snapshot != initial_destination_snapshot
                except (UploadFailure, OSError):
                    old_changed = True
            if old_changed:
                new_changed = True
                try:
                    _, exchanged_new_snapshot = directory_snapshots(destination)
                    new_changed = exchanged_new_snapshot != staging_snapshot
                except (UploadFailure, OSError):
                    pass
                if try_exchange_directories(destination, staging_path):
                    staging_contains_old = False
                    preserve_staging = new_changed
                    detail = "destination-content-changed-during-commit"
                    if preserve_staging:
                        detail += "; replacement-preserved-at=" + staging_path
                    fail(CHANGED, detail, 76)
                preserve_staging = True
                fail(
                    COMMIT_FAILED,
                    "rollback-failed; old-directory-preserved-at=" + staging_path,
                    77,
                )
            upload_committed = True
    except UploadFailure:
        raise
    except Exception as error:
        fail(COMMIT_FAILED, str(error), 77)
    finally:
        commit_phase = False

    if upload_committed and staging_contains_old:
        try:
            remove_staging(staging_path)
            staging_created = False
            staging_contains_old = False
        except OSError:
            pass
except UploadFailure as error:
    sys.exit(error.code)
except Exception as error:
    print(COMMIT_FAILED + " " + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
finally:
    commit_phase = False
    if placeholder_created and destination is not None:
        try:
            placeholder_value = os.lstat(destination)
            if (
                stat.S_ISDIR(placeholder_value.st_mode)
                and not stat.S_ISLNK(placeholder_value.st_mode)
                and (placeholder_value.st_dev, placeholder_value.st_ino) == placeholder_signature
            ):
                os.rmdir(destination)
        except OSError:
            pass
    if staging_created and not staging_contains_old and not preserve_staging:
        try:
            remove_staging(staging_path)
        except OSError:
            pass
    if upload_committed and staging_contains_old:
        try:
            remove_staging(staging_path)
        except OSError:
            pass
    if archive_created:
        try:
            os.unlink(archive_path)
        except OSError:
            pass
"#;

fn remote_upload_temp_path(remote_dir: &str) -> String {
    let name = format!(".ishell-upload-{}.tmp", uuid::Uuid::new_v4());
    if remote_dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", remote_dir.trim_end_matches('/'), name)
    }
}

fn transactional_upload_command(remote_path: &str, temp_path: &str, expected_size: u64) -> String {
    let python_command = format!(
        "python3 -c {} {} {} {expected_size}",
        openssh::shell_quote(TRANSACTIONAL_UPLOAD_SCRIPT),
        openssh::shell_quote(remote_path),
        openssh::shell_quote(temp_path),
    );
    format!("sh -c {}", openssh::shell_quote(&python_command))
}

fn remote_folder_upload_paths(remote_dir: &str) -> (String, String) {
    let token = uuid::Uuid::new_v4();
    let prefix = if remote_dir == "/" {
        String::new()
    } else {
        remote_dir.trim_end_matches('/').to_string()
    };
    (
        format!("{prefix}/.ishell-upload-{token}.tar.tmp"),
        format!("{prefix}/.ishell-upload-{token}.stage"),
    )
}

#[derive(Debug, PartialEq, Eq)]
struct RemoteFolderRevision {
    revision: String,
    rename_stable: String,
}

#[derive(Debug, PartialEq, Eq)]
enum RemoteFolderTarget {
    Missing,
    Directory(Option<RemoteFolderRevision>),
    Unsupported(String),
    Changed(String),
}

fn parse_remote_folder_target(raw: &str) -> Result<RemoteFolderTarget, String> {
    let state = raw.trim();
    if state == "missing" {
        Ok(RemoteFolderTarget::Missing)
    } else if state == "directory" {
        Ok(RemoteFolderTarget::Directory(None))
    } else if let Some(tokens) = state.strip_prefix("directory ") {
        let mut tokens = tokens.split_whitespace();
        let revision = tokens.next().unwrap_or_default();
        let rename_stable = tokens.next().unwrap_or_default();
        let valid_digest =
            |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        if tokens.next().is_some() || !valid_digest(revision) || !valid_digest(rename_stable) {
            return Err("远程目标版本令牌无效".to_string());
        }
        Ok(RemoteFolderTarget::Directory(Some(RemoteFolderRevision {
            revision: revision.to_ascii_lowercase(),
            rename_stable: rename_stable.to_ascii_lowercase(),
        })))
    } else if let Some(details) = state.strip_prefix("unsupported ") {
        Ok(RemoteFolderTarget::Unsupported(details.to_string()))
    } else if let Some(details) = state.strip_prefix("changed ") {
        Ok(RemoteFolderTarget::Changed(details.to_string()))
    } else {
        Err(format!("无法识别远程目标类型：{state}"))
    }
}

fn probe_remote_folder_target(
    app: &AppHandle,
    id: &str,
    remote_dir: &str,
    folder_name: &str,
    include_revision: bool,
) -> Result<RemoteFolderTarget, String> {
    let include_revision = if include_revision { "1" } else { "0" };
    run_remote_python(
        app,
        id,
        FOLDER_TARGET_PROBE_SCRIPT,
        &[remote_dir, folder_name, include_revision],
    )
    .and_then(|raw| parse_remote_folder_target(&raw))
}

fn folder_upload_conflict_error() -> String {
    format!("{UPLOAD_FOLDER_CONFLICT_MARKER} 目标文件夹已存在，请确认是否全量覆盖")
}

#[allow(clippy::too_many_arguments)]
fn transactional_folder_upload_command(
    remote_dir: &str,
    folder_name: &str,
    archive_path: &str,
    staging_path: &str,
    expected_size: u64,
    root_mode: u32,
    replace_existing_folder: bool,
    expected_destination_revision: &str,
    expected_destination_stable: &str,
) -> String {
    transactional_folder_upload_command_with_script(
        TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT,
        remote_dir,
        folder_name,
        archive_path,
        staging_path,
        expected_size,
        root_mode,
        replace_existing_folder,
        expected_destination_revision,
        expected_destination_stable,
    )
}

#[allow(clippy::too_many_arguments)]
fn transactional_folder_upload_command_with_script(
    script: &str,
    remote_dir: &str,
    folder_name: &str,
    archive_path: &str,
    staging_path: &str,
    expected_size: u64,
    root_mode: u32,
    replace_existing_folder: bool,
    expected_destination_revision: &str,
    expected_destination_stable: &str,
) -> String {
    let replace_existing_folder = u8::from(replace_existing_folder);
    let python_command = format!(
        "python3 -c {} {} {} {} {} {expected_size} {root_mode:o} {replace_existing_folder} {} {}",
        openssh::shell_quote(script),
        openssh::shell_quote(remote_dir),
        openssh::shell_quote(folder_name),
        openssh::shell_quote(archive_path),
        openssh::shell_quote(staging_path),
        openssh::shell_quote(expected_destination_revision),
        openssh::shell_quote(expected_destination_stable),
    );
    format!("sh -c {}", openssh::shell_quote(&python_command))
}

#[derive(Debug)]
struct PreparedFolderArchive {
    path: PathBuf,
    file: Option<fs::File>,
    size: u64,
    root_mode: u32,
}

impl PreparedFolderArchive {
    fn file_mut(&mut self) -> &mut fs::File {
        self.file.as_mut().expect("prepared archive file missing")
    }
}

impl Drop for PreparedFolderArchive {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

struct CancelReader<'a> {
    inner: fs::File,
    is_canceled: &'a dyn Fn() -> bool,
}

impl Read for CancelReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if (self.is_canceled)() {
            return Err(io::Error::other("上传已停止"));
        }
        self.inner.read(buffer)
    }
}

fn validate_archive_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("文件夹归档包含空路径".to_string());
    }
    for component in path.components() {
        match component {
            Component::Normal(value) if value.to_str().is_some() => {}
            Component::Normal(_) => return Err("文件夹包含非 UTF-8 文件名".to_string()),
            _ => return Err("文件夹包含不安全路径".to_string()),
        }
    }
    Ok(())
}

fn same_local_file_identity(first: &fs::Metadata, second: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        first.dev() == second.dev()
            && first.ino() == second.ino()
            && first.file_type() == second.file_type()
    }
    #[cfg(not(unix))]
    {
        first.file_type() == second.file_type() && first.len() == second.len()
    }
}

fn same_local_file_snapshot(first: &fs::Metadata, second: &fs::Metadata) -> bool {
    if !same_local_file_identity(first, second)
        || first.len() != second.len()
        || first.modified().ok() != second.modified().ok()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        first.mode() == second.mode()
            && first.nlink() == second.nlink()
            && first.mtime() == second.mtime()
            && first.mtime_nsec() == second.mtime_nsec()
            && first.ctime() == second.ctime()
            && first.ctime_nsec() == second.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        first.permissions().readonly() == second.permissions().readonly()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalFolderEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalFolderEntrySnapshot {
    relative_path: PathBuf,
    kind: LocalFolderEntryKind,
    len: u64,
    modified: Option<std::time::SystemTime>,
    readonly: bool,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    links: u64,
    #[cfg(unix)]
    modified_seconds: i64,
    #[cfg(unix)]
    modified_nanoseconds: i64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

fn local_folder_entry_snapshot(
    relative_path: PathBuf,
    metadata: &fs::Metadata,
) -> LocalFolderEntrySnapshot {
    let kind = if metadata.is_dir() {
        LocalFolderEntryKind::Directory
    } else {
        LocalFolderEntryKind::File
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        LocalFolderEntrySnapshot {
            relative_path,
            kind,
            len: metadata.len(),
            modified: metadata.modified().ok(),
            readonly: metadata.permissions().readonly(),
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            links: metadata.nlink(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
    #[cfg(not(unix))]
    {
        LocalFolderEntrySnapshot {
            relative_path,
            kind,
            len: metadata.len(),
            modified: metadata.modified().ok(),
            readonly: metadata.permissions().readonly(),
        }
    }
}

fn same_local_archive_identity(first: &fs::Metadata, second: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        first.dev() == second.dev() && first.ino() == second.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (first, second);
        false
    }
}

fn open_local_regular_file_no_follow(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
        .open(path)
        .map_err(|err| format!("无法安全打开本地文件：{}：{err}", path.display()))
}

fn local_directory_mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        0o755
    }
}

fn collect_local_folder_snapshot(
    root: &Path,
    directory: &Path,
    archive_path: Option<&Path>,
    archive_identity: Option<&fs::Metadata>,
    is_canceled: &dyn Fn() -> bool,
) -> Result<Vec<LocalFolderEntrySnapshot>, String> {
    let mut snapshot = Vec::new();
    collect_local_folder_snapshot_entries(
        root,
        directory,
        archive_path,
        archive_identity,
        is_canceled,
        &mut snapshot,
    )?;
    snapshot.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(snapshot)
}

fn collect_local_folder_snapshot_entries(
    root: &Path,
    directory: &Path,
    archive_path: Option<&Path>,
    archive_identity: Option<&fs::Metadata>,
    is_canceled: &dyn Fn() -> bool,
    snapshot: &mut Vec<LocalFolderEntrySnapshot>,
) -> Result<(), String> {
    if is_canceled() {
        return Err("上传已停止".to_string());
    }
    let before =
        fs::symlink_metadata(directory).map_err(|err| format!("无法读取本地文件夹：{err}"))?;
    if before.file_type().is_symlink() || !before.is_dir() {
        return Err("本地文件夹包含符号链接或目录已发生变化".to_string());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|err| format!("无法读取本地文件夹：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("无法读取本地文件夹条目：{err}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if is_canceled() {
            return Err("上传已停止".to_string());
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "本地文件夹条目越界".to_string())?;
        validate_archive_relative_path(relative)?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|err| format!("无法读取本地文件夹条目：{err}"))?;
        if archive_path.is_some_and(|archive_path| path == archive_path)
            || archive_identity.is_some_and(|archive_identity| {
                same_local_archive_identity(&metadata, archive_identity)
            })
        {
            continue;
        }
        if metadata.file_type().is_symlink() {
            return Err(format!("文件夹包含符号链接：{}", path.display()));
        }
        if metadata.is_dir() {
            collect_local_folder_snapshot_entries(
                root,
                &path,
                archive_path,
                archive_identity,
                is_canceled,
                snapshot,
            )?;
        } else if !metadata.is_file() {
            return Err(format!("文件夹包含特殊文件：{}", path.display()));
        } else {
            snapshot.push(local_folder_entry_snapshot(
                relative.to_path_buf(),
                &metadata,
            ));
        }
    }
    let after =
        fs::symlink_metadata(directory).map_err(|err| format!("无法再次检查本地文件夹：{err}"))?;
    if !same_local_file_snapshot(&before, &after) {
        return Err(format!(
            "本地文件夹遍历期间发生变化：{}",
            directory.display()
        ));
    }
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| "本地文件夹条目越界".to_string())?;
    snapshot.push(local_folder_entry_snapshot(relative.to_path_buf(), &after));
    Ok(())
}

fn append_local_folder_entries(
    builder: &mut tar::Builder<fs::File>,
    root: &Path,
    directory: &Path,
    archive_path: &Path,
    archive_identity: &fs::Metadata,
    is_canceled: &dyn Fn() -> bool,
) -> Result<(), String> {
    if is_canceled() {
        return Err("上传已停止".to_string());
    }
    let directory_metadata =
        fs::symlink_metadata(directory).map_err(|err| format!("无法读取本地文件夹：{err}"))?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err("本地文件夹包含符号链接或目录已发生变化".to_string());
    }

    let mut entries = fs::read_dir(directory)
        .map_err(|err| format!("无法读取本地文件夹：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("无法读取本地文件夹条目：{err}"))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if is_canceled() {
            return Err("上传已停止".to_string());
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "本地文件夹条目越界".to_string())?;
        validate_archive_relative_path(relative)?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|err| format!("无法读取本地文件夹条目：{err}"))?;
        if path == archive_path || same_local_archive_identity(&metadata, archive_identity) {
            continue;
        }
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(format!("文件夹包含符号链接：{}", path.display()));
        }
        if metadata.is_dir() {
            let mut header = tar::Header::new_gnu();
            header.set_metadata(&metadata);
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_cksum();
            builder
                .append_data(&mut header, relative, io::empty())
                .map_err(|err| format!("无法写入文件夹归档：{err}"))?;
            append_local_folder_entries(
                builder,
                root,
                &path,
                archive_path,
                archive_identity,
                is_canceled,
            )?;
        } else if metadata.is_file() {
            let file = open_local_regular_file_no_follow(&path)?;
            let opened_metadata = file
                .metadata()
                .map_err(|err| format!("无法读取本地文件信息：{err}"))?;
            if !opened_metadata.is_file() {
                return Err(format!("本地文件已发生变化：{}", path.display()));
            }
            if !same_local_file_identity(&metadata, &opened_metadata) {
                return Err(format!("本地文件打开期间发生变化：{}", path.display()));
            }
            let mut header = tar::Header::new_gnu();
            header.set_metadata(&opened_metadata);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(opened_metadata.len());
            header.set_cksum();
            let mut reader = CancelReader {
                inner: file,
                is_canceled,
            };
            builder
                .append_data(&mut header, relative, &mut reader)
                .map_err(|err| {
                    if is_canceled() {
                        "上传已停止".to_string()
                    } else {
                        format!("无法写入文件夹归档：{err}")
                    }
                })?;
            let after = fs::symlink_metadata(&path)
                .map_err(|err| format!("无法再次检查本地文件：{err}"))?;
            if !same_local_file_snapshot(&opened_metadata, &after) {
                return Err(format!("本地文件归档期间发生变化：{}", path.display()));
            }
        } else {
            return Err(format!("文件夹包含特殊文件：{}", path.display()));
        }
    }
    let after =
        fs::symlink_metadata(directory).map_err(|err| format!("无法再次检查本地文件夹：{err}"))?;
    if !same_local_file_snapshot(&directory_metadata, &after) {
        return Err(format!(
            "本地文件夹归档期间发生变化：{}",
            directory.display()
        ));
    }
    Ok(())
}

fn prepare_folder_archive(
    local_path: &Path,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<PreparedFolderArchive, String> {
    let metadata =
        fs::symlink_metadata(local_path).map_err(|err| format!("无法读取本地文件夹：{err}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("请选择不含符号链接的本地文件夹".to_string());
    }
    collect_local_folder_snapshot(local_path, local_path, None, None, is_canceled)?;
    let root_mode = local_directory_mode(&metadata);
    let safe_transfer_id: String = transfer_id
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || *value == '-' || *value == '_')
        .take(36)
        .collect();
    let path = std::env::temp_dir().join(format!(
        "ishell-folder-{}-{}.tar.tmp",
        if safe_transfer_id.is_empty() {
            "upload"
        } else {
            &safe_transfer_id
        },
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let output = options
        .open(&path)
        .map_err(|err| format!("无法创建本地文件夹归档：{err}"))?;
    let archive_identity = output
        .metadata()
        .map_err(|err| format!("无法读取本地文件夹归档信息：{err}"))?;
    let result = (|| -> Result<fs::File, String> {
        let initial_snapshot = collect_local_folder_snapshot(
            local_path,
            local_path,
            Some(&path),
            Some(&archive_identity),
            is_canceled,
        )?;
        let mut builder = tar::Builder::new(output);
        builder.follow_symlinks(false);
        append_local_folder_entries(
            &mut builder,
            local_path,
            local_path,
            &path,
            &archive_identity,
            is_canceled,
        )?;
        builder
            .finish()
            .map_err(|err| format!("无法完成本地文件夹归档：{err}"))?;
        let mut output = builder
            .into_inner()
            .map_err(|err| format!("无法完成本地文件夹归档：{err}"))?;
        output
            .flush()
            .map_err(|err| format!("无法刷新本地文件夹归档：{err}"))?;
        if is_canceled() {
            return Err("上传已停止".to_string());
        }
        let final_snapshot = collect_local_folder_snapshot(
            local_path,
            local_path,
            Some(&path),
            Some(&archive_identity),
            is_canceled,
        )?;
        if final_snapshot != initial_snapshot {
            return Err("本地文件夹在打包期间发生变化，请重试上传".to_string());
        }
        output
            .seek(SeekFrom::Start(0))
            .map_err(|err| format!("无法读取本地文件夹归档：{err}"))?;
        Ok(output)
    })();
    let file = match result {
        Ok(file) => file,
        Err(error) => {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
    };
    let size = file
        .metadata()
        .map_err(|err| format!("无法读取本地文件夹归档信息：{err}"))?
        .len();
    Ok(PreparedFolderArchive {
        path,
        file: Some(file),
        size,
        root_mode,
    })
}

fn humanize_upload_error_message(message: &str) -> String {
    message
        .lines()
        .filter_map(|line| {
            if line.contains(UPLOAD_HEARTBEAT_MARKER) {
                None
            } else if line.contains(UPLOAD_TARGET_DIRECTORY_MARKER) {
                Some("目标路径是目录，无法覆盖".to_string())
            } else if let Some(details) = line
                .split_once(UPLOAD_TARGET_UNSUPPORTED_MARKER)
                .map(|(_, details)| details.trim())
            {
                if details.is_empty() {
                    Some("目标不是可安全替换的普通文件".to_string())
                } else {
                    Some(format!("目标不是可安全替换的普通文件（{details}）"))
                }
            } else if line.contains(UPLOAD_TARGET_CHANGED_MARKER) {
                Some("上传期间目标文件发生变化，已取消覆盖".to_string())
            } else if let Some(details) = line
                .split_once(openssh::UPLOAD_SIZE_MISMATCH_MARKER)
                .map(|(_, details)| details.trim())
            {
                if details.is_empty() {
                    Some("上传字节数校验失败".to_string())
                } else {
                    Some(format!("上传字节数校验失败（{details}）"))
                }
            } else if let Some(details) = line
                .split_once(UPLOAD_WRITE_FAILED_MARKER)
                .map(|(_, details)| details.trim())
            {
                if details.is_empty() {
                    Some("远程临时文件写入失败".to_string())
                } else {
                    Some(format!("远程临时文件写入失败（{details}）"))
                }
            } else if let Some(details) = line
                .split_once(UPLOAD_COMMIT_FAILED_MARKER)
                .map(|(_, details)| details.trim())
            {
                if details.is_empty() {
                    Some("远程文件提交失败".to_string())
                } else {
                    Some(format!("远程文件提交失败（{details}）"))
                }
            } else if line.contains(UPLOAD_FOLDER_CONFLICT_MARKER) {
                Some(folder_upload_conflict_error())
            } else if let Some(details) = line
                .split_once(UPLOAD_FOLDER_UNSAFE_MARKER)
                .map(|(_, details)| details.trim())
            {
                Some(if details == "destination-already-exists" {
                    "目标文件夹已存在，为避免破坏现有内容，本次上传未覆盖".to_string()
                } else if details.is_empty() {
                    "文件夹包含不安全条目或远程目标不安全".to_string()
                } else {
                    format!("文件夹包含不安全条目或远程目标不安全（{details}）")
                })
            } else if let Some(details) = line
                .split_once(UPLOAD_FOLDER_EXTRACT_FAILED_MARKER)
                .map(|(_, details)| details.trim())
            {
                Some(if details.is_empty() {
                    "远程解包失败".to_string()
                } else {
                    format!("远程解包失败（{details}）")
                })
            } else if let Some(details) = line
                .split_once(UPLOAD_FOLDER_COMMIT_FAILED_MARKER)
                .map(|(_, details)| details.trim())
            {
                Some(if details.is_empty() {
                    "远程文件夹提交失败".to_string()
                } else {
                    format!("远程文件夹提交失败（{details}）")
                })
            } else if let Some(details) = line
                .split_once(UPLOAD_FOLDER_CHANGED_MARKER)
                .map(|(_, details)| details.trim())
            {
                Some(if details.is_empty() {
                    "上传期间目标文件夹发生变化，已取消覆盖".to_string()
                } else {
                    format!("上传期间目标文件夹发生变化，已取消覆盖（{details}）")
                })
            } else {
                Some(line.to_string())
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
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
    let total = local
        .metadata()
        .map_err(|err| format!("无法读取本地文件信息：{err}"))?
        .len();
    #[cfg(not(russh_backend))]
    {
        let mut retries = 0;
        loop {
            let temp_path = remote_upload_temp_path(remote_dir);
            let remote_command = transactional_upload_command(&remote_path, &temp_path, total);
            let result = openssh_upload_attempt(
                app,
                id,
                &remote_command,
                &mut local,
                total,
                transfer_id,
                is_canceled,
                true,
            );
            match result {
                Ok(()) => break,
                Err(UploadAttemptError::Canceled) => {
                    let _ = remove_remote_file(app, id, &temp_path);
                    return Err("上传已停止".to_string());
                }
                Err(err) if should_retry_upload(&err, retries, is_canceled()) => {
                    let _ = remove_remote_file(app, id, &temp_path);
                    retries += 1;
                    if let Err(seek_err) = local.seek(SeekFrom::Start(0)) {
                        return Err(format!("无法重试上传：{seek_err}"));
                    }
                }
                Err(UploadAttemptError::Failed { message, .. }) => {
                    let _ = remove_remote_file(app, id, &temp_path);
                    return Err(message);
                }
            }
        }
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        let mut retries = 0;
        loop {
            emit_progress(app, "sftp-upload-progress", transfer_id, 0, total, false);
            let mut last_emit = Instant::now();
            let mut on_progress = |transferred: u64| {
                if transferred >= total || last_emit.elapsed() >= Duration::from_millis(80) {
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
            let temp_path = remote_upload_temp_path(remote_dir);
            let remote_command = transactional_upload_command(&remote_path, &temp_path, total);
            let result = crate::russh_transport::upload(
                &server,
                secret.as_deref(),
                &remote_command,
                &mut local,
                false,
                is_canceled,
                &mut on_progress,
            );
            match result {
                Ok(()) => break,
                Err(crate::russh_transport::UploadError::Canceled) => {
                    let _ = remove_remote_file(app, id, &temp_path);
                    return Err("上传已停止".to_string());
                }
                Err(crate::russh_transport::UploadError::Failed { message, retryable }) => {
                    let err = UploadAttemptError::Failed {
                        message: format!("上传失败：{}", humanize_upload_error_message(&message)),
                        retryable,
                    };
                    if should_retry_upload(&err, retries, is_canceled()) {
                        let _ = remove_remote_file(app, id, &temp_path);
                        retries += 1;
                        if let Err(seek_err) = local.seek(SeekFrom::Start(0)) {
                            return Err(format!("无法重试上传：{seek_err}"));
                        }
                        continue;
                    }
                    let _ = remove_remote_file(app, id, &temp_path);
                    let UploadAttemptError::Failed { message, .. } = err;
                    return Err(message);
                }
            }
        }
    }

    emit_progress(app, "sftp-upload-progress", transfer_id, total, total, true);
    Ok(remote_path)
}

fn remove_remote_folder_upload_artifacts(
    app: &AppHandle,
    id: &str,
    archive_path: &str,
    staging_path: &str,
    replace_existing_folder: bool,
) {
    if replace_existing_folder {
        // A transport failure after an atomic directory exchange has an
        // uncertain commit result. The staging path may then contain the old
        // destination, so a blind rm -rf could destroy the only recoverable
        // copy. The remote transaction cleans its own artifacts whenever it
        // can determine the outcome.
        return;
    }
    let _ = run_remote_python(
        app,
        id,
        FOLDER_UPLOAD_ARTIFACT_CLEANUP_SCRIPT,
        &[archive_path, staging_path],
    );
}

#[allow(clippy::too_many_arguments)]
pub fn upload_folder(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    local_path: &str,
    remote_dir: &str,
    transfer_id: &str,
    replace_existing_folder: bool,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let local_root = Path::new(local_path);
    let folder_name = local_root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .ok_or_else(|| "无效的本地文件夹名称".to_string())?
        .to_string();
    let remote_path = if remote_dir == "/" {
        format!("/{folder_name}")
    } else {
        format!("{}/{}", remote_dir.trim_end_matches('/'), folder_name)
    };
    if is_canceled() {
        return Err("上传已停止".to_string());
    }
    let (expected_destination_revision, expected_destination_stable) =
        match probe_remote_folder_target(
            app,
            id,
            remote_dir,
            &folder_name,
            replace_existing_folder,
        )? {
            RemoteFolderTarget::Missing if replace_existing_folder => {
                ("missing".to_string(), "missing".to_string())
            }
            RemoteFolderTarget::Missing => ("unchecked".to_string(), "unchecked".to_string()),
            RemoteFolderTarget::Directory(_) if !replace_existing_folder => {
                return Err(folder_upload_conflict_error());
            }
            RemoteFolderTarget::Directory(Some(revision)) => {
                (revision.revision, revision.rename_stable)
            }
            RemoteFolderTarget::Directory(None) => {
                return Err("远程目标版本预检未返回版本令牌，请重试上传".to_string());
            }
            RemoteFolderTarget::Unsupported(details) => {
                return Err(format!("远程目标不是可安全覆盖的文件夹（{details}）"));
            }
            RemoteFolderTarget::Changed(details) => {
                return Err(format!(
                    "远程目标在覆盖预检期间发生变化，请重试（{details}）"
                ));
            }
        };
    if is_canceled() {
        return Err("上传已停止".to_string());
    }
    emit_progress(app, "sftp-upload-progress", transfer_id, 0, 0, false);
    let mut archive = prepare_folder_archive(local_root, transfer_id, is_canceled)?;
    let total = archive.size;

    #[cfg(not(russh_backend))]
    {
        let mut retries = 0;
        loop {
            let (archive_path, staging_path) = remote_folder_upload_paths(remote_dir);
            let remote_command = transactional_folder_upload_command(
                remote_dir,
                &folder_name,
                &archive_path,
                &staging_path,
                total,
                archive.root_mode,
                replace_existing_folder,
                &expected_destination_revision,
                &expected_destination_stable,
            );
            let result = openssh_upload_attempt(
                app,
                id,
                &remote_command,
                archive.file_mut(),
                total,
                transfer_id,
                is_canceled,
                !replace_existing_folder,
            );
            match result {
                Ok(()) => break,
                Err(UploadAttemptError::Canceled) => {
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    return Err("上传已停止".to_string());
                }
                Err(error)
                    if !replace_existing_folder
                        && should_retry_upload(&error, retries, is_canceled()) =>
                {
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    retries += 1;
                    archive
                        .file_mut()
                        .seek(SeekFrom::Start(0))
                        .map_err(|err| format!("无法重试文件夹上传：{err}"))?;
                }
                Err(UploadAttemptError::Failed { message, .. }) => {
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    return Err(message);
                }
            }
        }
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        let mut retries = 0;
        loop {
            emit_progress(app, "sftp-upload-progress", transfer_id, 0, total, false);
            let mut last_emit = Instant::now();
            let mut on_progress = |transferred: u64| {
                if transferred >= total || last_emit.elapsed() >= Duration::from_millis(80) {
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
            let (archive_path, staging_path) = remote_folder_upload_paths(remote_dir);
            let remote_command = transactional_folder_upload_command(
                remote_dir,
                &folder_name,
                &archive_path,
                &staging_path,
                total,
                archive.root_mode,
                replace_existing_folder,
                &expected_destination_revision,
                &expected_destination_stable,
            );
            let result = crate::russh_transport::upload(
                &server,
                secret.as_deref(),
                &remote_command,
                archive.file_mut(),
                replace_existing_folder,
                is_canceled,
                &mut on_progress,
            );
            match result {
                Ok(()) => break,
                Err(crate::russh_transport::UploadError::Canceled) => {
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    return Err("上传已停止".to_string());
                }
                Err(crate::russh_transport::UploadError::Failed { message, retryable }) => {
                    let error = UploadAttemptError::Failed {
                        message: format!("上传失败：{}", humanize_upload_error_message(&message)),
                        retryable,
                    };
                    if !replace_existing_folder
                        && should_retry_upload(&error, retries, is_canceled())
                    {
                        remove_remote_folder_upload_artifacts(
                            app,
                            id,
                            &archive_path,
                            &staging_path,
                            replace_existing_folder,
                        );
                        retries += 1;
                        archive
                            .file_mut()
                            .seek(SeekFrom::Start(0))
                            .map_err(|err| format!("无法重试文件夹上传：{err}"))?;
                        continue;
                    }
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    let UploadAttemptError::Failed { message, .. } = error;
                    return Err(message);
                }
            }
        }
    }

    emit_progress(app, "sftp-upload-progress", transfer_id, total, total, true);
    Ok(remote_path)
}

#[derive(Debug)]
enum UploadAttemptError {
    #[cfg(not(russh_backend))]
    Canceled,
    Failed {
        message: String,
        retryable: bool,
    },
}

fn should_retry_upload(error: &UploadAttemptError, retries: usize, is_canceled: bool) -> bool {
    retries == 0
        && !is_canceled
        && matches!(
            error,
            UploadAttemptError::Failed {
                retryable: true,
                ..
            }
        )
}

#[cfg(not(russh_backend))]
#[allow(clippy::too_many_arguments)]
fn openssh_upload_attempt(
    app: &AppHandle,
    id: &str,
    remote_command: &str,
    local: &mut fs::File,
    total: u64,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
    cancel_while_waiting: bool,
) -> Result<(), UploadAttemptError> {
    let (mut child, helper_path) =
        spawn_remote_ex(app, id, remote_command, true, false, true, false).map_err(|message| {
            UploadAttemptError::Failed {
                message: format!("上传失败：{message}"),
                retryable: false,
            }
        })?;

    let stderr_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut output = Vec::new();
            stderr.read_to_end(&mut output)?;
            Ok::<Vec<u8>, io::Error>(output)
        })
    });

    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = join_stderr_reader(stderr_reader);
            cleanup_askpass_helper(helper_path.as_ref());
            return Err(UploadAttemptError::Failed {
                message: "上传失败：无法写入 OpenSSH 上传输入".to_string(),
                retryable: false,
            });
        }
    };
    let progress = ProgressConfig::new(
        app,
        total,
        transfer_id,
        "sftp-upload-progress",
        "上传已停止",
        is_canceled,
    );
    let copy_result = copy_upload_with_progress(local, &mut stdin, progress);
    drop(stdin);

    if matches!(
        &copy_result,
        Err(UploadCopyError::Canceled | UploadCopyError::Read { .. })
    ) {
        let _ = child.kill();
    }
    let mut canceled_while_waiting = false;
    let status = loop {
        if cancel_while_waiting && is_canceled() {
            canceled_while_waiting = true;
            let _ = child.kill();
            break child.wait();
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => break Err(error),
        }
    };
    if status.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let stderr = join_stderr_reader(stderr_reader);
    cleanup_askpass_helper(helper_path.as_ref());

    let status = match status {
        Ok(status) => status,
        Err(wait_error) => {
            let fallback = copy_result
                .as_ref()
                .err()
                .map(UploadCopyError::description)
                .unwrap_or_else(|| "OpenSSH 上传进程提前结束".to_string());
            return Err(UploadAttemptError::Failed {
                message: format!("上传失败：{fallback}；等待 OpenSSH 上传结束失败：{wait_error}"),
                retryable: copy_result
                    .as_ref()
                    .err()
                    .is_some_and(upload_copy_is_connection_error),
            });
        }
    };
    let stderr =
        stderr.unwrap_or_else(|error| format!("无法读取 OpenSSH 错误输出：{error}").into_bytes());

    if canceled_while_waiting {
        return Err(UploadAttemptError::Canceled);
    }

    match copy_result {
        Err(UploadCopyError::Canceled) => Err(UploadAttemptError::Canceled),
        Err(error) => {
            let retryable = openssh_upload_is_retryable(&status, &stderr, Some(&error));
            Err(UploadAttemptError::Failed {
                message: format_upload_attempt_failure(&status, &stderr, &error.description()),
                retryable,
            })
        }
        Ok(_) if !status.success() => Err(UploadAttemptError::Failed {
            message: format_upload_attempt_failure(&status, &stderr, "OpenSSH 上传进程提前退出"),
            retryable: openssh_upload_is_retryable(&status, &stderr, None),
        }),
        Ok(_) => Ok(()),
    }
}

#[cfg(not(russh_backend))]
fn join_stderr_reader(
    reader: Option<std::thread::JoinHandle<io::Result<Vec<u8>>>>,
) -> Result<Vec<u8>, String> {
    match reader {
        Some(reader) => reader
            .join()
            .map_err(|_| "OpenSSH 错误输出线程异常退出".to_string())?
            .map_err(|error| error.to_string()),
        None => Ok(Vec::new()),
    }
}

#[cfg(not(russh_backend))]
fn upload_copy_is_connection_error(error: &UploadCopyError) -> bool {
    matches!(
        error,
        UploadCopyError::Write { error, .. }
            if matches!(
                error.kind(),
                io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::NotConnected
                    | io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::TimedOut
            )
    )
}

#[cfg(not(russh_backend))]
fn openssh_upload_is_retryable(
    status: &std::process::ExitStatus,
    stderr: &[u8],
    copy_error: Option<&UploadCopyError>,
) -> bool {
    if matches!(copy_error, Some(UploadCopyError::Read { .. })) {
        return false;
    }
    let stderr = String::from_utf8_lossy(stderr);
    if stderr.contains(openssh::UPLOAD_SIZE_MISMATCH_MARKER) {
        return true;
    }
    let normalized = stderr.to_ascii_lowercase();
    let permanent_ssh_error = [
        "permission denied",
        "remote host identification has changed",
        "host key verification failed",
        "could not resolve hostname",
        "hostname contains invalid characters",
        "bad configuration option",
        "no such identity",
        "identity file",
        "load key",
        "invalid format",
        "no supported authentication methods",
        "too many authentication failures",
        "unable to negotiate",
    ]
    .iter()
    .any(|needle| normalized.contains(needle));
    if permanent_ssh_error {
        return false;
    }
    if status.code() == Some(255) {
        return true;
    }
    if status.code().is_some() && !status.success() {
        return false;
    }
    copy_error.is_some_and(upload_copy_is_connection_error)
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
#[derive(Debug)]
enum UploadCopyError {
    Canceled,
    Read { error: io::Error },
    Write { error: io::Error },
}

#[cfg(not(russh_backend))]
impl UploadCopyError {
    fn description(&self) -> String {
        match self {
            Self::Canceled => "上传已停止".to_string(),
            Self::Read { error, .. } => format!("读取本地文件失败：{error}"),
            Self::Write { error, .. } => format!("写入 OpenSSH 上传输入失败：{error}"),
        }
    }
}

/// Upload-specific copy loop that records exact progress and distinguishes local
/// read failures from connection-oriented child-stdin failures.
#[cfg(not(russh_backend))]
fn copy_upload_stream(
    reader: &mut impl Read,
    writer: &mut impl Write,
    is_canceled: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(u64),
) -> Result<u64, UploadCopyError> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut transferred = 0_u64;

    loop {
        if is_canceled() {
            return Err(UploadCopyError::Canceled);
        }
        let read = loop {
            match reader.read(&mut buffer) {
                Ok(read) => break read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(UploadCopyError::Read { error }),
            }
        };
        if read == 0 {
            return Ok(transferred);
        }

        let mut offset = 0;
        while offset < read {
            if is_canceled() {
                return Err(UploadCopyError::Canceled);
            }
            match writer.write(&buffer[offset..read]) {
                Ok(0) => {
                    return Err(UploadCopyError::Write {
                        error: io::Error::new(
                            io::ErrorKind::WriteZero,
                            "OpenSSH 上传输入未接受数据",
                        ),
                    });
                }
                Ok(written) => {
                    offset += written;
                    transferred += written as u64;
                    on_progress(transferred);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(UploadCopyError::Write { error }),
            }
        }
    }
}

#[cfg(not(russh_backend))]
fn copy_upload_with_progress(
    reader: &mut impl Read,
    writer: &mut impl Write,
    progress: ProgressConfig<'_>,
) -> Result<u64, UploadCopyError> {
    let mut last_emit = Instant::now();
    emit_progress(
        progress.app,
        progress.event_name,
        progress.transfer_id,
        0,
        progress.total,
        false,
    );
    let mut on_progress = |transferred: u64| {
        if transferred >= progress.total || last_emit.elapsed() >= Duration::from_millis(80) {
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
    };
    copy_upload_stream(reader, writer, progress.is_canceled, &mut on_progress)
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
    if content.len() as u64 > MAX_TEXT_EDIT_BYTES {
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
    spawn_remote_ex(
        app,
        id,
        remote_command,
        stdin_piped,
        stdout_piped,
        stderr_piped,
        true,
    )
}

/// Like `spawn_remote`, but lets the caller opt out of `ControlMaster` reuse
/// (`multiplex = false`) so the connection doesn't share a socket with the
/// terminal or other commands. Used for bulk downloads.
#[cfg(not(russh_backend))]
fn spawn_remote_ex(
    app: &AppHandle,
    id: &str,
    remote_command: &str,
    stdin_piped: bool,
    stdout_piped: bool,
    stderr_piped: bool,
    multiplex: bool,
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
    for arg in openssh::common_ssh_args(&server, multiplex) {
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
    let slug: String = id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(32)
        .collect();
    let slug = if slug.is_empty() { "server" } else { &slug };

    for _ in 0..4 {
        let path = std::env::temp_dir().join(format!(
            "ishell-ssh-askpass-{slug}-{}.sh",
            uuid::Uuid::new_v4()
        ));
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("无法创建 SSH_ASKPASS helper：{err}")),
        };
        if let Err(err) = file.write_all(b"#!/bin/sh\nprintf '%s\\n' \"$ISHELL_SSH_PASSWORD\"\n") {
            let _ = fs::remove_file(&path);
            return Err(format!("无法写入 SSH_ASKPASS helper：{err}"));
        }
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = fs::Permissions::from_mode(0o700);
            if let Err(err) = fs::set_permissions(&path, permissions) {
                let _ = fs::remove_file(&path);
                return Err(format!("无法设置 SSH_ASKPASS helper 权限：{err}"));
            }
        }
        return Ok(path);
    }

    Err("无法创建唯一的 SSH_ASKPASS helper".to_string())
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

#[cfg(not(russh_backend))]
fn format_upload_attempt_failure(
    status: &std::process::ExitStatus,
    stderr: &[u8],
    fallback: &str,
) -> String {
    let stderr = humanize_upload_error_message(String::from_utf8_lossy(stderr).trim());
    if !stderr.is_empty() {
        format!("上传失败：{stderr}")
    } else if !status.success() {
        format!("上传失败（OpenSSH {status}）：{fallback}")
    } else {
        format!("上传失败：{fallback}")
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

#[cfg(test)]
mod tests {
    #[cfg(not(russh_backend))]
    use super::{
        cleanup_askpass_helper, copy_upload_stream, create_askpass_helper,
        format_upload_attempt_failure, humanize_upload_error_message, openssh_upload_is_retryable,
        parse_remote_folder_target, remote_folder_upload_paths,
        transactional_folder_upload_command, transactional_folder_upload_command_with_script,
        PreparedFolderArchive, RemoteFolderTarget, UploadCopyError, FOLDER_TARGET_PROBE_SCRIPT,
        TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT, UPLOAD_FOLDER_CHANGED_MARKER,
        UPLOAD_FOLDER_CONFLICT_MARKER, UPLOAD_FOLDER_UNSAFE_MARKER,
        UPLOAD_TARGET_UNSUPPORTED_MARKER,
    };
    use super::{
        prepare_folder_archive, remote_basename, remote_parent, remote_upload_temp_path,
        sanitize_archive_for_windows, sanitize_windows_file_name, should_retry_upload,
        transactional_upload_command, CancelReader, UploadAttemptError,
    };
    #[cfg(not(russh_backend))]
    use crate::openssh;
    #[cfg(not(russh_backend))]
    use std::io::{self, Write};
    #[cfg(not(russh_backend))]
    use std::path::Path;
    #[cfg(not(russh_backend))]
    use std::process::Stdio;
    use std::{fs, io::Cursor, io::Seek, path::PathBuf};
    use uuid::Uuid;

    #[cfg(not(russh_backend))]
    struct BrokenPipeWriter {
        bytes_before_failure: usize,
        written: usize,
    }

    #[cfg(not(russh_backend))]
    impl Write for BrokenPipeWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if self.written >= self.bytes_before_failure {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"));
            }
            let written = buffer.len().min(self.bytes_before_failure - self.written);
            self.written += written;
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn remote_paths_always_use_posix_separators() {
        assert_eq!(remote_basename("/tmp/a\\b.txt"), Some("a\\b.txt"));
        assert_eq!(remote_parent("/tmp/a\\b.txt"), "/tmp");
    }

    #[test]
    fn retries_only_one_transactional_connection_failure() {
        let retryable = UploadAttemptError::Failed {
            message: "connection closed".to_string(),
            retryable: true,
        };
        assert!(should_retry_upload(&retryable, 0, false));
        assert!(!should_retry_upload(&retryable, 1, false));
        assert!(!should_retry_upload(&retryable, 0, true));

        let partial = UploadAttemptError::Failed {
            message: "connection closed".to_string(),
            retryable: true,
        };
        assert!(should_retry_upload(&partial, 0, false));

        let local_read_failure = UploadAttemptError::Failed {
            message: "local read failed".to_string(),
            retryable: false,
        };
        assert!(!should_retry_upload(&local_read_failure, 0, false));
    }

    #[test]
    fn transactional_upload_uses_unique_same_directory_temp_and_atomic_commit() {
        let first = remote_upload_temp_path("/srv/files");
        let second = remote_upload_temp_path("/srv/files");
        assert_ne!(first, second);
        assert!(first.starts_with("/srv/files/.ishell-upload-"));
        assert!(second.starts_with("/srv/files/.ishell-upload-"));

        let command = transactional_upload_command("/srv/files/final.bin", &first, 123);
        assert!(command.starts_with("sh -c "));
        assert!(command.contains("python3 -c"));
        assert!(command.contains(" 123"));
        assert!(command.contains("__ISHELL_UPLOAD_TARGET_IS_DIRECTORY__"));
        assert!(command.contains("__ISHELL_UPLOAD_SIZE_MISMATCH__"));
        assert!(command.contains("os.replace"));
        assert!(command.contains("os.unlink"));
    }

    #[test]
    fn prepares_retryable_folder_archive_without_root_wrapper() {
        let root = std::env::temp_dir().join(format!("ishell-folder-test-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("nested/empty")).unwrap();
        fs::write(root.join("alpha.txt"), b"alpha").unwrap();
        fs::write(root.join("nested/beta.txt"), b"beta").unwrap();
        let mut prepared = prepare_folder_archive(&root, "folder-test", &|| false).unwrap();
        let archive_path = prepared.path.clone();
        let mut input = prepared.file_mut().try_clone().unwrap();
        input.seek(std::io::SeekFrom::Start(0)).unwrap();
        let mut archive = tar::Archive::new(input);
        let mut paths = archive
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().into_owned())
            .collect::<Vec<_>>();
        paths.sort();
        assert!(paths.contains(&PathBuf::from("alpha.txt")));
        assert!(paths.contains(&PathBuf::from("nested")));
        assert!(paths.contains(&PathBuf::from("nested/beta.txt")));
        assert!(!paths
            .iter()
            .any(|path| path.starts_with(root.file_name().unwrap())));
        drop(archive);
        drop(prepared);
        assert!(!archive_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_archive_rejects_source_changes_after_its_temp_file_is_created() {
        let root = std::env::temp_dir().join(format!("ishell-folder-mutation-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("seed.txt"), b"seed").unwrap();
        let transfer_id = format!(
            "mutate-{}",
            Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        );
        let archive_prefix = format!("ishell-folder-{transfer_id}-");
        let callbacks_after_archive = std::cell::Cell::new(0_u32);
        let injected = std::cell::Cell::new(false);
        let is_canceled = || {
            let archive_exists = fs::read_dir(std::env::temp_dir())
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(&archive_prefix)
                });
            if archive_exists && !injected.get() {
                let count = callbacks_after_archive.get() + 1;
                callbacks_after_archive.set(count);
                if count == 3 {
                    fs::write(root.join("concurrent.txt"), b"concurrent").unwrap();
                    injected.set(true);
                }
            }
            false
        };

        let error = prepare_folder_archive(&root, &transfer_id, &is_canceled).unwrap_err();
        assert!(injected.get());
        assert!(error.contains("打包期间发生变化"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_packaging_cancel_error_is_not_retried_as_interrupted_io() {
        let path = std::env::temp_dir().join(format!("ishell-cancel-reader-{}", Uuid::new_v4()));
        fs::write(&path, b"data").unwrap();
        let file = fs::File::open(&path).unwrap();
        let mut reader = CancelReader {
            inner: file,
            is_canceled: &|| true,
        };
        let error = std::io::Read::read(&mut reader, &mut [0_u8; 4]).unwrap_err();
        assert_ne!(error.kind(), std::io::ErrorKind::Interrupted);
        fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn folder_archive_rejects_symlinks_and_special_files() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;

        let root = PathBuf::from("/tmp").join(format!(
            "ifu-{}",
            Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("target"), b"data").unwrap();
        symlink(root.join("target"), root.join("link")).unwrap();
        assert!(prepare_folder_archive(&root, "unsafe", &|| false)
            .unwrap_err()
            .contains("符号链接"));
        fs::remove_file(root.join("link")).unwrap();
        let _socket = UnixListener::bind(root.join("socket")).unwrap();
        assert!(prepare_folder_archive(&root, "unsafe", &|| false)
            .unwrap_err()
            .contains("特殊文件"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(russh_backend))]
    fn run_folder_upload_script(
        prepared: &mut PreparedFolderArchive,
        remote: &Path,
        folder_name: &str,
        replace_existing_folder: bool,
        expected_size: u64,
    ) -> (std::process::Output, String, String) {
        run_folder_upload_script_with_source(
            prepared,
            remote,
            folder_name,
            replace_existing_folder,
            expected_size,
            TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT,
        )
    }

    #[cfg(not(russh_backend))]
    fn run_folder_upload_script_with_source(
        prepared: &mut PreparedFolderArchive,
        remote: &Path,
        folder_name: &str,
        replace_existing_folder: bool,
        expected_size: u64,
        script: &str,
    ) -> (std::process::Output, String, String) {
        let (archive_path, staging_path) = remote_folder_upload_paths(remote.to_str().unwrap());
        let (expected_revision, expected_stable) =
            folder_revision_tokens_for_test(remote, folder_name, replace_existing_folder);
        let command = transactional_folder_upload_command_with_script(
            script,
            remote.to_str().unwrap(),
            folder_name,
            &archive_path,
            &staging_path,
            expected_size,
            prepared.root_mode,
            replace_existing_folder,
            &expected_revision,
            &expected_stable,
        );
        let mut input = prepared.file_mut().try_clone().unwrap();
        input.seek(std::io::SeekFrom::Start(0)).unwrap();
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .stdin(Stdio::from(input))
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        (output, archive_path, staging_path)
    }

    #[cfg(not(russh_backend))]
    fn folder_revision_tokens_for_test(
        remote: &Path,
        folder_name: &str,
        replace_existing_folder: bool,
    ) -> (String, String) {
        if !replace_existing_folder {
            return ("unchecked".to_string(), "unchecked".to_string());
        }
        let target = remote.join(folder_name);
        let Ok(metadata) = fs::symlink_metadata(&target) else {
            return ("missing".to_string(), "missing".to_string());
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return ("missing".to_string(), "missing".to_string());
        }
        let output = std::process::Command::new("python3")
            .args([
                "-c",
                FOLDER_TARGET_PROBE_SCRIPT,
                remote.to_str().unwrap(),
                folder_name,
                "1",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        match parse_remote_folder_target(&String::from_utf8(output.stdout).unwrap()).unwrap() {
            RemoteFolderTarget::Directory(Some(revision)) => {
                (revision.revision, revision.rename_stable)
            }
            other => panic!("unexpected folder probe result: {other:?}"),
        }
    }

    #[cfg(not(russh_backend))]
    fn assert_folder_upload_artifacts_removed(archive_path: &str, staging_path: &str) {
        assert!(!Path::new(archive_path).exists());
        assert!(!Path::new(staging_path).exists());
        assert!(!Path::new(&format!("{staging_path}.backup")).exists());
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_upload_conflict_preserves_old_then_confirmed_replace_is_full() {
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-remote-{}", Uuid::new_v4()));
        let local = sandbox.join("source-folder");
        let remote = sandbox.join("remote");
        fs::create_dir_all(local.join("nested")).unwrap();
        fs::create_dir_all(&remote).unwrap();
        fs::write(local.join("nested/file.txt"), b"folder-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "remote-test", &|| false).unwrap();
        let destination = remote.join("source-folder");
        fs::create_dir_all(destination.join("old-only")).unwrap();
        fs::write(destination.join("keep.txt"), b"old-data").unwrap();
        fs::write(destination.join("old-only/remote.txt"), b"remote-only").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("keep.txt", destination.join("old-link")).unwrap();

        let expected_size = prepared.size;
        let (conflict, conflict_archive, conflict_staging) = run_folder_upload_script(
            &mut prepared,
            &remote,
            "source-folder",
            false,
            expected_size,
        );
        assert!(!conflict.status.success());
        assert!(String::from_utf8_lossy(&conflict.stderr).contains(UPLOAD_FOLDER_CONFLICT_MARKER));
        assert_eq!(fs::read(destination.join("keep.txt")).unwrap(), b"old-data");
        assert_folder_upload_artifacts_removed(&conflict_archive, &conflict_staging);

        let (output, archive_path, staging_path) =
            run_folder_upload_script(&mut prepared, &remote, "source-folder", true, expected_size);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read(destination.join("nested/file.txt")).unwrap(),
            b"folder-data"
        );
        assert!(!destination.join("keep.txt").exists());
        assert!(!destination.join("old-only").exists());
        assert!(!destination.join("old-link").exists());
        assert_folder_upload_artifacts_removed(&archive_path, &staging_path);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_replace_rolls_back_if_old_changes_during_atomic_commit() {
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-rollback-{}", Uuid::new_v4()));
        let local = sandbox.join("source-folder");
        let remote = sandbox.join("remote");
        let destination = remote.join("source-folder");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(local.join("new.txt"), b"new-data").unwrap();
        fs::write(destination.join("old.txt"), b"old-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "rollback-test", &|| false).unwrap();
        let expected_size = prepared.size;

        let exchange_marker =
            "            staging_contains_old = True\n\n            exchanged_destination";
        let injected_exchange = "            staging_contains_old = True\n            with open(os.path.join(staging_path, \"concurrent.txt\"), \"wb\") as changed:\n                changed.write(b\"concurrent\")\n\n            exchanged_destination";
        let rollback_script =
            TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.replacen(exchange_marker, injected_exchange, 1);
        assert_ne!(rollback_script, TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT);

        let (output, archive_path, staging_path) = run_folder_upload_script_with_source(
            &mut prepared,
            &remote,
            "source-folder",
            true,
            expected_size,
            &rollback_script,
        );
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(UPLOAD_FOLDER_CHANGED_MARKER));
        assert_eq!(fs::read(destination.join("old.txt")).unwrap(), b"old-data");
        assert_eq!(
            fs::read(destination.join("concurrent.txt")).unwrap(),
            b"concurrent"
        );
        assert!(!destination.join("new.txt").exists());
        assert_folder_upload_artifacts_removed(&archive_path, &staging_path);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_upload_does_not_overwrite_destination_created_during_transfer() {
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-race-{}", Uuid::new_v4()));
        let local = sandbox.join("raced-folder");
        let remote = sandbox.join("remote");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&remote).unwrap();
        fs::write(local.join("new.txt"), b"new-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "race-test", &|| false).unwrap();
        let (archive_path, staging_path) = remote_folder_upload_paths(remote.to_str().unwrap());
        let command = transactional_folder_upload_command(
            remote.to_str().unwrap(),
            "raced-folder",
            &archive_path,
            &staging_path,
            prepared.size,
            prepared.root_mode,
            false,
            "unchecked",
            "unchecked",
        );
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        for _ in 0..500 {
            if Path::new(&archive_path).exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !Path::new(&archive_path).exists() {
            drop(child.stdin.take());
            let output = child.wait_with_output().unwrap();
            panic!(
                "remote archive was not created: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let destination = remote.join("raced-folder");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep.txt"), b"concurrent").unwrap();
        let mut input = prepared.file_mut().try_clone().unwrap();
        input.seek(std::io::SeekFrom::Start(0)).unwrap();
        std::io::copy(&mut input, &mut child.stdin.take().unwrap()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(UPLOAD_FOLDER_CONFLICT_MARKER));
        assert_eq!(
            fs::read(destination.join("keep.txt")).unwrap(),
            b"concurrent"
        );
        assert!(!destination.join("new.txt").exists());
        assert_folder_upload_artifacts_removed(&archive_path, &staging_path);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_replace_rejects_remote_changes_while_archive_is_in_flight() {
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-revision-race-{}", Uuid::new_v4()));
        let local = sandbox.join("source-folder");
        let remote = sandbox.join("remote");
        let destination = remote.join("source-folder");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(local.join("new.txt"), b"new-data").unwrap();
        fs::write(destination.join("old.txt"), b"old-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "revision-race-test", &|| false).unwrap();
        let (expected_revision, expected_stable) =
            folder_revision_tokens_for_test(&remote, "source-folder", true);
        let (archive_path, staging_path) = remote_folder_upload_paths(remote.to_str().unwrap());
        let command = transactional_folder_upload_command(
            remote.to_str().unwrap(),
            "source-folder",
            &archive_path,
            &staging_path,
            prepared.size,
            prepared.root_mode,
            true,
            &expected_revision,
            &expected_stable,
        );
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        for _ in 0..500 {
            if Path::new(&archive_path).exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !Path::new(&archive_path).exists() {
            drop(child.stdin.take());
            let output = child.wait_with_output().unwrap();
            panic!(
                "remote archive was not created: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        fs::write(destination.join("concurrent.txt"), b"concurrent").unwrap();
        let mut input = prepared.file_mut().try_clone().unwrap();
        input.seek(std::io::SeekFrom::Start(0)).unwrap();
        std::io::copy(&mut input, &mut child.stdin.take().unwrap()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(UPLOAD_FOLDER_CHANGED_MARKER));
        assert_eq!(fs::read(destination.join("old.txt")).unwrap(), b"old-data");
        assert_eq!(
            fs::read(destination.join("concurrent.txt")).unwrap(),
            b"concurrent"
        );
        assert!(!destination.join("new.txt").exists());
        assert_folder_upload_artifacts_removed(&archive_path, &staging_path);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_upload_script_refuses_to_cross_mount_points() {
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("destination-is-mount-point"));
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("destination-contains-mount-point"));
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("refusing to remove mounted directory"));
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("os.path.ismount"));
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("/proc/self/mountinfo"));
    }

    #[cfg(all(not(russh_backend), unix))]
    #[test]
    fn folder_replace_failure_preserves_old_and_special_targets_are_rejected() {
        use std::os::unix::fs::symlink;

        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-failure-{}", Uuid::new_v4()));
        let local = sandbox.join("source-folder");
        let remote = sandbox.join("remote");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&remote).unwrap();
        fs::write(local.join("new.txt"), b"new-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "failure-test", &|| false).unwrap();

        let destination = remote.join("source-folder");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("old.txt"), b"old-data").unwrap();
        let wrong_size = prepared.size + 1;
        let (failed, failed_archive, failed_staging) =
            run_folder_upload_script(&mut prepared, &remote, "source-folder", true, wrong_size);
        assert!(!failed.status.success());
        assert_eq!(fs::read(destination.join("old.txt")).unwrap(), b"old-data");
        assert!(!destination.join("new.txt").exists());
        assert_folder_upload_artifacts_removed(&failed_archive, &failed_staging);

        let file_target = remote.join("file-target");
        fs::write(&file_target, b"file-data").unwrap();
        let expected_size = prepared.size;
        let (file_result, file_archive, file_staging) =
            run_folder_upload_script(&mut prepared, &remote, "file-target", true, expected_size);
        assert!(!file_result.status.success());
        assert!(String::from_utf8_lossy(&file_result.stderr).contains(UPLOAD_FOLDER_UNSAFE_MARKER));
        assert_eq!(fs::read(&file_target).unwrap(), b"file-data");
        assert_folder_upload_artifacts_removed(&file_archive, &file_staging);

        let link_target = remote.join("link-target-data");
        let link_path = remote.join("link-target");
        fs::create_dir(&link_target).unwrap();
        fs::write(link_target.join("old.txt"), b"linked-old").unwrap();
        symlink(&link_target, &link_path).unwrap();
        let (link_result, link_archive, link_staging) =
            run_folder_upload_script(&mut prepared, &remote, "link-target", true, expected_size);
        assert!(!link_result.status.success());
        assert!(String::from_utf8_lossy(&link_result.stderr).contains(UPLOAD_FOLDER_UNSAFE_MARKER));
        assert!(fs::symlink_metadata(&link_path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read(link_target.join("old.txt")).unwrap(),
            b"linked-old"
        );
        assert_folder_upload_artifacts_removed(&link_archive, &link_staging);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn transactional_upload_preserves_final_on_mismatch_and_replaces_on_success() {
        let root = std::env::temp_dir().join(format!("ishell-upload-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("final 'quoted name.bin");
        fs::write(&final_path, b"original").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&final_path, fs::Permissions::from_mode(0o751)).unwrap();
        }

        let failed_temp = root.join("failed 'quoted.tmp");
        let failed_command = transactional_upload_command(
            final_path.to_str().unwrap(),
            failed_temp.to_str().unwrap(),
            10,
        );
        let mut failed_child = std::process::Command::new("/bin/sh")
            .args(["-c", &failed_command])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        failed_child
            .stdin
            .take()
            .unwrap()
            .write_all(b"short")
            .unwrap();
        let failed_output = failed_child.wait_with_output().unwrap();
        assert!(!failed_output.status.success());
        assert!(String::from_utf8_lossy(&failed_output.stderr)
            .contains(openssh::UPLOAD_SIZE_MISMATCH_MARKER));
        assert_eq!(fs::read(&final_path).unwrap(), b"original");
        assert!(!failed_temp.exists());

        let replacement = b"replacement";
        let success_temp = root.join("success 'quoted.tmp");
        let success_command = transactional_upload_command(
            final_path.to_str().unwrap(),
            success_temp.to_str().unwrap(),
            replacement.len() as u64,
        );
        let mut success_child = std::process::Command::new("/bin/sh")
            .args(["-c", &success_command])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        success_child
            .stdin
            .take()
            .unwrap()
            .write_all(replacement)
            .unwrap();
        let success_output = success_child.wait_with_output().unwrap();
        assert!(
            success_output.status.success(),
            "{}",
            String::from_utf8_lossy(&success_output.stderr)
        );
        assert_eq!(fs::read(&final_path).unwrap(), replacement);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&final_path).unwrap().permissions().mode() & 0o777,
                0o751
            );
        }
        assert!(!success_temp.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let symlink_target = root.join("symlink-target.bin");
            let symlink_path = root.join("symlink-upload.bin");
            let symlink_temp = root.join("symlink-upload.tmp");
            fs::write(&symlink_target, b"linked-original").unwrap();
            symlink(&symlink_target, &symlink_path).unwrap();
            let symlink_command = transactional_upload_command(
                symlink_path.to_str().unwrap(),
                symlink_temp.to_str().unwrap(),
                replacement.len() as u64,
            );
            let mut symlink_child = std::process::Command::new("/bin/sh")
                .args(["-c", &symlink_command])
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            symlink_child
                .stdin
                .take()
                .unwrap()
                .write_all(replacement)
                .unwrap();
            let symlink_output = symlink_child.wait_with_output().unwrap();
            assert!(!symlink_output.status.success());
            assert!(String::from_utf8_lossy(&symlink_output.stderr)
                .contains(UPLOAD_TARGET_UNSUPPORTED_MARKER));
            assert!(fs::symlink_metadata(&symlink_path)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(fs::read(&symlink_target).unwrap(), b"linked-original");
            assert!(!symlink_temp.exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn upload_copy_distinguishes_zero_and_partial_writes() {
        let mut reader = Cursor::new(b"payload".to_vec());
        let mut writer = BrokenPipeWriter {
            bytes_before_failure: 0,
            written: 0,
        };
        let error =
            copy_upload_stream(&mut reader, &mut writer, &|| false, &mut |_| {}).unwrap_err();
        assert!(matches!(error, UploadCopyError::Write { .. }));

        let mut reader = Cursor::new(b"payload".to_vec());
        let mut writer = BrokenPipeWriter {
            bytes_before_failure: 3,
            written: 0,
        };
        let error =
            copy_upload_stream(&mut reader, &mut writer, &|| false, &mut |_| {}).unwrap_err();
        assert!(matches!(error, UploadCopyError::Write { .. }));
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn askpass_helpers_are_unique_per_ssh_invocation() {
        let first = create_askpass_helper("same-server").unwrap();
        let second = create_askpass_helper("same-server").unwrap();
        assert_ne!(first, second);
        assert!(first.exists());
        assert!(second.exists());
        cleanup_askpass_helper(Some(&first));
        cleanup_askpass_helper(Some(&second));
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn upload_failure_prefers_ssh_stderr_over_broken_pipe() {
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", "printf 'authentication failed' >&2; exit 255"])
            .output()
            .unwrap();
        assert_eq!(
            format_upload_attempt_failure(
                &output.status,
                &output.stderr,
                "Broken pipe (os error 32)"
            ),
            "上传失败：authentication failed"
        );

        let marker = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "printf '__ISHELL_UPLOAD_SIZE_MISMATCH__ expected=10 actual=5' >&2; exit 75",
            ])
            .output()
            .unwrap();
        let message = format_upload_attempt_failure(
            &marker.status,
            &marker.stderr,
            "OpenSSH 上传进程提前退出",
        );
        assert!(message.contains("上传字节数校验失败"));
        assert!(!message.contains("__ISHELL_"));

        let conflict = humanize_upload_error_message(UPLOAD_FOLDER_CONFLICT_MARKER);
        assert!(conflict.contains(UPLOAD_FOLDER_CONFLICT_MARKER));
        assert!(conflict.contains("全量覆盖"));
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn retry_classifier_accepts_connections_and_size_mismatch_not_remote_errors() {
        let connection = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 255"])
            .output()
            .unwrap();
        assert!(openssh_upload_is_retryable(
            &connection.status,
            &connection.stderr,
            None
        ));

        let authentication = std::process::Command::new("/bin/sh")
            .args(["-c", "printf 'Permission denied (publickey)' >&2; exit 255"])
            .output()
            .unwrap();
        assert!(!openssh_upload_is_retryable(
            &authentication.status,
            &authentication.stderr,
            None
        ));

        let size_mismatch = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "printf '__ISHELL_UPLOAD_SIZE_MISMATCH__' >&2; exit 75",
            ])
            .output()
            .unwrap();
        assert!(openssh_upload_is_retryable(
            &size_mismatch.status,
            &size_mismatch.stderr,
            None
        ));

        let permission = std::process::Command::new("/bin/sh")
            .args(["-c", "printf 'Permission denied' >&2; exit 1"])
            .output()
            .unwrap();
        let broken_pipe = UploadCopyError::Write {
            error: io::Error::new(io::ErrorKind::BrokenPipe, "closed"),
        };
        assert!(!openssh_upload_is_retryable(
            &permission.status,
            &permission.stderr,
            Some(&broken_pipe)
        ));
    }

    #[test]
    fn sanitizes_windows_reserved_names_and_characters() {
        assert_eq!(
            sanitize_windows_file_name("bad:name?.txt"),
            "bad~003A~name~003F~.txt"
        );
        assert_eq!(sanitize_windows_file_name("CON.txt"), "~DEV~CON.txt");
        assert_eq!(
            sanitize_windows_file_name("trailing. "),
            "trailing~002E~~0020~"
        );
        assert!(
            sanitize_windows_file_name(&"x".repeat(255))
                .encode_utf16()
                .count()
                <= 180
        );
    }

    #[test]
    fn rewrites_tar_paths_for_windows_unpacking() {
        let root = std::env::temp_dir().join(format!("ishell-tar-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.tar");
        let destination = root.join("destination.tar");

        let output = fs::File::create(&source).unwrap();
        let mut builder = tar::Builder::new(output);
        let mut header = tar::Header::new_gnu();
        header.set_path("bad:name/CON.txt").unwrap();
        header.set_size(2);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append(&header, Cursor::new(b"ok")).unwrap();
        builder.finish().unwrap();

        sanitize_archive_for_windows(&source, &destination).unwrap();
        let input = fs::File::open(&destination).unwrap();
        let mut archive = tar::Archive::new(input);
        let paths = archive
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().into_owned())
            .collect::<Vec<PathBuf>>();

        assert_eq!(paths, vec![PathBuf::from("bad~003A~name/~DEV~CON.txt")]);
        fs::remove_dir_all(root).unwrap();
    }
}
