use reqwest::{Client, Response};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::ipc::Channel;

use super::{config::Config, metadata, Event};

pub fn client() -> Result<Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // `timeout` would bound the whole streamed body, cutting off reasoning
    // models that legitimately stream for more than five minutes. Bound the
    // idle gap between reads instead; the user can stop a run at any time.
    Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

pub async fn cancellable<T>(
    cancel: &AtomicBool,
    future: impl Future<Output = Result<T, reqwest::Error>>,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("已停止".into());
        }
        tokio::select! {
            result = &mut future => return result.map_err(|e| format!("模型请求失败：{e}")),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
}

async fn checked(
    response: Response,
    config: &Config,
    cancel: Option<&AtomicBool>,
) -> Result<Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let mut response = response;
    let mut bytes = Vec::new();
    loop {
        let chunk = match cancel {
            Some(cancel) => cancellable(cancel, response.chunk()).await?,
            None => response.chunk().await.map_err(|e| e.to_string())?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        let remaining = 4096usize.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if bytes.len() >= 4096 {
            break;
        }
    }
    let mut detail = String::from_utf8_lossy(&bytes).to_string();
    if !config.api_key.is_empty() {
        detail = detail.replace(&config.api_key, "[密钥]");
    }
    Err(format!("模型 API 返回 {status}：{detail}"))
}

pub async fn models(config: &Config) -> Result<Vec<metadata::Model>, String> {
    models_cancellable(config, None).await
}

