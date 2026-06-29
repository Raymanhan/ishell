//! Pure-Rust SSH transport (russh) used on platforms where spawning the system
//! `ssh` binary plus a `#!/bin/sh` askpass helper is not viable (Windows). The
//! remote commands are identical to the Unix path — only the transport differs.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::{client, ChannelMsg};
use tokio::runtime::Runtime;

use crate::models::ServerRecord;
use crate::terminal::TerminalControl;

type Session = client::Handle<ClientHandler>;

/// Result of a streaming transfer: a clean finish, a user cancellation, or a
/// hard failure (carrying a message for the UI).
pub enum TransferError {
    Canceled,
    Failed(String),
}

struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Match the Unix path's `StrictHostKeyChecking=accept-new` behaviour.
        Ok(true)
    }
}

fn runtime() -> Result<&'static Runtime, String> {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    if let Some(rt) = RUNTIME.get() {
        return Ok(rt);
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("无法创建异步运行时：{err}"))?;
    Ok(RUNTIME.get_or_init(|| rt))
}

/// Cache of live sessions keyed by server id. A `russh` handle can open many
/// channels concurrently (`channel_open_session` takes `&self`), so monitoring,
/// SFTP and the terminal all share one authenticated connection per host —
/// mirroring the `ControlPersist` multiplexing used on the Unix path.
fn pool() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static POOL: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop the cached session for `id` so the next operation reconnects. Called on
/// channel-open failure (stale session) and from `SshPool::invalidate`.
pub fn invalidate(id: &str) {
    if let Ok(mut map) = pool().lock() {
        map.remove(id);
    }
}

async fn get_or_connect(
    server: &ServerRecord,
    secret: Option<&str>,
) -> Result<Arc<Session>, String> {
    if let Ok(map) = pool().lock() {
        if let Some(handle) = map.get(&server.id).cloned() {
            return Ok(handle);
        }
    }

    let handle = Arc::new(connect(server, secret).await?);
    if let Ok(mut map) = pool().lock() {
        map.insert(server.id.clone(), handle.clone());
    }
    Ok(handle)
}

/// Open a channel on the pooled session, transparently reconnecting once if the
/// cached session has gone stale. The returned handle must be kept alive for the
/// channel's lifetime (the pool also holds a clone, but explicit invalidation
/// elsewhere could otherwise drop the last reference mid-operation).
async fn session_channel(
    server: &ServerRecord,
    secret: Option<&str>,
) -> Result<(Arc<Session>, russh::Channel<client::Msg>), String> {
    let handle = get_or_connect(server, secret).await?;
    if let Ok(channel) = handle.channel_open_session().await {
        return Ok((handle, channel));
    }

    // Cached session is stale — drop it and reconnect once.
    invalidate(&server.id);
    let handle = get_or_connect(server, secret).await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|err| format!("无法打开通道：{err}"))?;
    Ok((handle, channel))
}

async fn connect(
    server: &ServerRecord,
    secret: Option<&str>,
) -> Result<client::Handle<ClientHandler>, String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..client::Config::default()
    });
    let mut handle = client::connect(config, (server.host.as_str(), server.port), ClientHandler)
        .await
        .map_err(|err| format!("无法连接 {}:{}：{err}", server.host, server.port))?;

    if server.auth_type == "key" {
        let key_path = server
            .key_path
            .as_deref()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| "密钥认证需要私钥路径".to_string())?;
        let key = russh::keys::load_secret_key(key_path, None)
            .map_err(|err| format!("无法加载私钥：{err}"))?;
        let result = handle
            .authenticate_publickey(
                &server.username,
                russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
            )
            .await
            .map_err(|err| format!("密钥认证失败：{err}"))?;
        if !result.success() {
            return Err("密钥认证被拒绝".into());
        }
    } else {
        let secret = secret.ok_or_else(|| "尚未保存该主机的密码".to_string())?;
        let result = handle
            .authenticate_password(&server.username, secret)
            .await
            .map_err(|err| format!("密码认证失败：{err}"))?;
        if !result.success() {
            return Err("密码认证被拒绝（用户名或密码错误）".into());
        }
    }

    Ok(handle)
}

/// Run a remote command, optionally feeding `stdin`, returning captured stdout.
/// Mirrors the Unix `run_remote_command` contract: a non-zero exit becomes an
/// error carrying stderr.
pub fn run_command(
    server: &ServerRecord,
    secret: Option<&str>,
    remote_command: &str,
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    runtime()?.block_on(async {
        let (_handle, mut channel) = session_channel(server, secret).await?;
        channel
            .exec(true, remote_command)
            .await
            .map_err(|err| format!("无法执行远程命令：{err}"))?;

        if let Some(input) = stdin {
            channel
                .data(input)
                .await
                .map_err(|err| format!("写入远程输入失败：{err}"))?;
            channel
                .eof()
                .await
                .map_err(|err| format!("关闭远程输入失败：{err}"))?;
        }

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code: u32 = 0;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status,
                _ => {}
            }
        }

        if exit_code != 0 {
            let message = String::from_utf8_lossy(&stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("远程命令退出码 {exit_code}")
            } else {
                message
            });
        }
        Ok(stdout)
    })
}

