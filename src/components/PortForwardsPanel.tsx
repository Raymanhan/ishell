import { useState, type FormEvent } from "react";
import { ArrowRight, Copy, Network, Pencil, Plus, Trash2 } from "lucide-react";
import { formatAddress } from "../features/forwards/usePortForwards";
import type {
  PortForward,
  PortForwardInput,
  PortForwardKind,
  PortForwardStatus,
} from "../types";

const KIND_LABELS: Record<PortForwardKind, string> = {
  local: "本地",
  remote: "远程",
  dynamic: "SOCKS",
};

const KIND_HINTS: Record<PortForwardKind, string> = {
  local: "访问本机的监听地址，等于从服务器访问目标地址。常用于连接只对服务器开放的数据库或后台。",
  remote: "服务器上的监听地址收到的连接，会转到本机能访问的目标地址。常用于把本机服务临时暴露给服务器。",
  dynamic: "在本机开一个 SOCKS5 代理，浏览器或其他程序经它通过服务器访问网络。",
};

const STATE_LABELS: Record<string, string> = {
  starting: "启动中",
  running: "运行中",
  stopped: "已停止",
  error: "失败",
};

type Draft = Omit<PortForwardInput, "bindPort" | "destPort"> & { bindPort: string; destPort: string };

function draftFor(serverId: string, forward?: PortForward): Draft {
  return forward
    ? { ...forward, bindPort: String(forward.bindPort), destPort: forward.destPort ? String(forward.destPort) : "" }
    : {
        id: null,
        serverId,
        kind: "local",
        bindHost: "127.0.0.1",
        bindPort: "",
        destHost: "127.0.0.1",
        destPort: "",
        description: "",
        autoStart: false,
      };
}

