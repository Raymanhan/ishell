use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{
    models::{ServerRecord, TerminalClosedPayload, TerminalDataPayload, TerminalSnapshotPayload},
    openssh,
    store::{get_server, mark_connected, read_secret},
};

#[derive(Default)]
pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, mpsc::Sender<TerminalControl>>>,
    output_buffers: Mutex<HashMap<String, String>>,
    output_starts: Mutex<HashMap<String, usize>>,
    output_offsets: Mutex<HashMap<String, usize>>,
}

enum TerminalControl {
    Input(String),
    Resize { cols: u16, rows: u16 },
    Close,
}

const CONNECTED_MARKER: &str = "[iShell] connected";

impl TerminalRegistry {
    fn remove_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }
}

pub fn open_terminal(
    app: AppHandle,
    registry: State<'_, Arc<TerminalRegistry>>,
    id: String,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::channel::<TerminalControl>();

    registry
        .sessions
        .lock()
        .map_err(|_| "终端会话表已锁定".to_string())?
        .insert(session_id.clone(), sender);
    registry
        .output_buffers
        .lock()
        .map_err(|_| "终端输出缓冲已锁定".to_string())?
        .insert(session_id.clone(), String::new());
    registry
        .output_starts
        .lock()
        .map_err(|_| "终端输出偏移已锁定".to_string())?
        .insert(session_id.clone(), 0);
    registry
        .output_offsets
        .lock()
        .map_err(|_| "终端输出偏移已锁定".to_string())?
        .insert(session_id.clone(), 0);

    let thread_app = app.clone();
    let thread_session_id = session_id.clone();
    let thread_registry = registry.inner().clone();
    thread::spawn(move || {
        let result = run_terminal_thread(
            thread_app.clone(),
            thread_registry.clone(),
            thread_session_id.clone(),
            id,
            receiver,
        );
        if let Err(reason) = result {
            let _ = thread_app.emit(
                "terminal:closed",
                TerminalClosedPayload {
                    session_id: thread_session_id.clone(),
                    reason,
                },
            );
        }
        thread_registry.remove_session(&thread_session_id);
    });

    Ok(session_id)
}

pub fn terminal_input(
    registry: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sender = registry
        .sessions
        .lock()
        .map_err(|_| "终端会话表已锁定".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "找不到终端会话".to_string())?;

    sender.send(TerminalControl::Input(data)).map_err(|_| {
        registry.inner().remove_session(&session_id);
        "终端会话已关闭，请重新连接".to_string()
    })
}

pub fn terminal_resize(
    registry: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sender = registry
        .sessions
        .lock()
        .map_err(|_| "终端会话表已锁定".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "找不到终端会话".to_string())?;

    sender
        .send(TerminalControl::Resize {
            cols: cols.max(1),
            rows: rows.max(1),
        })
        .map_err(|_| {
            registry.inner().remove_session(&session_id);
            "终端会话已关闭，请重新连接".to_string()
        })
}

pub fn close_terminal(
    registry: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
) -> Result<(), String> {
    if let Some(sender) = registry
        .sessions
        .lock()
        .map_err(|_| "终端会话表已锁定".to_string())?
        .remove(&session_id)
    {
        let _ = sender.send(TerminalControl::Close);
    }
    if let Ok(mut buffers) = registry.output_buffers.lock() {
        buffers.remove(&session_id);
    }
    if let Ok(mut starts) = registry.output_starts.lock() {
        starts.remove(&session_id);
    }
    if let Ok(mut offsets) = registry.output_offsets.lock() {
        offsets.remove(&session_id);
    }

    Ok(())
}

pub fn terminal_snapshot(
    registry: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
) -> Result<TerminalSnapshotPayload, String> {
    terminal_snapshot_inner(registry.inner(), &session_id)
}

fn terminal_snapshot_inner(
    registry: &TerminalRegistry,
    session_id: &str,
) -> Result<TerminalSnapshotPayload, String> {
    let data = registry
        .output_buffers
        .lock()
        .map_err(|_| "终端输出缓冲已锁定".to_string())?
        .get(session_id)
        .cloned()
        .unwrap_or_default();
    let start_offset = registry
        .output_starts
        .lock()
        .map_err(|_| "终端输出偏移已锁定".to_string())?
        .get(session_id)
        .copied()
        .unwrap_or_default();
    let end_offset = start_offset + data.chars().count();

    Ok(TerminalSnapshotPayload {
        data,
        start_offset,
        end_offset,
    })
}

