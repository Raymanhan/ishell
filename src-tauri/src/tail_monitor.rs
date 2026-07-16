use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use tauri::{AppHandle, Emitter};

use crate::{
    models::{TailDataPayload, TailStatusPayload},
    ssh,
};

const TAIL_DATA_EVENT: &str = "tail:data";
const TAIL_STATUS_EVENT: &str = "tail:status";
const MAX_TAIL_VIEWERS: usize = 12;

struct MonitorEntry {
    window_label: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct TailMonitorRegistry {
    monitors: Mutex<HashMap<String, MonitorEntry>>,
}

impl TailMonitorRegistry {
    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        viewer_id: String,
        window_label: String,
        server_id: String,
        path: String,
        initial_lines: u32,
    ) -> Result<(), String> {
        validate_request(&viewer_id, &window_label, &server_id, &path, initial_lines)?;

        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut monitors = self
                .monitors
                .lock()
                .map_err(|_| "滚动查看注册表已锁定".to_string())?;
            if !monitors.contains_key(&viewer_id) && monitors.len() >= MAX_TAIL_VIEWERS {
                return Err(format!("最多同时打开 {MAX_TAIL_VIEWERS} 个滚动查看窗口"));
            }
            if let Some(previous) = monitors.insert(
                viewer_id.clone(),
                MonitorEntry {
                    window_label: window_label.clone(),
                    cancel: cancel.clone(),
                },
            ) {
                previous.cancel.store(true, Ordering::Relaxed);
            }
        }

        emit_status(&app, &window_label, &viewer_id, "connecting", None);
        let registry = self.clone();
        thread::spawn(move || {
            run_monitor(
                app,
                viewer_id.clone(),
                window_label,
                server_id,
                path,
                initial_lines,
                cancel.clone(),
            );
            registry.finish(&viewer_id, &cancel);
        });
        Ok(())
    }

    pub fn stop(&self, viewer_id: &str) {
        let Ok(mut monitors) = self.monitors.lock() else {
            return;
        };
        if let Some(entry) = monitors.remove(viewer_id) {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn stop_window(&self, window_label: &str) {
        let Ok(mut monitors) = self.monitors.lock() else {
            return;
        };
        let viewer_ids: Vec<String> = monitors
            .iter()
            .filter(|(_, entry)| entry.window_label == window_label)
            .map(|(viewer_id, _)| viewer_id.clone())
            .collect();
        for viewer_id in viewer_ids {
            if let Some(entry) = monitors.remove(&viewer_id) {
                entry.cancel.store(true, Ordering::Relaxed);
            }
        }
    }

    fn finish(&self, viewer_id: &str, cancel: &Arc<AtomicBool>) {
        let Ok(mut monitors) = self.monitors.lock() else {
            return;
        };
        let should_remove = monitors
            .get(viewer_id)
            .is_some_and(|entry| Arc::ptr_eq(&entry.cancel, cancel));
        if should_remove {
            monitors.remove(viewer_id);
        }
    }
}

fn run_monitor(
    app: AppHandle,
    viewer_id: String,
    window_label: String,
    server_id: String,
    path: String,
    initial_lines: u32,
    cancel: Arc<AtomicBool>,
) {
    let binary_detected = AtomicBool::new(false);
    let mut decoder = Utf8StreamDecoder::default();
    let result = ssh::stream_tail_file(
        &app,
        &server_id,
        &path,
        initial_lines,
        || cancel.load(Ordering::Relaxed),
        || emit_status(&app, &window_label, &viewer_id, "streaming", None),
        |chunk| {
            if chunk.contains(&0) {
                binary_detected.store(true, Ordering::Relaxed);
                cancel.store(true, Ordering::Relaxed);
                return;
            }
            let data = decoder.push(chunk);
            if !data.is_empty() {
                let _ = app.emit_to(
                    &window_label,
                    TAIL_DATA_EVENT,
                    TailDataPayload {
                        viewer_id: viewer_id.clone(),
                        data,
                    },
                );
            }
        },
    );

    let remainder = decoder.finish();
    if !remainder.is_empty()
        && !binary_detected.load(Ordering::Relaxed)
        && !cancel.load(Ordering::Relaxed)
    {
        let _ = app.emit_to(
            &window_label,
            TAIL_DATA_EVENT,
            TailDataPayload {
                viewer_id: viewer_id.clone(),
                data: remainder,
            },
        );
    }
    if binary_detected.load(Ordering::Relaxed) {
        emit_status(
            &app,
            &window_label,
            &viewer_id,
            "error",
            Some("该文件包含二进制内容，无法滚动查看".to_string()),
        );
    } else if !cancel.load(Ordering::Relaxed) {
        match result {
            Ok(()) => emit_status(
                &app,
                &window_label,
                &viewer_id,
                "stopped",
                Some("远程 tail 已结束".to_string()),
            ),
            Err(error) => emit_status(&app, &window_label, &viewer_id, "error", Some(error)),
        }
    }
}

fn emit_status(
    app: &AppHandle,
    window_label: &str,
    viewer_id: &str,
    state: &str,
    message: Option<String>,
) {
    let _ = app.emit_to(
        window_label,
        TAIL_STATUS_EVENT,
        TailStatusPayload {
            viewer_id: viewer_id.to_string(),
            state: state.to_string(),
            message,
        },
    );
}

fn validate_request(
    viewer_id: &str,
    window_label: &str,
    server_id: &str,
    path: &str,
    initial_lines: u32,
) -> Result<(), String> {
    if viewer_id.trim().is_empty() || server_id.trim().is_empty() || path.trim().is_empty() {
        return Err("滚动查看缺少文件或连接信息".to_string());
    }
    if !window_label.starts_with("tail-") {
        return Err("只能在滚动查看窗口中启动监听".to_string());
    }
    if !(10..=10_000).contains(&initial_lines) {
        return Err("可见行数必须在 10 到 10000 之间".to_string());
    }
    Ok(())
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let valid = std::str::from_utf8(&self.pending[..valid_up_to])
                            .expect("validated UTF-8 prefix");
                        output.push_str(valid);
                        self.pending.drain(..valid_up_to);
                    }
                    match error.error_len() {
                        Some(length) => {
                            output.push('\u{fffd}');
                            self.pending.drain(..length);
                        }
                        None => break,
                    }
                }
            }
        }
        output
    }

    fn finish(&mut self) -> String {
        let output = String::from_utf8_lossy(&self.pending).to_string();
        self.pending.clear();
        output
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_request, Utf8StreamDecoder};

    #[test]
    fn decoder_preserves_utf8_split_across_chunks() {
        let mut decoder = Utf8StreamDecoder::default();
        let bytes = "日志".as_bytes();
        assert_eq!(decoder.push(&bytes[..2]), "");
        assert_eq!(decoder.push(&bytes[2..]), "日志");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn request_requires_tail_window_and_bounded_lines() {
        assert!(validate_request("viewer", "tail-1", "server", "/tmp/app.log", 200).is_ok());
        assert!(validate_request("viewer", "main", "server", "/tmp/app.log", 200).is_err());
        assert!(validate_request("viewer", "tail-1", "server", "/tmp/app.log", 1).is_err());
    }
}
