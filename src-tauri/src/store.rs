use std::{fs, path::PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};

use crate::{
    models::{
        JumpHop, PortForward, PortForwardInput, ServerInput, ServerRecord, Snippet, SnippetInput,
    },
    time::now,
};

const DB_FILE: &str = "ishell.db";
const KEY_FILE: &str = "secret.key";
const LEGACY_JSON: &str = "servers.json";
const COMMAND_HISTORY_LIMIT: i64 = 10_000;
/// Jump hosts allowed in front of a server (counting the server's own jump).
pub const MAX_JUMP_HOPS: usize = 3;

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
    last_connected_at INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    jump_server_id TEXT
);";

const COMMAND_HISTORY_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS command_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_history_created_at ON command_history(created_at DESC);";

const SNIPPETS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    run INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);";

const PORT_FORWARDS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS port_forwards (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    bind_host TEXT NOT NULL,
    bind_port INTEGER NOT NULL,
    dest_host TEXT NOT NULL DEFAULT '',
    dest_port INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    auto_start INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);";

const FORWARD_COLUMNS: &str = "id, server_id, kind, bind_host, bind_port, dest_host, dest_port, description, auto_start, created_at, updated_at";

const COLUMNS: &str = "id,name,host,port,username,\"group\",tags,auth_type,key_path,color,notes,created_at,updated_at,last_connected_at,sort_order,jump_server_id";

pub fn list_servers(app: &AppHandle) -> Result<Vec<ServerRecord>, String> {
    let conn = open_db(app)?;
    let sql = format!("SELECT {COLUMNS} FROM servers ORDER BY \"group\", sort_order, name");
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

/// Insert or update a server. When `secret` is `Some`, the password/passphrase
/// is encrypted (AES-256-GCM) and stored in the local SQLite database; when
/// `None`, the existing stored secret is preserved.
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
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16, NULL)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name, host=excluded.host, port=excluded.port,
               username=excluded.username, \"group\"=excluded.\"group\",
               tags=excluded.tags, auth_type=excluded.auth_type,
               key_path=excluded.key_path, color=excluded.color,
               notes=excluded.notes, updated_at=excluded.updated_at,
               last_connected_at=excluded.last_connected_at,
               sort_order=excluded.sort_order,
               jump_server_id=excluded.jump_server_id"
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
            record.sort_order as i64,
            record.jump_server_id,
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
    conn.execute("DELETE FROM port_forwards WHERE server_id = ?1", [id])
        .map_err(db_err)?;
    // Servers that went through this one now connect directly.
    conn.execute(
        "UPDATE servers SET jump_server_id = NULL WHERE jump_server_id = ?1",
        [id],
    )
    .map_err(db_err)?;
    Ok(())
}

/// The jump hosts in front of `server`, the one dialled first first. Fails on
/// a missing jump server, a loop, or a chain longer than `MAX_JUMP_HOPS`.
pub fn jump_hops(app: &AppHandle, server: &ServerRecord) -> Result<Vec<JumpHop>, String> {
    let mut hops = Vec::new();
    let mut seen = vec![server.id.clone()];
    let mut next = server.jump_server_id.clone();
    while let Some(jump_id) = next.filter(|id| !id.is_empty()) {
        if seen.contains(&jump_id) {
            return Err("跳板机设置出现循环，请检查各服务器的跳板机".into());
        }
        if hops.len() >= MAX_JUMP_HOPS {
            return Err(format!("跳板机最多串联 {MAX_JUMP_HOPS} 层"));
        }
        let jump = get_server(app, &jump_id)
            .map_err(|_| "找不到设置的跳板机，它可能已被删除".to_string())?;
        let secret = read_secret(app, &jump_id)
            .ok()
            .filter(|value| !value.is_empty());
        seen.push(jump_id);
        next = jump.jump_server_id.clone();
        hops.push(JumpHop {
            server: jump,
            secret,
        });
    }
    hops.reverse();
    Ok(hops)
}