function parsePort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** The port forwards of one server, for the side panel. */
export function PortForwardsPanel({
  serverId,
  serverName,
  forwards,
  statuses,
  onSave,
  onDelete,
  onStart,
  onStop,
  onCopied,
}: {
  serverId: string;
  serverName: string;
  forwards: PortForward[];
  statuses: Record<string, PortForwardStatus>;
  onSave: (input: PortForwardInput) => Promise<unknown>;
  onDelete: (forward: PortForward) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onCopied: (text: string) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverForwards = forwards.filter((forward) => forward.serverId === serverId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    const bindPort = parsePort(draft.bindPort);
    const destPort = draft.kind === "dynamic" ? 0 : parsePort(draft.destPort);
    if (bindPort === null) {
      setError("监听端口应为 1–65535");
      return;
    }
    if (destPort === null) {
      setError("目标端口应为 1–65535");
      return;
    }
    if (draft.kind !== "dynamic" && !draft.destHost.trim()) {
      setError("请填写目标主机");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, bindPort, destPort });
      setDraft(null);
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }

  const listenLabel = draft?.kind === "remote" ? "服务器上监听" : "本机监听";
  const targetLabel = draft?.kind === "remote" ? "转到（本机可访问的地址）" : "转到（服务器可访问的地址）";

  return (
    <section className="history-panel forwards-panel" aria-label="端口转发">
      <div className="forwards-head">
        <div>
          <strong>端口转发</strong>
          <span title={serverName}>{serverName}</span>
        </div>
        <button
          type="button"
          className="snippets-add"
          title="新建端口转发"
          aria-label="新建端口转发"
          onClick={() => {
            setError(null);
            setDraft(draftFor(serverId));
          }}
        >
          <Plus size={14} />
        </button>
      </div>

      {draft && (
        <form className="snippet-editor forward-editor" onSubmit={submit}>
          <div className="forward-kinds" role="group" aria-label="转发类型">
            {(Object.keys(KIND_LABELS) as PortForwardKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                className={draft.kind === kind ? "active" : ""}
                aria-pressed={draft.kind === kind}
                onClick={() => setDraft({ ...draft, kind })}
              >
                {KIND_LABELS[kind]}
              </button>
            ))}
          </div>
          <p className="forward-hint">{KIND_HINTS[draft.kind]}</p>
          <span className="forward-label">{listenLabel}</span>
          <div className="forward-address">
            <input
              value={draft.bindHost}
              placeholder="127.0.0.1"
              aria-label={`${listenLabel}地址`}
              onChange={(event) => setDraft({ ...draft, bindHost: event.target.value })}
            />
            <input
              value={draft.bindPort}
              placeholder="端口"
              inputMode="numeric"
              aria-label={`${listenLabel}端口`}
              autoFocus
              onChange={(event) => setDraft({ ...draft, bindPort: event.target.value })}
            />
          </div>
          {draft.kind !== "dynamic" && (
            <>
              <span className="forward-label">{targetLabel}</span>
              <div className="forward-address">
                <input
                  value={draft.destHost}
                  placeholder="主机"
                  aria-label="目标主机"
                  onChange={(event) => setDraft({ ...draft, destHost: event.target.value })}
                />
                <input
                  value={draft.destPort}
                  placeholder="端口"
                  inputMode="numeric"
                  aria-label="目标端口"
                  onChange={(event) => setDraft({ ...draft, destPort: event.target.value })}
                />
              </div>
            </>
          )}
          <input
            value={draft.description}
            placeholder="说明（可选）"
            aria-label="说明"
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
          <label className="snippet-run-toggle">
            <input
              type="checkbox"
              checked={draft.autoStart}
              onChange={(event) => setDraft({ ...draft, autoStart: event.target.checked })}
            />
            连接这台服务器的终端时自动启动
          </label>
          {error && <div className="snippet-error">{error}</div>}
          <div className="snippet-editor-actions">
            <button type="button" className="btn-ghost" onClick={() => setDraft(null)}>
              取消
            </button>
            <button type="submit" className="solid-button" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      )}

      <div className="history-list forwards-list">
        {serverForwards.length > 0 ? (
          serverForwards.map((forward) => {
            const status = statuses[forward.id];
            const state = status?.state ?? "stopped";
            const active = state === "running" || state === "starting";
            const listen = formatAddress(forward.bindHost, forward.bindPort);
            return (
              <div key={forward.id} className={`forward-row ${state}`}>
                <div className="forward-row-main">
                  <span className={`forward-state ${state}`} title={STATE_LABELS[state]} />
                  <span className="forward-kind">{KIND_LABELS[forward.kind]}</span>
                  <code title={listen}>{listen}</code>
                </div>
                {forward.kind !== "dynamic" && (
                  <div className="forward-row-dest">
                    <ArrowRight size={11} />
                    <code title={formatAddress(forward.destHost, forward.destPort)}>
                      {formatAddress(forward.destHost, forward.destPort)}
                    </code>
                  </div>
                )}
                {(forward.description || (state === "error" && status?.message)) && (
                  <div className={`forward-row-note ${state === "error" ? "error" : ""}`}>
                    {state === "error" && status?.message ? status.message : forward.description}
                  </div>
                )}
                <div className="forward-row-actions">
                  <button
                    type="button"
                    className={`forward-toggle ${active ? "on" : ""}`}
                    role="switch"
                    aria-checked={active}
                    title={active ? "停止" : "启动"}
                    aria-label={`${active ? "停止" : "启动"} ${listen}`}
                    onClick={() => (active ? onStop(forward.id) : onStart(forward.id))}
                  >
                    <span />
                  </button>
                  <span className="forward-state-label">{STATE_LABELS[state]}</span>
                  {forward.kind !== "remote" && (
                    <button
                      type="button"
                      title="复制监听地址"
                      aria-label={`复制 ${listen}`}
                      onClick={() => {
                        void navigator.clipboard.writeText(listen).then(() => onCopied(listen));
                      }}
                    >
                      <Copy size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    title="编辑"
                    aria-label={`编辑 ${listen}`}
                    onClick={() => {
                      setError(null);
                      setDraft(draftFor(serverId, forward));
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    className="danger"
                    title="删除"
                    aria-label={`删除 ${listen}`}
                    onClick={() => onDelete(forward)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          !draft && (
            <div className="history-empty">
              <Network size={16} />
              <span>还没有端口转发，点 + 新建</span>
            </div>
          )
        )}
      </div>
      <p className="snippets-hint">转发独立于终端运行，关闭标签不会停止；退出 iShell 时全部停止。</p>
    </section>
  );
}
