use crate::store::{decrypt_secret, encrypt_secret, open_db};
use rusqlite::{params, Connection};
use serde::Serialize;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryList {
    records: Vec<Value>,
    /// Records that could not be decrypted or parsed. They stay in the
    /// database untouched; one bad row must not disable the whole AI panel.
    skipped: usize,
}

fn read_records(
    rows: impl Iterator<Item = Result<Vec<u8>, String>>,
    decrypt: impl Fn(&[u8]) -> Result<String, String>,
) -> HistoryList {
    let mut list = HistoryList {
        records: Vec::new(),
        skipped: 0,
    };
    for row in rows {
        match row
            .and_then(|blob| decrypt(&blob))
            .and_then(|json| serde_json::from_str::<Value>(&json).map_err(|e| e.to_string()))
        {
            Ok(value) if serialize(&value).is_ok() => list.records.push(value),
            _ => list.skipped += 1,
        }
    }
    list
}

#[tauri::command]
pub async fn ai_get_history(app: AppHandle) -> Result<HistoryList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = database(&app)?;
        let mut statement = conn
            .prepare("SELECT encrypted FROM ai_history")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|e| e.to_string())?;
        Ok(read_records(
            rows.map(|row| row.map_err(|e| e.to_string())),
            |blob| decrypt_secret(&app, blob),
        ))
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
    #[test]
    fn unreadable_records_are_skipped_instead_of_failing_the_whole_history() {
        let good = serde_json::json!({"id": uuid::Uuid::new_v4().to_string(), "serverId": "s", "entries": [], "messages": []}).to_string();
        let rows = vec![
            Ok(good.clone().into_bytes()),
            Ok(b"wrong key".to_vec()),
            Ok(b"not json".to_vec()),
            Ok(br#"{"id":"bad"}"#.to_vec()),
            Err("row error".to_string()),
        ];
        let list = read_records(rows.into_iter(), |blob| {
            if blob == b"wrong key" {
                Err("密码解密失败".into())
            } else {
                Ok(String::from_utf8(blob.to_vec()).unwrap())
            }
        });
        assert_eq!(list.records.len(), 1);
        assert_eq!(list.records[0]["serverId"], "s");
        assert_eq!(list.skipped, 4);
    }
}
