import { useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { command, isTauri } from "../api/tauri";
import {
  permissionOptions,
  type AiConfig,
  type AiConfigInput,
  type AiPermission,
} from "../features/ai/types";

export function AiSettings({
  config,
  onSaved,
}: {
  config: AiConfig;
  onSaved: (config: AiConfig) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState(config.models.join("\n"));
  const [defaultModel, setDefaultModel] = useState(config.defaultModel);
  const [defaultPermission, setDefaultPermission] = useState<AiPermission>(
    config.defaultPermission || "auto",
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const modelList = [
    ...new Set(
      models
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  function input(): AiConfigInput {
    return {
      baseUrl,
      apiKey: clearKey ? "" : apiKey.trim() || null,
      models: modelList,
      defaultModel: modelList.includes(defaultModel)
        ? defaultModel
        : modelList[0] || "",
      defaultPermission,
    };
  }
  async function save() {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      if (!isTauri)
        throw new Error("请在桌面客户端保存 AI 设置；预览模式不保存密钥。");
      const value = await command<AiConfig>("ai_save_config", {
        input: input(),
      });
      onSaved(value);
      setBaseUrl(value.baseUrl);
      setApiKey("");
      setClearKey(false);
      setModels(value.models.join("\n"));
      setDefaultModel(value.defaultModel);
      setNotice("已保存，密钥已在本机加密。");
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy("");
    }
  }
  async function fetchModels() {
    setBusy("models");
    setError("");
    setNotice("");
    try {
      if (!isTauri) throw new Error("请在桌面客户端测试连接。");
      const fetched = await command<string[]>("ai_list_models", {
        input: input(),
      });
      const merged = [...new Set([...modelList, ...fetched])];
      setModels(merged.join("\n"));
      if (!defaultModel) setDefaultModel(merged[0] || "");
      setNotice(`连接成功，获取到 ${fetched.length} 个模型。点击保存后生效。`);
    } catch (error) {
      setError(`${error}。若服务不支持 /models，可手动填写模型 ID。`);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="ai-settings">
      <div className="settings-section-copy">
        <h3>模型服务</h3>
        <p>
          连接支持工具调用的 OpenAI 兼容 Chat Completions
          服务。任务消息、必要的服务器信息和工具输出将发送到此地址。
        </p>
      </div>
      <fieldset disabled={Boolean(busy)}>
        <label>
          API 地址
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
          />
        </label>
        <small>
          填写包含 /v1 的服务根地址，也支持粘贴完整 /chat/completions 地址。
        </small>
        <label>
          API 密钥
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setClearKey(false);
            }}
            placeholder={
              config.hasApiKey
                ? "已保存，留空保留原密钥"
                : "sk-…（本地服务可留空）"
            }
          />
        </label>
        {config.hasApiKey && (
          <label className="ai-key-clear">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => {
                setClearKey(e.target.checked);
                if (e.target.checked) setApiKey("");
              }}
            />
            清除已保存的密钥
          </label>
        )}
        <div className="ai-settings-label">
          <span>可选模型（每行一个 ID）</span>
          <button type="button" onClick={() => void fetchModels()}>
            {busy === "models" ? (
              <LoaderCircle size={13} className="ai-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            测试连接 / 获取模型
          </button>
        </div>
        <textarea
          aria-label="可选模型"
          value={models}
          onChange={(e) => setModels(e.target.value)}
          placeholder={"gpt-5.1\ndeepseek-chat\n或其他支持工具调用的模型 ID"}
          rows={5}
          spellCheck={false}
        />
        <label>
          默认模型
          <select
            value={
              modelList.includes(defaultModel)
                ? defaultModel
                : modelList[0] || ""
            }
            onChange={(e) => setDefaultModel(e.target.value)}
          >
            <option value="" disabled>
              请先填写或获取模型
            </option>
            {modelList.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <small>
          对话中可选择模型与思考程度；不支持 reasoning_effort
          的服务请选择“默认”。远端工具需要 Python 3，JavaScript 执行另需
          Node.js。
        </small>
        <label>
          新对话默认权限
          <select
            aria-label="默认 Agent 权限"
            value={defaultPermission}
            onChange={(event) =>
              setDefaultPermission(event.target.value as AiPermission)
            }
          >
            {permissionOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <small>
          {
            permissionOptions.find(
              (option) => option.value === defaultPermission,
            )?.description
          }
          。对话中可单独调整。风险判断采用保守规则，不是隔离沙箱。
        </small>
        <div className="settings-section-copy">
          <h3>自动压缩上下文 · 200k tokens</h3>
          <p>
            估算用量达到 200k
            时，自动生成历史摘要，保留原始任务和近期完整工具调用。压缩仅影响发送给模型的上下文，聊天记录仍可查看；对话保留在当前窗口会话中。
          </p>
        </div>
        <button
          type="button"
          className="btn-primary ai-save"
          onClick={() => void save()}
        >
          {busy === "save" && <LoaderCircle size={14} className="ai-spin" />}
          保存 AI 设置
        </button>
      </fieldset>
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ai-settings-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