fn emit_terminal_data(
    app: &AppHandle,
    registry: &TerminalRegistry,
    session_id: &str,
    data: String,
) {
    let offset = registry
        .output_offsets
        .lock()
        .map(|mut offsets| {
            let offset = offsets.entry(session_id.to_string()).or_default();
            let current = *offset;
            *offset += data.chars().count();
            current
        })
        .unwrap_or_default();

    if let Ok(mut buffers) = registry.output_buffers.lock() {
        let buffer = buffers.entry(session_id.to_string()).or_default();
        buffer.push_str(&data);
        const MAX_BUFFER_BYTES: usize = 256 * 1024;
        if buffer.len() > MAX_BUFFER_BYTES {
            let keep_from = buffer.len() - MAX_BUFFER_BYTES;
            let trim_from = buffer
                .char_indices()
                .find(|(index, _)| *index >= keep_from)
                .map(|(index, _)| index)
                .unwrap_or(keep_from);
            let drained_chars = buffer[..trim_from].chars().count();
            buffer.drain(..trim_from);
            if let Ok(mut starts) = registry.output_starts.lock() {
                *starts.entry(session_id.to_string()).or_default() += drained_chars;
            }
        }
    }

    let _ = app.emit(
        "terminal:data",
        TerminalDataPayload {
            session_id: session_id.to_string(),
            offset,
            data,
        },
    );
}

fn create_askpass_helper(session_id: &str) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("ishell-askpass-{session_id}.sh"));
    fs::write(
        &path,
        "#!/bin/sh\nprintf '%s\\n' \"$ISHELL_SSH_PASSWORD\"\n",
    )
    .map_err(|err| format!("无法创建 SSH_ASKPASS helper：{err}"))?;
    #[cfg(unix)]
    {
        let permissions = fs::Permissions::from_mode(0o700);
        fs::set_permissions(&path, permissions)
            .map_err(|err| format!("无法设置 SSH_ASKPASS helper 权限：{err}"))?;
    }
    Ok(path)
}

fn cleanup_askpass_helper(path: Option<&PathBuf>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

fn strip_ansi_sequences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for seq in chars.by_ref() {
                if ('@'..='~').contains(&seq) {
                    break;
                }
            }
            continue;
        }
        output.push(ch);
    }

    output
}

fn keep_recent_tail(value: &mut String, max_bytes: usize) {
    if value.len() <= max_bytes {
        return;
    }

    let keep_from = value.len() - max_bytes;
    let drain_to = value
        .char_indices()
        .find(|(index, _)| *index >= keep_from)
        .map(|(index, _)| index)
        .unwrap_or(keep_from);
    value.drain(..drain_to);
}

fn looks_like_password_prompt(output_tail: &str) -> bool {
    let plain = strip_ansi_sequences(output_tail).replace('\r', "");
    let line = plain
        .rsplit('\n')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_lowercase();

    (line.ends_with(':') || line.ends_with('：'))
        && (line.contains("password")
            || line.contains("passphrase")
            || line.contains("密码")
            || line.contains("口令"))
}

fn build_ssh_command(
    server: &ServerRecord,
    saved_password: Option<&str>,
    askpass_path: Option<&Path>,
) -> CommandBuilder {
    let mut command = CommandBuilder::new(openssh::ssh_binary());
    command.env("TERM", "xterm-256color");
    command.arg("-tt");
    for arg in openssh::common_ssh_args(server) {
        command.arg(arg);
    }
    command.arg("-o");
    command.arg("PermitLocalCommand=yes");
    command.arg("-o");
    command.arg("LocalCommand=printf '\\r\\n[iShell] connected via OpenSSH\\r\\n'");

    if let (Some(password), Some(path)) = (saved_password, askpass_path) {
        command.env("SSH_ASKPASS", path);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("ISHELL_SSH_PASSWORD", password);
        if command.get_env("DISPLAY").is_none() {
            command.env("DISPLAY", "ishell:0");
        }
        command.arg("-o");
        command.arg("PubkeyAuthentication=no");
        command.arg("-o");
        command.arg("PasswordAuthentication=yes");
        command.arg("-o");
        command.arg("KbdInteractiveAuthentication=yes");
    } else {
        for arg in openssh::auth_ssh_args(server, false) {
            command.arg(arg);
        }
    }

    command.arg(&server.host);
    command
}