/// Stream the stdout of `remote_command` (e.g. `cat -- file`) into `sink`,
/// invoking `on_progress` with the running byte count and aborting when
/// `is_canceled` returns true.
pub fn download(
    server: &ServerRecord,
    secret: Option<&str>,
    remote_command: &str,
    sink: &mut dyn Write,
    is_canceled: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(u64),
) -> Result<(), TransferError> {
    let rt = runtime().map_err(TransferError::Failed)?;
    rt.block_on(async {
        let (_handle, mut channel) = session_channel(server, secret)
            .await
            .map_err(TransferError::Failed)?;
        channel
            .exec(true, remote_command)
            .await
            .map_err(|err| TransferError::Failed(format!("无法执行远程命令：{err}")))?;

        let mut transferred: u64 = 0;
        let mut stderr = Vec::new();
        let mut exit_code: u32 = 0;
        while let Some(msg) = channel.wait().await {
            if is_canceled() {
                return Err(TransferError::Canceled);
            }
            match msg {
                ChannelMsg::Data { ref data } => {
                    sink.write_all(data)
                        .map_err(|err| TransferError::Failed(format!("写入本地文件失败：{err}")))?;
                    transferred += data.len() as u64;
                    on_progress(transferred);
                }
                ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status,
                _ => {}
            }
        }

        if exit_code != 0 {
            let message = String::from_utf8_lossy(&stderr).trim().to_string();
            return Err(TransferError::Failed(if message.is_empty() {
                format!("下载失败，退出码 {exit_code}")
            } else {
                message
            }));
        }
        Ok(())
    })
}

/// Stream `source` into the stdin of `remote_command` (e.g. `cat > file`),
/// invoking `on_progress` with the running byte count and aborting when
/// `is_canceled` returns true.
pub fn upload(
    server: &ServerRecord,
    secret: Option<&str>,
    remote_command: &str,
    source: &mut dyn Read,
    is_canceled: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(u64),
) -> Result<(), TransferError> {
    let rt = runtime().map_err(TransferError::Failed)?;
    rt.block_on(async {
        let (_handle, mut channel) = session_channel(server, secret)
            .await
            .map_err(TransferError::Failed)?;
        channel
            .exec(true, remote_command)
            .await
            .map_err(|err| TransferError::Failed(format!("无法执行远程命令：{err}")))?;

        let mut buffer = vec![0u8; 64 * 1024];
        let mut transferred: u64 = 0;
        loop {
            if is_canceled() {
                return Err(TransferError::Canceled);
            }
            let read = source
                .read(&mut buffer)
                .map_err(|err| TransferError::Failed(format!("读取本地文件失败：{err}")))?;
            if read == 0 {
                break;
            }
            channel
                .data(&buffer[..read])
                .await
                .map_err(|err| TransferError::Failed(format!("上传数据失败：{err}")))?;
            transferred += read as u64;
            on_progress(transferred);
        }
        channel
            .eof()
            .await
            .map_err(|err| TransferError::Failed(format!("结束上传失败：{err}")))?;

        let mut stderr = Vec::new();
        let mut exit_code: u32 = 0;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status,
                _ => {}
            }
        }
        if exit_code != 0 {
            let message = String::from_utf8_lossy(&stderr).trim().to_string();
            return Err(TransferError::Failed(if message.is_empty() {
                format!("上传失败，退出码 {exit_code}")
            } else {
                message
            }));
        }
        Ok(())
    })
}

/// Drive an interactive shell over a russh PTY channel. Output bytes are handed
/// to `on_data`; input/resize/close come from the shared `control` receiver.
/// Blocks until the channel closes or a `Close` control message is received.
pub fn run_terminal(
    server: &ServerRecord,
    secret: Option<&str>,
    cols: u16,
    rows: u16,
    control: std::sync::mpsc::Receiver<TerminalControl>,
    on_ready: impl FnOnce(),
    mut on_data: impl FnMut(&[u8]),
) -> Result<(), String> {
    use std::sync::mpsc::TryRecvError;

    let rt = runtime()?;
    rt.block_on(async move {
        let (_handle, mut channel) = session_channel(server, secret).await?;
        channel
            .request_pty(
                false,
                "xterm-256color",
                cols as u32,
                rows as u32,
                0,
                0,
                &[],
            )
            .await
            .map_err(|err| format!("无法申请 PTY：{err}"))?;
        channel
            .request_shell(true)
            .await
            .map_err(|err| format!("无法启动远程 shell：{err}"))?;

        on_ready();

        loop {
            // Drain any pending control messages without blocking.
            loop {
                match control.try_recv() {
                    Ok(TerminalControl::Input(data)) => {
                        channel
                            .data(data.as_bytes())
                            .await
                            .map_err(|err| format!("终端写入失败：{err}"))?;
                    }
                    Ok(TerminalControl::Resize { cols, rows }) => {
                        channel
                            .window_change(cols as u32, rows as u32, 0, 0)
                            .await
                            .map_err(|err| format!("无法调整终端尺寸：{err}"))?;
                    }
                    Ok(TerminalControl::Close) | Err(TryRecvError::Disconnected) => {
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        return Ok(());
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }

            // Poll for remote output with a short timeout so we loop back to
            // service control messages promptly.
            match tokio::time::timeout(Duration::from_millis(20), channel.wait()).await {
                Ok(Some(ChannelMsg::Data { ref data })) => on_data(data),
                Ok(Some(ChannelMsg::ExtendedData { ref data, .. })) => on_data(data),
                Ok(Some(ChannelMsg::Eof)) | Ok(None) => {
                    return Err("远程终端已关闭".to_string());
                }
                Ok(Some(_)) => {}
                Err(_timeout) => {}
            }
        }
    })
}
