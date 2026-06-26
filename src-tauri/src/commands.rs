use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::SystemTime,
};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    models::{
        ConnectionTest, NetworkSample, ServerInput, ServerRecord, ServerStatus, SftpEntry,
        TerminalSnapshotPayload,
    },
    pool::SshPool,
    ssh::{
        connect_server, download_file, fetch_network_sample as fetch_network, fetch_status,
        list_sftp, make_directory, remove_entry, rename_entry, upload_file,
    },
    store::{
        append_command_history, delete_server as remove_server, get_server,
        list_command_history as load_command_history, list_servers as load_servers, mark_connected,
        normalize_tags, upsert_server, validate_server,
    },
    terminal::{self, TerminalRegistry},
    time::now,
};

#[derive(Default)]
pub struct UploadCancelRegistry {
    canceled: Mutex<HashSet<String>>,
}

impl UploadCancelRegistry {
    fn clear(&self, transfer_id: &str) {
        if let Ok(mut canceled) = self.canceled.lock() {
            canceled.remove(transfer_id);
        }
    }

    fn cancel(&self, transfer_id: &str) {
        if let Ok(mut canceled) = self.canceled.lock() {
            canceled.insert(transfer_id.to_string());
        }
    }

    fn is_canceled(&self, transfer_id: &str) -> bool {
        self.canceled
            .lock()
            .map(|canceled| canceled.contains(transfer_id))
            .unwrap_or(false)
    }
}

#[derive(Default)]
pub struct DownloadCancelRegistry {
    canceled: Mutex<HashSet<String>>,
}

impl DownloadCancelRegistry {
    fn clear(&self, transfer_id: &str) {
        if let Ok(mut canceled) = self.canceled.lock() {
            canceled.remove(transfer_id);
        }
    }

    fn cancel(&self, transfer_id: &str) {
        if let Ok(mut canceled) = self.canceled.lock() {
            canceled.insert(transfer_id.to_string());
        }
    }

    fn is_canceled(&self, transfer_id: &str) -> bool {
        self.canceled
            .lock()
            .map(|canceled| canceled.contains(transfer_id))
            .unwrap_or(false)
    }
}

async fn run_blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|err| format!("后台任务失败：{err}"))?
}

#[tauri::command]
pub fn list_servers(app: AppHandle) -> Result<Vec<ServerRecord>, String> {
    load_servers(&app)
}

#[tauri::command]
pub fn save_server(
    app: AppHandle,
    input: ServerInput,
    password: Option<String>,
) -> Result<ServerRecord, String> {
    validate_server(&input)?;

    let id = input
        .id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let current = get_server(&app, &id).ok();
    let created_at = current
        .as_ref()
        .map(|server| server.created_at)
        .unwrap_or_else(now);

    let record = ServerRecord {
        id,
        name: input.name.trim().to_string(),
        host: input.host.trim().to_string(),
        port: input.port,
        username: input.username.trim().to_string(),
        group: input.group.trim().to_string(),
        tags: normalize_tags(input.tags),
        auth_type: input.auth_type,
        key_path: input.key_path.filter(|path| !path.trim().is_empty()),
        color: input.color,
        notes: input.notes.trim().to_string(),
        created_at,
        updated_at: now(),
        last_connected_at: current.and_then(|server| server.last_connected_at),
    };

    let secret = password.as_deref().filter(|value| !value.is_empty());
    upsert_server(&app, &record, secret)?;

    Ok(record)
}

#[tauri::command]
pub fn delete_server(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    id: String,
) -> Result<(), String> {
    pool.invalidate(&id);
    remove_server(&app, &id)
}

#[tauri::command]
pub fn list_command_history(app: AppHandle) -> Result<Vec<String>, String> {
    load_command_history(&app)
}

#[tauri::command]
pub fn save_command_history(app: AppHandle, command_text: String) -> Result<(), String> {
    append_command_history(&app, &command_text)
}