pub fn reorder_servers(
    app: &AppHandle,
    items: &[crate::models::ServerOrderInput],
) -> Result<(), String> {
    let mut conn = open_db(app)?;
    let tx = conn.transaction().map_err(db_err)?;
    let stamp = now() as i64;
    for item in items {
        tx.execute(
            "UPDATE servers SET \"group\" = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4",
            params![item.group.trim(), item.sort_order as i64, stamp, item.id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;
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

pub fn list_snippets(app: &AppHandle) -> Result<Vec<Snippet>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, command, description, run, sort_order, created_at, updated_at
             FROM snippets
             ORDER BY sort_order, created_at",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Snippet {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                description: row.get(3)?,
                run: row.get::<_, i64>(4)? != 0,
                sort_order: row.get::<_, i64>(5)? as u64,
                created_at: row.get::<_, i64>(6)? as u64,
                updated_at: row.get::<_, i64>(7)? as u64,
            })
        })
        .map_err(db_err)?;

    let mut snippets = Vec::new();
    for row in rows {
        snippets.push(row.map_err(db_err)?);
    }
    Ok(snippets)
}

/// Insert a new snippet (at the end of the list) or update an existing one.
pub fn save_snippet(app: &AppHandle, input: SnippetInput) -> Result<Snippet, String> {
    let name = input.name.trim().to_string();
    let command = input.command.trim_end().to_string();
    if command.trim().is_empty() {
        return Err("命令不能为空".into());
    }
    let name = if name.is_empty() {
        command
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string()
    } else {
        name
    };

    let conn = open_db(app)?;
    let stamp = now();
    let existing = match input.id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => conn
            .query_row(
                "SELECT sort_order, created_at FROM snippets WHERE id = ?1",
                [id],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
            )
            .optional()
            .map_err(db_err)?,
        None => None,
    };
    let (id, sort_order, created_at) = match (input.id, existing) {
        (Some(id), Some((sort_order, created_at))) => (id, sort_order, created_at),
        _ => {
            let next_order: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM snippets",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            (uuid::Uuid::new_v4().to_string(), next_order as u64, stamp)
        }
    };

    let snippet = Snippet {
        id,
        name,
        command,
        description: input.description.trim().to_string(),
        run: input.run,
        sort_order,
        created_at,
        updated_at: stamp,
    };
    conn.execute(
        "INSERT INTO snippets (id, name, command, description, run, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, command=excluded.command, description=excluded.description,
           run=excluded.run, updated_at=excluded.updated_at",
        params![
            snippet.id,
            snippet.name,
            snippet.command,
            snippet.description,
            snippet.run as i64,
            snippet.sort_order as i64,
            snippet.created_at as i64,
            snippet.updated_at as i64,
        ],
    )
    .map_err(db_err)?;
    Ok(snippet)
}

pub fn delete_snippet(app: &AppHandle, id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute("DELETE FROM snippets WHERE id = ?1", [id])
        .map_err(db_err)?;
    Ok(())
}

fn row_to_forward(row: &rusqlite::Row) -> rusqlite::Result<PortForward> {
    Ok(PortForward {
        id: row.get(0)?,
        server_id: row.get(1)?,
        kind: row.get(2)?,
        bind_host: row.get(3)?,
        bind_port: row.get::<_, i64>(4)? as u16,
        dest_host: row.get(5)?,
        dest_port: row.get::<_, i64>(6)? as u16,
        description: row.get(7)?,
        auto_start: row.get::<_, i64>(8)? != 0,
        created_at: row.get::<_, i64>(9)? as u64,
        updated_at: row.get::<_, i64>(10)? as u64,
    })
}

pub fn list_port_forwards(app: &AppHandle) -> Result<Vec<PortForward>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {FORWARD_COLUMNS} FROM port_forwards ORDER BY created_at"
        ))
        .map_err(db_err)?;
    let rows = stmt.query_map([], row_to_forward).map_err(db_err)?;
    let mut forwards = Vec::new();
    for row in rows {
        forwards.push(row.map_err(db_err)?);
    }
    Ok(forwards)
}

pub fn get_port_forward(app: &AppHandle, id: &str) -> Result<PortForward, String> {
    let conn = open_db(app)?;
    conn.query_row(
        &format!("SELECT {FORWARD_COLUMNS} FROM port_forwards WHERE id = ?1"),
        [id],
        row_to_forward,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| "找不到该端口转发".into())
}

pub fn validate_port_forward(input: &PortForwardInput) -> Result<(), String> {
    if !matches!(input.kind.as_str(), "local" | "remote" | "dynamic") {
        return Err("转发类型无效".into());
    }
    if input.bind_port == 0 {
        return Err("监听端口必须在 1–65535 之间".into());
    }
    if input.kind != "dynamic" {
        if input.dest_host.trim().is_empty() {
            return Err("请填写目标主机".into());
        }
        if input.dest_port == 0 {
            return Err("目标端口必须在 1–65535 之间".into());
        }
    }
    Ok(())
}

