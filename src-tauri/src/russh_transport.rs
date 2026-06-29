//! Pure-Rust SSH transport (russh) used on platforms where spawning the system
//! `ssh` binary plus a `#!/bin/sh` askpass helper is not viable (Windows). The
//! remote commands are identical to the Unix path — only the transport differs.

use std::sync::Arc;

use russh::{client, ChannelMsg};
use tokio::runtime::Runtime;

use crate::models::ServerRecord;

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
    use std::sync::OnceLock;
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

async fn connect(
    server: &ServerRecord,
    secret: Option<&str>,
) -> Result<client::Handle<ClientHandler>, String> {
    let config = Arc::new(client::Config::default());
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
/// Mirrors the Unix `run_remote_command` contract: non-zero exit is an error
/// carrying stderr.
pub fn run_command(
    server: &ServerRecord,
    secret: Option<&str>,
    remote_command: &str,
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    runtime()?.block_on(async {
        let handle = connect(server, secret).await?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|err| format!("无法打开通道：{err}"))?;
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
