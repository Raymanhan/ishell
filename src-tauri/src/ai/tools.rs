use super::Event;
use crate::terminal::TerminalRegistry;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle};

pub fn definitions() -> Value {
    json!([
        {"type":"function","function":{"name":"shell","description":"在当前服务器执行非交互 Shell 命令。每次调用是独立进程；指定 cwd。使用 sudo -n；服务使用 systemctl 或重定向后的 nohup。返回真实输出和退出码。","parameters":{"type":"object","properties":{"description":{"type":"string","description":"一句话说明这次操作的目的，显示在界面上代替命令标题，例如“检查磁盘占用”。不超过 20 个字，使用与用户相同的语言。"},"command":{"type":"string"},"cwd":{"type":"string"},"timeout":{"type":"integer","minimum":1,"maximum":1800}},"required":["description","command"]}}},
        {"type":"function","function":{"name":"run_code","description":"编写并在当前服务器执行 Python、Shell 或 Node.js 代码，适合部署脚本、排查与批量操作。代码存于临时文件，执行后清理。","parameters":{"type":"object","properties":{"description":{"type":"string","description":"一句话说明这次操作的目的，显示在界面上代替命令标题，例如“检查磁盘占用”。不超过 20 个字，使用与用户相同的语言。"},"language":{"type":"string","enum":["python","shell","javascript"]},"code":{"type":"string"},"cwd":{"type":"string"},"timeout":{"type":"integer","minimum":1,"maximum":1800}},"required":["description","language","code"]}}},
        {"type":"function","function":{"name":"read_file","description":"读取当前服务器 UTF-8 文本文件，最多 16000 字符；更大的文件可用 shell 分段查看。","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}},
        {"type":"function","function":{"name":"write_file","description":"在当前服务器创建或完整替换 UTF-8 文件（原子写入）。需先检查现有内容；父目录须已存在。保留现有文件权限，新文件为 0600。","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}
    ])
}

pub fn validate(name: &str, args: &Value) -> Result<(), String> {
    if !args.is_object() {
        return Err("工具参数必须是对象".into());
    }
    let fields: &[&str] = match name {
        "shell" => &["command"],
        "run_code" => &["language", "code"],
        "read_file" => &["path"],
        "write_file" => &["path", "content"],
        _ => return Err(format!("不支持的工具：{name}")),
    };
    for field in fields {
        if args[*field].as_str().is_none()
            || (*field != "content" && args[*field].as_str() == Some(""))
        {
            return Err(format!("工具参数 {field} 无效"));
        }
    }
    if name == "run_code"
        && !matches!(
            args["language"].as_str(),
            Some("python" | "shell" | "javascript")
        )
    {
        return Err("不支持的代码语言".into());
    }
    if let Some(timeout) = args.get("timeout") {
        if !timeout.as_u64().is_some_and(|v| (1..=1800).contains(&v)) {
            return Err("超时应在 1–1800 秒之间".into());
        }
    }
    for field in ["path", "cwd"] {
        if let Some(value) = args.get(field) {
            let path = value
                .as_str()
                .ok_or_else(|| format!("{field} 必须是字符串"))?;
            if !(path.starts_with('/') || path == "~" || path.starts_with("~/"))
                || path.contains('\0')
            {
                return Err("请使用绝对路径或 ~/ 路径".into());
            }
        }
    }
    Ok(())
}

fn job(app: &AppHandle, server: &str, payload: Value) -> Result<Value, String> {
    let encoded = STANDARD.encode(serde_json::to_vec(&payload).map_err(|e| e.to_string())?);
    let script = format!(
        "import base64, json\npayload = json.loads(base64.b64decode('{encoded}'))\n{}",
        include_str!("job.py")
    );
    let raw = crate::ssh::run_remote_python(app, server, &script, &[])?;
    serde_json::from_str(raw.trim()).map_err(|_| "服务器 AI 工具响应无效".into())
}

pub struct Context {
    pub app: AppHandle,
    pub server: String,
    pub session: String,
    pub terminals: Arc<TerminalRegistry>,
    pub cancel: Arc<AtomicBool>,
    pub events: Channel<Event>,
    /// Set when the call runs without a human decision; the remote runner then
    /// refuses reads whose real path (after symlinks) looks like a secret.
    pub guard_sensitive: bool,
}

/// Poll quickly while output changes, then back off so a quiet long-running
/// command does not cost an SSH exec and a remote interpreter start every 400 ms.
pub(crate) fn next_poll_interval(current: Duration, changed: bool) -> Duration {
    const MIN: Duration = Duration::from_millis(400);
    const MAX: Duration = Duration::from_millis(2000);
    if changed {
        MIN
    } else {
        (current + current / 2).clamp(MIN, MAX)
    }
}

pub fn execute(context: Context, id: String, name: String, args: Value) -> Result<Value, String> {
    validate(&name, &args)?;
    let Context {
        app,
        server,
        session,
        terminals,
        cancel,
        events,
        guard_sensitive,
    } = context;
    if cancel.load(Ordering::Relaxed) || !terminals.connected_to(&session, &server) {
        return Err("已停止或服务器连接已关闭".into());
    }
    let job_id = uuid::Uuid::new_v4().to_string();
    let mut input = json!({"name":name,"args":args});
    if guard_sensitive {
        input["sensitivePatterns"] = json!(super::permissions::SENSITIVE_PATTERNS);
    }
    job(
        &app,
        &server,
        json!({"action":"start","job":job_id,"input":input,"runner":include_str!("runner.py")}),
    )?;
    let started = Instant::now();
    let mut previous = Value::Null;
    let mut stopping_since = None;
    let mut interval = Duration::from_millis(400);
    loop {
        let stopping = cancel.load(Ordering::Relaxed)
            || !terminals.connected_to(&session, &server)
            || started.elapsed() > Duration::from_secs(1830);
        let state = job(
            &app,
            &server,
            json!({"action":if stopping {"cancel"} else {"poll"},"job":job_id}),
        );
        let state = match state {
            Ok(state) => state,
            Err(error) => {
                // The remote runner has its own deadline even if the connection disappears.
                let _ = job(&app, &server, json!({"action":"cancel","job":job_id}));
                return Err(format!("工具状态无法获取，无法确认远端是否已停止：{error}"));
            }
        };
        let changed = state != previous;
        if changed {
            let _ = events.send(Event::new("tool_output", json!({"id":id,"result":state})));
            previous = state.clone();
        }
        if state["status"] == "done" {
            let _ = job(&app, &server, json!({"action":"clean","job":job_id}));
            return Ok(state);
        }
        if stopping {
            let since = stopping_since.get_or_insert_with(Instant::now);
            if since.elapsed() > Duration::from_secs(15) {
                // job.py removes stale job directories on later starts.
                return Err("停止请求已发送，但尚未确认远端进程退出".into());
            }
            interval = Duration::from_millis(400);
        } else {
            interval = next_poll_interval(interval, changed);
        }
        // Sleep in short slices so a stop click is noticed without waiting
        // for a backed-off poll interval.
        let wake = Instant::now() + interval;
        while Instant::now() < wake {
            if !stopping && cancel.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100).min(wake - Instant::now()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn polling_backs_off_while_quiet_and_resets_on_output() {
        let mut interval = Duration::from_millis(400);
        for _ in 0..10 {
            interval = next_poll_interval(interval, false);
        }
        assert_eq!(interval, Duration::from_millis(2000));
        assert_eq!(
            next_poll_interval(interval, true),
            Duration::from_millis(400)
        );
        assert_eq!(
            next_poll_interval(Duration::from_millis(400), false),
            Duration::from_millis(600)
        );
    }
    #[test]
    fn validate_before_any_remote_execution() {
        assert!(validate(
            "shell",
            &json!({"command":"pwd","cwd":"/tmp/a b","timeout":20})
        )
        .is_ok());
        assert!(validate("write_file", &json!({"path":"~/a","content":""})).is_ok());
        for (name, args) in [
            ("unknown", json!({})),
            ("shell", json!({"command":"x","timeout":0})),
            ("run_code", json!({"language":"ruby","code":"x"})),
            ("read_file", json!({"path":"relative"})),
            ("shell", json!({"command":"x","cwd":12})),
        ] {
            assert!(validate(name, &args).is_err());
        }
    }
}
