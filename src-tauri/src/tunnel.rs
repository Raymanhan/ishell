//! Running port forwards. A forward runs until it is stopped, its connection
//! fails or the app quits, independent of any terminal tab. Every change of
//! state is emitted as a `port-forward:status` event.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tauri::{AppHandle, Emitter};

use crate::{
    models::{PortForward, PortForwardStatus},
    store::{get_server, read_secret},
};

#[cfg(not(russh_backend))]
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    thread,
};

#[cfg(not(russh_backend))]
use crate::{openssh, store::jump_hops};

pub const STATUS_EVENT: &str = "port-forward:status";

struct Tunnel {
    /// Tells this run apart from a later run of the same forward.
    generation: u64,
    stop: Box<dyn Fn() + Send + Sync>,
}

#[derive(Default)]
pub struct TunnelRegistry {
    tunnels: Mutex<HashMap<String, Tunnel>>,
    statuses: Mutex<HashMap<String, PortForwardStatus>>,
    generation: Mutex<u64>,
}

impl TunnelRegistry {
    pub fn statuses(&self) -> Vec<PortForwardStatus> {
        self.statuses
            .lock()
            .map(|statuses| statuses.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn start(self: &Arc<Self>, app: &AppHandle, forward: PortForward) -> Result<(), String> {
        // Register the run before launching it, so a second start is a no-op and
        // the run's own reports (which can arrive before `launch` returns) find it.
        let generation = {
            let mut tunnels = self.tunnels.lock().map_err(|_| "端口转发状态不可用")?;
            if tunnels.contains_key(&forward.id) {
                return Ok(());
            }
            let mut generation = self.generation.lock().map_err(|_| "端口转发状态不可用")?;
            *generation += 1;
            tunnels.insert(
                forward.id.clone(),
                Tunnel {
                    generation: *generation,
                    stop: Box::new(|| {}),
                },
            );
            *generation
        };
        self.set_status(app, &forward.id, "starting", None);
        match self.launch(app, &forward, generation) {
            Ok(stop) => {
                let mut tunnels = self.tunnels.lock().map_err(|_| "端口转发状态不可用")?;
                match tunnels.get_mut(&forward.id) {
                    Some(tunnel) if tunnel.generation == generation => tunnel.stop = stop,
                    // Stopped, or already ended, while launching.
                    _ => {
                        drop(tunnels);
                        stop();
                    }
                }
                Ok(())
            }
            Err(message) => {
                self.finish(app, &forward.id, generation, message.clone());
                Err(message)
            }
        }
    }

    pub fn stop(&self, app: &AppHandle, id: &str) {
        let tunnel = self
            .tunnels
            .lock()
            .ok()
            .and_then(|mut tunnels| tunnels.remove(id));
        if let Some(tunnel) = tunnel {
            (tunnel.stop)();
        }
        self.set_status(app, id, "stopped", None);
    }

    /// Stop every forward, e.g. when the app quits.
    pub fn stop_all(&self) {
        let tunnels: Vec<Tunnel> = self
            .tunnels
            .lock()
            .map(|mut tunnels| tunnels.drain().map(|(_, tunnel)| tunnel).collect())
            .unwrap_or_default();
        for tunnel in tunnels {
            (tunnel.stop)();
        }
    }

    fn is_current(&self, id: &str, generation: u64) -> bool {
        self.tunnels
            .lock()
            .map(|tunnels| {
                tunnels
                    .get(id)
                    .is_some_and(|tunnel| tunnel.generation == generation)
            })
            .unwrap_or(false)
    }

    fn mark_running(&self, app: &AppHandle, id: &str, generation: u64) {
        if self.is_current(id, generation) {
            self.set_status(app, id, "running", None);
        }
    }

    /// A run ended on its own (not through `stop`): report why.
    fn finish(&self, app: &AppHandle, id: &str, generation: u64, reason: String) {
        let removed = self
            .tunnels
            .lock()
            .map(|mut tunnels| {
                if tunnels
                    .get(id)
                    .is_some_and(|tunnel| tunnel.generation == generation)
                {
                    tunnels.remove(id);
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if removed {
            self.set_status(app, id, "error", Some(reason));
        }
    }

    fn set_status(&self, app: &AppHandle, id: &str, state: &str, message: Option<String>) {
        let status = PortForwardStatus {
            id: id.to_string(),
            state: state.to_string(),
            message,
        };
        if let Ok(mut statuses) = self.statuses.lock() {
            statuses.insert(id.to_string(), status.clone());
        }
        let _ = app.emit(STATUS_EVENT, status);
    }

    #[cfg(russh_backend)]
    fn launch(
        self: &Arc<Self>,
        app: &AppHandle,
        forward: &PortForward,
        generation: u64,
    ) -> Result<Box<dyn Fn() + Send + Sync>, String> {
        let server = get_server(app, &forward.server_id)?;
        let secret = read_secret(app, &forward.server_id)
            .ok()
            .filter(|value| !value.is_empty());
        let id = forward.id.clone();

        let (registry, running_app, running_id) = (self.clone(), app.clone(), id.clone());
        let on_running = Box::new(move || {
            registry.mark_running(&running_app, &running_id, generation);
        });
        let (registry, ended_app) = (self.clone(), app.clone());
        let on_end = Box::new(move |reason: String| {
            registry.finish(&ended_app, &id, generation, reason);
        });
        crate::russh_transport::start_port_forward(
            server,
            secret,
            forward.clone(),
            on_running,
            on_end,
        )
    }

    #[cfg(not(russh_backend))]
    fn launch(
        self: &Arc<Self>,
        app: &AppHandle,
        forward: &PortForward,
        generation: u64,
    ) -> Result<Box<dyn Fn() + Send + Sync>, String> {
        let server = get_server(app, &forward.server_id)?;
        let secret = read_secret(app, &forward.server_id)
            .ok()
            .filter(|value| !value.is_empty());
        let hops = jump_hops(app, &server)?;
        let invocation = openssh::SshInvocation::prepare(
            &server,
            secret.as_deref(),
            &hops,
            false,
            true,
            &format!("forward-{}", forward.id),
        )?;

        let mut command = Command::new(openssh::ssh_binary());
        command.envs(invocation.env.iter().cloned());
        command.args(&invocation.args);
        // -v: the debug lines tell when the forward is actually listening.
        command.args(["-N", "-T", "-v", "-o", "ExitOnForwardFailure=yes"]);
        command.args(openssh_forward_args(forward));
        command.arg(&server.host);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                invocation.cleanup();
                return Err(format!("无法启动 OpenSSH：{err}"));
            }
        };
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(child));

        let registry = self.clone();
        let app = app.clone();
        let id = forward.id.clone();
        let remote = forward.kind == "remote";
        let watched = child.clone();
        thread::spawn(move || {
            let mut errors: Vec<String> = Vec::new();
            if let Some(stderr) = stderr {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    // Local and dynamic listeners exist once the session starts;
                    // a remote one once the server confirms it.
                    let listening = if remote {
                        line.contains("remote forward success")
                    } else {
                        line.contains("Entering interactive session")
                    };
                    if listening {
                        registry.mark_running(&app, &id, generation);
                    }
                    if !line.starts_with("debug") && !line.trim().is_empty() {
                        errors.push(line.trim().to_string());
                    }
                }
            }
            let status = watched.lock().ok().and_then(|mut child| child.wait().ok());
            invocation.cleanup();
            let reason = forward_failure_reason(&errors)
                .or_else(|| status.map(|status| format!("OpenSSH 已退出（{status}）")))
                .unwrap_or_else(|| "端口转发已结束".to_string());
            registry.finish(&app, &id, generation, reason);
        });

        Ok(Box::new(move || {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }))
    }
}

/// `host:port` for an ssh forward spec; IPv6 literals need brackets.
#[cfg(not(russh_backend))]
fn spec_address(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(not(russh_backend))]
fn openssh_forward_args(forward: &PortForward) -> Vec<String> {
    let bind = spec_address(&forward.bind_host, forward.bind_port);
    let dest = spec_address(&forward.dest_host, forward.dest_port);
    match forward.kind.as_str() {
        "remote" => vec!["-R".into(), format!("{bind}:{dest}")],
        "dynamic" => vec!["-D".into(), bind],
        _ => vec!["-L".into(), format!("{bind}:{dest}")],
    }
}

/// The most useful line of what ssh printed before it gave up.
#[cfg(not(russh_backend))]
fn forward_failure_reason(lines: &[String]) -> Option<String> {
    // Most specific first.
    const TELLING: [&str; 8] = [
        "Address already in use",
        "Permission denied",
        "Host key verification failed",
        "Could not resolve",
        "Connection refused",
        "timed out",
        "forwarding failed",
        "Could not request",
    ];
    TELLING
        .iter()
        .find_map(|needle| lines.iter().rev().find(|line| line.contains(needle)))
        .or_else(|| lines.last())
        .cloned()
}

#[cfg(all(test, not(russh_backend)))]
mod tests {
    use super::*;