pub fn save_port_forward(app: &AppHandle, input: PortForwardInput) -> Result<PortForward, String> {
    validate_port_forward(&input)?;
    get_server(app, &input.server_id)?;
    let conn = open_db(app)?;
    let stamp = now();
    let created_at = match input.id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => conn
            .query_row(
                "SELECT created_at FROM port_forwards WHERE id = ?1",
                [id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(db_err)?
            .map(|value| value as u64),
        None => None,
    };
    let bind_host = input.bind_host.trim();
    let forward = PortForward {
        id: input
            .id
            .filter(|id| !id.is_empty() && created_at.is_some())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        server_id: input.server_id,
        bind_host: if bind_host.is_empty() {
            "127.0.0.1".into()
        } else {
            bind_host.into()
        },
        bind_port: input.bind_port,
        dest_host: if input.kind == "dynamic" {
            String::new()
        } else {
            input.dest_host.trim().into()
        },
        dest_port: if input.kind == "dynamic" {
            0
        } else {
            input.dest_port
        },
        kind: input.kind,
        description: input.description.trim().into(),
        auto_start: input.auto_start,
        created_at: created_at.unwrap_or(stamp),
        updated_at: stamp,
    };
    conn.execute(
        &format!(
            "INSERT INTO port_forwards ({FORWARD_COLUMNS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               kind=excluded.kind, bind_host=excluded.bind_host, bind_port=excluded.bind_port,
               dest_host=excluded.dest_host, dest_port=excluded.dest_port,
               description=excluded.description, auto_start=excluded.auto_start,
               updated_at=excluded.updated_at"
        ),
        params![
            forward.id,
            forward.server_id,
            forward.kind,
            forward.bind_host,
            forward.bind_port as i64,
            forward.dest_host,
            forward.dest_port as i64,
            forward.description,
            forward.auto_start as i64,
            forward.created_at as i64,
            forward.updated_at as i64,
        ],
    )
    .map_err(db_err)?;
    Ok(forward)
}

pub fn delete_port_forward(app: &AppHandle, id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute("DELETE FROM port_forwards WHERE id = ?1", [id])
        .map_err(db_err)?;
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
        sort_order: row.get::<_, i64>(14)? as u64,
        jump_server_id: row.get(15)?,
    })
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(db_err)?;
    conn.execute_batch(SCHEMA).map_err(db_err)?;
    ensure_column(
        &conn,
        "sort_order",
        "ALTER TABLE servers ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &conn,
        "jump_server_id",
        "ALTER TABLE servers ADD COLUMN jump_server_id TEXT",
    )?;
    conn.execute_batch(COMMAND_HISTORY_SCHEMA).map_err(db_err)?;
    conn.execute_batch(SNIPPETS_SCHEMA).map_err(db_err)?;
    conn.execute_batch(PORT_FORWARDS_SCHEMA).map_err(db_err)?;
    migrate_legacy_json(app, &conn)?;
    Ok(conn)
}

/// Add a column to `servers` in databases created before it existed.
fn ensure_column(conn: &Connection, column: &str, alter: &str) -> Result<(), String> {
    let exists = conn
        .prepare("PRAGMA table_info(servers)")
        .map_err(db_err)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_err)?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !exists {
        conn.execute(alter, []).map_err(db_err)?;
    }
    Ok(())
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
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16, NULL)"
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
                record.sort_order as i64,
                record.jump_server_id,
            ],
        );
    }

    let _ = fs::rename(&json_path, json_path.with_extension("json.imported"));
    Ok(())
}

/// Encrypt a secret with AES-256-GCM. The output is `nonce (12 bytes) ||
/// ciphertext` and is stored verbatim in the `secret` BLOB column.
fn encrypt_secret(app: &AppHandle, plaintext: &str) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&master_key(app)?));
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|err| format!("无法生成随机数：{err}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| "密码加密失败".to_string())?;

    let mut blob = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
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
        .map_err(|_| "密码解密失败，请重新编辑主机并保存密码".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "密码解码失败".to_string())
}

/// Load the local AES master key, generating and persisting a fresh random key
/// on first use. The key lives in the app data directory with 0600 permissions.
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
    getrandom::getrandom(&mut key).map_err(|err| format!("无法生成本地主密钥：{err}"))?;
    fs::write(&path, key).map_err(|err| format!("无法写入本地主密钥：{err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(&path, permissions);
    }
    Ok(key)
}

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
