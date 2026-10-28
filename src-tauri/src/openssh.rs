#[cfg(not(russh_backend))]
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
};

#[cfg(not(russh_backend))]
use crate::models::{JumpHop, ServerRecord};

pub const UPLOAD_SIZE_MISMATCH_MARKER: &str = "__ISHELL_UPLOAD_SIZE_MISMATCH__";

/// SSH_ASKPASS helper. OpenSSH runs it for every password or passphrase
/// prompt, with the prompt as `$1`. Prompts that name a jump host (its
/// `user@host` or key file, see `hop_prompt_patterns`) get that hop's saved
/// secret, every other prompt the target's. Without a saved secret it asks on
/// the terminal when there is one, like ssh itself would.
#[cfg(not(russh_backend))]
const ASKPASS_SCRIPT: &str = r#"#!/bin/sh
ask_tty() {
  ( : </dev/tty ) 2>/dev/null || exit 1
  stty -echo </dev/tty 2>/dev/null
  printf '%s' "$1" >/dev/tty
  IFS= read -r answer </dev/tty
  stty echo </dev/tty 2>/dev/null
  printf '\n' >/dev/tty
  printf '%s\n' "$answer"
  exit 0
}
i=1
while :; do
  eval "match=\${ISHELL_ASKPASS_MATCH_$i-}"
  [ -n "$match" ] || break
  case "$1" in
    *"$match"*)
      eval "secret_set=\${ISHELL_ASKPASS_SECRET_$i+set}"
      [ "$secret_set" = set ] || ask_tty "$1"
      eval "printf '%s\n' \"\$ISHELL_ASKPASS_SECRET_$i\""
      exit 0
      ;;
  esac
  i=$((i + 1))
done
[ "${ISHELL_SSH_PASSWORD+set}" = set ] || ask_tty "$1"
printf '%s\n' "$ISHELL_SSH_PASSWORD"
"#;

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
    args.extend(connection_ssh_args(server));
    args
}

