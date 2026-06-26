use std::{fs, path::PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};

use crate::{
    models::{ServerInput, ServerRecord},
    time::now,
};

const DB_FILE: &str = "ishell.db";
const KEY_FILE: &str = "secret.key";
const LEGACY_JSON: &str = "servers.json";
const COMMAND_HISTORY_LIMIT: i64 = 10_000;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    \"group\" TEXT NOT NULL,
    tags TEXT NOT NULL,
    auth_type TEXT NOT NULL,
    key_path TEXT,
    color TEXT NOT NULL,
    notes TEXT NOT NULL,
    secret BLOB,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_connected_at INTEGER
);";

const COMMAND_HISTORY_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS command_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_history_created_at ON command_history(created_at DESC);";

const COLUMNS: &str = "id,name,host,port,username,\"group\",tags,auth_type,key_path,color,notes,created_at,updated_at,last_connected_at";

pub fn list_servers(app: &AppHandle) -> Result<Vec<ServerRecord>, String> {
    let conn = open_db(app)?;
    let sql = format!("SELECT {COLUMNS} FROM servers ORDER BY \"group\", name");
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt.query_map([], row_to_record).map_err(db_err)?;

    let mut servers = Vec::new();
    for row in rows {
        servers.push(row.map_err(db_err)?);
    }
    Ok(servers)
}

pub fn get_server(app: &AppHandle, id: &str) -> Result<ServerRecord, String> {
    let conn = open_db(app)?;
    let sql = format!("SELECT {COLUMNS} FROM servers WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_record)
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| "找不到该服务器".into())
}

/// Insert or update a server. When `secret` is `Some`, the encrypted password
/// is (re)written; when `None`, the stored secret is left untouched so editing
/// a host without retyping the password keeps the existing one.
pub fn upsert_server(
    app: &AppHandle,
    record: &ServerRecord,
    secret: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    let tags = serde_json::to_string(&record.tags).map_err(|err| err.to_string())?;

    conn.execute(
        &format!(
            "INSERT INTO servers ({COLUMNS}, secret)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14, NULL)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name, host=excluded.host, port=excluded.port,
               username=excluded.username, \"group\"=excluded.\"group\",
               tags=excluded.tags, auth_type=excluded.auth_type,
               key_path=excluded.key_path, color=excluded.color,
               notes=excluded.notes, updated_at=excluded.updated_at,
               last_connected_at=excluded.last_connected_at"
        ),
        params![
            record.id,
            record.name,
            record.host,
            record.port as i64,
            record.username,
            record.group,
            tags,
            record.auth_type,
            record.key_path,
            record.color,
            record.notes,
            record.created_at as i64,
            record.updated_at as i64,
            record.last_connected_at.map(|value| value as i64),
        ],
    )
    .map_err(db_err)?;

    if let Some(plaintext) = secret {
        let blob = encrypt_secret(app, plaintext)?;
        conn.execute(
            "UPDATE servers SET secret = ?1 WHERE id = ?2",
            params![blob, record.id],
        )
        .map_err(db_err)?;
    }

    Ok(())
}

pub fn delete_server(app: &AppHandle, id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute("DELETE FROM servers WHERE id = ?1", [id])
        .map_err(db_err)?;
    Ok(())
}

