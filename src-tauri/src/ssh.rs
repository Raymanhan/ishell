use ssh2::{RenameFlags, Session, Sftp};
use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    models::{DiskMount, NetworkSample, ServerRecord, ServerStatus, SftpEntry, UploadProgress},
    pool::{with_monitor_session, with_sftp, with_sftp_session, SshPool},
    store::{get_server, read_secret},
    time::now,
};

const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;

/// Collect every status metric in a single remote command to avoid paying a
/// round trip per metric. Sections are delimited by `@@KEY@@` markers.
const STATUS_SCRIPT: &str = "A=\"$(uname -srmo 2>/dev/null || uname -a)\"; \
B=\"$(cat /proc/uptime 2>/dev/null)\"; \
C=\"$(cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null)\"; \
D=\"$(awk '/MemTotal|MemAvailable/{print $1,$2}' /proc/meminfo 2>/dev/null)\"; \
E=\"$(awk 'NR==1{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null; sleep 0.2; awk 'NR==1{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null)\"; \
F=\"$(ps -e --no-headers 2>/dev/null | wc -l || ps -ax 2>/dev/null | wc -l)\"; \
G=\"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)\"; \
printf '@@OS@@\\n%s\\n@@UP@@\\n%s\\n@@LOAD@@\\n%s\\n@@MEM@@\\n%s\\n@@CPU@@\\n%s\\n@@PROC@@\\n%s\\n@@CORES@@\\n%s\\n' \
\"$A\" \"$B\" \"$C\" \"$D\" \"$E\" \"$F\" \"$G\"";

const DISK_SCRIPT: &str = "df -Pk 2>/dev/null | tail -n +2";

const NETWORK_SCRIPT: &str = "awk -F'[: ]+' 'NR>2 && $2 != \"lo\" {rx += $3; tx += $11} END {printf \"%s %s\\n\", rx+0, tx+0}' /proc/net/dev 2>/dev/null";

pub fn connect_server(app: &AppHandle, id: &str) -> Result<(Session, ServerRecord), String> {
    let server = get_server(app, id)?;
    let session = handshake(&server)?;

    match server.auth_type.as_str() {
        "key" => {
            let passphrase = read_secret(app, &server.id).ok();
            let key_path = server
                .key_path
                .as_deref()
                .ok_or_else(|| "缺少私钥路径".to_string())?;
            session
                .userauth_pubkey_file(
                    &server.username,
                    None,
                    Path::new(key_path),
                    passphrase.as_deref(),
                )
                .map_err(|err| format!("私钥认证失败：{err}"))?;
        }
        _ => {
            let password = read_secret(app, &server.id)?;
            session
                .userauth_password(&server.username, &password)
                .map_err(|err| format!("密码认证失败：{err}"))?;
        }
    }

    if !session.authenticated() {
        return Err("SSH 认证失败".into());
    }

    Ok((session, server))
}

/// Open a TCP connection and perform the SSH banner/handshake exchange.
///
/// Tries every resolved address (handles hosts that expose an unreachable
/// IPv6 record alongside a working IPv4 one) and retries transient banner
/// failures, which commonly happen when sshd throttles new connections
/// (`MaxStartups`) or fail2ban briefly drops a burst of reconnects.
fn handshake(server: &ServerRecord) -> Result<Session, String> {
    let addresses: Vec<_> = (server.host.as_str(), server.port)
        .to_socket_addrs()
        .map_err(|err| format!("无法解析主机地址 {}：{err}", server.host))?
        .collect();
    if addresses.is_empty() {
        return Err(format!("无法解析主机地址 {}", server.host));
    }

    let mut last_error = String::from("未知错误");
    for attempt in 0..3 {
        for address in &addresses {
            match try_handshake(address) {
                Ok(session) => return Ok(session),
                Err(err) => last_error = err,
            }
        }
        std::thread::sleep(Duration::from_millis(350 * (attempt + 1)));
    }

    Err(format!(
        "SSH 握手失败：{last_error}。请确认 {}:{} 为可用的 SSH 服务，且未被防火墙或 fail2ban 拦截",
        server.host, server.port
    ))
}

