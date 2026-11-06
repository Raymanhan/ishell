use crate::store::{decrypt_secret, encrypt_secret, open_db};
use rusqlite::{params, Connection};
use serde_json::Value;
use tauri::AppHandle;

fn database(app: &AppHandle) -> Result<Connection, String> {
    let conn = open_db(app)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_history (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL)",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn serialize(input: &Value) -> Result<(&str, String), String> {
    let id = input["id"].as_str().ok_or("历史记录 ID 无效")?;
    uuid::Uuid::parse_str(id).map_err(|_| "历史记录 ID 无效")?;
    let server = input["serverId"].as_str().ok_or("历史记录服务器无效")?;
    if server.is_empty()
        || server.len() > 200
        || !input["entries"].is_array()
        || !input["messages"].is_array()
    {
        return Err("历史记录格式无效".into());
    }
    let json = serde_json::to_string(input).map_err(|e| e.to_string())?;
    if json.len() > 32 * 1024 * 1024 {
        return Err("单条历史记录超过 32 MB，无法保存".into());
    }
    Ok((id, json))
}

#[tauri::command]
pub async fn ai_get_history(app: AppHandle) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = database(&app)?;
        let mut statement = conn
            .prepare("SELECT encrypted FROM ai_history")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let json = decrypt_secret(&app, &row.map_err(|e| e.to_string())?)?;
            serde_json::from_str(&json).map_err(|_| "AI 历史记录无法读取".into())
        })
        .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_save_history(app: AppHandle, input: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (id, json) = serialize(&input)?;
        let blob = encrypt_secret(&app, &json)?;
        database(&app)?.execute("INSERT INTO ai_history (id, encrypted) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted", params![id, blob]).map_err(|e| e.to_string())?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_delete_history(app: AppHandle, id: String) -> Result<(), String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "历史记录 ID 无效")?;
    tauri::async_runtime::spawn_blocking(move || {
        database(&app)?
            .execute("DELETE FROM ai_history WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_history_before_storage() {
        let mut value = serde_json::json!({"id": uuid::Uuid::new_v4().to_string(), "serverId": "server", "entries": [], "messages": []});
        assert!(serialize(&value).is_ok());
        value["serverId"] = "".into();
        assert!(serialize(&value).is_err());
        value["serverId"] = "server".into();
        value["id"] = "bad".into();
        assert!(serialize(&value).is_err());
    }
}
