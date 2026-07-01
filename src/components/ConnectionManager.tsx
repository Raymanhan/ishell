import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Pencil,
  PlugZap,
  Search,
  Server,
  Signal,
  Trash2,
} from "lucide-react";
import type { ServerRecord } from "../types";

export interface ConnectionMoveRequest {
  draggedKey: string;
  targetKey: string;
  position: "before" | "after" | "inside";
}

export function ConnectionManager({
  open,
  grouped,
  selectedServerId,
  onSelect,
  onConnect,
  onEdit,
  onNew,
  onCreateFolder,
  onExport,
  onImport,
  onDelete,
  onMove,
  onClose,
}: {
  open: boolean;
  grouped: Record<string, ServerRecord[]>;
  selectedServerId: string | null;
  onSelect: (server: ServerRecord) => void;
  onConnect: (server: ServerRecord) => void;
  onEdit: (server: ServerRecord) => void;
  onNew: (group?: string) => void;
  onCreateFolder: (name: string) => void;
  onExport: (target: { serverIds: string[]; folders: string[] }) => void;
  onImport: () => void;
  onDelete: (target: { serverIds: string[]; folders: string[] }) => void;
  onMove: (request: ConnectionMoveRequest) => void;
  onClose: () => void;
}) {
  const entries = useMemo(() => Object.entries(grouped), [grouped]);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredEntries = useMemo(() => {
    if (!normalizedQuery) return entries;
    return entries
      .map(([group, list]) => {
        const groupMatches = group.toLowerCase().includes(normalizedQuery);
        const filteredList = groupMatches
          ? list
          : list.filter((server) => serverMatchesQuery(server, normalizedQuery));
        return [group, filteredList] as const;
      })
      .filter(([group, list]) => group.toLowerCase().includes(normalizedQuery) || list.length > 0);
  }, [entries, normalizedQuery]);
  const treeItems = useMemo(
    () => filteredEntries.flatMap(([group, list]) => [
      { key: folderKey(group), type: "folder" as const, group },
      ...list.map((server) => ({ key: serverKey(server.id), type: "server" as const, group, server })),
    ]),
    [filteredEntries],
  );
  const allTreeItems = useMemo(
    () => entries.flatMap(([group, list]) => [
      { key: folderKey(group), type: "folder" as const, group },
      ...list.map((server) => ({ key: serverKey(server.id), type: "server" as const, group, server })),
    ]),
    [entries],
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    key: string;
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const createFolderInputRef = useRef<HTMLInputElement>(null);
  const createFolderFocusedRef = useRef(false);
  const suppressTreeClickRef = useRef(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const [creatingFolderName, setCreatingFolderName] = useState<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<ConnectionMoveRequest | null>(null);
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
    const known = new Set(allTreeItems.map((item) => item.key));
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => known.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [allTreeItems]);

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
      ...menuPosition(event, 148, 178),
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
      ...menuPosition(event, 148, 178),
    });
  }

  function handleBlankContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    setMenu({
      type: "blank",
      ...menuPosition(event, 148, 140),
    });
  }

  function connect(server: ServerRecord) {
    onSelect(server);
    onConnect(server);
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

  function beginTreeDrag(event: ReactPointerEvent<HTMLElement>, key: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("input")) return;
    dragRef.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTreeDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && moved < 4) return;

    event.preventDefault();
    drag.dragging = true;
    setDraggingKey(drag.key);

    const target = document
      .elementsFromPoint(event.clientX, event.clientY)
      .map((element) =>
        element instanceof HTMLElement
          ? element.closest<HTMLElement>("[data-connection-key]")
          : null,
      )
      .find((element): element is HTMLElement => Boolean(element));
    const targetKey = target?.dataset.connectionKey;
    if (!target || !targetKey || targetKey === drag.key) {
      setDropHint(null);
      return;
    }

    const rect = target.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const isFolderTarget = targetKey.startsWith("folder:");
    const position: ConnectionMoveRequest["position"] = isFolderTarget
      ? offsetY < rect.height * 0.28
        ? "before"
        : offsetY > rect.height * 0.72
          ? "after"
          : "inside"
      : offsetY < rect.height / 2
        ? "before"
        : "after";
    const next = { draggedKey: drag.key, targetKey, position };
    if (!canDropConnection(next)) {
      setDropHint(null);
      return;
    }
    setDropHint(next);
    if (position === "inside" && isFolderTarget) {
      setCollapsedFolders((current) => {
        const group = targetKey.slice("folder:".length);
        if (!current.has(group)) return current;
        const nextCollapsed = new Set(current);
        nextCollapsed.delete(group);
        return nextCollapsed;
      });
    }
  }

  function endTreeDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraggingKey(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.dragging && dropHint) {
      onMove(dropHint);
    }
    if (drag.dragging) {
      suppressTreeClickRef.current = true;
      window.setTimeout(() => {
        suppressTreeClickRef.current = false;
      }, 0);
    }
    setDropHint(null);
  }

  function canDropConnection(request: ConnectionMoveRequest) {
    if (request.draggedKey === request.targetKey) return false;
    if (request.draggedKey.startsWith("folder:") && request.position === "inside") return false;
    if (request.draggedKey.startsWith("folder:") && request.targetKey.startsWith("server:")) return false;
    return true;
  }

  function dropClassFor(key: string) {
    if (!dropHint || dropHint.targetKey !== key) return "";
    return `drop-${dropHint.position}`;
  }

  const selectedExportCount = selectedKeys.size;

  return (
    <aside
      className={`connection-manager ${open ? "open" : ""}`}
      aria-hidden={!open}
      aria-label="连接管理"
    >
      {open && (
        <div className="connection-panel-content">
          <label className="history-search connection-search">
            <Search size={13} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="搜索主机"
              spellCheck={false}
            />
          </label>
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
            </div>
          )}
          {filteredEntries.length === 0 ? (
            <div className="connection-empty">
              <Signal size={24} />
              <p>{entries.length === 0 ? "暂无主机" : "没有匹配的主机"}</p>
            </div>
          ) : (
            filteredEntries.map(([group, list]) => (
              <section key={group} className="connection-folder">
                <button
                  type="button"
                  className={`connection-folder-row ${selectedKeys.has(folderKey(group)) ? "on" : ""} ${
                    draggingKey === folderKey(group) ? "dragging" : ""
                  } ${dropClassFor(folderKey(group))}`}
                  data-connection-key={folderKey(group)}
                  onPointerDown={(event) => beginTreeDrag(event, folderKey(group))}
                  onPointerMove={moveTreeDrag}
                  onPointerUp={endTreeDrag}
                  onPointerCancel={endTreeDrag}
                  onClick={(event) => {
                    if (suppressTreeClickRef.current) return;
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
                </button>
                {!collapsedFolders.has(group) && (
                  <div className="connection-tree-children">
                    {list.map((server) => (
                      <div
                        key={server.id}
                        className={`connection-node ${
                          selectedServerId === server.id || selectedKeys.has(serverKey(server.id)) ? "on" : ""
                        } ${draggingKey === serverKey(server.id) ? "dragging" : ""} ${dropClassFor(serverKey(server.id))}`}
                        data-connection-key={serverKey(server.id)}
                        onPointerDown={(event) => beginTreeDrag(event, serverKey(server.id))}
                        onPointerMove={moveTreeDrag}
                        onPointerUp={endTreeDrag}
                        onPointerCancel={endTreeDrag}
                      >
                        <button
                          type="button"
                          className="connection-node-main"
                          onClick={(event) => {
                            if (suppressTreeClickRef.current) return;
                            selectTreeItem(event, serverKey(server.id), server);
                          }}
                          onDoubleClick={() => {
                            if (!suppressTreeClickRef.current) connect(server);
                          }}
                          onContextMenu={(event) => handleContextMenu(event, server)}
                          title={`${server.username}@${server.host}:${server.port} · 双击连接`}
                        >
                          <span className="tree-branch" aria-hidden />
                          <span className="dot" style={{ backgroundColor: server.color }} />
                          <span className="connection-meta">
                            <strong>{server.name}</strong>
                          </span>
                          <span className={`pulse ${server.lastConnectedAt ? "live" : ""}`} />
                        </button>
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

      {menu && createPortal(
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
        </div>,
        document.body,
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

function serverMatchesQuery(server: ServerRecord, query: string) {
  return [
    server.name,
    server.host,
    server.username,
    server.group,
    String(server.port),
    ...server.tags,
  ].some((value) => value.toLowerCase().includes(query));
}

function menuPosition(event: MouseEvent, width: number, height: number) {
  const offsetY = 10;
  return {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width)),
    y: Math.max(8, Math.min(event.clientY - offsetY, window.innerHeight - height)),
  };
}
