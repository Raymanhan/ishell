import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  LoaderCircle,
  History,
  Trash2,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AiController } from "../features/ai/useAi";
import {
  modelSelection,
  mergeModelSources,
  emptyConversation,
  permissionOptions,
  serverHistory,
  conversationTitle,
  compactionThreshold,
  type AiEntry,
} from "../features/ai/types";
import type { ShellTab } from "../features/shell/types";
import { toolStatus } from "../features/ai/toolStatus";

import { t, translateMessage, formatDateTime } from "../i18n";
import { useLocale } from "../i18n/useLocale";
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="ai-icon"
      title={copied ? t("已复制") : t("复制")}
      aria-label={copied ? t("已复制") : t("复制")}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
function ToolCard({
  entry,
  target,
  onApprove,
}: {
  entry: AiEntry;
  target: string;
  onApprove: (allow: boolean) => void;
}) {
  const result = entry.result;
  const status = toolStatus(entry);
  const failed = status.kind === "error";
  const title =
    (
      {
        shell: t("执行命令"),
        run_code: t("运行代码"),
        read_file: t("读取文件"),
        write_file: t("写入文件"),
      } as Record<string, string>
    )[entry.name || ""] || entry.name;
  const args = entry.arguments;
  const code = String(
    args?.command ??
      args?.code ??
      args?.content ??
      args?.path ??
      entry.rawArguments ??
      "",
  );
  return (
    <details
      className={`ai-tool ${failed ? "failed" : ""} ${status.kind === "neutral" ? "neutral" : ""} ${entry.approvalPending ? "awaiting" : ""}`}
      open={entry.running || entry.approvalPending || undefined}
    >
      <summary>
        {entry.approvalPending ? (
          <ShieldCheck size={14} />
        ) : entry.running ? (
          <LoaderCircle size={14} className="ai-spin" />
        ) : failed ? (
          <X size={14} />
        ) : status.kind === "neutral" ? (
          <Square size={12} />
        ) : (
          <Check size={14} />
        )}
        <strong>{title}</strong>
        <span>{status.label}</span>
        <ChevronDown size={13} />
      </summary>
      {entry.risk && (
        <div className={`ai-risk ${entry.risk.level}`}>
          <strong>{translateMessage(entry.risk.label)}</strong>
          <span>{translateMessage(entry.risk.reason)}</span>
        </div>
      )}
      {(entry.name === "shell" || entry.name === "run_code") && (
        <div className="ai-tool-path">
          {t("目录：")}{String(args?.cwd || t("~（远端主目录）"))}
        </div>
      )}
      {entry.name === "write_file" && (
        <div className="ai-tool-path">{String(args?.path || "")}</div>
      )}
      <div className="ai-code">
        <CopyButton text={code} />
        <pre>{code}</pre>
      </div>
      {entry.approvalPending && (
        <div className="ai-approval">
          <p>{t("目标：")}{target}{t("。请检查命令、代码和路径。")}</p>
          <div>
            <button
              type="button"
              disabled={entry.approvalBusy}
              onClick={() => onApprove(false)}
            >
              {t("拒绝")}</button>
            <button
              type="button"
              disabled={entry.approvalBusy}
              onClick={() => onApprove(true)}
            >
              {entry.approvalBusy ? t("提交中…") : t("仅此次允许")}
            </button>
          </div>
        </div>
      )}
      {entry.approvalError && (
        <div className="ai-error" role="alert">
          {entry.approvalError}
        </div>
      )}
      {result?.stdout && (
        <pre className="ai-tool-output">
          {entry.name === "write_file" ? translateMessage(result.stdout) : result.stdout}
        </pre>
      )}
      {result?.stderr && (
        <pre className="ai-tool-output ai-stderr">{result.stderr}</pre>
      )}
      {result?.error && <div className="ai-error">{translateMessage(result.error)}</div>}
      {result?.exitCode != null && <small>{t("退出码：")}{result.exitCode}</small>}
      {result?.truncated && <small>{t("输出较长，仅保留部分内容。")}</small>}
    </details>
  );
}
const Message = memo(function Message({
  entry,
  target,
  onApprove,
}: {
  entry: AiEntry;
  target: string;
  onApprove: (entryId: string, allow: boolean) => void;
}) {
  // Re-render on language changes (memoized or a window root).
  useLocale();
  if (entry.kind === "tool")
    return (
      <ToolCard
        entry={entry}
        target={target}
        onApprove={(allow) => onApprove(entry.id, allow)}
      />
    );
  if (entry.kind === "notice" || entry.kind === "error")
    return (
      <div
        className={entry.kind === "error" ? "ai-error" : "ai-notice"}
        role={entry.kind === "error" ? "alert" : undefined}
      >
        {translateMessage(entry.text || "")}
      </div>
    );
  return (
    <article className={`ai-message ${entry.kind}`}>
      {entry.thinking && (
        <details className="ai-thinking">
          <summary>{t("思考过程")}</summary>
          <div>{entry.thinking}</div>
        </details>
      )}
      {entry.text &&
        (entry.kind === "user" ? (
          <p>{entry.text}</p>
        ) : (
          <div className="ai-markdown">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                pre: ({ children, ...props }) => (
                  <pre {...props}>{children}</pre>
                ),
              }}
            >
              {entry.text}
            </Markdown>
            <CopyButton text={entry.text} />
          </div>
        ))}
    </article>
  );
});