pub async fn models_cancellable(
    config: &Config,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<metadata::Model>, String> {
    let client = client()?;
    let mut request = client
        .get(format!("{}/models", config.base_url))
        .timeout(Duration::from_secs(30));
    if !config.api_key.is_empty() {
        request = request.bearer_auth(&config.api_key);
    }
    let response = match cancel {
        Some(cancel) => cancellable(cancel, request.send()).await?,
        None => request.send().await.map_err(|e| e.to_string())?,
    };
    let response = checked(response, config, cancel).await?;
    let body = match cancel {
        Some(cancel) => cancellable(cancel, response.json::<Value>()).await?,
        None => response
            .json::<Value>()
            .await
            .map_err(|e| format!("模型元数据无法解析：{e}"))?,
    };
    metadata::catalog(&body)
}

#[derive(Default)]
pub struct Accumulator {
    text: String,
    reasoning: String,
    tools: BTreeMap<usize, Value>,
    finished: bool,
}

impl Accumulator {
    pub fn ingest(&mut self, chunk: &Value, emit: &impl Fn(Event)) -> Result<(), String> {
        if let Some(error) = chunk.get("error") {
            return Err(format!("模型响应错误：{error}"));
        }
        let Some(choice) = chunk["choices"].as_array().and_then(|v| v.first()) else {
            return Ok(());
        };
        let delta = choice
            .get("delta")
            .or_else(|| choice.get("message"))
            .unwrap_or(&Value::Null);
        for (field, target, kind) in [
            ("content", &mut self.text, "text"),
            ("reasoning_content", &mut self.reasoning, "thinking"),
        ] {
            if let Some(text) = delta[field].as_str() {
                if target.len() + text.len() > 1_048_576 {
                    return Err("模型响应超过 1 MB，请缩小任务范围".into());
                }
                target.push_str(text);
                emit(Event::new(kind, json!({"text":text})));
            }
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for (position, call) in calls.iter().enumerate() {
                let index = call["index"].as_u64().unwrap_or(position as u64) as usize;
                if index >= 32 {
                    return Err("单轮工具调用过多".into());
                }
                let entry = self.tools.entry(index).or_insert_with(
                    || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                for path in [
                    vec!["id"],
                    vec!["function", "name"],
                    vec!["function", "arguments"],
                ] {
                    let fragment = if path.len() == 1 {
                        &call[path[0]]
                    } else {
                        &call[path[0]][path[1]]
                    };
                    if let Some(fragment) = fragment.as_str() {
                        let target = if path.len() == 1 {
                            &mut entry[path[0]]
                        } else {
                            &mut entry[path[0]][path[1]]
                        };
                        let mut value = target.as_str().unwrap_or_default().to_string();
                        // OpenAI sends id and name once, but some compatible
                        // gateways repeat them in every chunk; only arguments
                        // are true fragments.
                        if path.last() != Some(&"arguments") && value == fragment {
                            continue;
                        }
                        if value.len() + fragment.len() > 524_288 {
                            return Err("工具参数超过 512 KB".into());
                        }
                        value.push_str(fragment);
                        *target = json!(value);
                    }
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            if !matches!(reason, "stop" | "tool_calls") {
                return Err(format!("模型未完整生成（{reason}），未执行本轮工具"));
            }
            self.finished = true;
        }
        Ok(())
    }

    pub fn finish(self) -> Result<Value, String> {
        if !self.finished {
            return Err("模型响应意外中断，未执行本轮工具".into());
        }
        let mut message = json!({"role":"assistant", "content": self.text});
        if !self.reasoning.is_empty() {
            message["reasoning_content"] = json!(self.reasoning);
        }
        if !self.tools.is_empty() {
            let tools = self.tools.into_values().collect::<Vec<_>>();
            for call in &tools {
                if call["id"].as_str().unwrap_or_default().is_empty()
                    || call["function"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .is_empty()
                {
                    return Err("模型返回了不完整的工具调用".into());
                }
            }
            message["tool_calls"] = json!(tools);
        }
        if message["content"].as_str() == Some("") && message.get("tool_calls").is_none() {
            return Err("模型返回了空回复，请检查模型是否支持 Chat Completions 和工具调用".into());
        }
        Ok(message)
    }
}

pub async fn completion(
    config: &Config,
    body: Value,
    cancel: Arc<AtomicBool>,
    events: &Channel<Event>,
) -> Result<Value, String> {
    let client = client()?;
    let mut request = client
        .post(format!("{}/chat/completions", config.base_url))
        .json(&body);
    if !config.api_key.is_empty() {
        request = request.bearer_auth(&config.api_key);
    }
    let response = cancellable(&cancel, request.send()).await?;
    let mut response = checked(response, config, Some(&cancel)).await?;
    let emit = |event| {
        let _ = events.send(event);
    };
    let mut acc = Accumulator::default();
    if response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("application/json"))
    {
        let chunk = cancellable(&cancel, response.json::<Value>()).await?;
        acc.ingest(&chunk, &emit)?;
        return acc.finish();
    }
    let mut pending = Vec::new();
    let mut ended = false;
    while let Some(chunk) = cancellable(&cancel, response.chunk()).await? {
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line = pending.drain(..=end).collect::<Vec<_>>();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                ended = true;
                break;
            }
            if data.is_empty() {
                continue;
            }
            let value: Value =
                serde_json::from_str(data).map_err(|_| "模型流式响应不是有效 JSON".to_string())?;
            acc.ingest(&value, &emit)?;
        }
        if ended {
            break;
        }
        if pending.len() > 1_048_576 {
            return Err("模型响应单行过长".into());
        }
    }
    acc.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_arguments_are_assembled_without_executing_partial_calls() {
        let mut acc = Accumulator::default();
        acc.ingest(&json!({"choices":[{"delta":{"content":"先检查", "tool_calls":[{"index":0,"id":"a","function":{"name":"shell","arguments":"{\"command\":"}}]}}]}), &|_| {}).unwrap();
        acc.ingest(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}), &|_| {}).unwrap();
        let message = acc.finish().unwrap();
        assert_eq!(
            message["tool_calls"][0]["function"]["arguments"],
            "{\"command\":\"pwd\"}"
        );
        let mut acc = Accumulator::default();
        acc.ingest(
            &json!({"choices":[{"delta":{"content":"partial"}}]}),
            &|_| {},
        )
        .unwrap();
        assert!(acc.finish().is_err());
    }
    #[test]
    fn repeated_ids_and_names_from_compatible_gateways_are_not_duplicated() {
        let mut acc = Accumulator::default();
        for (arguments, finish) in [("{\"command\":", None), ("\"pwd\"}", Some("tool_calls"))] {
            acc.ingest(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":arguments}}]},"finish_reason":finish}]}), &|_| {}).unwrap();
        }
        let message = acc.finish().unwrap();
        assert_eq!(message["tool_calls"][0]["id"], "call_1");
        assert_eq!(message["tool_calls"][0]["function"]["name"], "shell");
        assert_eq!(
            message["tool_calls"][0]["function"]["arguments"],
            "{\"command\":\"pwd\"}"
        );
    }
    #[test]
    fn truncation_and_api_errors_never_become_commands() {
        let mut acc = Accumulator::default();
        assert!(acc
            .ingest(
                &json!({"choices":[{"delta":{}, "finish_reason":"length"}]}),
                &|_| {}
            )
            .is_err());
        assert!(acc
            .ingest(&json!({"error":{"message":"unsupported tools"}}), &|_| {})
            .is_err());
    }
}

#[cfg(test)]
pub(super) mod http_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Mutex,
    };

    pub(crate) fn server(
        status: &str,
        content_type: &str,
        body: String,
        fragment: bool,
    ) -> (String, std::thread::JoinHandle<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let headers = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let end;
            loop {
                let mut buf = [0; 1024];
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buf[..n]);
                if let Some(position) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                    end = position + 4;
                    break;
                }
            }
            let head = String::from_utf8_lossy(&request[..end]);
            assert!(head.starts_with("POST /v1/chat/completions "));
            assert!(head
                .to_lowercase()
                .contains("authorization: bearer test-key"));
            let length = head
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse::<usize>().ok())
                })
                .unwrap();
            while request.len() < end + length {
                let mut buf = [0; 1024];
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buf[..n]);
            }
            let value = serde_json::from_slice(&request[end..end + length]).unwrap();
            socket.write_all(headers.as_bytes()).unwrap();
            if fragment {
                for bytes in body.as_bytes().chunks(3) {
                    if socket.write_all(bytes).is_err() {
                        break;
                    }
                }
            } else {
                let _ = socket.write_all(body.as_bytes());
            }
            value
        });
        (url, handle)
    }

    #[tokio::test]
    async fn reads_fragmented_utf8_sse_and_returns_complete_tool_calls() {
        let chunks = [
            json!({"choices":[{"delta":{"content":"正在检查中文目录"}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"shell","arguments":"{\"command\":"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}),
        ];
        let body = chunks
            .iter()
            .map(|chunk| format!("data: {chunk}\r\n\r\n"))
            .collect::<String>()
            + "data: [DONE]\r\n\r\n";
        let (url, handle) = server("200 OK", "text/event-stream", body, true);
        let config = Config {
            base_url: url,
            api_key: "test-key".into(),
            ..Config::default()
        };
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let channel = Channel::<Event>::new(move |body| {
            captured.lock().unwrap().push(body);
            Ok(())
        });
        let body = json!({"model":"fixture","messages":[{"role":"user","content":"check"}],"reasoning_effort":"high","stream":true});
        let result = completion(&config, body, Arc::new(AtomicBool::new(false)), &channel)
            .await
            .unwrap();
        assert_eq!(result["content"], "正在检查中文目录");
        assert_eq!(
            result["tool_calls"][0]["function"]["arguments"],
            "{\"command\":\"pwd\"}"
        );
        assert_eq!(handle.join().unwrap()["reasoning_effort"], "high");
        assert!(!events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn handles_non_stream_json_and_redacts_api_errors() {
        let body = json!({"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}).to_string();
        let (url, handle) = server("200 OK", "application/json", body, false);
        let config = Config {
            base_url: url,
            api_key: "test-key".into(),
            ..Config::default()
        };
        let channel = Channel::<Event>::new(|_| Ok(()));
        assert_eq!(
            completion(
                &config,
                json!({}),
                Arc::new(AtomicBool::new(false)),
                &channel
            )
            .await
            .unwrap()["content"],
            "done"
        );
        handle.join().unwrap();
        let (url, handle) = server(
            "401 Unauthorized",
            "application/json",
            "{\"error\":\"test-key invalid\"}".into(),
            false,
        );
        let config = Config {
            base_url: url,
            ..config
        };
        let error = completion(
            &config,
            json!({}),
            Arc::new(AtomicBool::new(false)),
            &channel,
        )
        .await
        .unwrap_err();
        assert!(error.contains("401"));
        assert!(!error.contains("test-key"));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_request() {
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let worker = tokio::spawn(async move {
            cancellable(
                &worker_cancel,
                std::future::pending::<Result<(), reqwest::Error>>(),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.store(true, Ordering::Relaxed);
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err(), "已停止");
    }
}

#[cfg(test)]
mod metadata_http_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    #[tokio::test]
    async fn model_metadata_is_fetched_from_the_configured_authenticated_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/custom/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let mut buf = [0; 1024];
                let count = socket.read(&mut buf).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buf[..count]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /custom/v1/models HTTP/1.1"));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer fixture-key"));
            let body = json!({"data":[{"id":"server-model","name":"服务模型","supported_reasoning_efforts":["minimal","xhigh"],"default_reasoning_effort":"minimal"}]}).to_string();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let config = Config {
            base_url: url,
            api_key: "fixture-key".into(),
            ..Config::default()
        };
        let catalog = models(&config).await.unwrap();
        assert_eq!(catalog[0].id, "server-model");
        assert_eq!(catalog[0].name, "服务模型");
        assert_eq!(catalog[0].reasoning_efforts[0].value, "minimal");
        assert_eq!(
            catalog[0].default_reasoning_effort.as_deref(),
            Some("minimal")
        );
        server.join().unwrap();
    }
}
