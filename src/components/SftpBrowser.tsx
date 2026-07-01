import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  Columns3,
  Download,
  Eye,
  EyeOff,
  File,
  FilePenLine,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  HardDrive,
  Pencil,
  RefreshCw,
  TableProperties,
  SquareTerminal,
  Trash2,
  Upload,
  UploadCloud,
  X,
} from "lucide-react";
import type { ShellTab } from "../features/shell/types";
import type { SftpEntry } from "../types";
import { formatBytes } from "../utils/format";
import type { CSSProperties } from "react";

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
type SortKey = "name" | "type" | "size" | "modifiedAt";
type SortDirection = "asc" | "desc";

const DETAIL_COLUMN_WIDTHS = [240, 96, 188, 116, 128];
const DETAIL_COLUMN_MIN_WIDTHS = [180, 80, 156, 96, 96];
const DETAIL_COLUMN_GAP = 12;
const DETAIL_ROW_X_PADDING = 24;

interface DetailResizeState {
  dividerIndex: number;
  startX: number;
  widths: number[];
}

interface SortState {
  key: SortKey | null;
  direction: SortDirection;
}

function filterHiddenEntries(entries: SftpEntry[], showHidden: boolean) {
  return showHidden ? entries : entries.filter((entry) => !isHiddenEntry(entry));
}

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
  onEdit,
  onTerminalJump,
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
  onEdit: (entry: SftpEntry) => void;
  onTerminalJump: (targetDir: string) => void;
  onMkdir: (name: string, targetDir?: string) => void;
  onRename: (entry: SftpEntry, columnIndex: number, nextName: string) => void;
  onDelete: (entries: SftpEntry[], columnIndex: number) => void;
  onClose: () => void;
}) {
  const columns = tab.files;
  const [sort, setSort] = useState<SortState>({ key: null, direction: "asc" });
  const [showHidden, setShowHidden] = useState(false);
  const currentDir = columns.length ? columns[columns.length - 1].path : "/";
  const currentColumnIndex = Math.max(0, columns.length - 1);
  const currentColumn = columns[currentColumnIndex] ?? null;
  const currentEntries = useMemo(
    () => sortEntriesForView(filterHiddenEntries(currentColumn?.entries ?? [], showHidden), sort),
    [currentColumn?.entries, showHidden, sort],
  );
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const treeRows = useMemo(
    () => buildDirectoryTreeRows(columns, collapsedPaths, showHidden),
    [columns, collapsedPaths, showHidden],
  );
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
    () => selectedPaths
      .map((path) => findEntry(tab, path))
      .filter((entry): entry is SftpEntry => entry != null)
      .filter((entry) => showHidden || !isHiddenEntry(entry)),
    [selectedPaths, showHidden, tab],
  );
  const selectedDownloadEntries = useMemo(
    () => selectedEntries.filter((entry) => !entry.isDir),
    [selectedEntries],
  );
  const selectedEditableEntry = selectedEntries.length === 1 && isEditableTextEntry(selectedEntries[0])
    ? selectedEntries[0]
    : null;
  const [viewMode, setViewMode] = useState<SftpViewMode>("tree");
  const [pathValue, setPathValue] = useState(currentDir);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [creatingDir, setCreatingDir] = useState<CreateDirState | null>(null);
  const [detailColumnWidths, setDetailColumnWidths] = useState(() => DETAIL_COLUMN_WIDTHS);
  const [resizingDetailDivider, setResizingDetailDivider] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const renameStartedForRef = useRef<string | null>(null);
  const createStartedForRef = useRef<string | null>(null);
  const detailResizeRef = useRef<DetailResizeState | null>(null);

  const detailTableMinWidth = useMemo(
    () => detailColumnWidths.reduce((total, width) => total + width, 0)
      + DETAIL_COLUMN_GAP * (detailColumnWidths.length - 1)
      + DETAIL_ROW_X_PADDING,
    [detailColumnWidths],
  );
  const detailGridStyle = useMemo<CSSProperties>(
    () => ({
      gridTemplateColumns: detailColumnWidths.map((width) => `${width}px`).join(" "),
      minWidth: `${detailTableMinWidth}px`,
    }),
    [detailColumnWidths, detailTableMinWidth],
  );

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
    setCollapsedPaths((current) => {
      const knownPaths = new Set<string>(["/"]);
      for (const column of columns) {
        knownPaths.add(column.path);
        for (const entry of column.entries) {
          if (entry.isDir) knownPaths.add(entry.path);
        }
      }
      const next = new Set([...current].filter((path) => knownPaths.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [columns]);

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

  useEffect(() => {
    if (resizingDetailDivider == null) return;
    const onPointerMove = (event: PointerEvent) => {
      const drag = detailResizeRef.current;
      if (!drag) return;
      const leftIndex = drag.dividerIndex;
      const rightIndex = leftIndex + 1;
      const delta = event.clientX - drag.startX;
      const pairWidth = drag.widths[leftIndex] + drag.widths[rightIndex];
      const nextLeft = Math.min(
        pairWidth - DETAIL_COLUMN_MIN_WIDTHS[rightIndex],
        Math.max(DETAIL_COLUMN_MIN_WIDTHS[leftIndex], drag.widths[leftIndex] + delta),
      );
      const next = [...drag.widths];
      next[leftIndex] = nextLeft;
      next[rightIndex] = pairWidth - nextLeft;
      setDetailColumnWidths(next);
    };
    const onPointerUp = () => {
      detailResizeRef.current = null;
      setResizingDetailDivider(null);
      document.documentElement.classList.remove("resizing-detail-column");
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.documentElement.classList.remove("resizing-detail-column");
    };
  }, [resizingDetailDivider]);

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
      const entries = columnIndex === currentColumnIndex
        ? currentEntries
        : filterHiddenEntries(columns[columnIndex]?.entries ?? [], showHidden);
      const anchorPath = tab.selectedPath;
      const anchorIndex = entries.findIndex((item) => item.path === anchorPath);
      const entryIndex = entries.findIndex((item) => item.path === entry.path);
      if (anchorIndex >= 0 && entryIndex >= 0) {
        const start = Math.min(anchorIndex, entryIndex);
        const end = Math.max(anchorIndex, entryIndex);
        const paths = entries.slice(start, end + 1).map((item) => item.path);
        onSelect(entry.path, paths);
        return;
      }
    }
    onSelect(entry.path, [entry.path]);
  }

  function setSortKey(key: SortKey) {
    setSort((current) => {
      if (current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return { key: null, direction: "asc" };
    });
  }

  function startDetailResize(event: React.PointerEvent, dividerIndex: number) {
    event.preventDefault();
    event.stopPropagation();
    detailResizeRef.current = {
      dividerIndex,
      startX: event.clientX,
      widths: detailColumnWidths,
    };
    setResizingDetailDivider(dividerIndex);
    document.documentElement.classList.add("resizing-detail-column");
  }

  function toggleTreeRow(event: React.MouseEvent, path: string) {
    event.stopPropagation();
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function selectedBatchFor(entry: SftpEntry) {
    return selectedPathSet.has(entry.path) ? selectedEntries : [entry];
  }

  const pathBar = (
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
  );

  const toolRail = (
    <div className="sftp-tools sftp-tools-rail">
      <button type="button" className="tool" onClick={onClose} title="关闭文件面板">
        <X size={15} />
      </button>
      <span className="tool-sep" />
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
      <button
        type="button"
        className={`tool ${showHidden ? "on" : ""}`}
        onClick={() => setShowHidden((current) => !current)}
        title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
        aria-pressed={showHidden}
      >
        {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
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
      {selectedEditableEntry && (
        <button
          type="button"
          className="tool"
          onClick={() => onEdit(selectedEditableEntry)}
          title="编辑文本文件"
        >
          <FilePenLine size={15} />
        </button>
      )}
      <span className="tool-sep" />
      <button type="button" className="tool" onClick={onRefresh} title="刷新">
        <RefreshCw size={15} className={busy ? "spin" : ""} />
      </button>
    </div>
  );

  return (
    <div className="sftp" onContextMenu={openEmptyMenu}>
      <div className="sftp-stage">
        {viewMode === "tree" ? (
        <>
          <aside className="sftp-tree" onContextMenu={(event) => openMenu(event, null, currentColumnIndex)}>
            <div className="sftp-tree-head">{pathBar}</div>
            <div className="tree-scroll">
              {columns.length === 0 ? (
                <div className="column-state">正在打开目录…</div>
              ) : (
                treeRows.map((row) => {
                  const isRoot = row.entry.path === "/";
                  const isCurrent = currentDir === row.entry.path;
                  const isActive = selectedPathSet.has(row.entry.path);
                  const isHidden = !isRoot && isHiddenEntry(row.entry);
                  const targetColumnIndex = isRoot ? 0 : row.columnIndex + 1;
                  const isCollapsed = collapsedPaths.has(row.entry.path);
                  const rowClassName = [
                    "tree-row",
                    isCurrent ? "current" : "",
                    isActive ? "on" : "",
                    row.inTrail ? "trail" : "",
                    isCollapsed ? "collapsed" : "",
                    row.loading ? "busy" : "",
                    isHidden ? "hidden-file" : "",
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
                        if (isCollapsed) {
                          setCollapsedPaths((current) => {
                            const next = new Set(current);
                            next.delete(row.entry.path);
                            return next;
                          });
                        }
                        onOpen(row.entry, targetColumnIndex);
                      }}
                      onContextMenu={(event) =>
                        isRoot ? openMenu(event, null, 0) : openMenu(event, row.entry, row.columnIndex)
                      }
                    >
                      <ChevronRight
                        size={12}
                        className="tree-caret"
                        onClick={(event) => toggleTreeRow(event, row.entry.path)}
                      />
                      {entryIcon(row.entry)}
                      <span>{isRoot ? "/" : row.entry.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="sftp-detail">
            <div className="detail-table">
              <div className="detail-row detail-header" style={detailGridStyle}>
                <div className="detail-header-cell">
                  <button type="button" className={sort.key === "name" ? "on" : ""} onClick={() => setSortKey("name")}>
                    文件名{sort.key === "name" ? sortArrow(sort.direction) : ""}
                  </button>
                  <span
                    className={`detail-resizer ${resizingDetailDivider === 0 ? "active" : ""}`}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整文件名列宽"
                    onPointerDown={(event) => startDetailResize(event, 0)}
                  />
                </div>
                <div className="detail-header-cell">
                  <button type="button" className={sort.key === "size" ? "on" : ""} onClick={() => setSortKey("size")}>
                    大小{sort.key === "size" ? sortArrow(sort.direction) : ""}
                  </button>
                  <span
                    className={`detail-resizer ${resizingDetailDivider === 1 ? "active" : ""}`}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整大小列宽"
                    onPointerDown={(event) => startDetailResize(event, 1)}
                  />
                </div>
                <div className="detail-header-cell">
                  <button
                    type="button"
                    className={sort.key === "modifiedAt" ? "on" : ""}
                    onClick={() => setSortKey("modifiedAt")}
                  >
                    修改时间{sort.key === "modifiedAt" ? sortArrow(sort.direction) : ""}
                  </button>
                  <span
                    className={`detail-resizer ${resizingDetailDivider === 2 ? "active" : ""}`}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整修改时间列宽"
                    onPointerDown={(event) => startDetailResize(event, 2)}
                  />
                </div>
                <div className="detail-header-cell">
                  <span>权限</span>
                  <span
                    className={`detail-resizer ${resizingDetailDivider === 3 ? "active" : ""}`}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整权限列宽"
                    onPointerDown={(event) => startDetailResize(event, 3)}
                  />
                </div>
                <div className="detail-header-cell">
                  <span>用户/组</span>
                </div>
              </div>
              <div className="detail-body" onContextMenu={(event) => openMenu(event, null, currentColumnIndex)}>
                {columns.length === 0 ? (
                  <div className="sftp-empty">
                    <Folder size={22} />
                    <p>正在打开目录…</p>
                  </div>
                ) : currentColumn?.error ? (
                  <div className="column-state bad">{currentColumn.error}</div>
                ) : currentEntries.length === 0 && currentColumn.loading ? (
                  <div className="column-skeleton">
                    {Array.from({ length: 7 }).map((_, skeleton) => (
                      <span key={skeleton} className="skeleton-row" />
                    ))}
                  </div>
                ) : (
                  <>
                    {creatingDir?.parentPath === currentDir && (
                      <div className="detail-row creating" style={detailGridStyle}>
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
                    {currentEntries.length === 0 ? (
                      <div className="column-state">空目录</div>
                    ) : (
                      currentEntries.map((entry) => {
                        const isActive = selectedPathSet.has(entry.path);
                        const inPath = columns[currentColumnIndex + 1]?.path === entry.path;
                        const isOpening = entry.isDir && inPath && columns[currentColumnIndex + 1]?.loading;
                        const isRenaming = renaming?.entry.path === entry.path;
                        const isHidden = isHiddenEntry(entry);
                        const rowClassName = [
                          "detail-row",
                          isActive ? "on" : "",
                          inPath ? "trail" : "",
                          isOpening ? "busy" : "",
                          isRenaming ? "renaming" : "",
                          isHidden ? "hidden-file" : "",
                        ]
                          .filter(Boolean)
                          .join(" ");
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            className={rowClassName}
                            style={detailGridStyle}
                            onClick={(event) => {
                              if (isRenaming) return;
                              selectEntry(entry, currentColumnIndex, event);
                              if (entry.isDir) onOpen(entry, currentColumnIndex + 1);
                            }}
                            onContextMenu={(event) => openMenu(event, entry, currentColumnIndex)}
                          >
                            <span className="detail-name">
                              {entryIcon(entry)}
                              {isRenaming ? (
                                <input
                                  ref={renameInputRef}
                                  className="entry-rename"
	                                  value={renaming?.value ?? ""}
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
        </>
      ) : (
        <>
        <aside className="sftp-tree compact" onContextMenu={(event) => openMenu(event, null, currentColumnIndex)}>
          <div className="sftp-tree-head">{pathBar}</div>
          <div className="sftp-left-note">
            <Columns3 size={14} />
            <span>多列浏览</span>
          </div>
        </aside>
        <div className="columns" ref={columnsRef}>
          {columns.length === 0 ? (
            <div className="sftp-empty">
              <Folder size={22} />
              <p>正在打开目录…</p>
            </div>
          ) : (
            columns.map((column, index) => {
              const columnEntries = filterHiddenEntries(column.entries, showHidden);
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
                    ) : columnEntries.length === 0 && column.loading ? (
                      <div className="column-skeleton">
                        {Array.from({ length: 7 }).map((_, skeleton) => (
                          <span key={skeleton} className="skeleton-row" />
                        ))}
                      </div>
                    ) : columnEntries.length === 0 ? (
                      <div className="column-state">空目录</div>
                    ) : (
                      columnEntries.map((entry) => {
                        const isActive = selectedPathSet.has(entry.path);
                        const inPath = columns[index + 1]?.path === entry.path;
                        const isOpening = entry.isDir && inPath && columns[index + 1]?.loading;
                        const isRenaming = renaming?.entry.path === entry.path;
                        const isHidden = isHiddenEntry(entry);
                        const entryClassName = [
                          "entry",
                          isActive ? "on" : "",
                          inPath ? "trail" : "",
                          isOpening ? "busy" : "",
                          isRenaming ? "renaming" : "",
                          isHidden ? "hidden-file" : "",
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
                            {entryIcon(entry)}
                            {isRenaming ? (
                              <input
                                ref={renameInputRef}
                                className="entry-rename"
	                                value={renaming?.value ?? ""}
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
        </>
      )}
        <aside className="sftp-tool-rail" aria-label="文件操作">
          {toolRail}
        </aside>
      </div>

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
              ) : null}
              {!menu.entry.isDir && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      runMenu(() => menu.entry && onDownload(selectedBatchFor(menu.entry).filter((entry) => !entry.isDir)))
                    }
                  >
                    <Download size={14} /> 下载{selectedBatchFor(menu.entry).filter((entry) => !entry.isDir).length > 1 ? "所选" : ""}
                  </button>
                  {isEditableTextEntry(menu.entry) && (
                    <button
                      type="button"
                      onClick={() => runMenu(() => menu.entry && onEdit(menu.entry))}
                    >
                      <FilePenLine size={14} /> 编辑
                    </button>
                  )}
                </>
              )}
              <button type="button" onClick={() => runMenu(() => onUpload(targetDirFor(menu.entry, menu.columnIndex)))}>
                <Upload size={14} /> 上传到此处
              </button>
              <button type="button" onClick={() => runMenu(() => onTerminalJump(targetDirFor(menu.entry, menu.columnIndex)))}>
                <SquareTerminal size={14} /> 跳转到此处
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
              <button type="button" onClick={() => runMenu(() => onTerminalJump(targetDirFor(null, menu.columnIndex)))}>
                <SquareTerminal size={14} /> 跳转到此处
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
  previous.dragOver === next.dragOver &&
  previous.onOpen === next.onOpen &&
  previous.onPathSubmit === next.onPathSubmit &&
  previous.onSelect === next.onSelect &&
  previous.onRefresh === next.onRefresh &&
  previous.onUpload === next.onUpload &&
  previous.onDownload === next.onDownload &&
  previous.onEdit === next.onEdit &&
  previous.onTerminalJump === next.onTerminalJump &&
  previous.onMkdir === next.onMkdir &&
  previous.onRename === next.onRename &&
  previous.onDelete === next.onDelete &&
  previous.onClose === next.onClose
));

interface DirectoryTreeRow {
  entry: SftpEntry;
  columnIndex: number;
  level: number;
  inTrail: boolean;
  loading: boolean;
}

function buildDirectoryTreeRows(
  columns: ShellTab["files"],
  collapsedPaths: Set<string>,
  showHidden: boolean,
): DirectoryTreeRow[] {
  const rows: DirectoryTreeRow[] = [
    {
      entry: rootEntry(),
      columnIndex: -1,
      level: 0,
      inTrail: true,
      loading: columns[0]?.loading ?? false,
    },
  ];

  if (!collapsedPaths.has("/")) appendDirectoryRows(rows, columns, collapsedPaths, showHidden, 0, 1);
  return rows;
}

function appendDirectoryRows(
  rows: DirectoryTreeRow[],
  columns: ShellTab["files"],
  collapsedPaths: Set<string>,
  showHidden: boolean,
  columnIndex: number,
  level: number,
) {
  const column = columns[columnIndex];
  if (!column) return;
  const nextColumn = columns[columnIndex + 1];
  for (const entry of column.entries) {
    if (!entry.isDir) continue;
    if (!showHidden && isHiddenEntry(entry)) continue;
    const inTrail = nextColumn?.path === entry.path;
    rows.push({
      entry,
      columnIndex,
      level,
      inTrail,
      loading: inTrail && Boolean(nextColumn?.loading),
    });
    if (inTrail && !collapsedPaths.has(entry.path)) {
      appendDirectoryRows(rows, columns, collapsedPaths, showHidden, columnIndex + 1, level + 1);
    }
  }
}

function sortEntriesForView(entries: SftpEntry[], sort: SortState) {
  if (!sort.key) return entries;
  return [...entries].sort((a, b) => compareEntries(a, b, sort));
}

function compareEntries(a: SftpEntry, b: SftpEntry, sort: SortState) {
  if (!sort.key) return 0;
  if (sort.key !== "type" && a.isDir !== b.isDir) return a.isDir ? -1 : 1;

  const direction = sort.direction === "asc" ? 1 : -1;
  let result = 0;
  switch (sort.key) {
    case "type":
      result = Number(b.isDir) - Number(a.isDir);
      break;
    case "size":
      result = (a.size ?? -1) - (b.size ?? -1);
      break;
    case "modifiedAt":
      result = (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0);
      break;
    case "name":
    default:
      result = compareNames(a.name, b.name);
      break;
  }

  if (result === 0) result = compareNames(a.name, b.name);
  return result * direction;
}

function compareNames(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function sortArrow(direction: SortDirection) {
  return direction === "asc" ? " ↑" : " ↓";
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

function isHiddenEntry(entry: SftpEntry) {
  return entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..";
}

const MAX_EDITABLE_TEXT_BYTES = 1024 * 1024;

function isEditableTextEntry(entry: SftpEntry | null | undefined) {
  if (!entry || entry.isDir) return false;
  if ((entry.size ?? 0) > MAX_EDITABLE_TEXT_BYTES) return false;
  return true;
}

function entryIcon(entry: SftpEntry) {
  if (entry.isSymlink) {
    return entry.isDir
      ? <FolderSymlink size={14} className="ic-link ic-link-dir" />
      : <FileSymlink size={14} className="ic-link ic-link-file" />;
  }
  return entry.isDir
    ? <Folder size={14} className="ic-dir" />
    : <File size={14} className="ic-file" />;
}

function findEntry(tab: ShellTab, path: string | null): SftpEntry | null {
  if (!path) return null;
  for (const column of tab.files) {
    const found = column.entries.find((entry) => entry.path === path);
    if (found) return found;
  }
  return null;
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
  const type = entry.isSymlink ? "l" : entry.isDir ? "d" : "-";
  return `${type}${bits.map((bit, index) => (mode & bit ? chars[index] : "-")).join("")}`;
}

function formatOwnerGroup(entry: SftpEntry) {
  const owner = entry.owner || (entry.uid == null ? "-" : String(entry.uid));
  const group = entry.group || (entry.gid == null ? "-" : String(entry.gid));
  return owner === "-" && group === "-" ? "--" : `${owner}:${group}`;
}
