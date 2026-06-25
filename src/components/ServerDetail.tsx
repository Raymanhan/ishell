import { Clock3, Plus, Server, TerminalSquare } from "lucide-react";
import type { ServerRecord } from "../types";

export function ServerDetail({
  servers,
  onConnect,
  onNew,
  onOpenConnections,
}: {
  servers: ServerRecord[];
  onConnect: (server: ServerRecord) => void;
  onNew: () => void;
  onOpenConnections: () => void;
}) {
  const recent = getRecentServers(servers);
  const hasRecent = servers.some((server) => server.lastConnectedAt != null);

  return (
    <div className="start-screen">
      <section className="start-panel">
        <div className="start-head">
          <div>
            <span className="eyebrow">iShell</span>
            <h1>最近打开</h1>
            <p>选择一个连接即可进入 Shell，会话会在顶部标签栏中打开。</p>
          </div>
          <div className="start-actions">
            <button type="button" className="btn-ghost" onClick={onOpenConnections}>
              <Server size={15} />
              连接管理
            </button>
            <button type="button" className="btn-primary" onClick={onNew}>
              <Plus size={15} />
              新建连接
            </button>
          </div>
        </div>

        {recent.length ? (
          <div className="recent-list" aria-label={hasRecent ? "最近打开的连接" : "连接列表"}>
            {recent.map((server) => (
              <button
                key={server.id}
                type="button"
                className="recent-card"
                onClick={() => onConnect(server)}
                title={`${server.name}\n${server.username}@${server.host}:${server.port}`}
              >
                <span className="recent-color" style={{ backgroundColor: server.color }} />
                <span className="recent-main">
                  <strong>{server.name}</strong>
                  <small>
                    {server.username}@{server.host}:{server.port}
                  </small>
                </span>
                <span className="recent-meta">
                  <Clock3 size={13} />
                  {formatLastConnected(server.lastConnectedAt)}
                </span>
                <span className="recent-open">
                  <TerminalSquare size={14} />
                  打开
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="recent-empty">
            <TerminalSquare size={28} />
            <p>还没有连接。新建一个连接开始使用。</p>
            <button type="button" className="btn-primary" onClick={onNew}>
              <Plus size={15} />
              新建连接
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function getRecentServers(servers: ServerRecord[]) {
  const sorted = [...servers].sort((a, b) => (b.lastConnectedAt ?? -1) - (a.lastConnectedAt ?? -1));
  return sorted.slice(0, 8);
}

function formatLastConnected(timestamp?: number | null) {
  if (timestamp == null) return "未连接";
  if (timestamp <= 0) return "最近使用";

  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (diffSeconds < 60) return "刚刚";
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} 分钟前`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)} 小时前`;
  if (diffSeconds < 86400 * 7) return `${Math.floor(diffSeconds / 86400)} 天前`;

  return new Date(timestamp * 1000).toLocaleDateString();
}
