import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  Columns3,
  Download,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Pencil,
  RefreshCw,
  TableProperties,
  Trash2,
  Upload,
  UploadCloud,
  X,
} from "lucide-react";
import type { ShellTab } from "../features/shell/types";
import type { SftpEntry } from "../types";
import { formatBytes } from "../utils/format";

interface ContextMenuState {
  x: number;
  y: number;
  entry: SftpEntry | null;
  columnIndex: number;
}

interface RenameState {
  entry: SftpEntry;
  columnIndex: number;
  value: string;
}

interface CreateDirState {
  parentPath: string;
  value: string;
}

type SftpViewMode = "tree" | "columns";

function SftpBrowserBase({
  tab,
  busy,
  dragOver,
  onOpen,
  onPathSubmit,
  onSelect,
  onRefresh,
  onUpload,
  onDownload,
  onMkdir,
  onRename,
  onDelete,
  onClose,
}: {
  tab: ShellTab;
  busy: boolean;
  dragOver: boolean;
  onOpen: (entry: SftpEntry, columnIndex: number) => void;
  onPathSubmit: (path: string) => void;
  onSelect: (path: string | null, paths?: string[]) => void;
  onRefresh: () => void;
  onUpload: (targetDir?: string) => void;
  onDownload: (entries: SftpEntry[]) => void;
  onMkdir: (name: string, targetDir?: string) => void;
  onRename: (entry: SftpEntry, columnIndex: number, nextName: string) => void;
  onDelete: (entries: SftpEntry[], columnIndex: number) => void;
  onClose: () => void;
}) {
  const columns = tab.files;
  const currentDir = columns.length ? columns[columns.length - 1].path : "/";
  const currentColumnIndex = Math.max(0, columns.length - 1);
  const currentColumn = columns[currentColumnIndex] ?? null;
  const treeRows = useMemo(() => buildDirectoryTreeRows(columns), [columns]);
  const selectedPaths = useMemo(
    () => (
      tab.selectedPaths?.length
        ? tab.selectedPaths
        : tab.selectedPath
          ? [tab.selectedPath]
          : []
    ),
    [tab.selectedPath, tab.selectedPaths],
  );
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedEntries = useMemo(
    () => selectedPaths.map((path) => findEntry(tab, path)).filter((entry): entry is SftpEntry => Boolean(entry)),
    [selectedPaths, tab],
  );
  const selectedDownloadEntries = useMemo(
    () => selectedEntries.filter((entry) => !entry.isDir),
    [selectedEntries],
  );
  const selected = useMemo(() => findEntry(tab, tab.selectedPath), [tab]);
  const selectedColumnIndex = useMemo(() => findEntryColumnIndex(tab, tab.selectedPath), [tab]);
  const [viewMode, setViewMode] = useState<SftpViewMode>("tree");
  const [pathValue, setPathValue] = useState(currentDir);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [creatingDir, setCreatingDir] = useState<CreateDirState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const renameStartedForRef = useRef<string | null>(null);
  const createStartedForRef = useRef<string | null>(null);

  // Keep the most recently opened column in view as the browser overflows right.
  const columnsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewMode !== "columns") return;
    const node = columnsRef.current;
    if (node) node.scrollTo({ left: node.scrollWidth, behavior: "smooth" });
  }, [columns.length, viewMode]);

  useEffect(() => {
    setPathValue(currentDir);
  }, [currentDir]);

  useEffect(() => {
    if (!renaming) {
      renameStartedForRef.current = null;
      return;
    }
    if (renameStartedForRef.current === renaming.entry.path) return;
    renameStartedForRef.current = renaming.entry.path;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renaming]);

  useEffect(() => {
    if (!creatingDir) {
      createStartedForRef.current = null;
      return;
    }
    if (createStartedForRef.current === creatingDir.parentPath) return;
    createStartedForRef.current = creatingDir.parentPath;
    requestAnimationFrame(() => {
      createInputRef.current?.focus();
      createInputRef.current?.select();
    });
  }, [creatingDir]);

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnResize = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", closeOnResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const nextX = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const nextY = Math.min(menu.y, window.innerHeight - rect.height - 8);
    if (nextX !== menu.x || nextY !== menu.y) {
      setMenu({ ...menu, x: Math.max(8, nextX), y: Math.max(8, nextY) });
    }
  }, [menu]);

  function openMenu(
    event: React.MouseEvent,
    entry: SftpEntry | null,
    columnIndex: number,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (entry && !selectedPathSet.has(entry.path)) onSelect(entry.path, [entry.path]);
    setMenu({
      x: event.clientX,
      y: event.clientY,
      entry,
      columnIndex,
    });
  }

  function openEmptyMenu(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    openMenu(event, null, columns.length - 1);
  }

  function runMenu(action: () => void) {
    setMenu(null);
    action();
  }

  function startRename(entry: SftpEntry, columnIndex: number) {
    onSelect(entry.path);
    setRenaming({ entry, columnIndex, value: entry.name });
  }

  function targetDirFor(entry: SftpEntry | null, columnIndex: number) {
    if (entry?.isDir) return entry.path;
    return columns[columnIndex]?.path ?? currentDir;
  }

  function startCreateDir(parentPath = currentDir, folderToOpen?: { entry: SftpEntry; columnIndex: number }) {
    if (folderToOpen && !columns.some((column) => column.path === parentPath)) {
      onOpen(folderToOpen.entry, folderToOpen.columnIndex + 1);
    }
    setRenaming(null);
    setCreatingDir({ parentPath, value: "新建文件夹" });
  }

  function startCreateDirFromMenu(menuState: ContextMenuState) {
    const parentPath = targetDirFor(menuState.entry, menuState.columnIndex);
    const folderToOpen = menuState.entry?.isDir
      ? { entry: menuState.entry, columnIndex: menuState.columnIndex }
      : undefined;
    startCreateDir(parentPath, folderToOpen);
  }

  function cancelRename() {
    setRenaming(null);
  }

  function commitRename() {
    if (!renaming) return;
    const nextName = renaming.value.trim();
    if (!nextName || nextName === renaming.entry.name) {
      setRenaming(null);
      return;
    }
    onRename(renaming.entry, renaming.columnIndex, nextName);
    setRenaming(null);
  }

  function cancelCreateDir() {
    setCreatingDir(null);
  }

  function commitCreateDir() {
    if (!creatingDir) return;
    const name = creatingDir.value.trim();
    if (!name) {
      setCreatingDir(null);
      return;
    }
    onMkdir(name, creatingDir.parentPath);
    setCreatingDir(null);
  }

  function submitPath() {
    const nextPath = normalizePath(pathValue);
    setPathValue(nextPath);
    if (nextPath === currentDir) return;
    onPathSubmit(nextPath);
  }

  function selectEntry(entry: SftpEntry, columnIndex: number, event: React.MouseEvent) {
    if (event.shiftKey) {
      const column = columns[columnIndex];
      const anchorPath = tab.selectedPath;
      const anchorIndex = column?.entries.findIndex((item) => item.path === anchorPath) ?? -1;
      const entryIndex = column?.entries.findIndex((item) => item.path === entry.path) ?? -1;
      if (column && anchorIndex >= 0 && entryIndex >= 0) {
        const start = Math.min(anchorIndex, entryIndex);
        const end = Math.max(anchorIndex, entryIndex);
        const paths = column.entries.slice(start, end + 1).map((item) => item.path);
        onSelect(entry.path, paths);
        return;
      }
    }
    onSelect(entry.path, [entry.path]);
  }

  function selectedBatchFor(entry: SftpEntry) {
    return selectedPathSet.has(entry.path) ? selectedEntries : [entry];
  }

  return (
    <div className="sftp" onContextMenu={openEmptyMenu}>
      <div className="sftp-bar">
        <label className="pathbar" title="输入远程路径后按 Enter 跳转">
          <HardDrive size={14} />
          <input
            value={pathValue}
            aria-label="远程路径"
            spellCheck={false}
            onChange={(event) => setPathValue(event.target.value)}
            onContextMenu={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitPath();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setPathValue(currentDir);
                event.currentTarget.blur();
              }
            }}
          />
        </label>

        <div className="sftp-tools">
          <button
            type="button"
            className={`tool ${viewMode === "tree" ? "on" : ""}`}
            onClick={() => setViewMode("tree")}
            title="目录树明细视图"
            aria-pressed={viewMode === "tree"}
          >
            <TableProperties size={15} />
          </button>
          <button
            type="button"
            className={`tool ${viewMode === "columns" ? "on" : ""}`}
            onClick={() => setViewMode("columns")}
            title="多列视图"
            aria-pressed={viewMode === "columns"}
          >
            <Columns3 size={15} />
          </button>
          <span className="tool-sep" />
          <button type="button" className="tool" onClick={() => onUpload(currentDir)} title="上传到当前目录">
            <Upload size={15} />
          </button>
          <button
            type="button"
            className="tool"
            disabled={selectedDownloadEntries.length === 0}
            onClick={() => onDownload(selectedDownloadEntries)}
            title={selectedDownloadEntries.length > 1 ? `下载所选 ${selectedDownloadEntries.length} 个文件` : "下载所选文件"}
          >
            <Download size={15} />
          </button>
          <button type="button" className="tool" onClick={() => startCreateDir(currentDir)} title="新建文件夹">
            <FolderPlus size={15} />
          </button>
          <button
            type="button"
            className="tool"
            disabled={selectedEntries.length !== 1 || !selected}
            onClick={() => selected && startRename(selected, selectedColumnIndex)}
            title="重命名"
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            className="tool danger"
            disabled={selectedEntries.length === 0}
            onClick={() => selectedEntries.length > 0 && onDelete(selectedEntries, selectedColumnIndex)}
            title={selectedEntries.length > 1 ? `删除所选 ${selectedEntries.length} 项` : "删除"}
          >
            <Trash2 size={15} />
          </button>
          <span className="tool-sep" />
          <button type="button" className="tool" onClick={onRefresh} title="刷新">
            <RefreshCw size={15} className={busy ? "spin" : ""} />
          </button>
          <button type="button" className="tool" onClick={onClose} title="关闭文件面板">
            <X size={15} />
          </button>
        </div>
      </div>

      {viewMode === "tree" ? (
        <div className="sftp-split">
          <aside className="sftp-tree" onContextMenu={(event) => openMenu(event, null, currentColumnIndex)}>
            <div className="tree-scroll">
              {columns.length === 0 ? (
                <div className="column-state">正在打开目录…</div>
              ) : (
                treeRows.map((row) => {
                  const isRoot = row.entry.path === "/";
                  const isCurrent = currentDir === row.entry.path;
                  const isActive = selectedPathSet.has(row.entry.path);
                  const rowClassName = [
                    "tree-row",
                    isCurrent ? "current" : "",
                    isActive ? "on" : "",
                    row.inTrail ? "trail" : "",
                    row.loading ? "busy" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <button
                      key={`${row.entry.path}-${row.level}`}
                      type="button"
                      className={rowClassName}
                      style={{ paddingLeft: `${8 + row.level * 14}px` }}
                      onClick={() => {
                        onSelect(row.entry.path);
                        onOpen(row.entry, isRoot ? 0 : row.columnIndex + 1);
                      }}
                      onContextMenu={(event) =>
                        isRoot ? openMenu(event, null, 0) : openMenu(event, row.entry, row.columnIndex)
                      }
                    >
                      <ChevronRight size={12} className="tree-caret" />
                      <Folder size={14} className="ic-dir" />
                      <span>{isRoot ? "/" : row.entry.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="sftp-detail">
            <div className="detail-table">
              <div className="detail-row detail-header">
                <span>文件名</span>
                <span>大小</span>
                <span>修改时间</span>
                <span>权限</span>
                <span>用户/组</span>
              </div>
              <div className="detail-body" onContextMenu={(event) => openMenu(event, null, currentColumnIndex)}>
                {columns.length === 0 ? (
                  <div className="sftp-empty">
                    <Folder size={22} />
                    <p>正在打开目录…</p>
                  </div>
                ) : currentColumn?.error ? (
                  <div className="column-state bad">{currentColumn.error}</div>
                ) : currentColumn?.entries.length === 0 && currentColumn.loading ? (
                  <div className="column-skeleton">
                    {Array.from({ length: 7 }).map((_, skeleton) => (
                      <span key={skeleton} className="skeleton-row" />
                    ))}
                  </div>
                ) : (
                  <>
                    {creatingDir?.parentPath === currentDir && (
                      <div className="detail-row creating">
                        <span className="detail-name">
                          <Folder size={14} className="ic-dir" />
                          <input
                            ref={createInputRef}
                            className="entry-rename"
                            value={creatingDir.value}
                            aria-label="新建文件夹名称"
                            onChange={(event) =>
                              setCreatingDir((current) =>
                                current ? { ...current, value: event.target.value } : current,
                              )
                            }
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onContextMenu={(event) => event.stopPropagation()}
                            onBlur={commitCreateDir}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") commitCreateDir();
                              if (event.key === "Escape") cancelCreateDir();
                            }}
                          />
                        </span>
                        <span />
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
                    {currentColumn?.entries.length === 0 ? (
                      <div className="column-state">空目录</div>
                    ) : (
                      currentColumn?.entries.map((entry) => {
                        const isActive = selectedPathSet.has(entry.path);
                        const inPath = columns[currentColumnIndex + 1]?.path === entry.path;
                        const isOpening = entry.isDir && inPath && columns[currentColumnIndex + 1]?.loading;
                        const isRenaming = renaming?.entry.path === entry.path;
                        const rowClassName = [
                          "detail-row",
                          isActive ? "on" : "",
                          inPath ? "trail" : "",
                          isOpening ? "busy" : "",
                          isRenaming ? "renaming" : "",
                        ]
                          .filter(Boolean)
                          .join(" ");
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            className={rowClassName}
                            onClick={(event) => {
                              if (isRenaming) return;
                              selectEntry(entry, currentColumnIndex, event);
                              if (entry.isDir) onOpen(entry, currentColumnIndex + 1);
                            }}
                            onContextMenu={(event) => openMenu(event, entry, currentColumnIndex)}
                          >
                            <span className="detail-name">
                              {entry.isDir ? (
                                <Folder size={14} className="ic-dir" />
                              ) : (
                                <File size={14} className="ic-file" />
                              )}
                              {isRenaming ? (
                                <input
                                  ref={renameInputRef}
                                  className="entry-rename"
                                  value={renaming.value}
                                  onChange={(event) =>
                                    setRenaming((current) =>
                                      current ? { ...current, value: event.target.value } : current,
                                    )
                                  }
                                  onClick={(event) => event.stopPropagation()}
                                  onDoubleClick={(event) => event.stopPropagation()}
                                  onContextMenu={(event) => event.stopPropagation()}
                                  onBlur={commitRename}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") commitRename();
                                    if (event.key === "Escape") cancelRename();
                                  }}
                                />
                              ) : (
                                <span>{entry.name}</span>
                              )}
                            </span>
                            <span className="mono">{entry.isDir ? "文件夹" : formatBytes(entry.size)}</span>
                            <span className="mono">{formatModifiedAt(entry.modifiedAt)}</span>
                            <span className="mono">{formatPermissions(entry)}</span>
                            <span className="mono">{formatOwnerGroup(entry)}</span>
                          </button>
                        );
                      })
                    )}
                  </>
                )}
              </div>
            </div>
          </section>
        </div>
      ) : (
        <div className="columns" ref={columnsRef}>
          {columns.length === 0 ? (
            <div className="sftp-empty">
              <Folder size={22} />
              <p>正在打开目录…</p>
            </div>
          ) : (
            columns.map((column, index) => {
              const className = [
                "column",
                column.loading ? "loading" : "",
                column.loading && column.entries.length ? "refreshing" : "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <section key={`${column.path}-${index}`} className={className}>
                  <div className="column-body" onContextMenu={(event) => openMenu(event, null, index)}>
                    {creatingDir?.parentPath === column.path && (
                      <div className="entry creating">
                        <Folder size={14} className="ic-dir" />
                        <input
                          ref={createInputRef}
                          className="entry-rename"
                          value={creatingDir.value}
                          aria-label="新建文件夹名称"
                          onChange={(event) =>
                            setCreatingDir((current) =>
                              current ? { ...current, value: event.target.value } : current,
                            )
                          }
                          onClick={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onContextMenu={(event) => event.stopPropagation()}
                          onBlur={commitCreateDir}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") commitCreateDir();
                            if (event.key === "Escape") cancelCreateDir();
                          }}
                        />
                      </div>
                    )}
                    {column.error ? (
                      <div className="column-state bad">{column.error}</div>
                    ) : column.entries.length === 0 && column.loading ? (
                      <div className="column-skeleton">
                        {Array.from({ length: 7 }).map((_, skeleton) => (
                          <span key={skeleton} className="skeleton-row" />
                        ))}
                      </div>
                    ) : column.entries.length === 0 ? (
                      <div className="column-state">空目录</div>
                    ) : (
                      column.entries.map((entry) => {
                        const isActive = selectedPathSet.has(entry.path);
                        const inPath = columns[index + 1]?.path === entry.path;
                        const isOpening = entry.isDir && inPath && columns[index + 1]?.loading;
                        const isRenaming = renaming?.entry.path === entry.path;
                        const entryClassName = [
                          "entry",
                          isActive ? "on" : "",
                          inPath ? "trail" : "",
                          isOpening ? "busy" : "",
                          isRenaming ? "renaming" : "",
                        ]
                          .filter(Boolean)
                          .join(" ");
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            className={entryClassName}
                            onClick={(event) => {
                              if (isRenaming) return;
                              selectEntry(entry, index, event);
                              if (entry.isDir) onOpen(entry, index + 1);
                            }}
                            onContextMenu={(event) => openMenu(event, entry, index)}
                          >
                            {entry.isDir ? (
                              <Folder size={14} className="ic-dir" />
                            ) : (
                              <File size={14} className="ic-file" />
                            )}
                            {isRenaming ? (
                              <input
                                ref={renameInputRef}
                                className="entry-rename"
                                value={renaming.value}
                                onChange={(event) =>
                                  setRenaming((current) =>
                                    current ? { ...current, value: event.target.value } : current,
                                  )
                                }
                                onClick={(event) => event.stopPropagation()}
                                onDoubleClick={(event) => event.stopPropagation()}
                                onContextMenu={(event) => event.stopPropagation()}
                                onBlur={commitRename}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") commitRename();
                                  if (event.key === "Escape") cancelRename();
                                }}
                              />
                            ) : (
                              <span className="entry-name">{entry.name}</span>
                            )}
                            {entry.isDir ? (
                              <ChevronRight size={13} className="entry-chev" />
                            ) : (
                              <small>{formatBytes(entry.size)}</small>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </section>
              );
            })
          )}
        </div>
      )}

      {dragOver && (
        <div className="sftp-drop">
          <div className="sftp-drop-card">
            <UploadCloud size={26} />
            <p>松开以上传到</p>
            <code>{currentDir}</code>
          </div>
        </div>
      )}

      {menu && createPortal(
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {menu.entry ? (
            <>
              {menu.entry.isDir ? (
                <button
                  type="button"
                  onClick={() => runMenu(() => menu.entry && onOpen(menu.entry, menu.columnIndex + 1))}
                >
                  <FolderOpen size={14} /> 打开
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    runMenu(() => menu.entry && onDownload(selectedBatchFor(menu.entry).filter((entry) => !entry.isDir)))
                  }
                >
                  <Download size={14} /> 下载{selectedBatchFor(menu.entry).filter((entry) => !entry.isDir).length > 1 ? "所选" : ""}
                </button>
              )}
              <button type="button" onClick={() => runMenu(() => onUpload(targetDirFor(menu.entry, menu.columnIndex)))}>
                <Upload size={14} /> 上传到此处
              </button>
              <button type="button" onClick={() => runMenu(() => startCreateDirFromMenu(menu))}>
                <FolderPlus size={14} /> 新建文件夹
              </button>
              <button type="button" onClick={() => runMenu(() => menu.entry && startRename(menu.entry, menu.columnIndex))}>
                <Pencil size={14} /> 重命名
              </button>
              <div className="ctx-sep" />
              <button
                type="button"
                className="danger"
                onClick={() => runMenu(() => menu.entry && onDelete(selectedBatchFor(menu.entry), menu.columnIndex))}
              >
                <Trash2 size={14} /> 删除{menu.entry && selectedBatchFor(menu.entry).length > 1 ? "所选" : ""}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => runMenu(() => onUpload(targetDirFor(null, menu.columnIndex)))}>
                <Upload size={14} /> 上传文件
              </button>
              <button type="button" onClick={() => runMenu(() => startCreateDirFromMenu(menu))}>
                <FolderPlus size={14} /> 新建文件夹
              </button>
              <div className="ctx-sep" />
              <button type="button" onClick={() => runMenu(onRefresh)}>
                <RefreshCw size={14} /> 刷新
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

export const SftpBrowser = memo(SftpBrowserBase, (previous, next) => (
  previous.tab.id === next.tab.id &&
  previous.tab.files === next.tab.files &&
  previous.tab.selectedPath === next.tab.selectedPath &&
  previous.tab.selectedPaths === next.tab.selectedPaths &&
  previous.busy === next.busy &&
  previous.dragOver === next.dragOver
));

interface DirectoryTreeRow {
  entry: SftpEntry;
  columnIndex: number;
  level: number;
  inTrail: boolean;
  loading: boolean;
}

function buildDirectoryTreeRows(columns: ShellTab["files"]): DirectoryTreeRow[] {
  const rows: DirectoryTreeRow[] = [
    {
      entry: rootEntry(),
      columnIndex: -1,
      level: 0,
      inTrail: true,
      loading: columns[0]?.loading ?? false,
    },
  ];

  appendDirectoryRows(rows, columns, 0, 1);
  return rows;
}

function appendDirectoryRows(
  rows: DirectoryTreeRow[],
  columns: ShellTab["files"],
  columnIndex: number,
  level: number,
) {
  const column = columns[columnIndex];
  if (!column) return;
  const nextColumn = columns[columnIndex + 1];
  for (const entry of column.entries) {
    if (!entry.isDir) continue;
    const inTrail = nextColumn?.path === entry.path;
    rows.push({
      entry,
      columnIndex,
      level,
      inTrail,
      loading: inTrail && Boolean(nextColumn?.loading),
    });
    if (inTrail) appendDirectoryRows(rows, columns, columnIndex + 1, level + 1);
  }
}

function rootEntry(): SftpEntry {
  return {
    name: "/",
    path: "/",
    isDir: true,
    size: null,
    uid: null,
    gid: null,
    owner: null,
    group: null,
    permissions: null,
    modifiedAt: null,
  };
}

function findEntry(tab: ShellTab, path: string | null): SftpEntry | null {
  if (!path) return null;
  for (const column of tab.files) {
    const found = column.entries.find((entry) => entry.path === path);
    if (found) return found;
  }
  return null;
}

function findEntryColumnIndex(tab: ShellTab, path: string | null): number {
  if (!path) return Math.max(0, tab.files.length - 1);
  const index = tab.files.findIndex((column) => column.entries.some((entry) => entry.path === path));
  return index >= 0 ? index : Math.max(0, tab.files.length - 1);
}

function normalizePath(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = absolute.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

function formatModifiedAt(value: number | null | undefined) {
  if (!value) return "--";
  return new Date(value * 1000).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPermissions(entry: SftpEntry) {
  const mode = entry.permissions;
  if (mode == null) return "--";
  const bits = [
    0o400,
    0o200,
    0o100,
    0o040,
    0o020,
    0o010,
    0o004,
    0o002,
    0o001,
  ];
  const chars = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  return `${entry.isDir ? "d" : "-"}${bits.map((bit, index) => (mode & bit ? chars[index] : "-")).join("")}`;
}

function formatOwnerGroup(entry: SftpEntry) {
  const owner = entry.owner || (entry.uid == null ? "-" : String(entry.uid));
  const group = entry.group || (entry.gid == null ? "-" : String(entry.gid));
  return owner === "-" && group === "-" ? "--" : `${owner}:${group}`;
}