#[tauri::command]
pub async fn test_connection(app: AppHandle, id: String) -> Result<ConnectionTest, String> {
    run_blocking(move || {
        let started = SystemTime::now();
        let (_session, server) = connect_server(&app, &id)?;
        mark_connected(&app, &id)?;
        let latency_ms = started.elapsed().unwrap_or_default().as_millis();

        Ok(ConnectionTest {
            ok: true,
            message: format!("已连接 {}@{}", server.username, server.host),
            latency_ms,
        })
    })
    .await
}

#[tauri::command]
pub async fn fetch_server_status(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    id: String,
    include_disk: Option<bool>,
) -> Result<ServerStatus, String> {
    let pool = pool.inner().clone();
    run_blocking(move || fetch_status(&pool, &app, &id, include_disk.unwrap_or(true))).await
}

#[tauri::command]
pub async fn fetch_network_sample(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    id: String,
) -> Result<NetworkSample, String> {
    let pool = pool.inner().clone();
    run_blocking(move || fetch_network(&pool, &app, &id)).await
}

#[tauri::command]
pub async fn sftp_list(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let pool = pool.inner().clone();
    run_blocking(move || list_sftp(&pool, &app, &id, &path)).await
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    cancels: State<'_, Arc<DownloadCancelRegistry>>,
    id: String,
    path: String,
    transfer_id: String,
) -> Result<String, String> {
    let pool = pool.inner().clone();
    let cancels = cancels.inner().clone();
    cancels.clear(&transfer_id);
    run_blocking(move || {
        let is_canceled = || cancels.is_canceled(&transfer_id);
        let result = download_file(&pool, &app, &id, &path, &transfer_id, &is_canceled);
        cancels.clear(&transfer_id);
        result
    })
    .await
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    cancels: State<'_, Arc<UploadCancelRegistry>>,
    id: String,
    local_path: String,
    remote_dir: String,
    transfer_id: String,
) -> Result<String, String> {
    let pool = pool.inner().clone();
    let cancels = cancels.inner().clone();
    cancels.clear(&transfer_id);
    run_blocking(move || {
        let is_canceled = || cancels.is_canceled(&transfer_id);
        let result = upload_file(
            &pool,
            &app,
            &id,
            &local_path,
            &remote_dir,
            &transfer_id,
            &is_canceled,
        );
        cancels.clear(&transfer_id);
        result
    })
    .await
}

#[tauri::command]
pub fn cancel_upload(cancels: State<'_, Arc<UploadCancelRegistry>>, transfer_id: String) {
    cancels.cancel(&transfer_id);
}

#[tauri::command]
pub fn cancel_download(cancels: State<'_, Arc<DownloadCancelRegistry>>, transfer_id: String) {
    cancels.cancel(&transfer_id);
}

#[tauri::command]
pub async fn sftp_mkdir(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    id: String,
    path: String,
) -> Result<(), String> {
    let pool = pool.inner().clone();
    run_blocking(move || make_directory(&pool, &app, &id, &path)).await
}

#[tauri::command]
pub async fn sftp_remove(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let pool = pool.inner().clone();
    run_blocking(move || remove_entry(&pool, &app, &id, &path, is_dir)).await
}

#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let pool = pool.inner().clone();
    run_blocking(move || rename_entry(&pool, &app, &id, &from, &to)).await
}

#[tauri::command]
pub fn open_terminal(
    app: AppHandle,
    registry: State<'_, Arc<TerminalRegistry>>,
    id: String,
) -> Result<String, String> {
    terminal::open_terminal(app, registry, id)
}

#[tauri::command]
pub fn terminal_input(
    registry: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    terminal::terminal_input(registry, session_id, data)
}

#[tauri::command]
pub fn terminal_resize(
    registry: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminal::terminal_resize(registry, session_id, cols, rows)
}

#[tauri::command]
pub fn close_terminal(
    registry: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
) -> Result<(), String> {
    terminal::close_terminal(registry, session_id)
}

#[tauri::command]
pub fn terminal_snapshot(
    registry: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
) -> Result<TerminalSnapshotPayload, String> {
    terminal::terminal_snapshot(registry, session_id)
}
