//! Pure-Rust SSH transport (russh) used on platforms where spawning the system
//! `ssh` binary plus a `#!/bin/sh` askpass helper is not viable (Windows). The
//! remote commands are identical to the Unix path — only the transport differs.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use russh::{client, ChannelMsg};
use tokio::runtime::Runtime;

use crate::models::{JumpHop, PortForward, ServerRecord};
use crate::terminal::TerminalControl;

type Session = client::Handle<ClientHandler>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const AUTH_TIMEOUT: Duration = Duration::from_secs(20);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const TRANSFER_POLL_INTERVAL: Duration = Duration::from_millis(250);
const TRANSFER_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const TRANSFER_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_FAILURE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const UPLOAD_ERROR_MARKER_PREFIX: &str = "__ISHELL_UPLOAD_";
const UPLOAD_HEARTBEAT_MARKER: &str = "__ISHELL_UPLOAD_HEARTBEAT__";

/// Result of a streaming transfer: a clean finish, a user cancellation, or a
/// hard failure (carrying a message for the UI).
pub enum TransferError {
    Canceled,
    Failed(String),
}

/// Upload failures carry an explicit retry flag. The caller writes to a
/// transaction temp path, so connection failures remain retry-safe even after
/// bytes were accepted by the SSH channel.
#[derive(Debug, PartialEq, Eq)]
pub enum UploadError {
    Canceled,
    Failed { message: String, retryable: bool },
}

impl UploadError {
    fn before_transfer(message: String) -> Self {
        let retryable = is_retryable_upload_transport_error(&message);
        Self::Failed { message, retryable }
    }

    fn after_progress(message: String, retryable: bool) -> Self {
        Self::Failed { message, retryable }
    }
}

