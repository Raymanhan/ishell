import { useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { command, isTauri } from "../api/tauri";
import {
  permissionOptions,
  type AiConfig,
  type AiConfigInput,
  type AiPermission,
  type AiModel,
  mergeModelSources,
} from "../features/ai/types";

import { t } from "../i18n";
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
  const [manualModels, setManualModels] = useState(
    (config.manualModels || []).join("\n"),
  );
  const generation = useRef(0);
  const [defaultModel, setDefaultModel] = useState(config.defaultModel);
  const [defaultPermission, setDefaultPermission] = useState<AiPermission>(
    config.defaultPermission || "auto",
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const manualIds = [
    ...new Set(
      manualModels
        .split(/[\n,]/)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const choices = mergeModelSources(models, manualIds);
  const modelList = choices.map((model) => model.id);
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
      manualModels: manualIds,
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
        throw new Error(t("请在桌面客户端保存 AI 设置；预览模式不保存密钥。"));
      const value = await command<AiConfig>("ai_save_config", {
        input: input(),
      });
      onSaved(value);
      setBaseUrl(value.baseUrl);
      setApiKey("");
      setClearKey(false);
      setModels(value.modelMetadata || []);
      setManualModels((value.manualModels || []).join("\n"));
      setDefaultModel(value.defaultModel);
      setNotice(t("设置已保存，密钥已在本机加密。"));
      if (value.metadataError)
        setError(t("模型元数据读取失败：{0}", value.metadataError));
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
      if (!isTauri) throw new Error(t("请在桌面客户端测试连接。"));
      const fetched = await command<AiModel[]>("ai_list_models", {
        input: input(),
      });
      if (request !== generation.current) return;
      setModels(fetched);
      if (!fetched.some((model) => model.id === defaultModel))
        setDefaultModel(fetched[0]?.id || "");
      setNotice(
        t("已获取 {0} 个模型及服务声明的思考档位。点击保存后生效。", fetched.length),
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
        <h3>{t("模型服务")}</h3>
        <p>
          {t("连接支持工具调用的 OpenAI 兼容 Chat Completions 服务。任务消息、必要的服务器信息和工具输出将发送到此地址。")}</p>
      </div>
      <fieldset disabled={Boolean(busy)}>
        <label>
          {t("API 地址")}<input
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
          {t("填写包含 /v1 的服务根地址，也支持粘贴完整 /chat/completions 地址。")}</small>
        <label>
          {t("API 密钥")}<input
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
                ? t("已保存，留空保留原密钥")
                : t("sk-…（本地服务可留空）")
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
            {t("清除已保存的密钥")}</label>
        )}
        <div className="ai-settings-label">
          <span>{t("模型元数据")}</span>
          <button type="button" onClick={() => void fetchModels()}>
            {busy === "models" ? (
              <LoaderCircle size={13} className="ai-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            {t("读取 / 刷新元数据")}</button>
        </div>
        <small>
          {t("从当前服务的 /models 接口读取模型与思考档位；未列出的模型可手动补充。")}</small>
        <label>
          {t("默认模型")}<select
            value={
              modelList.includes(defaultModel)
                ? defaultModel
                : modelList[0] || ""
            }
            onChange={(e) => setDefaultModel(e.target.value)}
          >
            <option value="" disabled>
              {t("请先读取元数据")}</option>
            {choices.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <details className="ai-manual-models">
          <summary>{t("手动补充模型 ID（可选）")}</summary>
          <textarea
            aria-label={t("手动模型 ID")}
            value={manualModels}
            onChange={(event) => setManualModels(event.target.value)}
            rows={3}
            placeholder={t("每行一个模型 ID，支持 /models 不可用的服务")}
            spellCheck={false}
          />
        </details>
        <small>
          {models.find((model) => model.id === defaultModel)?.reasoningEfforts
            .length
            ? t("此模型支持：{0}", models
                .find((model) => model.id === defaultModel)!
                .reasoningEfforts.map((effort) => effort.label)
                .join("、"))
            : t("服务未声明此模型的思考档位，默认使用服务默认值，也可在对话中手动输入。")}
          {t("远端工具需要 Python 3，JavaScript 执行另需 Node.js。")}</small>
        <label>
          {t("新对话默认权限")}<select
            aria-label={t("默认 Agent 权限")}
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
          {t("。对话中可单独调整。风险判断采用保守规则，不是隔离沙箱。")}</small>
        <div className="settings-section-copy">
          <h3>{t("自动压缩上下文")}</h3>
          <p>
            {t("估算用量达到 200k tokens，或达到模型声明上下文窗口的 75% 时，自动生成历史摘要，保留原始任务和近期完整工具调用。压缩仅影响发送给模型的上下文，聊天记录仍可查看。")}</p>
        </div>
        <button
          type="button"
          className="btn-primary ai-save"
          onClick={() => void save()}
        >
          {busy === "save" && <LoaderCircle size={14} className="ai-spin" />}
          {t("保存 AI 设置")}</button>
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