fn try_handshake(address: &std::net::SocketAddr) -> Result<Session, String> {
    let tcp = TcpStream::connect_timeout(address, Duration::from_secs(8))
        .map_err(|err| format!("无法连接到 {address}：{err}"))?;
    tcp.set_nodelay(true).ok();

    let mut session = Session::new().map_err(|err| format!("无法创建 SSH 会话：{err}"))?;
    session.set_timeout(15000);
    session.set_tcp_stream(tcp);
    session.handshake().map_err(|err| format!("{err}"))?;
    // Drop the libssh2 timeout so long blocking transfers are not interrupted.
    session.set_timeout(0);
    Ok(session)
}

pub fn fetch_status(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
    include_disk: bool,
) -> Result<ServerStatus, String> {
    let raw = with_monitor_session(pool, app, id, |session| {
        exec_command(session, STATUS_SCRIPT)
    })?;
    let sections = split_sections(&raw);
    let section = |key: &str| sections.get(key).map(String::as_str).unwrap_or("");

    let (load1, load5, load15) = parse_load(section("LOAD"));
    let cpu_cores = parse_cpu_cores(section("CORES"));
    let cpu_percent = parse_cpu_percent(section("CPU"))
        .unwrap_or_else(|| cpu_percent_from_load(load1, cpu_cores));
    let (memory_total_mb, memory_available_mb) = parse_memory(section("MEM"));
    let disk_mounts = if include_disk {
        let raw_disk =
            with_monitor_session(pool, app, id, |session| exec_command(session, DISK_SCRIPT))?;
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
        disk_used_percent: root_disk.map(|mount| mount.used_percent),
        disk_used_gb: root_disk.map(|mount| mount.used_gb),
        disk_total_gb: root_disk.map(|mount| mount.total_gb),
        disk_mounts,
        processes,
        sampled_at: now(),
    })
}

pub fn fetch_network_sample(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
) -> Result<NetworkSample, String> {
    let raw = with_monitor_session(pool, app, id, |session| {
        exec_command(session, NETWORK_SCRIPT)
    })?;
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
        sampled_at: now(),
    })
}

pub fn list_sftp(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
) -> Result<Vec<SftpEntry>, String> {
    with_sftp_session(pool, app, id, |session, sftp| {
        list_dir(session, sftp, path)
    })
}

fn list_dir(session: &Session, sftp: &Sftp, path: &str) -> Result<Vec<SftpEntry>, String> {
    let current_path = if path.trim().is_empty() {
        "/"
    } else {
        path.trim()
    };
    let entries = sftp
        .readdir(Path::new(current_path))
        .map_err(|err| format!("无法读取目录 {current_path}：{err}"))?;

    let mut mapped: Vec<SftpEntry> = entries
        .into_iter()
        .filter_map(|(entry_path, stat)| {
            let name = entry_path.file_name()?.to_string_lossy().to_string();
            if name == "." || name == ".." {
                return None;
            }

            let full_path = if current_path == "/" {
                format!("/{name}")
            } else {
                format!("{}/{}", current_path.trim_end_matches('/'), name)
            };
            let is_dir = stat
                .perm
                .map(|perm| (perm & S_IFMT) == S_IFDIR)
                .unwrap_or(false);

            Some(SftpEntry {
                name,
                path: full_path,
                is_dir,
                size: stat.size,
                uid: stat.uid,
                gid: stat.gid,
                owner: None,
                group: None,
                permissions: stat.perm,
                modified_at: stat.mtime,
            })
        })
        .collect();

    let (owners, groups) = resolve_owner_group_names(session, &mapped);
    for entry in &mut mapped {
        entry.owner = entry.uid.and_then(|uid| owners.get(&uid).cloned());
        entry.group = entry.gid.and_then(|gid| groups.get(&gid).cloned());
    }

    mapped.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(mapped)
}

