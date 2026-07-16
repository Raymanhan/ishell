use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use tauri::{AppHandle, Emitter};

use crate::{models::ProcessSamplePayload, ssh, time::now_fractional};

const PROCESS_SAMPLE_EVENT: &str = "server-process-sample";

struct MonitorEntry {
    consumers: HashSet<String>,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct ProcessMonitorRegistry {
    monitors: Mutex<HashMap<String, MonitorEntry>>,
}

impl ProcessMonitorRegistry {
    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        server_id: String,
        consumer_id: String,
    ) -> Result<(), String> {
        if server_id.trim().is_empty() || consumer_id.trim().is_empty() {
            return Err("进程监控缺少服务器或订阅者标识".to_string());
        }

        let cancel = {
            let mut monitors = self
                .monitors
                .lock()
                .map_err(|_| "进程监控注册表已锁定".to_string())?;
            if let Some(entry) = monitors.get_mut(&server_id) {
                entry.consumers.insert(consumer_id);
                return Ok(());
            }

            let cancel = Arc::new(AtomicBool::new(false));
            monitors.insert(
                server_id.clone(),
                MonitorEntry {
                    consumers: HashSet::from([consumer_id]),
                    cancel: cancel.clone(),
                },
            );
            cancel
        };

        let registry = self.clone();
        thread::spawn(move || {
            run_monitor(app, server_id.clone(), cancel.clone());
            registry.finish(&server_id, &cancel);
        });
        Ok(())
    }

    pub fn stop(&self, server_id: &str, consumer_id: &str) {
        let Ok(mut monitors) = self.monitors.lock() else {
            return;
        };
        let Some(entry) = monitors.get_mut(server_id) else {
            return;
        };
        entry.consumers.remove(consumer_id);
        if entry.consumers.is_empty() {
            entry.cancel.store(true, Ordering::Relaxed);
            monitors.remove(server_id);
        }
    }

    fn finish(&self, server_id: &str, cancel: &Arc<AtomicBool>) {
        let Ok(mut monitors) = self.monitors.lock() else {
            return;
        };
        let should_remove = monitors
            .get(server_id)
            .is_some_and(|entry| Arc::ptr_eq(&entry.cancel, cancel));
        if should_remove {
            monitors.remove(server_id);
        }
    }
}

fn run_monitor(app: AppHandle, server_id: String, cancel: Arc<AtomicBool>) {
    let mut retry_seconds = 1_u64;
    while !cancel.load(Ordering::Relaxed) {
        let result = ssh::stream_process_usage(
            &app,
            &server_id,
            || cancel.load(Ordering::Relaxed),
            |top_cpu_processes, top_memory_processes| {
                retry_seconds = 1;
                let _ = app.emit(
                    PROCESS_SAMPLE_EVENT,
                    ProcessSamplePayload {
                        id: server_id.clone(),
                        top_cpu_processes,
                        top_memory_processes,
                        sampled_at: now_fractional(),
                    },
                );
            },
        );

        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if let Err(error) = result {
            eprintln!("iShell process monitor for {server_id} stopped: {error}");
        }
        if sleep_until_cancelled(&cancel, Duration::from_secs(retry_seconds)) {
            break;
        }
        retry_seconds = (retry_seconds * 2).min(8);
    }
}

fn sleep_until_cancelled(cancel: &AtomicBool, duration: Duration) -> bool {
    let steps = duration.as_millis().div_ceil(100) as u64;
    for _ in 0..steps {
        if cancel.load(Ordering::Relaxed) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    cancel.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::sleep_until_cancelled;
    use std::{
        sync::atomic::AtomicBool,
        time::{Duration, Instant},
    };

    #[test]
    fn canceled_retry_sleep_returns_quickly() {
        let cancel = AtomicBool::new(true);
        let started = Instant::now();
        assert!(sleep_until_cancelled(&cancel, Duration::from_secs(8)));
        assert!(started.elapsed() < Duration::from_millis(100));
    }
}
