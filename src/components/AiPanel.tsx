import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  LoaderCircle,
  Plus,
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
  effortOptions,
  emptyConversation,
  permissionOptions,
  type AiEntry,
} from "../features/ai/types";
import type { ShellTab } from "../features/shell/types";

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
      title={copied ? "已复制" : "复制"}
      aria-label={copied ? "已复制" : "复制"}
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
  const failed =
    Boolean(result?.error) ||
    (result?.exitCode != null && result.exitCode !== 0);
  const title =
    (
      {
        shell: "执行命令",
        run_code: "运行代码",
        read_file: "读取文件",
        write_file: "写入文件",
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
      className={`ai-tool ${failed ? "failed" : ""} ${entry.approvalPending ? "awaiting" : ""}`}
      open={entry.running || entry.approvalPending || undefined}
    >
      <summary>
        {entry.approvalPending ? (
          <ShieldCheck size={14} />
        ) : entry.running ? (
          <LoaderCircle size={14} className="ai-spin" />
        ) : failed ? (
          <X size={14} />
        ) : (
          <Check size={14} />
        )}
        <strong>{title}</strong>
        <span>
          {entry.approvalPending
            ? "等待确认"
            : entry.approved === false
              ? "已拒绝"
              : entry.running
                ? "执行中"
                : failed
                  ? "失败"
                  : result?.exitCode === 0
                    ? "完成"
                    : "未完成"}
          {result?.exitCode != null ? ` · ${result.exitCode}` : ""}
        </span>
        <ChevronDown size={13} />
      </summary>
      {entry.risk && (
        <div className={`ai-risk ${entry.risk.level}`}>
          <strong>{entry.risk.label}</strong>
          <span>{entry.risk.reason}</span>
        </div>
      )}
      {(entry.name === "shell" || entry.name === "run_code") && (
        <div className="ai-tool-path">目录：{String(args?.cwd || "~（远端主目录）")}</div>
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
          <p>目标：{target}。请检查命令、代码和路径。</p>
          <div>
            <button
              type="button"
              disabled={entry.approvalBusy}
              onClick={() => onApprove(false)}
            >
              拒绝
            </button>
            <button
              type="button"
              disabled={entry.approvalBusy}
              onClick={() => onApprove(true)}
            >
              {entry.approvalBusy ? "提交中…" : "仅此次允许"}
            </button>
          </div>
        </div>
      )}
      {entry.approvalError && (
        <div className="ai-error" role="alert">
          {entry.approvalError}
        </div>
      )}
      {result?.stdout && <pre className="ai-tool-output">{result.stdout}</pre>}
      {result?.stderr && (
        <pre className="ai-tool-output ai-stderr">{result.stderr}</pre>
      )}
      {result?.error && <div className="ai-error">{result.error}</div>}
      {result?.truncated && <small>输出较长，仅保留部分内容。</small>}
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
        {entry.text}
      </div>
    );
  return (
    <article className={`ai-message ${entry.kind}`}>
      {entry.thinking && (
        <details className="ai-thinking">
          <summary>思考过程</summary>
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
  const connected = tab.state === "connected";
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [scrolled, setScrolled] = useState(false);
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
    follow.current = true;
    setScrolled(false);
  }, [tab.id]);
  useEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [conversation.entries, busy, tab.id]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(180, textarea.current.scrollHeight)}px`;
    }
  }, [conversation.draft, tab.id]);
  const models = [
    ...new Set([...ai.config.models, conversation.model].filter(Boolean)),
  ];
  const permission = permissionOptions.find(
    (option) => option.value === conversation.permission,
  )!;
  const awaiting = conversation.entries.some((entry) => entry.approvalPending);
  return (
    <section className="ai-panel" aria-label="AI 助手">
      <header className="ai-head">
        <div>
          <Sparkles size={16} />
          <strong>AI 助手</strong>
        </div>
        <div>
          <button
            className="ai-icon"
            type="button"
            title="新建对话"
            aria-label="新建 AI 对话"
            disabled={busy || !conversation.entries.length}
            onClick={() => ai.clear(tab.id)}
          >
            <Plus size={16} />
          </button>
          <button
            className="ai-icon"
            type="button"
            title="AI 设置"
            aria-label="AI 设置"
            onClick={onSettings}
          >
            <Settings size={15} />
          </button>
          <button
            className="ai-icon"
            type="button"
            title="关闭 AI 面板"
            aria-label="关闭 AI 面板"
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
            <h3>这台服务器，交给 AI</h3>
            <p>描述目标，AI 会检查环境、执行命令并验证结果。</p>
            <div>
              {[
                "检查服务器健康状态，找出异常服务",
                "检查 Docker 环境和正在运行的容器",
                "帮我部署一个网站，先确认所需信息",
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
          <div className="ai-error">AI 设置读取失败：{ai.configError}</div>
        )}
        {!models.length && (
          <button type="button" className="ai-setup" onClick={onSettings}>
            <Settings size={15} />
            先配置模型地址、密钥和模型
          </button>
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
              ? "正在停止远端任务…"
              : awaiting
                ? "请确认上述操作后继续"
                : conversation.compacting
                  ? "正在自动压缩上下文…"
                  : "正在处理…"}
          </div>
        )}
      </div>
      {scrolled && (
        <button
          type="button"
          className="ai-scroll-bottom"
          aria-label="滚动到最新消息"
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
          aria-label="给 AI 发送消息"
          value={conversation.draft}
          maxLength={50000}
          onChange={(e) => patch({ draft: e.target.value })}
          placeholder={
            connected ? "描述部署、排查或运维任务…" : "请先连接服务器"
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
            aria-label="AI 模型"
            title={conversation.model || "选择模型"}
            value={conversation.model}
            disabled={busy}
            onChange={(e) => patch({ model: e.target.value })}
          >
            <option value="" disabled>
              选择模型
            </option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <select
            aria-label="思考程度"
            title="思考程度（服务需支持 reasoning_effort）"
            value={conversation.effort}
            disabled={busy}
            onChange={(e) =>
              patch({ effort: e.target.value as typeof conversation.effort })
            }
          >
            {effortOptions.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {busy ? (
            <button
              type="button"
              className="ai-send stop"
              title="停止任务"
              aria-label="停止 AI 任务"
              disabled={conversation.stopping}
              onClick={() => void ai.stop(tab.id)}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              className="ai-send"
              title="发送（Enter）"
              aria-label="发送 AI 消息"
              disabled={
                !connected || !conversation.model || !conversation.draft.trim()
              }
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
        <div className="ai-permission-bar">
          <ShieldCheck size={12} />
          <select
            aria-label="Agent 权限"
            title={`${permission.description}。风险判断是辅助提示，不是隔离沙箱。`}
            value={conversation.permission}
            disabled={busy}
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
          <span title="估算的模型上下文用量；达到 200k tokens 时自动压缩">
            ≈
            {conversation.contextTokens >= 1000
              ? `${(conversation.contextTokens / 1000).toFixed(1)}k`
              : conversation.contextTokens}{" "}
            / 200k
          </span>
        </div>
      </form>
      <footer className="ai-foot">
        {permission.label} · {tab.title} · Shift + Enter 换行
      </footer>
    </section>
  );
}