pub fn mark_connected(app: &AppHandle, id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    let stamp = now() as i64;
    conn.execute(
        "UPDATE servers SET last_connected_at = ?1, updated_at = ?2 WHERE id = ?3",
        params![stamp, stamp, id],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn read_secret(app: &AppHandle, id: &str) -> Result<String, String> {
    let conn = open_db(app)?;
    let blob: Option<Vec<u8>> = conn
        .query_row("SELECT secret FROM servers WHERE id = ?1", [id], |row| {
            row.get::<_, Option<Vec<u8>>>(0)
        })
        .optional()
        .map_err(db_err)?
        .flatten();

    match blob {
        Some(bytes) => decrypt_secret(app, &bytes),
        None => Err("尚未保存该主机的密码，请编辑主机并填写密码后重试".into()),
    }
}

pub fn list_command_history(app: &AppHandle) -> Result<Vec<String>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(
            "SELECT command
             FROM command_history
             ORDER BY id DESC
             LIMIT ?1",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([COMMAND_HISTORY_LIMIT], |row| row.get::<_, String>(0))
        .map_err(db_err)?;

    let mut commands = Vec::new();
    for row in rows {
        commands.push(row.map_err(db_err)?);
    }
    Ok(commands)
}

pub fn append_command_history(app: &AppHandle, command_text: &str) -> Result<(), String> {
    let command_text = command_text.trim();
    if command_text.is_empty() {
        return Ok(());
    }

    let mut conn = open_db(app)?;
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute(
        "INSERT INTO command_history (command, created_at) VALUES (?1, ?2)",
        params![command_text, now() as i64],
    )
    .map_err(db_err)?;
    tx.execute(
        "DELETE FROM command_history
         WHERE id NOT IN (
           SELECT id FROM command_history ORDER BY id DESC LIMIT ?1
         )",
        [COMMAND_HISTORY_LIMIT],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(())
}

pub fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    tags.into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect()
}

pub fn validate_server(input: &ServerInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("服务器名称不能为空".into());
    }
    if input.host.trim().is_empty() {
        return Err("主机地址不能为空".into());
    }
    if input.username.trim().is_empty() {
        return Err("用户名不能为空".into());
    }
    if input.port == 0 {
        return Err("端口必须大于 0".into());
    }
    if input.auth_type != "password" && input.auth_type != "key" {
        return Err("认证方式无效".into());
    }
    if input.auth_type == "key" && input.key_path.as_deref().unwrap_or("").trim().is_empty() {
        return Err("密钥认证需要填写私钥路径".into());
    }
    Ok(())
}

// ===== internals =====

fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<ServerRecord> {
    let tags_json: String = row.get(6)?;
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

    Ok(ServerRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get::<_, i64>(3)? as u16,
        username: row.get(4)?,
        group: row.get(5)?,
        tags,
        auth_type: row.get(7)?,
        key_path: row.get(8)?,
        color: row.get(9)?,
        notes: row.get(10)?,
        created_at: row.get::<_, i64>(11)? as u64,
        updated_at: row.get::<_, i64>(12)? as u64,
        last_connected_at: row.get::<_, Option<i64>>(13)?.map(|value| value as u64),
    })
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(db_err)?;
    conn.execute_batch(SCHEMA).map_err(db_err)?;
    conn.execute_batch(COMMAND_HISTORY_SCHEMA).map_err(db_err)?;
    migrate_legacy_json(app, &conn)?;
    Ok(conn)
}

/// Best-effort one-time import of host metadata from the old `servers.json`
/// store. Passwords are not migrated (they lived in the OS keychain) and must
/// be re-entered once.
fn migrate_legacy_json(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM servers", [], |row| row.get(0))
        .map_err(db_err)?;
    if count > 0 {
        return Ok(());
    }

    let json_path = app_data_dir(app)?.join(LEGACY_JSON);
    if !json_path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&json_path).unwrap_or_default();
    if content.trim().is_empty() {
        return Ok(());
    }
    let records: Vec<ServerRecord> = serde_json::from_str(&content).unwrap_or_default();

    for record in &records {
        let tags = serde_json::to_string(&record.tags).unwrap_or_else(|_| "[]".into());
        let _ = conn.execute(
            &format!(
                "INSERT OR IGNORE INTO servers ({COLUMNS}, secret)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14, NULL)"
            ),
            params![
                record.id,
                record.name,
                record.host,
                record.port as i64,
                record.username,
                record.group,
                tags,
                record.auth_type,
                record.key_path,
                record.color,
                record.notes,
                record.created_at as i64,
                record.updated_at as i64,
                record.last_connected_at.map(|value| value as i64),
            ],
        );
    }

    let _ = fs::rename(&json_path, json_path.with_extension("json.imported"));
    Ok(())
}

fn encrypt_secret(app: &AppHandle, plaintext: &str) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&master_key(app)?));
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|err| format!("无法生成随机数：{err}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| "密码加密失败".to_string())?;

    let mut blob = Vec::with_capacity(12 + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

fn decrypt_secret(app: &AppHandle, blob: &[u8]) -> Result<String, String> {
    if blob.len() < 12 {
        return Err("密码数据已损坏".into());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&master_key(app)?));
    let nonce = Nonce::from_slice(&blob[..12]);
    let plaintext = cipher
        .decrypt(nonce, &blob[12..])
        .map_err(|_| "密码解密失败".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "密码解码失败".to_string())
}

/// Load (or lazily create) the 32-byte master key used to encrypt secrets.
fn master_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let path = app_data_dir(app)?.join(KEY_FILE);
    if let Ok(bytes) = fs::read(&path) {
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }

    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|err| format!("无法生成主密钥：{err}"))?;
    fs::write(&path, key).map_err(|err| format!("无法写入主密钥：{err}"))?;
    restrict_permissions(&path);
    Ok(key)
}

#[cfg(unix)]
fn restrict_permissions(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &PathBuf) {}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("无法定位应用数据目录：{err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建应用数据目录：{err}"))?;
    Ok(dir)
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(DB_FILE))
}

fn db_err(err: rusqlite::Error) -> String {
    format!("本地数据库错误：{err}")
}
