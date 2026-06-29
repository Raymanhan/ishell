import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Pencil,
  PlugZap,
  Plus,
  Search,
  Server,
  Signal,
  Trash2,
  X,
} from "lucide-react";
import type { ServerRecord } from "../types";

export function ConnectionManager({
  open,
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
  onCreateFolder,
  onExport,
  onImport,
  onDelete,
  onClose,
  count,
}: {
  open: boolean;
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
  onNew: (group?: string) => void;
  onCreateFolder: (name: string) => void;
  onExport: (target: { serverIds: string[]; folders: string[] }) => void;
  onImport: () => void;
  onDelete: (target: { serverIds: string[]; folders: string[] }) => void;
  onClose: () => void;
  count: number;
}) {
  const entries = Object.entries(grouped);
  const treeItems = useMemo(
    () => entries.flatMap(([group, list]) => [
      { key: folderKey(group), type: "folder" as const, group },
      ...list.map((server) => ({ key: serverKey(server.id), type: "server" as const, group, server })),
    ]),
    [entries],
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const createFolderInputRef = useRef<HTMLInputElement>(null);
  const createFolderFocusedRef = useRef(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const [creatingFolderName, setCreatingFolderName] = useState<string | null>(null);
  const [menu, setMenu] = useState<
    | { type: "server"; server: ServerRecord; x: number; y: number }
    | { type: "folder" | "blank"; group?: string; x: number; y: number }
    | null
  >(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) setMenu(null);
  }, [open]);

  useEffect(() => {
    if (creatingFolderName === null) {
      createFolderFocusedRef.current = false;
      return;
    }
    if (createFolderFocusedRef.current) return;
    createFolderFocusedRef.current = true;
    requestAnimationFrame(() => {
      createFolderInputRef.current?.focus();
      createFolderInputRef.current?.select();
    });
  }, [creatingFolderName]);

  useEffect(() => {
    const known = new Set(treeItems.map((item) => item.key));
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => known.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [treeItems]);

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
    event.stopPropagation();
    onSelect(server);
    const key = serverKey(server.id);
    if (!selectedKeys.has(key)) {
      setSelectedKeys(new Set([key]));
      setLastSelectedKey(key);
    }
    setMenu({
      type: "server",
      server,
      ...menuPosition(event, 164, 116),
    });
  }

  function handleFolderContextMenu(event: MouseEvent<HTMLButtonElement>, group: string) {
    event.preventDefault();
    event.stopPropagation();
    const key = folderKey(group);
    if (!selectedKeys.has(key)) {
      setSelectedKeys(new Set([key]));
      setLastSelectedKey(key);
    }
    setMenu({
      type: "folder",
      group,
      ...menuPosition(event, 180, 116),
    });
  }

  function handleBlankContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    setMenu({
      type: "blank",
      ...menuPosition(event, 180, 116),
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
    if (!menu || menu.type !== "server") return;
    connect(menu.server);
    setMenu(null);
  }

  function editFromMenu() {
    if (!menu || menu.type !== "server") return;
    edit(menu.server);
    setMenu(null);
  }

  function createServerFromMenu() {
    if (!menu || menu.type === "server") return;
    onNew(menu.group);
    setMenu(null);
  }

  function createFolderFromMenu() {
    setCreatingFolderName("");
    setMenu(null);
  }

  function importFromMenu() {
    onImport();
    setMenu(null);
  }

  function exportFromMenu() {
    onExport(exportTargetForMenu());
    setMenu(null);
  }

  function deleteFromMenu() {
    onDelete(exportTargetForMenu());
    setMenu(null);
  }

  function exportTargetForMenu() {
    const keys = selectedKeys.size > 0 ? selectedKeys : keysForMenuFallback();
    const serverIds: string[] = [];
    const folders: string[] = [];
    keys.forEach((key) => {
      if (key.startsWith("server:")) serverIds.push(key.slice("server:".length));
      if (key.startsWith("folder:")) folders.push(key.slice("folder:".length));
    });
    return { serverIds, folders };
  }

  function keysForMenuFallback() {
    if (!menu) return new Set<string>();
    if (menu.type === "server") return new Set([serverKey(menu.server.id)]);
    if (menu.type === "folder" && menu.group) return new Set([folderKey(menu.group)]);
    return new Set<string>();
  }

  function selectTreeItem(
    event: MouseEvent,
    key: string,
    server?: ServerRecord,
  ) {
    if (server) onSelect(server);

    if (event.shiftKey && lastSelectedKey) {
      const start = treeItems.findIndex((item) => item.key === lastSelectedKey);
      const end = treeItems.findIndex((item) => item.key === key);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        setSelectedKeys(new Set(treeItems.slice(from, to + 1).map((item) => item.key)));
        return;
      }
    }

    if (event.metaKey || event.ctrlKey) {
      setSelectedKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setLastSelectedKey(key);
      return;
    }

    setSelectedKeys(new Set([key]));
    setLastSelectedKey(key);
  }

  function toggleFolder(group: string) {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  function commitCreateFolder() {
    if (creatingFolderName === null) return;
    const name = creatingFolderName.trim();
    if (name) onCreateFolder(name);
    setCreatingFolderName(null);
  }

  const selectedExportCount = selectedKeys.size;

  return (
    <aside
      className={`connection-manager ${open ? "open" : ""}`}
      aria-hidden={!open}
      aria-labelledby="connection-manager-title"
    >
      {open && (
        <div className="connection-panel-content">
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
            <button type="button" className="btn-primary" onClick={() => onNew()}>
              <Plus size={15} />
              新建
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
              placeholder="搜索主机、文件夹、标签"
              spellCheck={false}
              autoFocus
            />
          </label>
        </div>

        <div className="connection-list" onContextMenu={handleBlankContextMenu}>
          {creatingFolderName !== null && (
            <div className="connection-folder-row creating-folder" onContextMenu={(event) => event.stopPropagation()}>
              <span />
              <Folder size={14} />
              <input
                ref={createFolderInputRef}
                value={creatingFolderName}
                placeholder="新建文件夹"
                onChange={(event) => setCreatingFolderName(event.target.value)}
                onBlur={commitCreateFolder}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitCreateFolder();
                  if (event.key === "Escape") setCreatingFolderName(null);
                }}
              />
              <em />
            </div>
          )}
          {entries.length === 0 ? (
            <div className="connection-empty">
              <Signal size={24} />
              <p>没有匹配的主机</p>
            </div>
          ) : (
            entries.map(([group, list]) => (
              <section key={group} className="connection-folder">
                <button
                  type="button"
                  className={`connection-folder-row ${selectedKeys.has(folderKey(group)) ? "on" : ""}`}
                  onClick={(event) => {
                    if (event.shiftKey || event.metaKey || event.ctrlKey) {
                      selectTreeItem(event, folderKey(group));
                    } else {
                      toggleFolder(group);
                    }
                  }}
                  onContextMenu={(event) => handleFolderContextMenu(event, group)}
                  aria-expanded={!collapsedFolders.has(group)}
                >
                  <ChevronRight size={13} className="folder-caret" />
                  {collapsedFolders.has(group) ? <Folder size={14} /> : <FolderOpen size={14} />}
                  <span>{group}</span>
                  <em>{list.length}</em>
                </button>
                {!collapsedFolders.has(group) && (
                  <div className="connection-tree-children">
                    {list.map((server) => (
                      <div
                        key={server.id}
                        className={`connection-node ${
                          selectedServerId === server.id || selectedKeys.has(serverKey(server.id)) ? "on" : ""
                        }`}
                      >
                        <button
                          type="button"
                          className="connection-node-main"
                          onClick={(event) => selectTreeItem(event, serverKey(server.id), server)}
                          onDoubleClick={() => connect(server)}
                          onContextMenu={(event) => handleContextMenu(event, server)}
                          title="右键菜单，双击连接"
                        >
                          <span className="tree-branch" aria-hidden />
                          <span className="dot" style={{ backgroundColor: server.color }} />
                          <span className="connection-meta">
                            <strong>{server.name}</strong>
                            <small>
                              {server.username}@{server.host}:{server.port}
                            </small>
                          </span>
                          <span className={`pulse ${server.lastConnectedAt ? "live" : ""}`} />
                        </button>
                        <div className="connection-node-actions">
                          <button type="button" onClick={() => connect(server)} title="连接">
                            <PlugZap size={13} />
                          </button>
                          <button type="button" onClick={() => edit(server)} title="编辑">
                            <Pencil size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
        </div>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="server-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label={menu.type === "server" ? `${menu.server.name} 操作` : "连接管理操作"}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {menu.type === "server" ? (
            <>
              <button type="button" onClick={connectFromMenu} role="menuitem">
                <PlugZap size={14} />
                <span>连接</span>
              </button>
              <button type="button" onClick={editFromMenu} role="menuitem">
                <Pencil size={14} />
                <span>编辑</span>
              </button>
              <div className="ctx-sep" />
              <button type="button" onClick={exportFromMenu} role="menuitem">
                <Server size={14} />
                <span>{selectedExportCount > 1 ? `导出所选 ${selectedExportCount} 项` : "导出"}</span>
              </button>
              <button type="button" onClick={importFromMenu} role="menuitem">
                <FolderOpen size={14} />
                <span>导入</span>
              </button>
              <div className="ctx-sep" />
              <button type="button" className="danger" onClick={deleteFromMenu} role="menuitem">
                <Trash2 size={14} />
                <span>{selectedExportCount > 1 ? `删除所选 ${selectedExportCount} 项` : "删除"}</span>
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={createServerFromMenu} role="menuitem">
                <Server size={14} />
                <span>新建服务器</span>
              </button>
              <button type="button" onClick={createFolderFromMenu} role="menuitem">
                <Folder size={14} />
                <span>新建文件夹</span>
              </button>
              <div className="ctx-sep" />
              <button type="button" onClick={exportFromMenu} role="menuitem">
                <Server size={14} />
                <span>{selectedExportCount > 1 ? `导出所选 ${selectedExportCount} 项` : "导出"}</span>
              </button>
              <button type="button" onClick={importFromMenu} role="menuitem">
                <FolderOpen size={14} />
                <span>导入</span>
              </button>
              {menu.type === "folder" && (
                <>
                  <div className="ctx-sep" />
                  <button type="button" className="danger" onClick={deleteFromMenu} role="menuitem">
                    <Trash2 size={14} />
                    <span>{selectedExportCount > 1 ? `删除所选 ${selectedExportCount} 项` : "删除文件夹"}</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function serverKey(id: string) {
  return `server:${id}`;
}

function folderKey(group: string) {
  return `folder:${group}`;
}

function menuPosition(event: MouseEvent, width: number, height: number) {
  const offsetY = 10;
  return {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width)),
    y: Math.max(8, Math.min(event.clientY - offsetY, window.innerHeight - height)),
  };
}
