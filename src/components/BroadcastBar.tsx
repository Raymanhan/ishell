import { Check, Radio, X } from "lucide-react";
import type { ShellTab } from "../features/shell/types";

/**
 * Shown while broadcast input is on: picks which sessions receive what is
 * typed into any of them.
 */
export function BroadcastBar({
  sessions,
  targets,
  activeGroupPaneIds,
  onChange,
  onStop,
}: {
  /** Every open session, in tab order. */
  sessions: ShellTab[];
  targets: Set<string>;
  /** Panes of the tab in front, for the "this tab" shortcut. */
  activeGroupPaneIds: string[];
  onChange: (targets: Set<string>) => void;
  onStop: () => void;
}) {
  const toggle = (id: string) => {
    const next = new Set(targets);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const count = sessions.filter((session) => targets.has(session.id)).length;
  // Number repeated titles (several panes on one server) so each chip is identifiable.
  const seen = new Map<string, number>();
  const totals = new Map<string, number>();
  sessions.forEach((session) => totals.set(session.title, (totals.get(session.title) ?? 0) + 1));
  const labels = sessions.map((session) => {
    if ((totals.get(session.title) ?? 0) < 2) return session.title;
    const ordinal = (seen.get(session.title) ?? 0) + 1;
    seen.set(session.title, ordinal);
    return `${session.title} #${ordinal}`;
  });

  return (
    <div className="broadcast-bar" role="region" aria-label="广播输入">
      <div className="broadcast-bar-head">
        <Radio size={14} />
        <strong>广播输入</strong>
        <span>
          {count < 2 ? "至少选择 2 个会话" : `在任一所选会话中输入，会同步发送到全部 ${count} 个会话`}
        </span>
        <button type="button" className="broadcast-bar-link" onClick={() => onChange(new Set(activeGroupPaneIds))}>
          当前标签
        </button>
        <button type="button" className="broadcast-bar-link" onClick={() => onChange(new Set(sessions.map((session) => session.id)))}>
          全部会话
        </button>
        <button type="button" className="broadcast-bar-close" onClick={onStop} title="停止广播" aria-label="停止广播">
          <X size={14} />
        </button>
      </div>
      <div className="broadcast-bar-sessions" role="group" aria-label="广播目标">
        {sessions.map((session, index) => {
          const selected = targets.has(session.id);
          return (
            <button
              key={session.id}
              type="button"
              className={`broadcast-chip ${selected ? "on" : ""}`}
              aria-pressed={selected}
              title={session.subtitle}
              onClick={() => toggle(session.id)}
            >
              <span className="broadcast-chip-check">{selected && <Check size={11} />}</span>
              <span className={`tab-dot ${session.state}`} style={{ color: session.color }} />
              <span className="broadcast-chip-title">{labels[index]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