/// Keepalive, timeout, host key and login options shared by targets and jump hosts.
#[cfg(not(russh_backend))]
fn connection_ssh_args(server: &ServerRecord) -> Vec<String> {
    vec![
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
    ]
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

/// `-W` argument: IPv6 literals need brackets.
#[cfg(not(russh_backend))]
fn stdio_forward_target(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// The shell command that runs the last of `hops` with its stdio forwarded to
/// `host:port`, itself reaching that hop through the earlier hops. Each hop
/// gets its own port, user and key or password, which `-J` cannot express.
#[cfg(not(russh_backend))]
fn hop_command(hops: &[JumpHop], host: &str, port: u16, batch: bool) -> Option<String> {
    let (hop, earlier) = hops.split_last()?;
    let mut args = vec![
        ssh_binary(),
        "-o".into(),
        "ControlMaster=no".into(),
        "-o".into(),
        "ControlPath=none".into(),
    ];
    args.extend(connection_ssh_args(&hop.server));
    args.extend(auth_ssh_args(&hop.server, hop.secret.is_some()));
    if batch && hop.secret.is_none() {
        args.push("-o".into());
        args.push("BatchMode=yes".into());
    }
    if let Some(inner) = hop_command(earlier, &hop.server.host, hop.server.port, batch) {
        args.push("-o".into());
        args.push(format!("ProxyCommand={}", escape_ssh_tokens(&inner)));
    }
    args.push("-W".into());
    args.push(stdio_forward_target(host, port));
    args.push(hop.server.host.clone());
    Some(
        args.iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// ssh expands `%` tokens in ProxyCommand; keep literal percent signs literal.
#[cfg(not(russh_backend))]
fn escape_ssh_tokens(value: &str) -> String {
    value.replace('%', "%%")
}

/// Text in a password or passphrase prompt that identifies the jump host it
/// is for: `user@host's password:`, `(user@host) Password:` or
/// `Enter passphrase for key '/path/to/key':`.
#[cfg(not(russh_backend))]
fn hop_prompt_patterns(server: &ServerRecord) -> Vec<String> {
    if server.auth_type == "key" {
        let key_name = server
            .key_path
            .as_deref()
            .and_then(|path| Path::new(path).file_name())
            .map(|name| name.to_string_lossy().to_string());
        return key_name
            .map(|name| vec![format!("/{name}'")])
            .unwrap_or_default();
    }
    let login = format!("{}@{}", server.username, server.host);
    vec![format!("{login}'"), format!("({login})")]
}

/// Everything needed to run `ssh` for a server besides the host and remote
/// command: the arguments (including jump hosts) and the environment that
/// lets the askpass helper answer password prompts. Remove the helper with
/// `cleanup` once ssh has exited.
#[cfg(not(russh_backend))]
pub struct SshInvocation {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub askpass: Option<PathBuf>,
}

#[cfg(not(russh_backend))]
impl SshInvocation {
    /// `batch` refuses interactive prompts (for background commands); the
    /// terminal passes false so a password that is not saved can be typed.
    pub fn prepare(
        server: &ServerRecord,
        secret: Option<&str>,
        hops: &[JumpHop],
        multiplex: bool,
        batch: bool,
        label: &str,
    ) -> Result<Self, String> {
        let mut args = common_ssh_args(server, multiplex);
        args.extend(auth_ssh_args(server, secret.is_some()));
        if let Some(command) = hop_command(hops, &server.host, server.port, batch) {
            args.push("-o".into());
            args.push(format!("ProxyCommand={}", escape_ssh_tokens(&command)));
        }
        if batch && secret.is_none() {
            args.push("-o".into());
            args.push("BatchMode=yes".into());
        }

        let needs_askpass = secret.is_some() || hops.iter().any(|hop| hop.secret.is_some());
        if !needs_askpass {
            return Ok(Self {
                args,
                env: Vec::new(),
                askpass: None,
            });
        }

        let askpass = create_askpass_helper(label)?;
        let mut env = vec![
            (
                "SSH_ASKPASS".to_string(),
                askpass.to_string_lossy().to_string(),
            ),
            ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
            ("DISPLAY".to_string(), "ishell:0".to_string()),
        ];
        if let Some(secret) = secret {
            env.push(("ISHELL_SSH_PASSWORD".to_string(), secret.to_string()));
        }
        let mut index = 1;
        for hop in hops {
            for pattern in hop_prompt_patterns(&hop.server) {
                env.push((format!("ISHELL_ASKPASS_MATCH_{index}"), pattern));
                if let Some(secret) = hop.secret.as_deref() {
                    env.push((format!("ISHELL_ASKPASS_SECRET_{index}"), secret.to_string()));
                }
                index += 1;
            }
        }
        Ok(Self {
            args,
            env,
            askpass: Some(askpass),
        })
    }

    pub fn cleanup(&self) {
        if let Some(path) = &self.askpass {
            let _ = fs::remove_file(path);
        }
    }
}

/// Write a fresh askpass helper script under a unique name.
#[cfg(not(russh_backend))]
pub fn create_askpass_helper(label: &str) -> Result<PathBuf, String> {
    let slug: String = label
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
        if let Err(err) = file.write_all(ASKPASS_SCRIPT.as_bytes()) {
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

pub fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".into();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(all(test, not(russh_backend)))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn server(id: &str, host: &str, user: &str, auth: &str) -> ServerRecord {
        ServerRecord {
            id: id.into(),
            name: id.into(),
            host: host.into(),
            port: 22,
            username: user.into(),
            group: "Default".into(),
            tags: vec![],
            auth_type: auth.into(),
            key_path: (auth == "key").then(|| "~/.ssh/id_jump".to_string()),
            color: String::new(),
            notes: String::new(),
            jump_server_id: None,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
            last_connected_at: None,
        }
    }

    fn run_askpass(prompt: &str, env: &[(String, String)]) -> Option<String> {
        use std::os::unix::process::CommandExt;

        let helper = create_askpass_helper("test").unwrap();
        let mut command = Command::new(&helper);
        // A new session has no controlling terminal, so the helper cannot
        // fall back to asking on one.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let output = command
            .arg(prompt)
            .env_clear()
            .envs(env.iter().cloned())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let _ = fs::remove_file(&helper);
        output.status.success().then(|| {
            String::from_utf8_lossy(&output.stdout)
                .trim_end()
                .to_string()
        })
    }

    #[test]
    fn direct_servers_get_no_proxy_command() {
        let target = server("t", "10.0.0.10", "root", "password");
        let invocation = SshInvocation::prepare(&target, None, &[], false, true, "t").unwrap();
        assert!(!invocation
            .args
            .iter()
            .any(|arg| arg.starts_with("ProxyCommand=")));
        assert!(invocation.askpass.is_none());
    }

    /// Split a ProxyCommand the way the shell that ssh runs it with would.
    fn shell_words(command: &str) -> Vec<String> {
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                "set -- {command}; for word; do printf '%s\\0' \"$word\"; done"
            ))
            .output()
            .unwrap();
        String::from_utf8(output.stdout)
            .unwrap()
            .split('\0')
            .filter(|word| !word.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn proxy_command(args: &[String]) -> Option<String> {
        args.iter()
            .find_map(|arg| arg.strip_prefix("ProxyCommand="))
            .map(|value| value.replace("%%", "%"))
    }

    #[test]
    fn chains_jump_hosts_innermost_first() {
        let target = server("t", "10.0.0.10", "app", "password");
        let hops = vec![
            JumpHop {
                server: server("a", "bastion.example.com", "ops", "key"),
                secret: None,
            },
            JumpHop {
                server: server("b", "fd00::2", "ops's", "password"),
                secret: Some("hop-pass".into()),
            },
        ];
        let invocation =
            SshInvocation::prepare(&target, Some("target-pass"), &hops, true, true, "t").unwrap();
        invocation.cleanup();

        // The target is reached through hop b ...
        let outer = shell_words(&proxy_command(&invocation.args).unwrap());
        assert_eq!(outer[0], ssh_binary());
        assert_eq!(outer[outer.len() - 3..], ["-W", "10.0.0.10:22", "fd00::2"]);
        assert!(outer.windows(2).any(|pair| pair == ["-l", "ops's"]));
        // ... which is reached through hop a, whose IPv6 forward target is bracketed.
        let inner = shell_words(&proxy_command(&outer).unwrap());
        assert_eq!(
            inner[inner.len() - 3..],
            ["-W", "[fd00::2]:22", "bastion.example.com"]
        );
        assert!(proxy_command(&inner).is_none());
        // Hop a has no saved secret, so it must not prompt in batch mode; hop b may.
        assert!(inner.iter().any(|arg| arg == "BatchMode=yes"));
        assert!(!outer.iter().any(|arg| arg == "BatchMode=yes"));
    }

    #[test]
    fn askpass_answers_each_hop_with_its_own_secret() {
        let hops = vec![JumpHop {
            server: server("b", "10.0.0.1", "ops", "password"),
            secret: Some("hop-pass".into()),
        }];
        let target = server("t", "10.0.0.10", "ops", "password");
        let invocation =
            SshInvocation::prepare(&target, Some("target-pass"), &hops, false, true, "t").unwrap();
        let env = invocation.env.clone();
        invocation.cleanup();

        assert_eq!(
            run_askpass("ops@10.0.0.1's password: ", &env).as_deref(),
            Some("hop-pass")
        );
        assert_eq!(
            run_askpass("(ops@10.0.0.1) Password: ", &env).as_deref(),
            Some("hop-pass")
        );
        // 10.0.0.10 starts with 10.0.0.1 but is the target.
        assert_eq!(
            run_askpass("ops@10.0.0.10's password: ", &env).as_deref(),
            Some("target-pass")
        );
    }

    #[test]
    fn askpass_fails_without_a_secret_or_terminal() {
        let hops = vec![JumpHop {
            server: server("a", "bastion", "ops", "key"),
            secret: Some("key-pass".into()),
        }];
        let target = server("t", "10.0.0.10", "app", "key");
        let invocation = SshInvocation::prepare(&target, None, &hops, false, true, "t").unwrap();
        let env = invocation.env.clone();
        invocation.cleanup();

        assert_eq!(
            run_askpass("Enter passphrase for key '/home/me/.ssh/id_jump': ", &env).as_deref(),
            Some("key-pass")
        );
        // The target has no saved passphrase and there is no terminal to ask on.
        assert_eq!(
            run_askpass("Enter passphrase for key '/home/me/.ssh/id_app': ", &env),
            None
        );
    }
}
