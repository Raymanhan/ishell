import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  Pencil,
  PlugZap,
  Layers,
  Plus,
  Search,
  Signal,
} from "lucide-react";
import type { ServerRecord } from "../types";

export function Sidebar({
  collapsed,
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
  onToggleCollapse,
  count,
}: {
  collapsed: boolean;
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
  onToggleCollapse: () => void;
  count: number;
}) {
  const entries = Object.entries(grouped);
  const servers = entries.flatMap(([, list]) => list);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    server: ServerRecord;
    x: number;
    y: number;
  } | null>(null);

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
    window.addEventListener("blur", () => setMenu(null), { once: true });
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

  function connectFromMenu() {
    if (!menu) return;
    const server = menu.server;
    setMenu(null);
    onConnect(server);
  }

  function editFromMenu() {
    if (!menu) return;
    const server = menu.server;
    setMenu(null);
    onEdit(server);
  }

  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="sidebar-head" data-tauri-drag-region>
        <div className="brand">
          <div className="brand-mark">
            <img src="/favicon.svg" alt="" aria-hidden="true" />
          </div>
          {!collapsed && <div className="brand-text">
            <strong>iShell</strong>
            <span>{count} 台主机</span>
          </div>}
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={onToggleCollapse}
          title={collapsed ? "展开侧栏" : "折叠侧栏"}
          aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
        >
          {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
        </button>
      </div>

      {collapsed ? (
        <div className="server-rail" aria-label="主机列表">
          {servers.length === 0 ? (
            <div className="rail-empty" title="没有匹配的主机">
              <Signal size={18} />
            </div>
          ) : (
            servers.map((server) => (
              <button
                key={server.id}
                type="button"
                className={`rail-server ${selectedServerId === server.id ? "on" : ""}`}
                onClick={() => onSelect(server)}
                onDoubleClick={() => onConnect(server)}
                onContextMenu={(event) => handleContextMenu(event, server)}
                title={`${server.name}\n${server.username}@${server.host}:${server.port}\n右键菜单，双击连接`}
                aria-label={`${server.name}，右键菜单，双击连接`}
              >
                <span style={{ backgroundColor: server.color }} />
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          <label className="search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索主机、分组、标签"
              spellCheck={false}
            />
          </label>

          <div className="chips">
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

          <div className="server-scroll">
            {entries.length === 0 ? (
              <div className="sidebar-empty">
                <Signal size={20} />
                <p>没有匹配的主机</p>
              </div>
            ) : (
              entries.map(([group, list]) => (
                <section key={group} className="server-group">
                  <div className="group-label">
                    <Layers size={12} />
                    <span>{group}</span>
                    <em>{list.length}</em>
                  </div>
                  {list.map((server) => (
                    <button
                      key={server.id}
                      type="button"
                      className={`server-card ${selectedServerId === server.id ? "on" : ""}`}
                      onClick={() => onSelect(server)}
                      onDoubleClick={() => onConnect(server)}
                      onContextMenu={(event) => handleContextMenu(event, server)}
                      title="右键菜单，双击连接"
                    >
                      <span className="dot" style={{ backgroundColor: server.color }} />
                      <span className="server-meta">
                        <strong>{server.name}</strong>
                        <small>
                          {server.username}@{server.host}
                          <span className="port">:{server.port}</span>
                        </small>
                      </span>
                      <span className={`pulse ${server.lastConnectedAt ? "live" : ""}`} />
                    </button>
                  ))}
                </section>
              ))
            )}
          </div>
        </>
      )}

      <div className="sidebar-foot">
        <button type="button" className="btn-primary" onClick={onNew}>
          <Plus size={15} />
          {!collapsed && "新建连接"}
        </button>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="server-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label={`${menu.server.name} 操作`}
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
    </aside>
  );
}
