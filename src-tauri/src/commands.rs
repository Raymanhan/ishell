use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Read, Write},
    sync::{Arc, Mutex},
    time::SystemTime,
};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    models::{
        ConnectionExport, ConnectionExportServer, ConnectionImport, ConnectionImportServer,
        ConnectionTest, EncryptedExportSecret, NetworkSample, ServerInput, ServerRecord,
        ServerStatus, SftpEntry, TerminalSnapshotPayload,
    },
    pool::SshPool,
    ssh::{
        connect_server, download_file, fetch_network_sample as fetch_network, fetch_status,
        list_sftp, make_directory, read_text_file, remove_entry, rename_entry, upload_file,
        write_text_file,
    },
    store::{
        append_command_history, delete_server as remove_server, get_server,
        list_command_history as load_command_history, list_servers as load_servers, mark_connected,
        normalize_tags, read_secret, upsert_server, validate_server,
    },
    terminal::{self, TerminalRegistry},
    time::now,
};

const CONNECTION_EXPORT_VERSION: u32 = 1;
const EXPORT_SECRET_ITERATIONS: u32 = 210_000;

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

fn is_zip_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") || bytes.starts_with(b"PK\x07\x08")
}

fn read_connection_export_from_zip(bytes: &[u8]) -> Result<ConnectionExport, String> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|err| format!("无法读取 ZIP：{err}"))?;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("无法读取 ZIP 条目：{err}"))?;
        if !file.name().ends_with(".json") {
            continue;
        }
        let mut json = Vec::new();
        file.read_to_end(&mut json)
            .map_err(|err| format!("无法读取 ZIP 中的 JSON：{err}"))?;
        return parse_connection_export(&json);
    }
    Err("ZIP 中没有找到连接 JSON 文件".to_string())
}

fn parse_connection_export(bytes: &[u8]) -> Result<ConnectionExport, String> {
    if let Ok(export) = serde_json::from_slice::<ConnectionExport>(bytes) {
        return Ok(export);
    }
    if let Ok(servers) = serde_json::from_slice::<Vec<ServerRecord>>(bytes) {
        return Ok(ConnectionExport {
            version: CONNECTION_EXPORT_VERSION,
            exported_at: now(),
            folders: servers.iter().map(|server| server.group.clone()).collect(),
            servers: servers
                .into_iter()
                .map(|server| ConnectionExportServer {
                    server,
                    encrypted_secret: None,
                })
                .collect(),
        });
    }
    if let Ok(server) = serde_json::from_slice::<ServerRecord>(bytes) {
        return Ok(ConnectionExport {
            version: CONNECTION_EXPORT_VERSION,
            exported_at: now(),
            folders: vec![server.group.clone()],
            servers: vec![ConnectionExportServer {
                server,
                encrypted_secret: None,
            }],
        });
    }
    Err("导入文件格式不正确".to_string())
}

fn server_record_to_input(server: ServerRecord) -> ServerInput {
    ServerInput {
        id: Some(server.id),
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        group: server.group,
        tags: server.tags,
        auth_type: server.auth_type,
        key_path: server.key_path,
        color: server.color,
        notes: server.notes,
    }
}

fn encrypt_export_secret(passphrase: &str, plaintext: &str) -> Result<EncryptedExportSecret, String> {
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut salt).map_err(|err| format!("无法生成导出 salt：{err}"))?;
    getrandom::getrandom(&mut nonce_bytes).map_err(|err| format!("无法生成导出 nonce：{err}"))?;
    let key = derive_export_key(passphrase, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|_| "密码导出加密失败".to_string())?;
    Ok(EncryptedExportSecret {
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
        kdf: "PBKDF2-HMAC-SHA256".to_string(),
        iterations: EXPORT_SECRET_ITERATIONS,
    })
}