export function AiPanel({
  tab,
  ai,
  onSettings,
  onClose,
}: {
  tab: ShellTab;
  ai: AiController;
  onSettings: () => void;
  onClose: () => void;
}) {
  const conversation = ai.conversations[tab.id] || emptyConversation(ai.config);
  const busy = Boolean(conversation.requestId);
  const serverBusy = ai.serverBusy(tab.serverId);
  const connected = tab.state === "connected";
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const history = serverHistory(ai.history, tab.serverId);
  const [editing, setEditing] = useState<"model" | "effort" | null>(null);
  const [manualDraft, setManualDraft] = useState("");
  const [manualError, setManualError] = useState("");
  const approveRef = useRef(ai.approve);
  approveRef.current = ai.approve;
  const approve = useCallback(
    (entryId: string, allow: boolean) => {
      void approveRef.current(tab.id, entryId, allow);
    },
    [tab.id],
  );
  const patch = (change: Partial<typeof conversation>) =>
    ai.update(tab.id, (value) => ({ ...value, ...change }));
  useEffect(() => {
    ai.restorePreferences(tab.id);
    follow.current = true;
    setScrolled(false);
    setEditing(null);
  }, [tab.id, conversation.id]);
  useEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [conversation.entries, busy, tab.id, conversation.id]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(180, textarea.current.scrollHeight)}px`;
    }
  }, [conversation.draft, tab.id]);
  const models = mergeModelSources(
    ai.models,
    conversation.manualModel ? [conversation.model] : [],
  );
  const selection = modelSelection(
    models,
    conversation.model,
    conversation.effort,
    ai.config.defaultModel,
    conversation.manualModel,
    conversation.manualEffort,
  );
  const selectedWindow = models.find(
    (model) => model.id === selection.model,
  )?.contextWindow;
  const contextLimit = compactionThreshold(selectedWindow);
  function openManual(kind: "model" | "effort") {
    setEditing(kind);
    setManualDraft(
      kind === "model"
        ? selection.model
        : selection.effort === "default"
          ? ""
          : selection.effort,
    );
    setManualError("");
  }
  function commitManual() {
    const value = manualDraft.trim();
    if (editing === "model") {
      if (
        !value ||
        new TextEncoder().encode(value).length > 200 ||
        /[\u0000-\u001f\u007f]/.test(value)
      ) {
        setManualError(t("请输入 1–200 字节的模型 ID"));
        return;
      }
      patch({
        model: value,
        manualModel: true,
        effort: "default",
        manualEffort: false,
      });
    } else {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
        setManualError(t("请输入 1–64 位字母、数字、下划线或短横线"));
        return;
      }
      patch({ effort: value, manualEffort: value !== "default" });
    }
    setEditing(null);
  }
  const permission = permissionOptions.find(
    (option) => option.value === conversation.permission,
  )!;
  const awaiting = conversation.entries.some((entry) => entry.approvalPending);
  return (
    <section className="ai-panel" aria-label={t("AI 助手")}>
      <header className="ai-head">
        <div>
          <Sparkles size={16} />
          <strong>{t("AI 助手")}</strong>
        </div>
        <div>
          <button
            className="ai-icon"
            type="button"
            title={t("刷新模型元数据")}
            aria-label={t("刷新模型元数据")}
            disabled={ai.modelsLoading}
            onClick={() => void ai.refreshModels()}
          >
            <RefreshCw
              size={14}
              className={ai.modelsLoading ? "ai-spin" : undefined}
            />
          </button>
          <button
            className="ai-icon"
            type="button"
            title={t("历史记录")}
            aria-label={t("AI 历史记录")}
            aria-expanded={historyOpen}
            onClick={() => {
              setHistoryOpen(!historyOpen);
              setDeleteId(null);
            }}
          >
            <History size={15} />
          </button>
          <button
            className="ai-icon"
            type="button"
            title={t("新建对话")}
            aria-label={t("新建 AI 对话")}
            disabled={!ai.historyLoaded || !conversation.entries.length}
            onClick={() => {
              ai.newChat(tab);
              setHistoryOpen(false);
            }}
          >
            <Plus size={16} />
          </button>
          <button
            className="ai-icon"
            type="button"
            title={t("AI 设置")}
            aria-label={t("AI 设置")}
            onClick={onSettings}
          >
            <Settings size={15} />
          </button>
          <button
            className="ai-icon"
            type="button"
            title={t("关闭 AI 面板")}
            aria-label={t("关闭 AI 面板")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="ai-target" title={`${tab.subtitle} · ${tab.host}`}>
        <span className={connected ? "connected" : ""} />
        <Terminal size={12} />
        <strong>{tab.title}</strong>
        <span>{tab.host}</span>
      </div>
      {historyOpen && (
        <div className="ai-history" role="dialog" aria-label={t("AI 历史记录列表")}>
          <header>
            <strong>{t("历史记录 · ")}{tab.title}</strong>
            <button
              type="button"
              className="ai-icon"
              aria-label={t("关闭历史记录")}
              onClick={() => setHistoryOpen(false)}
            >
              <X size={14} />
            </button>
          </header>
          <div className="ai-history-list">
            {!history.length && (
              <p className="ai-notice">
                {ai.historyLoaded ? t("暂无历史记录") : t("正在读取历史记录…")}
              </p>
            )}
            {history.map((item) => (
              <div
                key={item.id}
                className={`ai-history-item${item.id === conversation.id ? " active" : ""}`}
              >
                <button
                  type="button"
                  className="ai-history-select"
                  aria-current={
                    item.id === conversation.id ? "true" : undefined
                  }
                  disabled={ai.deletingIds.includes(item.id)}
                  onClick={() => {
                    ai.selectHistory(tab, item.id);
                    setHistoryOpen(false);
                    setDeleteId(null);
                  }}
                >
                  <strong>{conversationTitle(item)}</strong>
                  <span>
                    {formatDateTime(item.updatedAt, { dateStyle: "short", timeStyle: "short" })} ·{" "}
                    {item.requestId
                      ? t("执行中")
                      : t("{0} 条消息", item.entries.filter((entry) => entry.kind === "user").length)}
                  </span>
                </button>
                <button
                  type="button"
                  className="ai-icon"
                  title={item.requestId ? t("请先停止任务再删除") : t("删除历史记录")}
                  aria-label={t("删除历史记录：{0}", conversationTitle(item))}
                  disabled={
                    Boolean(item.requestId) || ai.deletingIds.includes(item.id)
                  }
                  onClick={() => setDeleteId(item.id)}
                >
                  <Trash2 size={14} />
                </button>
                {deleteId === item.id && (
                  <div className="ai-history-delete">
                    <span>{t("删除这条对话及其记录？")}</span>
                    <button
                      type="button"
                      disabled={ai.deletingIds.includes(item.id)}
                      onClick={() => setDeleteId(null)}
                    >
                      {t("取消")}</button>
                    <button
                      type="button"
                      disabled={ai.deletingIds.includes(item.id)}
                      onClick={() => {
                        void ai
                          .deleteHistory(item.id)
                          .then(() => setDeleteId(null));
                      }}
                    >
                      {t("删除")}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <small>{t("仅显示当前服务器的记录，保存在本机。")}</small>
        </div>
      )}
      {ai.historyError && (
        <div className="ai-error ai-history-error" role="alert">
          {ai.historyError}
          <button
            type="button"
            className="ai-icon"
            aria-label={t("重试历史记录")}
            onClick={() => void ai.retryHistory()}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      )}
      <div
        className="ai-messages"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 70;
          setScrolled(!follow.current);
        }}
        aria-live="polite"
        aria-relevant="additions"
      >
        {!conversation.entries.length && (
          <div className="ai-empty">
            <span>
              <Sparkles size={27} />
            </span>
            <h3>{t("这台服务器，交给 AI")}</h3>
            <p>{t("描述目标，AI 会检查环境、执行命令并验证结果。")}</p>
            <div>
              {[
                t("检查服务器健康状态，找出异常服务"),
                t("检查 Docker 环境和正在运行的容器"),
                t("帮我部署一个网站，先确认所需信息"),
              ].map((text) => (
                <button
                  type="button"
                  key={text}
                  onClick={() => {
                    patch({ draft: text });
                    textarea.current?.focus();
                  }}
                >
                  {text}
                  <ArrowUp size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        {ai.configError && (
          <div className="ai-error">{t("AI 设置读取失败：")}{ai.configError}</div>
        )}
        {ai.preferencesError && (
          <div className="ai-notice" role="status">
            {ai.preferencesError}
          </div>
        )}
        {ai.modelsError && (
          <div className="ai-error" role="alert">
            {t("模型元数据读取失败：")}{ai.modelsError}
            <button
              type="button"
              className="ai-icon"
              aria-label={t("刷新模型元数据")}
              disabled={ai.modelsLoading}
              onClick={() => void ai.refreshModels()}
            >
              <RefreshCw size={13} />
            </button>
          </div>
        )}
        {!models.length && !ai.modelsLoading && (
          <button type="button" className="ai-setup" onClick={onSettings}>
            <Settings size={15} />
            {t("先配置模型地址、密钥和模型")}</button>
        )}
        {conversation.entries.map((entry) => (
          <Message
            key={entry.id}
            entry={entry}
            target={`${tab.title} (${tab.host})`}
            onApprove={approve}
          />
        ))}
        {busy && (
          <div className="ai-working">
            {awaiting ? (
              <ShieldCheck size={13} />
            ) : (
              <LoaderCircle size={13} className="ai-spin" />
            )}
            {conversation.stopping
              ? t("正在停止远端任务…")
              : awaiting
                ? t("请确认上述操作后继续")
                : conversation.compacting
                  ? t("正在自动压缩上下文…")
                  : t("正在处理…")}
          </div>
        )}
      </div>
      {scrolled && (
        <button
          type="button"
          className="ai-scroll-bottom"
          aria-label={t("滚动到最新消息")}
          onClick={() => {
            follow.current = true;
            scroller.current?.scrollTo({
              top: scroller.current.scrollHeight,
              behavior: "smooth",
            });
          }}
        >
          <ChevronDown size={15} />
        </button>
      )}
      {editing && (
        <form
          className="ai-manual-editor"
          role="dialog"
          aria-label={editing === "model" ? t("手动输入模型") : t("手动输入思考程度")}
          onSubmit={(event) => {
            event.preventDefault();
            commitManual();
          }}
        >
          <label>
            {editing === "model" ? t("模型 ID") : t("reasoning_effort 参数")}
            <input
              autoFocus
              aria-label={t("手动值")}
              value={manualDraft}
              maxLength={editing === "model" ? 200 : 64}
              placeholder={
                editing === "model"
                  ? t("输入服务支持的模型 ID")
                  : t("输入服务支持的思考程度值")
              }
              spellCheck={false}
              onChange={(event) => setManualDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditing(null);
              }}
            />
          </label>
          <small>{t("优先使用 /models 元数据；手动值会按原样发送给模型服务。")}</small>
          {manualError && (
            <span className="ai-error" role="alert">
              {manualError}
            </span>
          )}
          <div>
            <button type="button" onClick={() => setEditing(null)}>
              {t("取消")}</button>
            <button type="submit">{t("应用")}</button>
          </div>
        </form>
      )}
      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          follow.current = true;
          void ai.send(tab);
        }}
      >
        <textarea
          ref={textarea}
          aria-label={t("给 AI 发送消息")}
          value={conversation.draft}
          maxLength={50000}
          onChange={(e) => patch({ draft: e.target.value })}
          placeholder={
            connected ? t("描述部署、排查或运维任务…") : t("请先连接服务器")
          }
          disabled={!connected}
          rows={2}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (!busy) {
                follow.current = true;
                void ai.send(tab);
              }
            }
          }}
        />
        <div className="ai-composer-controls">
          <select
            className="ai-model-select"
            aria-label={t("AI 模型")}
            title={selection.model || t("选择模型")}
            value={selection.model}
            onChange={(e) =>
              e.target.value === "__ishell_manual__"
                ? openManual("model")
                : patch({
                    model: e.target.value,
                    manualModel: Boolean(
                      models.find((model) => model.id === e.target.value)
                        ?.manual,
                    ),
                    manualEffort: false,
                    effort:
                      models.find((model) => model.id === e.target.value)
                        ?.defaultReasoningEffort || "default",
                  })
            }
          >
            <option value="" disabled>
              {ai.modelsLoading ? t("读取模型…") : t("选择模型")}
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
            <option value="__ishell_manual__">{t("手动输入模型…")}</option>
          </select>
          <select
            className="ai-effort-select"
            aria-label={t("思考程度")}
            title={
              selection.efforts.length > 1
                ? t("服务元数据声明的思考程度")
                : t("服务未声明思考档位，使用默认值")
            }
            value={selection.effort}
            onChange={(e) =>
              e.target.value === "__ishell_manual__"
                ? openManual("effort")
                : patch({
                    effort: e.target.value,
                    manualEffort: Boolean(
                      conversation.manualEffort &&
                      e.target.value === conversation.effort,
                    ),
                  })
            }
          >
            {selection.efforts.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            <option value="__ishell_manual__">{t("手动输入…")}</option>
          </select>
          <label className="ai-permission-control">
            <ShieldCheck size={12} />
            <select
              aria-label={t("Agent 权限")}
              title={t("{0}。风险判断是辅助提示，不是隔离沙箱。", permission.description)}
              value={conversation.permission}
              onChange={(event) =>
                patch({
                  permission: event.target
                    .value as typeof conversation.permission,
                })
              }
            >
              {permissionOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {busy ? (
            <button
              type="button"
              className="ai-send stop"
              title={t("停止任务")}
              aria-label={t("停止 AI 任务")}
              disabled={conversation.stopping}
              onClick={() => void ai.stop(tab.id)}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              className="ai-send"
              title={t("发送（Enter）")}
              aria-label={t("发送 AI 消息")}
              disabled={
                !connected ||
                !ai.historyLoaded ||
                serverBusy ||
                ai.deletingIds.includes(conversation.id) ||
                !selection.model ||
                (ai.modelsLoading && !selection.manualModel) ||
                !conversation.draft.trim()
              }
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </form>
      <footer className="ai-foot">
        <span>
          {busy
            ? t("设置修改于下次发送生效")
            : serverBusy
              ? t("此服务器另有任务执行中，可从历史记录查看")
              : t("{0} · Shift + Enter 换行", tab.title)}
        </span>
        <span
          className="ai-context-usage"
          title={t("估算的模型上下文用量；达到 {0}k tokens 时自动压缩{1}", Math.round(contextLimit / 1000), selectedWindow
              ? t("（模型声明上下文窗口 {0}k）", Math.round(selectedWindow / 1000))
              : "")}
        >
          ≈
          {conversation.contextTokens >= 1000
            ? `${(conversation.contextTokens / 1000).toFixed(1)}k`
            : conversation.contextTokens}{" "}
          / {Math.round(contextLimit / 1000)}k
        </span>
      </footer>
    </section>
  );
}
