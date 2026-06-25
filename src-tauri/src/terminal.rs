use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{
    models::{TerminalClosedPayload, TerminalDataPayload},
    ssh::connect_server,
    store::mark_connected,
};

#[derive(Default)]
pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, mpsc::Sender<TerminalControl>>>,
    output_buffers: Mutex<HashMap<String, String>>,
}

enum TerminalControl {
    Input(String),
    Close,
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
                    session_id: thread_session_id,
                    reason,
                },
            );
        }
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

    sender
        .send(TerminalControl::Input(data))
        .map_err(|err| format!("无法写入终端会话：{err}"))
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

    Ok(())
}

pub fn terminal_snapshot(
    registry: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
) -> Result<String, String> {
    Ok(registry
        .output_buffers
        .lock()
        .map_err(|_| "终端输出缓冲已锁定".to_string())?
        .get(&session_id)
        .cloned()
        .unwrap_or_default())
}

fn emit_terminal_data(
    app: &AppHandle,
    registry: &TerminalRegistry,
    session_id: &str,
    data: String,
) {
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
            buffer.drain(..trim_from);
        }
    }

    let _ = app.emit(
        "terminal:data",
        TerminalDataPayload {
            session_id: session_id.to_string(),
            data,
        },
    );
}

fn write_all_nonblocking(channel: &mut ssh2::Channel, mut data: &[u8]) -> std::io::Result<()> {
    while !data.is_empty() {
        match channel.write(data) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "channel closed",
                ))
            }
            Ok(written) => data = &data[written..],
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

fn run_terminal_thread(
    app: AppHandle,
    registry: Arc<TerminalRegistry>,
    session_id: String,
    server_id: String,
    receiver: mpsc::Receiver<TerminalControl>,
) -> Result<(), String> {
    let (session, _server) = connect_server(&app, &server_id)?;
    mark_connected(&app, &server_id).ok();

    // Open the shell channel while the session is still blocking; in
    // non-blocking mode channel_session/request_pty/shell return EAGAIN
    // ("Would block") instead of waiting for the remote to respond.
    let mut channel = session
        .channel_session()
        .map_err(|err| format!("无法打开终端 channel：{err}"))?;
    channel
        .request_pty("xterm-256color", None, Some((120, 32, 0, 0)))
        .map_err(|err| format!("无法创建远程 PTY：{err}"))?;
    channel
        .shell()
        .map_err(|err| format!("无法启动远程 shell：{err}"))?;

    // Switch to non-blocking so the read loop can interleave with input.
    session.set_blocking(false);

    emit_terminal_data(
        &app,
        &registry,
        &session_id,
        "\r\n[iShell] connected\r\n".into(),
    );

    let mut buffer = [0_u8; 8192];
    loop {
        while let Ok(control) = receiver.try_recv() {
            match control {
                TerminalControl::Input(data) => {
                    if let Err(err) = write_all_nonblocking(&mut channel, data.as_bytes()) {
                        return Err(format!("终端写入失败：{err}"));
                    }
                    let _ = channel.flush();
                }
                TerminalControl::Close => {
                    let _ = channel.close();
                    return Ok(());
                }
            }
        }

        match channel.read(&mut buffer) {
            Ok(size) if size > 0 => {
                let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                emit_terminal_data(&app, &registry, &session_id, data);
            }
            Ok(_) => {
                if channel.eof() {
                    return Err("远程终端已关闭".into());
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(err) => return Err(format!("终端读取失败：{err}")),
        }

        thread::sleep(Duration::from_millis(12));
    }
}