fn resolve_owner_group_names(
    session: &Session,
    entries: &[SftpEntry],
) -> (HashMap<u32, String>, HashMap<u32, String>) {
    let user_ids = format_id_list(entries.iter().filter_map(|entry| entry.uid));
    let group_ids = format_id_list(entries.iter().filter_map(|entry| entry.gid));
    if user_ids.is_empty() && group_ids.is_empty() {
        return (HashMap::new(), HashMap::new());
    }

    let command = format!(
        "uids='{user_ids}'; gids='{group_ids}'; \
for id in $uids; do \
name=$(getent passwd \"$id\" 2>/dev/null | awk -F: 'NR==1{{print $1}}'); \
if [ -z \"$name\" ] && [ -r /etc/passwd ]; then name=$(awk -F: -v id=\"$id\" '$3 == id {{print $1; exit}}' /etc/passwd 2>/dev/null); fi; \
if [ -n \"$name\" ]; then printf 'u\\t%s\\t%s\\n' \"$id\" \"$name\"; fi; \
done; \
for id in $gids; do \
name=$(getent group \"$id\" 2>/dev/null | awk -F: 'NR==1{{print $1}}'); \
if [ -z \"$name\" ] && [ -r /etc/group ]; then name=$(awk -F: -v id=\"$id\" '$3 == id {{print $1; exit}}' /etc/group 2>/dev/null); fi; \
if [ -n \"$name\" ]; then printf 'g\\t%s\\t%s\\n' \"$id\" \"$name\"; fi; \
done"
    );

    let Ok(raw) = exec_command(session, &command) else {
        return (HashMap::new(), HashMap::new());
    };
    parse_owner_group_output(&raw)
}

fn format_id_list(ids: impl Iterator<Item = u32>) -> String {
    let mut values: Vec<u32> = ids.collect();
    values.sort_unstable();
    values.dedup();
    values
        .into_iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_owner_group_output(raw: &str) -> (HashMap<u32, String>, HashMap<u32, String>) {
    let mut owners = HashMap::new();
    let mut groups = HashMap::new();

    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let kind = parts.next().unwrap_or_default();
        let id = parts.next().and_then(|value| value.parse::<u32>().ok());
        let name = parts.next().map(str::trim).filter(|value| !value.is_empty());
        let (Some(id), Some(name)) = (id, name) else {
            continue;
        };

        match kind {
            "u" => {
                owners.insert(id, name.to_string());
            }
            "g" => {
                groups.insert(id, name.to_string());
            }
            _ => {}
        }
    }

    (owners, groups)
}

pub fn download_file(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
    remote_path: &str,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    with_sftp(pool, app, id, |sftp| {
        download_with(app, sftp, remote_path, transfer_id, is_canceled)
    })
}

fn download_with(
    app: &AppHandle,
    sftp: &Sftp,
    remote_path: &str,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let file_name = Path::new(remote_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());

    let total = sftp
        .stat(Path::new(remote_path))
        .ok()
        .and_then(|stat| stat.size)
        .unwrap_or(0);
    let mut remote = sftp
        .open(Path::new(remote_path))
        .map_err(|err| format!("无法打开远程文件：{err}"))?;

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|err| format!("无法定位下载目录：{err}"))?;
    fs::create_dir_all(&download_dir).ok();

    let mut local_path = download_dir.join(&file_name);
    let mut counter = 1;
    while local_path.exists() {
        let stem = Path::new(&file_name)
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".to_string());
        let ext = Path::new(&file_name)
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy()))
            .unwrap_or_default();
        local_path = download_dir.join(format!("{stem} ({counter}){ext}"));
        counter += 1;
    }

    let mut local =
        fs::File::create(&local_path).map_err(|err| format!("无法创建本地文件：{err}"))?;
    match copy_with_progress(
        app,
        &mut remote,
        &mut local,
        total,
        transfer_id,
        "sftp-download-progress",
        "下载已停止",
        is_canceled,
    ) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::Interrupted => {
            drop(local);
            let _ = fs::remove_file(&local_path);
            return Err("下载已停止".to_string());
        }
        Err(err) => return Err(format!("下载失败：{err}")),
    }

    emit_progress(app, "sftp-download-progress", transfer_id, total, total, true);
    Ok(local_path.to_string_lossy().to_string())
}

pub fn upload_file(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
    local_path: &str,
    remote_dir: &str,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    with_sftp(pool, app, id, |sftp| {
        upload_with(app, sftp, local_path, remote_dir, transfer_id, is_canceled)
    })
}

fn upload_with(
    app: &AppHandle,
    sftp: &Sftp,
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
    let mut remote = sftp
        .create(Path::new(&remote_path))
        .map_err(|err| format!("无法创建远程文件：{err}"))?;

    match copy_with_progress(
        app,
        &mut local,
        &mut remote,
        total,
        transfer_id,
        "sftp-upload-progress",
        "上传已停止",
        is_canceled,
    ) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::Interrupted => {
            drop(remote);
            let _ = sftp.unlink(Path::new(&remote_path));
            return Err("上传已停止".to_string());
        }
        Err(err) => return Err(format!("上传失败：{err}")),
    }

    emit_progress(app, "sftp-upload-progress", transfer_id, total, total, true);
    Ok(remote_path)
}