fn decrypt_export_secret(passphrase: &str, encrypted: &EncryptedExportSecret) -> Result<String, String> {
    if encrypted.kdf != "PBKDF2-HMAC-SHA256" || encrypted.iterations != EXPORT_SECRET_ITERATIONS {
        return Err("不支持的导出密码加密格式".to_string());
    }
    let salt = BASE64
        .decode(&encrypted.salt)
        .map_err(|_| "导入文件 salt 无效".to_string())?;
    let nonce = BASE64
        .decode(&encrypted.nonce)
        .map_err(|_| "导入文件 nonce 无效".to_string())?;
    if nonce.len() != 12 {
        return Err("导入文件 nonce 长度无效".to_string());
    }
    let ciphertext = BASE64
        .decode(&encrypted.ciphertext)
        .map_err(|_| "导入文件密文无效".to_string())?;
    let key = derive_export_key(passphrase, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "导入密钥不正确，无法解密密码".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "导入密码内容不是有效文本".to_string())
}

fn derive_export_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(
        passphrase.as_bytes(),
        salt,
        EXPORT_SECRET_ITERATIONS,
        &mut key,
    );
    key
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
pub fn export_connections(
    app: AppHandle,
    path: String,
    payload: ConnectionExport,
    as_zip: bool,
    passphrase: Option<String>,
) -> Result<(), String> {
    let passphrase = passphrase.filter(|value| !value.is_empty());
    let export = ConnectionExport {
        version: CONNECTION_EXPORT_VERSION,
        exported_at: now(),
        folders: payload
            .folders
            .into_iter()
            .map(|folder| folder.trim().to_string())
            .filter(|folder| !folder.is_empty())
            .collect(),
        servers: payload
            .servers
            .into_iter()
            .map(|mut item| {
                if let Some(passphrase) = passphrase.as_deref() {
                    if let Ok(secret) = read_secret(&app, &item.server.id) {
                        if !secret.is_empty() {
                            item.encrypted_secret = Some(encrypt_export_secret(passphrase, &secret)?);
                        }
                    }
                }
                Ok(item)
            })
            .collect::<Result<Vec<_>, String>>()?,
    };
    let json = serde_json::to_vec_pretty(&export).map_err(|err| format!("无法序列化连接：{err}"))?;
    if !as_zip {
        fs::write(&path, json).map_err(|err| format!("无法写入导出文件：{err}"))?;
        return Ok(());
    }

    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer
        .start_file("connections.json", options)
        .map_err(|err| format!("无法创建 ZIP 条目：{err}"))?;
    writer
        .write_all(&json)
        .map_err(|err| format!("无法写入 ZIP：{err}"))?;
    let cursor = writer
        .finish()
        .map_err(|err| format!("无法完成 ZIP：{err}"))?;
    fs::write(&path, cursor.into_inner()).map_err(|err| format!("无法写入导出文件：{err}"))?;
    Ok(())
}

#[tauri::command]
pub fn import_connections(path: String, passphrase: Option<String>) -> Result<ConnectionImport, String> {
    let bytes = fs::read(&path).map_err(|err| format!("无法读取导入文件：{err}"))?;
    let export = if is_zip_bytes(&bytes) {
        read_connection_export_from_zip(&bytes)?
    } else {
        parse_connection_export(&bytes)?
    };

    Ok(ConnectionImport {
        folders: export.folders,
        servers: export
            .servers
            .into_iter()
            .map(|item| {
                let password = match item.encrypted_secret {
                    Some(secret) => {
                        let passphrase = passphrase
                            .as_deref()
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| "导入文件包含加密密码，请输入导入密钥".to_string())?;
                        Some(decrypt_export_secret(passphrase, &secret)?)
                    }
                    None => None,
                };
                Ok(ConnectionImportServer {
                    input: server_record_to_input(item.server),
                    password,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
    })
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
pub fn invalidate_connection(pool: State<'_, Arc<SshPool>>, id: String) {
    pool.invalidate(&id);
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
pub async fn sftp_read_text_file(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    id: String,
    path: String,
) -> Result<String, String> {
    let pool = pool.inner().clone();
    run_blocking(move || read_text_file(&pool, &app, &id, &path)).await
}

#[tauri::command]
pub async fn sftp_write_text_file(
    app: AppHandle,
    pool: State<'_, Arc<SshPool>>,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let pool = pool.inner().clone();
    run_blocking(move || write_text_file(&pool, &app, &id, &path, &content)).await
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