fn run_terminal_thread(
    app: AppHandle,
    registry: Arc<TerminalRegistry>,
    session_id: String,
    server_id: String,
    receiver: mpsc::Receiver<TerminalControl>,
) -> Result<(), String> {
    let server = get_server(&app, &server_id)?;
    let saved_password = if server.auth_type == "password" {
        read_secret(&app, &server_id)
            .ok()
            .filter(|password| !password.is_empty())
    } else {
        None
    };
    let askpass_path = if saved_password.is_some() {
        Some(create_askpass_helper(&session_id)?)
    } else {
        None
    };
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("无法创建本地 PTY：{err}"))?;

    let command = build_ssh_command(&server, saved_password.as_deref(), askpass_path.as_deref());
    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(err) => {
            cleanup_askpass_helper(askpass_path.as_ref());
            return Err(format!("无法启动本机 ssh：{err}"));
        }
    };
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("无法读取本地 PTY：{err}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("无法写入本地 PTY：{err}"))?;

    let (read_done_sender, read_done_receiver) = mpsc::channel::<String>();
    let (password_prompt_sender, password_prompt_receiver) = mpsc::channel::<()>();
    let read_app = app.clone();
    let read_registry = registry.clone();
    let read_session_id = session_id.clone();
    let read_server_id = server_id.clone();
    let should_autofill_password = saved_password.is_some();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut output_tail = String::new();
        let mut connection_tail = String::new();
        let mut password_prompt_seen = false;
        let mut connected_seen = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = read_done_sender.send("远程终端已关闭".to_string());
                    break;
                }
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    if !connected_seen {
                        connection_tail.push_str(&data);
                        keep_recent_tail(&mut connection_tail, 1024);
                        if connection_tail.contains(CONNECTED_MARKER) {
                            connected_seen = true;
                            mark_connected(&read_app, &read_server_id).ok();
                        }
                    }
                    if should_autofill_password && !password_prompt_seen {
                        output_tail.push_str(&data);
                        keep_recent_tail(&mut output_tail, 1024);
                        if looks_like_password_prompt(&output_tail) {
                            password_prompt_seen = true;
                            let _ = password_prompt_sender.send(());
                        }
                    }
                    emit_terminal_data(&read_app, &read_registry, &read_session_id, data);
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                Err(err) => {
                    let _ = read_done_sender.send(format!("终端读取失败：{err}"));
                    break;
                }
            }
        }
    });

    emit_terminal_data(
        &app,
        &registry,
        &session_id,
        "\r\n[iShell] OpenSSH started\r\n".into(),
    );

    loop {
        if password_prompt_receiver.try_recv().is_ok() {
            if let Some(password) = saved_password.as_deref() {
                if let Err(err) = writer.write_all(password.as_bytes()) {
                    cleanup_askpass_helper(askpass_path.as_ref());
                    return Err(format!("终端写入失败：{err}"));
                }
                if let Err(err) = writer.write_all(b"\n") {
                    cleanup_askpass_helper(askpass_path.as_ref());
                    return Err(format!("终端写入失败：{err}"));
                }
                writer.flush().ok();
            }
        }

        if let Ok(reason) = read_done_receiver.try_recv() {
            let _ = child.wait();
            cleanup_askpass_helper(askpass_path.as_ref());
            return Err(reason);
        }

        match receiver.recv_timeout(Duration::from_millis(80)) {
            Ok(TerminalControl::Input(data)) => {
                if let Err(err) = writer.write_all(data.as_bytes()) {
                    cleanup_askpass_helper(askpass_path.as_ref());
                    return Err(format!("终端写入失败：{err}"));
                }
                writer.flush().ok();
            }
            Ok(TerminalControl::Resize { cols, rows }) => {
                if let Err(err) = pair.master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    cleanup_askpass_helper(askpass_path.as_ref());
                    return Err(format!("无法调整终端尺寸：{err}"));
                }
            }
            Ok(TerminalControl::Close) => {
                let _ = child.kill();
                let _ = child.wait();
                cleanup_askpass_helper(askpass_path.as_ref());
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                cleanup_askpass_helper(askpass_path.as_ref());
                return Ok(());
            }
        }
    }
}
