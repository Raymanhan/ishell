//! Running commands on a server: connection tests, one-shot remote shell or
//! Python commands, and the OpenSSH process plumbing (askpass helpers).

use super::*;

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
        jump_server_id: input
            .jump_server_id
            .filter(|jump_id| !jump_id.trim().is_empty()),
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
    test_connection_with_server(app, &server, secret.as_deref())
}

#[cfg(not(russh_backend))]
pub(super) fn test_connection_with_server(
    app: &AppHandle,
    server: &ServerRecord,
    secret: Option<&str>,
) -> Result<(), String> {
    let hops = jump_hops(app, server)?;
    let invocation =
        openssh::SshInvocation::prepare(server, secret, &hops, true, true, &server.id)?;
    let mut command = Command::new(openssh::ssh_binary());
    command.envs(invocation.env.iter().cloned());
    command.args(&invocation.args);
    command.arg("-o");
    command.arg("ConnectTimeout=10");
    command.arg(&server.host);
    command.arg("printf ishell-test");
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let output = command
        .output()
        .map_err(|err| format!("无法启动 OpenSSH：{err}"));
    invocation.cleanup();
    let output = output?;
    if !output.status.success() {
        return Err(format_process_error("测试连接失败", &output.stderr));
    }
    Ok(())
}

#[cfg(russh_backend)]
pub(super) fn test_connection_with_server(
    _app: &AppHandle,
    server: &ServerRecord,
    secret: Option<&str>,
) -> Result<(), String> {
    let result = crate::russh_transport::run_command(server, secret, "printf ishell-test", None)
        .map_err(|err| format!("测试连接失败：{err}"))
        .map(|_| ());
    crate::russh_transport::invalidate(&server.id);
    result
}

pub(super) fn run_remote_shell(app: &AppHandle, id: &str, script: &str) -> Result<String, String> {
    run_remote_command(
        app,
        id,
        &format!("sh -lc {}", openssh::shell_quote(script)),
        None,
    )
}

pub(super) fn run_remote_python(
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
pub(super) fn run_remote_command(
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
pub(super) fn run_remote_command(
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
pub(super) fn spawn_remote(
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
pub(super) fn spawn_remote_ex(
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
    let hops = jump_hops(app, &server)?;
    let invocation = openssh::SshInvocation::prepare(
        &server,
        saved_secret.as_deref(),
        &hops,
        multiplex,
        true,
        id,
    )?;
    let helper_path = invocation.askpass.clone();
    let mut command = Command::new(openssh::ssh_binary());
    command.envs(invocation.env.iter().cloned());
    command.args(&invocation.args);
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
pub(super) fn cleanup_askpass_helper(path: Option<&PathBuf>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

#[cfg(not(russh_backend))]
pub(super) fn format_process_error(prefix: &str, stderr: &[u8]) -> String {
    let message = String::from_utf8_lossy(stderr).trim().to_string();
    if message.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}：{message}")
    }
}

pub(super) fn remote_file_size(
    app: &AppHandle,
    id: &str,
    remote_path: &str,
) -> Result<u64, String> {
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

pub(super) fn read_remote_file_bytes(
    app: &AppHandle,
    id: &str,
    remote_path: &str,
) -> Result<Vec<u8>, String> {
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

pub(super) fn remove_remote_file(app: &AppHandle, id: &str, path: &str) -> Result<(), String> {
    run_remote_shell(app, id, &format!("rm -f -- {}", openssh::shell_quote(path))).map(|_| ())
}

#[cfg(all(test, not(russh_backend)))]
mod tests {
    use super::*;

    #[cfg(not(russh_backend))]
    #[test]
    fn askpass_helpers_are_unique_per_ssh_invocation() {
        let first = openssh::create_askpass_helper("same-server").unwrap();
        let second = openssh::create_askpass_helper("same-server").unwrap();
        assert_ne!(first, second);
        assert!(first.exists());
        assert!(second.exists());
        cleanup_askpass_helper(Some(&first));
        cleanup_askpass_helper(Some(&second));
    }
}