fn is_retryable_upload_transport_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    let permanent = [
        "认证",
        "密码",
        "密钥",
        "私钥",
        "用户名",
        "known_hosts",
        "host key",
        "server key",
        "key changed",
        "permission denied",
        "authentication",
        "invalid format",
        "configuration",
        "failed to lookup address information",
        "name or service not known",
        "nodename nor servname",
        "no such host",
    ]
    .iter()
    .any(|needle| normalized.contains(needle));
    if permanent {
        return false;
    }

    [
        "超时",
        "timed out",
        "timeout",
        "connection reset",
        "connection aborted",
        "connection closed",
        "connection refused",
        "broken pipe",
        "early eof",
        "unexpected eof",
        "not connected",
        "network is unreachable",
        "host is unreachable",
        "disconnect",
        "channel",
        "通道",
        "send error",
        "senderror",
        "发送",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn should_cancel_upload(
    cancel_requested: bool,
    eof_sent: bool,
    defer_cancel_after_eof: bool,
) -> bool {
    cancel_requested && !(eof_sent && defer_cancel_after_eof)
}

#[derive(Debug, Default, PartialEq, Eq)]
struct UploadRemoteOutcome {
    stderr: Vec<u8>,
    exit_code: Option<u32>,
    exit_signal: Option<String>,
}

impl UploadRemoteOutcome {
    fn record(&mut self, msg: ChannelMsg) -> bool {
        match msg {
            ChannelMsg::ExtendedData { ref data, .. } => self.stderr.extend_from_slice(data),
            ChannelMsg::ExitStatus { exit_status } => self.exit_code = Some(exit_status),
            ChannelMsg::ExitSignal {
                signal_name,
                error_message,
                ..
            } => {
                self.exit_signal = Some(format!("{signal_name:?}"));
                if !error_message.is_empty() {
                    self.stderr.extend_from_slice(error_message.as_bytes());
                }
            }
            ChannelMsg::Close => return true,
            _ => {}
        }
        false
    }
}

fn meaningful_upload_stderr(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .filter(|line| !line.contains(UPLOAD_HEARTBEAT_MARKER))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Decide whether a send-side failure was actually caused by a remote command
/// rejection. A remote non-zero exit/signal wins, as does stderr received before
/// an exit status when it contains a protocol marker (or another meaningful
/// diagnostic). A successful exit plus incidental stderr does not hide a real
/// transport failure.
fn resolve_upload_transport_failure(
    transport_message: String,
    transport_retryable: bool,
    remote: &UploadRemoteOutcome,
) -> UploadError {
    let stderr = meaningful_upload_stderr(&remote.stderr);
    let has_upload_error_marker = stderr.contains(UPLOAD_ERROR_MARKER_PREFIX);
    let has_failure_status =
        remote.exit_signal.is_some() || remote.exit_code.is_some_and(|exit_code| exit_code != 0);
    let has_diagnostic_without_status =
        remote.exit_code.is_none() && remote.exit_signal.is_none() && !stderr.is_empty();

    if has_upload_error_marker || has_failure_status || has_diagnostic_without_status {
        let message = if stderr.is_empty() {
            ensure_successful_exit("上传", remote.exit_code, remote.exit_signal.clone(), &[])
                .expect_err("a remote failure status must produce an error")
        } else {
            stderr
        };
        let retryable = message.contains(crate::openssh::UPLOAD_SIZE_MISMATCH_MARKER);
        UploadError::after_progress(message, retryable)
    } else {
        UploadError::after_progress(transport_message, transport_retryable)
    }
}

async fn drain_after_upload_transport_failure(
    channel: &mut russh::Channel<client::Msg>,
    is_canceled: &dyn Fn() -> bool,
) -> Result<UploadRemoteOutcome, UploadError> {
    let deadline = Instant::now() + UPLOAD_FAILURE_DRAIN_TIMEOUT;
    let mut remote = UploadRemoteOutcome::default();

    loop {
        if is_canceled() {
            let _ = channel.close().await;
            return Err(UploadError::Canceled);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let poll_timeout = remaining.min(TRANSFER_POLL_INTERVAL);
        match tokio::time::timeout(poll_timeout, channel.wait()).await {
            Ok(Some(msg)) => {
                if remote.record(msg) {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => {}
        }
    }

    Ok(remote)
}

async fn recover_upload_transport_failure(
    channel: &mut russh::Channel<client::Msg>,
    is_canceled: &dyn Fn() -> bool,
    message: String,
    retryable: bool,
) -> UploadError {
    let remote = match drain_after_upload_transport_failure(channel, is_canceled).await {
        Ok(remote) => remote,
        Err(error) => return error,
    };
    let error = resolve_upload_transport_failure(message, retryable, &remote);
    let _ = channel.close().await;
    error
}

/// Remote (-R) forwards of one session: server-side listen port to the
/// host and port that connections are passed on to from this computer.
type RemoteForwards = Arc<Mutex<HashMap<u32, (String, u16)>>>;

struct ClientHandler {
    host: String,
    port: u16,
    /// The jump host session this connection is tunnelled through, kept alive
    /// for as long as this connection.
    _jump: Option<Arc<Session>>,
    remote_forwards: RemoteForwards,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Match OpenSSH's `StrictHostKeyChecking=accept-new`: trust and persist
        // the first key, accept matching known keys, and reject changed keys.
        match russh::keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                russh::keys::known_hosts::learn_known_hosts(
                    &self.host,
                    self.port,
                    server_public_key,
                )?;
                Ok(true)
            }
            Err(err) => Err(err.into()),
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = self
            .remote_forwards
            .lock()
            .ok()
            .and_then(|forwards| forwards.get(&connected_port).cloned());
        if let Some((host, port)) = target {
            tokio::spawn(async move {
                if let Ok(mut socket) = tokio::net::TcpStream::connect((host.as_str(), port)).await
                {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                }
            });
        }
        Ok(())
    }
}

type JumpResolver = Box<dyn Fn(&ServerRecord) -> Result<Vec<JumpHop>, String> + Send + Sync>;

static JUMP_RESOLVER: OnceLock<JumpResolver> = OnceLock::new();

/// Install the lookup of a server's jump hosts (from the app database). Set
/// once at startup; without it every server is reached directly.
pub fn set_jump_resolver(resolver: JumpResolver) {
    let _ = JUMP_RESOLVER.set(resolver);
}

fn jump_hops(server: &ServerRecord) -> Result<Vec<JumpHop>, String> {
    match JUMP_RESOLVER.get() {
        Some(resolve) => resolve(server),
        None => Ok(Vec::new()),
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

/// Open a brand-new connection and channel that is *not* added to the
/// session pool, so bulk transfer traffic (uploads/downloads) doesn't share a TCP
/// connection with the terminal or other pooled commands — mirroring the
/// `ControlMaster=no` isolation used on the Unix (system ssh) transport.
async fn isolated_channel(
    server: &ServerRecord,
    secret: Option<&str>,
) -> Result<(Session, russh::Channel<client::Msg>), String> {
    let handle = connect(server, secret).await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|err| format!("无法打开通道：{err}"))?;
    Ok((handle, channel))
}

/// Open a `direct-tcpip` channel to the server through its last jump host,
/// whose (pooled) session in turn goes through any earlier hops.
async fn tunnel_through(
    jump: &JumpHop,
    server: &ServerRecord,
) -> Result<(Arc<Session>, russh::Channel<client::Msg>), String> {
    let hop_error = |err: String| format!("跳板机 {}：{err}", jump.server.name);
    let open = |session: Arc<Session>| async move {
        let channel = tokio::time::timeout(
            CONNECT_TIMEOUT,
            session.channel_open_direct_tcpip(
                server.host.clone(),
                u32::from(server.port),
                "127.0.0.1",
                0,
            ),
        )
        .await
        .map_err(|_| format!("经跳板机连接 {}:{} 超时", server.host, server.port))?
        .map_err(|err| format!("跳板机无法连接到 {}:{}：{err}", server.host, server.port))?;
        Ok::<_, String>((session, channel))
    };

    // Recursion through the pool: the jump host's own jump hosts are resolved there.
    let session = Box::pin(get_or_connect(&jump.server, jump.secret.as_deref()))
        .await
        .map_err(hop_error)?;
    match open(session).await {
        Ok(tunnel) => Ok(tunnel),
        Err(_) => {
            // The pooled jump session may be stale: reconnect it once.
            invalidate(&jump.server.id);
            let session = Box::pin(get_or_connect(&jump.server, jump.secret.as_deref()))
                .await
                .map_err(hop_error)?;
            open(session).await
        }
    }
}

async fn connect(
    server: &ServerRecord,
    secret: Option<&str>,
) -> Result<client::Handle<ClientHandler>, String> {
    connect_with_forwards(server, secret, RemoteForwards::default()).await
}

async fn connect_with_forwards(
    server: &ServerRecord,
    secret: Option<&str>,
    remote_forwards: RemoteForwards,
) -> Result<client::Handle<ClientHandler>, String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        nodelay: true,
        ..client::Config::default()
    });
    let hops = jump_hops(server)?;
    let connect_timeout = |_| {
        format!(
            "连接 {}:{} 超时（{} 秒）",
            server.host,
            server.port,
            CONNECT_TIMEOUT.as_secs()
        )
    };
    let mut handle = match hops.last() {
        None => {
            let handler = ClientHandler {
                host: server.host.clone(),
                port: server.port,
                _jump: None,
                remote_forwards,
            };
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                client::connect(config, (server.host.as_str(), server.port), handler),
            )
            .await
            .map_err(connect_timeout)?
            .map_err(|err| format!("无法连接 {}:{}：{err}", server.host, server.port))?
        }
        Some(jump) => {
            let (jump_session, channel) = tunnel_through(jump, server).await?;
            let handler = ClientHandler {
                host: server.host.clone(),
                port: server.port,
                _jump: Some(jump_session),
                remote_forwards,
            };
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                client::connect_stream(config, channel.into_stream(), handler),
            )
            .await
            .map_err(connect_timeout)?
            .map_err(|err| format!("无法连接 {}:{}：{err}", server.host, server.port))?
        }
    };

    if server.auth_type == "key" {
        let key_path = server
            .key_path
            .as_deref()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| "密钥认证需要私钥路径".to_string())?;
        let key_path = expand_key_path(key_path)?;
        let key = russh::keys::load_secret_key(&key_path, secret.filter(|value| !value.is_empty()))
            .map_err(|err| format!("无法加载私钥：{err}"))?;
        let result = tokio::time::timeout(
            AUTH_TIMEOUT,
            handle.authenticate_publickey(
                &server.username,
                russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
            ),
        )
        .await
        .map_err(|_| format!("密钥认证超时（{} 秒）", AUTH_TIMEOUT.as_secs()))?
        .map_err(|err| format!("密钥认证失败：{err}"))?;
        if !result.success() {
            return Err("密钥认证被拒绝".into());
        }
    } else {
        let secret = secret.ok_or_else(|| "尚未保存该主机的密码".to_string())?;
        let result = tokio::time::timeout(
            AUTH_TIMEOUT,
            handle.authenticate_password(&server.username, secret),
        )
        .await
        .map_err(|_| format!("密码认证超时（{} 秒）", AUTH_TIMEOUT.as_secs()))?
        .map_err(|err| format!("密码认证失败：{err}"))?;
        if !result.success() {
            return Err("密码认证被拒绝（用户名或密码错误）".into());
        }
    }

    Ok(handle)
}

