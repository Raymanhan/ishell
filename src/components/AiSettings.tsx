import { useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { command, isTauri } from "../api/tauri";
import {
  permissionOptions,
  type AiConfig,
  type AiConfigInput,
  type AiPermission,
  type AiModel,
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
  const [models, setModels] = useState<AiModel[]>(config.modelMetadata || []);
  const generation = useRef(0);
  const [defaultModel, setDefaultModel] = useState(config.defaultModel);
  const [defaultPermission, setDefaultPermission] = useState<AiPermission>(
    config.defaultPermission || "auto",
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const modelList = models.map((model) => model.id);
  function invalidateMetadata() {
    generation.current += 1;
    setModels([]);
    setDefaultModel("");
    setNotice("");
    setError("");
  }
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
      setModels(value.modelMetadata || []);
      setDefaultModel(value.defaultModel);
      setNotice("设置已保存，密钥已在本机加密。");
      if (value.metadataError)
        setError(`模型元数据读取失败：${value.metadataError}`);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy("");
    }
  }
  async function fetchModels() {
    const request = ++generation.current;
    setBusy("models");
    setError("");
    setNotice("");
    try {
      if (!isTauri) throw new Error("请在桌面客户端测试连接。");
      const fetched = await command<AiModel[]>("ai_list_models", {
        input: input(),
      });
      if (request !== generation.current) return;
      setModels(fetched);
      if (!fetched.some((model) => model.id === defaultModel))
        setDefaultModel(fetched[0]?.id || "");
      setNotice(
        `已获取 ${fetched.length} 个模型及服务声明的思考档位。点击保存后生效。`,
      );
    } catch (error) {
      if (request === generation.current) setError(String(error));
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
            onChange={(e) => {
              setBaseUrl(e.target.value);
              invalidateMetadata();
            }}
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
              invalidateMetadata();
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
                invalidateMetadata();
                if (e.target.checked) setApiKey("");
              }}
            />
            清除已保存的密钥
          </label>
        )}
        <div className="ai-settings-label">
          <span>模型元数据</span>
          <button type="button" onClick={() => void fetchModels()}>
            {busy === "models" ? (
              <LoaderCircle size={13} className="ai-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            读取 / 刷新元数据
          </button>
        </div>
        <small>
          从当前服务的 /models 接口读取模型与思考档位，不再手动填写模型 ID。
        </small>
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
              请先读取元数据
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <small>
          {models.find((model) => model.id === defaultModel)?.reasoningEfforts
            .length
            ? `此模型支持：${models
                .find((model) => model.id === defaultModel)!
                .reasoningEfforts.map((effort) => effort.label)
                .join("、")}`
            : "服务未声明此模型的思考档位，对话中仅提供默认选项。"}
          远端工具需要 Python 3，JavaScript 执行另需 Node.js。
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
