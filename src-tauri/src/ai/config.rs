use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::metadata::Model;
use crate::store::{decrypt_secret, encrypt_secret, open_db};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub base_url: String,
    pub models: Vec<String>,
    pub manual_models: Vec<String>,
    pub model_metadata: Vec<Model>,
    pub default_model: String,
    pub api_key: String,
    pub default_permission: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".into(),
            models: vec![],
            manual_models: vec![],
            model_metadata: vec![],
            default_model: String::new(),
            api_key: String::new(),
            default_permission: "auto".into(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub base_url: String,
    pub models: Vec<String>,
    pub manual_models: Vec<String>,
    pub model_metadata: Vec<Model>,
    pub default_model: String,
    pub has_api_key: bool,
    pub default_permission: String,
    pub metadata_error: Option<String>,
}

impl From<&Config> for PublicConfig {
    fn from(value: &Config) -> Self {
        Self {
            base_url: value.base_url.clone(),
            models: value.models.clone(),
            manual_models: value.manual_models.clone(),
            model_metadata: value.model_metadata.clone(),
            default_model: value.default_model.clone(),
            has_api_key: !value.api_key.is_empty(),
            default_permission: value.default_permission.clone(),
            metadata_error: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInput {
    pub base_url: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub manual_models: Vec<String>,
    pub default_model: String,
    /// None preserves the stored key; Some("") explicitly clears it.
    pub api_key: Option<String>,
    #[serde(default = "default_permission")]
    pub default_permission: String,
}
fn default_permission() -> String {
    "auto".into()
}

pub fn normalize_url(raw: &str) -> Result<String, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "请输入完整的模型 API 地址".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("API 地址应为 HTTP(S) 地址，不包含密钥、查询参数或片段".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    let path = path
        .strip_suffix("/chat/completions")
        .or_else(|| path.strip_suffix("/models"))
        .unwrap_or(&path);
    url.set_path(path);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

pub fn load(app: &AppHandle) -> Result<Config, String> {
    let conn = open_db(app)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ai_settings (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL)")
        .map_err(|e| e.to_string())?;
    use rusqlite::OptionalExtension;
    let blob = conn
        .query_row("SELECT encrypted FROM ai_settings WHERE id=1", [], |row| {
            row.get::<_, Vec<u8>>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    match blob {
        Some(blob) => {
            let mut config: Config = serde_json::from_str(&decrypt_secret(app, &blob)?)
                .map_err(|_| "AI 设置无法读取".to_string())?;
            if config.model_metadata.is_empty() && config.manual_models.is_empty() {
                config.manual_models = config.models.clone();
            }
            Ok(config)
        }
        None => Ok(Config::default()),
    }
}

pub fn merge(old: Config, input: ConfigInput) -> Result<Config, String> {
    if !matches!(
        input.default_permission.as_str(),
        "suggest" | "ask" | "auto" | "full"
    ) {
        return Err("默认权限无效".into());
    }
    let mut models = Vec::new();
    for model in input.models {
        let model = model.trim().to_string();
        if !model.is_empty() && model.len() <= 200 && !models.contains(&model) {
            models.push(model);
        }
    }
    if models.len() > 1000 {
        return Err("最多配置 1000 个模型（含手动补充）".into());
    }
    let mut manual_models = Vec::new();
    for model in input.manual_models {
        let id = model.trim().to_string();
        if !id.is_empty()
            && id.len() <= 200
            && !id.chars().any(char::is_control)
            && !manual_models.contains(&id)
        {
            manual_models.push(id);
        }
    }
    if manual_models.len() > 500 {
        return Err("最多配置 500 个手动模型".into());
    }
    let default_model = input.default_model.trim().to_string();
    if default_model.len() > 200 {
        return Err("模型 ID 最多为 200 字节".into());
    }
    if !default_model.is_empty() && !models.contains(&default_model) {
        models.insert(0, default_model.clone());
    }
    let api_key = input
        .api_key
        .unwrap_or_else(|| old.api_key.clone())
        .trim()
        .to_string();
    if api_key.len() > 4096 || api_key.contains(['\r', '\n']) {
        return Err("API 密钥格式无效".into());
    }
    let base_url = normalize_url(&input.base_url)?;
    // The previous catalog still describes the same service, so a temporary
    // /models failure while saving (say) the permission mode must not wipe
    // the model list and default model. A new endpoint or key starts empty.
    let model_metadata = if base_url == old.base_url && api_key == old.api_key {
        old.model_metadata
    } else {
        vec![]
    };
    Ok(Config {
        base_url,
        models,
        manual_models,
        model_metadata,
        default_model,
        api_key,
        default_permission: input.default_permission,
    })
}

pub fn save(app: &AppHandle, config: Config) -> Result<PublicConfig, String> {
    let blob = encrypt_secret(
        app,
        &serde_json::to_string(&config).map_err(|e| e.to_string())?,
    )?;
    open_db(app)?.execute("INSERT INTO ai_settings (id, encrypted) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted", [blob])
        .map_err(|e| e.to_string())?;
    Ok(PublicConfig::from(&config))
}

pub fn apply_metadata(config: &mut Config, result: Result<Vec<Model>, String>) -> Option<String> {
    let error = match result {
        Ok(models) => {
            config.model_metadata = models;
            None
        }
        // `merge` already kept or dropped the previous catalog.
        Err(error) => Some(error),
    };
    config.models = config
        .model_metadata
        .iter()
        .map(|model| model.id.clone())
        .collect();
    for id in &config.manual_models {
        if !config.models.contains(id) {
            config.models.push(id.clone());
        }
    }
    if !config.models.contains(&config.default_model) {
        config.default_model = config.models.first().cloned().unwrap_or_default();
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_replaces_manual_ids_and_failed_discovery_still_allows_key_removal() {
        let mut config = Config {
            models: vec!["old-manual".into()],
            default_model: "old-manual".into(),
            ..Config::default()
        };
        let catalog = super::super::metadata::catalog(
            &serde_json::json!({"data":[{"id":"remote","supported_reasoning_efforts":["high"]}]}),
        )
        .unwrap();
        assert!(apply_metadata(&mut config, Ok(catalog)).is_none());
        assert_eq!(config.default_model, "remote");
        assert_eq!(config.models, ["remote"]);
        // Same service, temporary failure: the known catalog stays usable.
        let same = merge(
            config.clone(),
            ConfigInput {
                base_url: config.base_url.clone(),
                models: vec![],
                manual_models: vec![],
                default_model: "remote".into(),
                api_key: None,
                default_permission: "ask".into(),
            },
        )
        .unwrap();
        let mut retained = same;
        assert_eq!(
            apply_metadata(&mut retained, Err("timeout".into())).as_deref(),
            Some("timeout")
        );
        assert_eq!(retained.models, ["remote"]);
        assert_eq!(retained.default_model, "remote");
        // A different endpoint never inherits the old catalog.
        let mut moved = merge(
            config.clone(),
            ConfigInput {
                base_url: "https://other.example/v1".into(),
                models: vec![],
                manual_models: vec![],
                default_model: "remote".into(),
                api_key: None,
                default_permission: "auto".into(),
            },
        )
        .unwrap();
        assert_eq!(
            apply_metadata(&mut moved, Err("401".into())).as_deref(),
            Some("401")
        );
        assert!(moved.model_metadata.is_empty());
        assert!(moved.models.is_empty());
        config.model_metadata.clear();
        apply_metadata(&mut config, Err("401".into()));
        assert!(config.models.is_empty());
        assert!(config.api_key.is_empty());
        config.manual_models = vec!["private-model".into()];
        apply_metadata(&mut config, Err("metadata unavailable".into()));
        assert_eq!(config.models, ["private-model"]);
        assert_eq!(config.default_model, "private-model");
    }
    #[test]
    fn endpoint_normalization() {
        assert_eq!(
            normalize_url(" https://example.com/v1/chat/completions/ ").unwrap(),
            "https://example.com/v1"
        );
        assert_eq!(
            normalize_url("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/v1"
        );
        for url in [
            "file:///tmp/a",
            "https://key@example.com/v1",
            "https://a/v1?api_key=secret",
            "invalid",
        ] {
            assert!(normalize_url(url).is_err());
        }
    }
    #[test]
    fn unchanged_key_is_preserved_and_clear_is_explicit() {
        let old = Config {
            api_key: "secret".into(),
            ..Config::default()
        };
        let input = |key| ConfigInput {
            base_url: "https://example.com/v1".into(),
            models: vec![" a ".into(), "a".into()],
            manual_models: vec![],
            default_model: "b".into(),
            api_key: key,
            default_permission: "auto".into(),
        };
        let config = merge(old.clone(), input(None)).unwrap();
        assert_eq!(config.api_key, "secret");
        assert_eq!(config.models, ["b", "a"]);
        assert!(merge(old, input(Some(String::new())))
            .unwrap()
            .api_key
            .is_empty());
    }
}
