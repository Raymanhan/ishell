import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  Download,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Pencil,
  RefreshCw,
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

export function SftpBrowser({
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
  onSelect: (path: string | null) => void;
  onRefresh: () => void;
  onUpload: (targetDir?: string) => void;
  onDownload: (entry: SftpEntry) => void;
  onMkdir: (name: string, targetDir?: string) => void;
  onRename: (entry: SftpEntry, columnIndex: number, nextName: string) => void;
  onDelete: (entry: SftpEntry, columnIndex: number) => void;
  onClose: () => void;
}) {
  const columns = tab.files;
  const currentDir = columns.length ? columns[columns.length - 1].path : "/";
  const selected = findEntry(tab, tab.selectedPath);
  const selectedColumnIndex = findEntryColumnIndex(tab, tab.selectedPath);
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
    const node = columnsRef.current;
    if (node) node.scrollTo({ left: node.scrollWidth, behavior: "smooth" });
  }, [columns.length]);

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
    if (entry) onSelect(entry.path);
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
          <button type="button" className="tool" onClick={() => onUpload(currentDir)} title="上传到当前目录">
            <Upload size={15} />
          </button>
          <button
            type="button"
            className="tool"
            disabled={!selected || selected.isDir}
            onClick={() => selected && onDownload(selected)}
            title="下载所选文件"
          >
            <Download size={15} />
          </button>
          <button type="button" className="tool" onClick={() => startCreateDir(currentDir)} title="新建文件夹">
            <FolderPlus size={15} />
          </button>
          <button
            type="button"
            className="tool"
            disabled={!selected}
            onClick={() => selected && startRename(selected, selectedColumnIndex)}
            title="重命名"
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            className="tool danger"
            disabled={!selected}
            onClick={() => selected && onDelete(selected, selectedColumnIndex)}
            title="删除"
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
                      const isActive = tab.selectedPath === entry.path;
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
                          onClick={() => {
                            if (isRenaming) return;
                            onSelect(entry.path);
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
                <button type="button" onClick={() => runMenu(() => menu.entry && onDownload(menu.entry))}>
                  <Download size={14} /> 下载
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
                onClick={() => runMenu(() => menu.entry && onDelete(menu.entry, menu.columnIndex))}
              >
                <Trash2 size={14} /> 删除
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