/// Stream the file in chunks, emitting throttled progress events (at most every
/// ~80ms) so the UI can render a live progress bar without being flooded by one
/// event per chunk on large transfers.
fn copy_with_progress(
    app: &AppHandle,
    reader: &mut impl Read,
    writer: &mut impl Write,
    total: u64,
    transfer_id: &str,
    event_name: &str,
    stop_message: &str,
    is_canceled: &dyn Fn() -> bool,
) -> io::Result<()> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();
    emit_progress(app, event_name, transfer_id, 0, total, false);

    loop {
        if is_canceled() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, stop_message));
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if is_canceled() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, stop_message));
        }
        writer.write_all(&buffer[..read])?;
        transferred += read as u64;

        if last_emit.elapsed() >= Duration::from_millis(80) {
            emit_progress(app, event_name, transfer_id, transferred, total, false);
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

pub fn make_directory(pool: &SshPool, app: &AppHandle, id: &str, path: &str) -> Result<(), String> {
    with_sftp(pool, app, id, |sftp| {
        sftp.mkdir(Path::new(path), 0o755)
            .map_err(|err| format!("无法创建目录：{err}"))
    })
}

pub fn remove_entry(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    with_sftp(pool, app, id, |sftp| {
        if is_dir {
            remove_dir_recursive(sftp, path)
        } else {
            sftp.unlink(Path::new(path))
                .map_err(|err| format!("无法删除文件：{err}"))
        }
    })
}

fn remove_dir_recursive(sftp: &Sftp, path: &str) -> Result<(), String> {
    let entries = sftp
        .readdir(Path::new(path))
        .map_err(|err| format!("无法读取待删除目录 {path}：{err}"))?;

    for (entry_path, stat) in entries {
        let name = match entry_path.file_name() {
            Some(name) => name.to_string_lossy(),
            None => continue,
        };
        if name == "." || name == ".." {
            continue;
        }

        let child_path = if path == "/" {
            format!("/{name}")
        } else {
            format!("{}/{}", path.trim_end_matches('/'), name)
        };
        let is_dir = stat
            .perm
            .map(|perm| (perm & S_IFMT) == S_IFDIR)
            .unwrap_or(false);

        if is_dir {
            remove_dir_recursive(sftp, &child_path)?;
        } else {
            sftp.unlink(Path::new(&child_path))
                .map_err(|err| format!("无法删除文件 {child_path}：{err}"))?;
        }
    }

    sftp.rmdir(Path::new(path))
        .map_err(|err| format!("无法删除目录 {path}：{err}"))
}

pub fn rename_entry(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    with_sftp(pool, app, id, |sftp| {
        sftp.rename(Path::new(from), Path::new(to), None)
            .or_else(|_| sftp.rename(Path::new(from), Path::new(to), Some(RenameFlags::OVERWRITE)))
            .map_err(|err| format!("无法重命名：{err}"))
    })
}

pub fn exec_command(session: &Session, command: &str) -> Result<String, String> {
    let mut channel = session
        .channel_session()
        .map_err(|err| format!("无法打开 SSH command channel：{err}"))?;
    channel
        .exec(command)
        .map_err(|err| format!("远程命令执行失败：{err}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    channel.read_to_string(&mut stdout).ok();
    channel.stderr().read_to_string(&mut stderr).ok();
    channel.wait_close().ok();

    if stdout.trim().is_empty() && !stderr.trim().is_empty() {
        Ok(stderr)
    } else {
        Ok(stdout)
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
        values.get(0).copied().unwrap_or(0.0),
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

fn parse_memory(raw: &str) -> (Option<u64>, Option<u64>) {
    let mut total = None;
    let mut available = None;

    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or_default().trim_end_matches(':');
        let value = parts.next().and_then(|part| part.parse::<u64>().ok());

        match key {
            "MemTotal" => total = value.map(|kb| kb / 1024),
            "MemAvailable" => available = value.map(|kb| kb / 1024),
            _ => {}
        }
    }

    (total, available)
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