fn expand_key_path(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);

    if value == "~" || value.eq_ignore_ascii_case("%USERPROFILE%") || value == "$HOME" {
        return home.ok_or_else(|| "无法定位当前用户主目录".to_string());
    }

    for prefix in [
        "~/",
        "~\\",
        "%USERPROFILE%/",
        "%USERPROFILE%\\",
        "$HOME/",
        "$HOME\\",
    ] {
        if let Some(rest) = value.strip_prefix(prefix) {
            return home
                .map(|path| path.join(rest))
                .ok_or_else(|| "无法定位当前用户主目录".to_string());
        }
    }

    Ok(PathBuf::from(value))
}

fn ensure_successful_exit(
    action: &str,
    exit_code: Option<u32>,
    exit_signal: Option<String>,
    stderr: &[u8],
) -> Result<(), String> {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if let Some(signal) = exit_signal {
        return Err(if stderr.is_empty() {
            format!("{action}被远程信号 {signal} 终止")
        } else {
            stderr
        });
    }

    match exit_code {
        Some(0) => Ok(()),
        Some(code) if stderr.is_empty() => Err(format!("{action}退出码 {code}")),
        Some(_) => Err(stderr),
        None => Err(format!("{action}未返回退出状态，SSH 连接可能已中断")),
    }
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
        tokio::time::timeout(COMMAND_TIMEOUT, async {
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
            let mut exit_code = None;
            let mut exit_signal = None;
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                    ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::ExitSignal {
                        signal_name,
                        error_message,
                        ..
                    } => {
                        exit_signal = Some(format!("{signal_name:?}"));
                        if !error_message.is_empty() {
                            stderr.extend_from_slice(error_message.as_bytes());
                        }
                    }
                    _ => {}
                }
            }

            ensure_successful_exit("远程命令", exit_code, exit_signal, &stderr)?;
            Ok(stdout)
        })
        .await
        .map_err(|_| format!("远程命令执行超时（{} 秒）", COMMAND_TIMEOUT.as_secs()))?
    })
}