    fn forward(kind: &str, bind_host: &str, dest_host: &str) -> PortForward {
        PortForward {
            id: "f".into(),
            server_id: "s".into(),
            kind: kind.into(),
            bind_host: bind_host.into(),
            bind_port: 8080,
            dest_host: dest_host.into(),
            dest_port: 80,
            description: String::new(),
            auto_start: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn builds_ssh_forward_specs() {
        assert_eq!(
            openssh_forward_args(&forward("local", "127.0.0.1", "db.internal")),
            ["-L", "127.0.0.1:8080:db.internal:80"]
        );
        assert_eq!(
            openssh_forward_args(&forward("remote", "0.0.0.0", "::1")),
            ["-R", "0.0.0.0:8080:[::1]:80"]
        );
        assert_eq!(
            openssh_forward_args(&forward("dynamic", "127.0.0.1", "")),
            ["-D", "127.0.0.1:8080"]
        );
    }

    #[test]
    fn prefers_the_line_that_explains_the_failure() {
        let lines = vec![
            "Warning: Permanently added '[127.0.0.1]:22' to the list of known hosts.".to_string(),
            "bind [127.0.0.1]:8080: Address already in use".to_string(),
            "channel_setup_fwd_listener_tcpip: cannot listen to port: 8080".to_string(),
            "Could not request local forwarding.".to_string(),
        ];
        assert_eq!(
            forward_failure_reason(&lines).as_deref(),
            Some("bind [127.0.0.1]:8080: Address already in use")
        );
    }
}
