#[cfg(not(russh_backend))]
use std::path::{Path, PathBuf};

#[cfg(not(russh_backend))]
use crate::models::ServerRecord;

#[cfg(not(russh_backend))]
pub fn ssh_binary() -> String {
    if Path::new("/usr/bin/ssh").exists() {
        "/usr/bin/ssh".to_string()
    } else {
        "ssh".to_string()
    }
}

#[cfg(not(russh_backend))]
pub fn control_path(server_id: &str) -> PathBuf {
    let slug: String = server_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(18)
        .collect();
    let slug = if slug.is_empty() { "server" } else { &slug };
    PathBuf::from(format!("/tmp/ishell-{slug}.sock"))
}

/// `multiplex = true` shares one `ControlMaster` connection with the terminal
/// and every other command for the host (matches OpenSSH's default reuse
/// behaviour). `multiplex = false` explicitly disables it (`ControlMaster=no`,
/// `ControlPath=none`, overriding any user `~/.ssh/config` default) so the
/// invocation gets its own dedicated TCP connection — used for bulk uploads
/// and downloads so they don't crowd out the terminal's interactive traffic
/// on a shared socket.
#[cfg(not(russh_backend))]
pub fn common_ssh_args(server: &ServerRecord, multiplex: bool) -> Vec<String> {
    let mut args = if multiplex {
        let control_path = control_path(&server.id);
        vec![
            "-o".into(),
            "ControlMaster=auto".into(),
            "-o".into(),
            format!("ControlPath={}", control_path.to_string_lossy()),
            "-o".into(),
            "ControlPersist=10m".into(),
        ]
    } else {
        vec![
            "-o".into(),
            "ControlMaster=no".into(),
            "-o".into(),
            "ControlPath=none".into(),
        ]
    };
    args.extend([
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
        "-o".into(),
        "TCPKeepAlive=yes".into(),
        "-o".into(),
        "ConnectTimeout=15".into(),
        "-o".into(),
        "ConnectionAttempts=1".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "NumberOfPasswordPrompts=1".into(),
        "-p".into(),
        server.port.to_string(),
        "-l".into(),
        server.username.clone(),
    ]);
    args
}

#[cfg(not(russh_backend))]
pub fn auth_ssh_args(server: &ServerRecord, has_saved_secret: bool) -> Vec<String> {
    let mut args = Vec::new();
    if server.auth_type == "password" && has_saved_secret {
        args.extend([
            "-o".into(),
            "PubkeyAuthentication=no".into(),
            "-o".into(),
            "PasswordAuthentication=yes".into(),
            "-o".into(),
            "KbdInteractiveAuthentication=yes".into(),
        ]);
    } else if server.auth_type == "key" {
        if let Some(key_path) = server.key_path.as_deref().filter(|path| !path.is_empty()) {
            args.push("-i".into());
            args.push(key_path.to_string());
        }
    }
    args
}

pub fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".into();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