/// Run a long-lived remote command on a pooled SSH channel and stream stdout
/// chunks until the caller cancels or the remote command exits.
pub fn stream_command(
    server: &ServerRecord,
    secret: Option<&str>,
    remote_command: &str,
    is_canceled: &dyn Fn() -> bool,
    on_data: &mut dyn FnMut(&[u8]),
) -> Result<(), String> {
    runtime()?.block_on(async {
        let (_handle, mut channel) = session_channel(server, secret).await?;
        channel
            .exec(true, remote_command)
            .await
            .map_err(|err| format!("无法执行远程流命令：{err}"))?;

        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut exit_signal = None;
        loop {
            if is_canceled() {
                let _ = channel.eof().await;
                let _ = channel.close().await;
                return Ok(());
            }

            match tokio::time::timeout(Duration::from_millis(250), channel.wait()).await {
                Ok(Some(msg)) => match msg {
                    ChannelMsg::Data { ref data } => on_data(data),
                    ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::ExitSignal {
                        signal_name,
                        error_message,
                        ..
                    } => {
                        exit_signal = Some(format!("{signal_name:?}"));
                        if !error_message.is_empty() {
                            stderr.extend_from_slice(error_message.as_bytes());
                        }
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                },
                Ok(None) => break,
                Err(_) => {}
            }
        }

        ensure_successful_exit("远程流命令", exit_code, exit_signal, &stderr)
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
        let (_handle, mut channel) = isolated_channel(server, secret)
            .await
            .map_err(TransferError::Failed)?;
        channel
            .exec(true, remote_command)
            .await
            .map_err(|err| TransferError::Failed(format!("无法执行远程命令：{err}")))?;

        let mut transferred: u64 = 0;
        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut exit_signal = None;
        let mut last_activity = Instant::now();
        loop {
            if is_canceled() {
                let _ = channel.close().await;
                return Err(TransferError::Canceled);
            }
            if last_activity.elapsed() >= TRANSFER_IDLE_TIMEOUT {
                let _ = channel.close().await;
                return Err(TransferError::Failed(format!(
                    "下载超过 {} 秒没有收到数据",
                    TRANSFER_IDLE_TIMEOUT.as_secs()
                )));
            }
            let msg = match tokio::time::timeout(TRANSFER_POLL_INTERVAL, channel.wait()).await {
                Ok(Some(msg)) => msg,
                Ok(None) => break,
                Err(_) => continue,
            };
            last_activity = Instant::now();
            match msg {
                ChannelMsg::Data { ref data } => {
                    sink.write_all(data)
                        .map_err(|err| TransferError::Failed(format!("写入本地文件失败：{err}")))?;
                    transferred += data.len() as u64;
                    on_progress(transferred);
                }
                ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::ExitSignal {
                    signal_name,
                    error_message,
                    ..
                } => {
                    exit_signal = Some(format!("{signal_name:?}"));
                    if !error_message.is_empty() {
                        stderr.extend_from_slice(error_message.as_bytes());
                    }
                }
                _ => {}
            }
        }

        ensure_successful_exit("下载", exit_code, exit_signal, &stderr)
            .map_err(TransferError::Failed)?;
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
    defer_cancel_after_eof: bool,
    is_canceled: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(u64),
) -> Result<(), UploadError> {
    let rt = runtime().map_err(|message| UploadError::after_progress(message, false))?;
    rt.block_on(async {
        let (_handle, mut channel) = isolated_channel(server, secret)
            .await
            .map_err(UploadError::before_transfer)?;
        channel
            .exec(true, remote_command)
            .await
            .map_err(|err| UploadError::before_transfer(format!("无法执行远程命令：{err}")))?;

        let mut buffer = vec![0u8; 64 * 1024];
        let mut transferred: u64 = 0;
        loop {
            if should_cancel_upload(is_canceled(), false, defer_cancel_after_eof) {
                let _ = channel.close().await;
                return Err(UploadError::Canceled);
            }
            let read = source.read(&mut buffer).map_err(|err| {
                UploadError::after_progress(format!("读取本地文件失败：{err}"), false)
            })?;
            if read == 0 {
                break;
            }
            let write_result =
                tokio::time::timeout(TRANSFER_WRITE_TIMEOUT, channel.data(&buffer[..read])).await;
            let transport_failure = match write_result {
                Ok(Ok(())) => None,
                Ok(Err(err)) => Some((format!("上传数据失败：{err}"), true)),
                Err(_) => Some((
                    format!(
                        "上传数据超过 {} 秒没有进展",
                        TRANSFER_WRITE_TIMEOUT.as_secs()
                    ),
                    true,
                )),
            };
            if let Some((message, retryable)) = transport_failure {
                return Err(recover_upload_transport_failure(
                    &mut channel,
                    is_canceled,
                    message,
                    retryable,
                )
                .await);
            }
            transferred += read as u64;
            on_progress(transferred);
        }
        if let Err(err) = channel.eof().await {
            return Err(recover_upload_transport_failure(
                &mut channel,
                is_canceled,
                format!("结束上传失败：{err}"),
                true,
            )
            .await);
        }

        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut exit_signal = None;
        let mut last_activity = Instant::now();
        loop {
            if should_cancel_upload(is_canceled(), true, defer_cancel_after_eof) {
                let _ = channel.close().await;
                return Err(UploadError::Canceled);
            }
            if last_activity.elapsed() >= TRANSFER_IDLE_TIMEOUT {
                let _ = channel.close().await;
                return Err(UploadError::after_progress(
                    format!(
                        "上传完成后超过 {} 秒没有收到远程确认",
                        TRANSFER_IDLE_TIMEOUT.as_secs()
                    ),
                    true,
                ));
            }
            let msg = match tokio::time::timeout(TRANSFER_POLL_INTERVAL, channel.wait()).await {
                Ok(Some(msg)) => msg,
                Ok(None) => break,
                Err(_) => continue,
            };
            last_activity = Instant::now();
            match msg {
                ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::ExitSignal {
                    signal_name,
                    error_message,
                    ..
                } => {
                    exit_signal = Some(format!("{signal_name:?}"));
                    if !error_message.is_empty() {
                        stderr.extend_from_slice(error_message.as_bytes());
                    }
                }
                _ => {}
            }
        }
        let retryable = stderr
            .windows(crate::openssh::UPLOAD_SIZE_MISMATCH_MARKER.len())
            .any(|window| window == crate::openssh::UPLOAD_SIZE_MISMATCH_MARKER.as_bytes())
            || (exit_code.is_none() && exit_signal.is_none());
        ensure_successful_exit("上传", exit_code, exit_signal, &stderr)
            .map_err(|message| UploadError::after_progress(message, retryable))?;
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
            .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
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

/// Called once a port forward is listening; the forward then runs until stopped.
pub type ForwardRunning = Box<dyn Fn() + Send + Sync>;
/// Called when a port forward ends on its own, with the reason.
pub type ForwardEnded = Box<dyn FnOnce(String) + Send>;

/// Start a port forward on the shared runtime. Returns a function that stops
/// it; a forward stopped that way does not report `on_end`.
pub fn start_port_forward(
    server: ServerRecord,
    secret: Option<String>,
    forward: PortForward,
    on_running: ForwardRunning,
    on_end: ForwardEnded,
) -> Result<Box<dyn Fn() + Send + Sync>, String> {
    let rt = runtime()?;
    let task = rt.spawn(async move {
        match forward.kind.as_str() {
            "remote" => {
                serve_remote_forward(&server, secret.as_deref(), &forward, on_running).await
            }
            kind => {
                serve_local_forward(&server, secret, &forward, kind == "dynamic", on_running).await
            }
        }
    });
    let abort = task.abort_handle();
    rt.spawn(async move {
        let reason = match task.await {
            Ok(Ok(())) => "端口转发已结束".to_string(),
            Ok(Err(message)) => message,
            Err(err) if err.is_cancelled() => return,
            Err(err) => format!("端口转发异常退出：{err}"),
        };
        on_end(reason);
    });
    Ok(Box::new(move || abort.abort()))
}

/// Open a direct-tcpip channel to `host:port` on the server's pooled session.
async fn open_direct(
    server: &ServerRecord,
    secret: Option<&str>,
    host: &str,
    port: u16,
    origin: std::net::SocketAddr,
) -> Result<(Arc<Session>, russh::Channel<client::Msg>), String> {
    let open = |session: Arc<Session>| async move {
        let channel = session
            .channel_open_direct_tcpip(
                host.to_string(),
                u32::from(port),
                origin.ip().to_string(),
                u32::from(origin.port()),
            )
            .await
            .map_err(|err| format!("服务器无法连接到 {host}:{port}：{err}"))?;
        Ok::<_, String>((session, channel))
    };
    match open(get_or_connect(server, secret).await?).await {
        Ok(tunnel) => Ok(tunnel),
        Err(_) => {
            invalidate(&server.id);
            open(get_or_connect(server, secret).await?).await
        }
    }
}

/// Local (-L) and dynamic (-D) forwards: listen here, connect from the server.
async fn serve_local_forward(
    server: &ServerRecord,
    secret: Option<String>,
    forward: &PortForward,
    socks: bool,
    on_running: ForwardRunning,
) -> Result<(), String> {
    // Connect first so a login problem shows up now, not on the first connection.
    get_or_connect(server, secret.as_deref()).await?;
    let listener = tokio::net::TcpListener::bind((forward.bind_host.as_str(), forward.bind_port))
        .await
        .map_err(|err| {
            format!(
                "无法监听 {}:{}：{err}",
                forward.bind_host, forward.bind_port
            )
        })?;
    on_running();

    // Dropping the set (when the forward stops) closes every open connection.
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (socket, origin) = accepted.map_err(|err| format!("接受连接失败：{err}"))?;
                let server = server.clone();
                let secret = secret.clone();
                let target = (forward.dest_host.clone(), forward.dest_port);
                connections.spawn(async move {
                    let _ = if socks {
                        relay_socks5(socket, origin, &server, secret.as_deref()).await
                    } else {
                        relay_direct(socket, origin, &server, secret.as_deref(), &target.0, target.1).await
                    };
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

async fn relay_direct(
    mut socket: tokio::net::TcpStream,
    origin: std::net::SocketAddr,
    server: &ServerRecord,
    secret: Option<&str>,
    host: &str,
    port: u16,
) -> Result<(), String> {
    let (_session, channel) = open_direct(server, secret, host, port, origin).await?;
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

/// Minimal SOCKS5 server for one connection: no authentication, CONNECT only.
async fn relay_socks5(
    mut socket: tokio::net::TcpStream,
    origin: std::net::SocketAddr,
    server: &ServerRecord,
    secret: Option<&str>,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let io = |err: std::io::Error| err.to_string();
    let mut header = [0u8; 2];
    socket.read_exact(&mut header).await.map_err(io)?;
    if header[0] != 5 {
        return Err("只支持 SOCKS5".into());
    }
    let mut methods = vec![0u8; usize::from(header[1])];
    socket.read_exact(&mut methods).await.map_err(io)?;
    if !methods.contains(&0) {
        socket.write_all(&[5, 0xff]).await.map_err(io)?;
        return Err("SOCKS5 客户端要求认证".into());
    }
    socket.write_all(&[5, 0]).await.map_err(io)?;

    let mut request = [0u8; 4];
    socket.read_exact(&mut request).await.map_err(io)?;
    let host = match request[3] {
        1 => {
            let mut ip = [0u8; 4];
            socket.read_exact(&mut ip).await.map_err(io)?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            socket.read_exact(&mut len).await.map_err(io)?;
            let mut name = vec![0u8; usize::from(len[0])];
            socket.read_exact(&mut name).await.map_err(io)?;
            String::from_utf8(name).map_err(|_| "SOCKS5 域名无效".to_string())?
        }
        4 => {
            let mut ip = [0u8; 16];
            socket.read_exact(&mut ip).await.map_err(io)?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        _ => return Err("SOCKS5 地址类型无效".into()),
    };
    let mut port = [0u8; 2];
    socket.read_exact(&mut port).await.map_err(io)?;
    let port = u16::from_be_bytes(port);

    // Replies carry a bound address we do not have; zeros are accepted by clients.
    const SUCCEEDED: [u8; 10] = [5, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    const COMMAND_NOT_SUPPORTED: [u8; 10] = [5, 7, 0, 1, 0, 0, 0, 0, 0, 0];
    const HOST_UNREACHABLE: [u8; 10] = [5, 4, 0, 1, 0, 0, 0, 0, 0, 0];
    if request[1] != 1 {
        socket.write_all(&COMMAND_NOT_SUPPORTED).await.map_err(io)?;
        return Err("SOCKS5 只支持 CONNECT".into());
    }
    let (_session, channel) = match open_direct(server, secret, &host, port, origin).await {
        Ok(tunnel) => tunnel,
        Err(err) => {
            let _ = socket.write_all(&HOST_UNREACHABLE).await;
            return Err(err);
        }
    };
    socket.write_all(&SUCCEEDED).await.map_err(io)?;
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream)
        .await
        .map(|_| ())
        .map_err(io)
}

/// Remote (-R) forward: the server listens and hands each connection to us.
/// Uses its own connection, so stopping the forward cancels it on the server.
async fn serve_remote_forward(
    server: &ServerRecord,
    secret: Option<&str>,
    forward: &PortForward,
    on_running: ForwardRunning,
) -> Result<(), String> {
    let forwards = RemoteForwards::default();
    let session = connect_with_forwards(server, secret, forwards.clone()).await?;
    if let Ok(mut map) = forwards.lock() {
        map.insert(
            u32::from(forward.bind_port),
            (forward.dest_host.clone(), forward.dest_port),
        );
    }
    session
        .tcpip_forward(forward.bind_host.clone(), u32::from(forward.bind_port))
        .await
        .map_err(|err| {
            format!(
                "服务器拒绝在 {}:{} 监听：{err}",
                forward.bind_host, forward.bind_port
            )
        })?;
    on_running();
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if session.is_closed() {
            return Err("与服务器的连接已断开".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        ensure_successful_exit, expand_key_path, is_retryable_upload_transport_error,
        resolve_upload_transport_failure, should_cancel_upload, UploadError, UploadRemoteOutcome,
    };

    #[test]
    fn missing_exit_status_is_an_error() {
        let error = ensure_successful_exit("下载", None, None, &[]).unwrap_err();
        assert!(error.contains("未返回退出状态"));
    }

    #[test]
    fn non_zero_exit_prefers_stderr() {
        let error =
            ensure_successful_exit("命令", Some(1), None, b"permission denied").unwrap_err();
        assert_eq!(error, "permission denied");
    }

    #[test]
    fn absolute_key_path_is_unchanged() {
        let path = expand_key_path("/tmp/id_ed25519").unwrap();
        assert_eq!(path, PathBuf::from("/tmp/id_ed25519"));
    }

    #[test]
    fn upload_retry_classifier_rejects_auth_and_accepts_transport_failures() {
        assert!(!is_retryable_upload_transport_error("密码认证被拒绝"));
        assert!(!is_retryable_upload_transport_error(
            "密钥认证失败：invalid format"
        ));
        assert!(!is_retryable_upload_transport_error(
            "failed to lookup address information"
        ));
        assert!(is_retryable_upload_transport_error("连接 10.0.0.1:22 超时"));
        assert!(is_retryable_upload_transport_error(
            "上传数据失败：connection reset"
        ));
        assert!(is_retryable_upload_transport_error("无法打开通道：closed"));
    }

    #[test]
    fn remote_folder_conflict_wins_over_send_failure_without_exit_status() {
        let remote = UploadRemoteOutcome {
            stderr: b"__ISHELL_UPLOAD_FOLDER_CONFLICT__ destination-already-exists\n".to_vec(),
            ..UploadRemoteOutcome::default()
        };

        assert_eq!(
            resolve_upload_transport_failure("上传数据失败：closed".into(), true, &remote),
            UploadError::Failed {
                message: "__ISHELL_UPLOAD_FOLDER_CONFLICT__ destination-already-exists".into(),
                retryable: false,
            }
        );
    }

    #[test]
    fn remote_non_zero_exit_wins_over_eof_failure() {
        let remote = UploadRemoteOutcome {
            stderr: b"permission denied\n".to_vec(),
            exit_code: Some(1),
            exit_signal: None,
        };

        assert_eq!(
            resolve_upload_transport_failure("结束上传失败：closed".into(), true, &remote),
            UploadError::Failed {
                message: "permission denied".into(),
                retryable: false,
            }
        );
    }

    #[test]
    fn size_mismatch_remote_failure_remains_retryable() {
        let remote = UploadRemoteOutcome {
            stderr: b"__ISHELL_UPLOAD_SIZE_MISMATCH__ expected=10 actual=5\n".to_vec(),
            exit_code: Some(75),
            exit_signal: None,
        };

        assert_eq!(
            resolve_upload_transport_failure("上传数据失败：closed".into(), true, &remote),
            UploadError::Failed {
                message: "__ISHELL_UPLOAD_SIZE_MISMATCH__ expected=10 actual=5".into(),
                retryable: true,
            }
        );
    }

    #[test]
    fn heartbeat_or_success_status_does_not_hide_transport_failure() {
        for remote in [
            UploadRemoteOutcome {
                stderr: b"__ISHELL_UPLOAD_HEARTBEAT__\n".to_vec(),
                ..UploadRemoteOutcome::default()
            },
            UploadRemoteOutcome {
                stderr: b"remote warning\n".to_vec(),
                exit_code: Some(0),
                exit_signal: None,
            },
        ] {
            assert_eq!(
                resolve_upload_transport_failure(
                    "上传数据失败：connection reset".into(),
                    true,
                    &remote,
                ),
                UploadError::Failed {
                    message: "上传数据失败：connection reset".into(),
                    retryable: true,
                }
            );
        }
    }

    #[test]
    fn deferred_cancel_only_applies_after_eof_was_sent() {
        assert!(!should_cancel_upload(false, false, false));
        assert!(should_cancel_upload(true, false, false));
        assert!(should_cancel_upload(true, false, true));
        assert!(should_cancel_upload(true, true, false));
        assert!(!should_cancel_upload(true, true, true));
    }
}
