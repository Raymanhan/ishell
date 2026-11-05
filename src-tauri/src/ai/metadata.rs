use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffort {
    pub value: String,
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub reasoning_efforts: Vec<ReasoningEffort>,
    pub default_reasoning_effort: Option<String>,
}

fn text_at<'a>(value: &'a Value, paths: &[&str]) -> Option<&'a str> {
    paths
        .iter()
        .find_map(|path| value.pointer(path).and_then(Value::as_str))
        .filter(|v| !v.trim().is_empty())
}

fn valid_effort(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub fn model(value: &Value) -> Option<Model> {
    let id = value
        .as_str()
        .or_else(|| text_at(value, &["/id", "/slug"]))?
        .trim();
    if id.is_empty() || id.len() > 200 {
        return None;
    }
    let name = text_at(value, &["/display_name", "/name"])
        .unwrap_or(id)
        .chars()
        .take(200)
        .collect();
    let paths = [
        "/supported_reasoning_efforts",
        "/supported_reasoning_levels",
        "/reasoning_efforts",
        "/metadata/supported_reasoning_efforts",
        "/metadata/supported_reasoning_levels",
        "/capabilities/reasoning/supported_efforts",
        "/capabilities/reasoning/efforts",
        "/capabilities/reasoning_effort",
        "/parameters/reasoning_effort/enum",
        "/parameters/properties/reasoning_effort/enum",
    ];
    // Capabilities such as supported_parameters:["reasoning_effort"] do not
    // declare which values are valid. Never manufacture levels from model IDs.
    let levels = paths
        .iter()
        .find_map(|path| value.pointer(path).and_then(Value::as_array));
    let mut reasoning_efforts = Vec::<ReasoningEffort>::new();
    for level in levels.into_iter().flatten().take(32) {
        let Some(effort) = level
            .as_str()
            .or_else(|| text_at(level, &["/effort", "/value", "/id"]))
        else {
            continue;
        };
        if !valid_effort(effort)
            || effort == "default"
            || reasoning_efforts.iter().any(|e| e.value == effort)
        {
            continue;
        }
        reasoning_efforts.push(ReasoningEffort {
            value: effort.into(),
            label: text_at(level, &["/display_name", "/label", "/name"])
                .unwrap_or(effort)
                .chars()
                .take(100)
                .collect(),
            description: text_at(level, &["/description"])
                .unwrap_or_default()
                .chars()
                .take(500)
                .collect(),
        });
    }
    let default_reasoning_effort = text_at(
        value,
        &[
            "/default_reasoning_effort",
            "/default_reasoning_level",
            "/metadata/default_reasoning_effort",
            "/default_parameters/reasoning_effort",
            "/capabilities/reasoning/default_effort",
        ],
    )
    .filter(|default| {
        reasoning_efforts
            .iter()
            .any(|effort| effort.value == *default)
    })
    .map(str::to_string);
    Some(Model {
        id: id.into(),
        name,
        reasoning_efforts,
        default_reasoning_effort,
    })
}

pub fn catalog(body: &Value) -> Result<Vec<Model>, String> {
    let values = body
        .as_array()
        .or_else(|| body["data"].as_array())
        .or_else(|| body["models"].as_array())
        .ok_or("服务未返回可识别的模型元数据（需要 /models 返回 data 或 models 数组）")?;
    let mut models = Vec::<Model>::new();
    for value in values {
        if let Some(model) = model(value) {
            if !models.iter().any(|existing| existing.id == model.id) {
                models.push(model);
            }
        }
        if models.len() == 500 {
            break;
        }
    }
    if !values.is_empty() && models.is_empty() {
        return Err("模型元数据未包含有效的 id 或 slug".into());
    }
    Ok(models)
}

pub fn validate_selection(models: &[Model], id: &str, effort: &str) -> Result<(), String> {
    let model = models
        .iter()
        .find(|model| model.id == id)
        .ok_or("所选模型已不在服务元数据中，请刷新模型列表")?;
    if effort != "default"
        && !model
            .reasoning_efforts
            .iter()
            .any(|level| level.value == effort)
    {
        return Err("服务元数据未声明该模型支持所选思考程度，请刷新后重新选择".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn reads_openai_and_codex_catalogs_without_guessed_efforts() {
        let openai = catalog(&json!({"data":[{"id":"plain"},{"id":"custom","supported_reasoning_efforts":["minimal","high","high","future-level"],"default_reasoning_effort":"high"}]})).unwrap();
        assert!(openai[0].reasoning_efforts.is_empty());
        assert_eq!(
            openai[1]
                .reasoning_efforts
                .iter()
                .map(|e| e.value.as_str())
                .collect::<Vec<_>>(),
            ["minimal", "high", "future-level"]
        );
        assert_eq!(openai[1].default_reasoning_effort.as_deref(), Some("high"));
        let codex = catalog(&json!({"models":[{"slug":"agent","display_name":"Agent Model","supported_reasoning_levels":[{"effort":"low","description":"Quick"},{"effort":"xhigh","label":"最高"}],"default_reasoning_level":"xhigh"}]})).unwrap();
        assert_eq!(codex[0].name, "Agent Model");
        assert_eq!(codex[0].reasoning_efforts[0].description, "Quick");
        assert_eq!(codex[0].reasoning_efforts[1].label, "最高");
        assert!(validate_selection(&codex, "agent", "medium").is_err());
        assert!(validate_selection(&codex, "agent", "xhigh").is_ok());
    }
    #[test]
    fn capabilities_without_values_do_not_invent_levels_and_unknown_models_are_rejected() {
        let models = catalog(&json!({"data":[{"id":"gpt-future","supported_parameters":["reasoning_effort"]},{"id":"schema","parameters":{"properties":{"reasoning_effort":{"enum":["none","high"]}}}}]})).unwrap();
        assert!(models[0].reasoning_efforts.is_empty());
        assert!(validate_selection(&models, "gpt-future", "high").is_err());
        assert!(validate_selection(&models, "gpt-future", "default").is_ok());
        assert!(validate_selection(&models, "missing", "default").is_err());
        assert_eq!(models[1].reasoning_efforts[0].value, "none");
        assert!(catalog(&json!({"error":"failed"})).is_err());
    }
}
