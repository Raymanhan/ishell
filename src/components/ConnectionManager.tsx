import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  Layers,
  Pencil,
  PlugZap,
  Plus,
  Search,
  Server,
  Signal,
  X,
} from "lucide-react";
import type { ServerRecord } from "../types";

export function ConnectionManager({
  grouped,
  query,
  setQuery,
  groups,
  activeGroup,
  setActiveGroup,
  selectedServerId,
  onSelect,
  onConnect,
  onEdit,
  onNew,
  onClose,
  count,
}: {
  grouped: Record<string, ServerRecord[]>;
  query: string;
  setQuery: (value: string) => void;
  groups: string[];
  activeGroup: string;
  setActiveGroup: (value: string) => void;
  selectedServerId: string | null;
  onSelect: (server: ServerRecord) => void;
  onConnect: (server: ServerRecord) => void;
  onEdit: (server: ServerRecord) => void;
  onNew: () => void;
  onClose: () => void;
  count: number;
}) {
  const entries = Object.entries(grouped);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    server: ServerRecord;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  function handleContextMenu(event: MouseEvent<HTMLButtonElement>, server: ServerRecord) {
    event.preventDefault();
    onSelect(server);
    setMenu({
      server,
      x: Math.min(event.clientX, window.innerWidth - 164),
      y: Math.min(event.clientY, window.innerHeight - 96),
    });
  }

  function connect(server: ServerRecord) {
    onSelect(server);
    onConnect(server);
    onClose();
  }

  function edit(server: ServerRecord) {
    onSelect(server);
    onEdit(server);
  }

  function connectFromMenu() {
    if (!menu) return;
    connect(menu.server);
    setMenu(null);
  }

  function editFromMenu() {
    if (!menu) return;
    edit(menu.server);
    setMenu(null);
  }

  return (
    <div className="connection-backdrop" onMouseDown={onClose}>
      <section
        className="connection-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-manager-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="connection-head">
          <div className="connection-title">
            <span className="brand-mark subtle">
              <img src="/favicon.svg" alt="" aria-hidden="true" />
            </span>
            <div>
              <span className="eyebrow">Connections</span>
              <h2 id="connection-manager-title">连接管理</h2>
            </div>
          </div>
          <div className="connection-head-actions">
            <span className="connection-count">
              <Server size={13} />
              {count} 台主机
            </span>
            <button type="button" className="btn-primary" onClick={onNew}>
              <Plus size={15} />
              新建连接
            </button>
            <button type="button" className="icon-button" onClick={onClose} aria-label="关闭连接管理">
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="connection-toolbar">
          <label className="search connection-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索主机、分组、标签"
              spellCheck={false}
              autoFocus
            />
          </label>
          <div className="chips connection-chips">
            {groups.map((group) => (
              <button
                key={group}
                type="button"
                className={`chip ${group === activeGroup ? "on" : ""}`}
                onClick={() => setActiveGroup(group)}
              >
                {group}
              </button>
            ))}
          </div>
        </div>

        <div className="connection-list">
          {entries.length === 0 ? (
            <div className="connection-empty">
              <Signal size={24} />
              <p>没有匹配的主机</p>
            </div>
          ) : (
            entries.map(([group, list]) => (
              <section key={group} className="connection-group">
                <div className="group-label">
                  <Layers size={12} />
                  <span>{group}</span>
                  <em>{list.length}</em>
                </div>
                <div className="connection-grid">
                  {list.map((server) => (
                    <button
                      key={server.id}
                      type="button"
                      className={`connection-card ${selectedServerId === server.id ? "on" : ""}`}
                      onClick={() => onSelect(server)}
                      onDoubleClick={() => connect(server)}
                      onContextMenu={(event) => handleContextMenu(event, server)}
                      title="右键菜单，双击连接"
                    >
                      <span className="dot" style={{ backgroundColor: server.color }} />
                      <span className="connection-meta">
                        <strong>{server.name}</strong>
                        <small>
                          {server.username}@{server.host}:{server.port}
                        </small>
                      </span>
                      <span className={`pulse ${server.lastConnectedAt ? "live" : ""}`} />
                      <span className="connection-actions">
                        <span onClick={() => connect(server)}>
                          <PlugZap size={13} />
                          连接
                        </span>
                        <span onClick={() => edit(server)}>
                          <Pencil size={13} />
                          编辑
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </section>

      {menu && (
        <div
          ref={menuRef}
          className="server-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label={`${menu.server.name} 操作`}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={connectFromMenu} role="menuitem">
            <PlugZap size={14} />
            <span>连接</span>
          </button>
          <button type="button" onClick={editFromMenu} role="menuitem">
            <Pencil size={14} />
            <span>编辑</span>
          </button>
        </div>
      )}
    </div>
  );
}
