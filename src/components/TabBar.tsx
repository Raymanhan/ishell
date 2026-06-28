import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Activity, ArrowLeft, ArrowRight, Clock3, FolderTree, RefreshCw, Server, Settings, X } from "lucide-react";
import type { ShellTab } from "../features/shell/types";

export function TabBar({
  tabs,
  activeTabId,
  filesOpen,
  statusOpen,
  historyOpen,
  serverCount,
  onOpenConnections,
  onOpenSettings,
  onToggleFiles,
  onToggleStatus,
  onToggleHistory,
  notice,
  onActivate,
  onReconnect,
  onClose,
  onCloseTabs,
}: {
  tabs: ShellTab[];
  activeTabId: string | null;
  filesOpen: boolean;
  statusOpen: boolean;
  historyOpen: boolean;
  serverCount: number;
  onOpenConnections: () => void;
  onOpenSettings: () => void;
  onToggleFiles: () => void;
  onToggleStatus: () => void;
  onToggleHistory: () => void;
  notice: string;
  onActivate: (id: string) => void;
  onReconnect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseTabs: (ids: string[]) => void;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [scrollbar, setScrollbar] = useState({ left: 0, width: 0, visible: false });
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const menuIndex = menu ? tabs.findIndex((tab) => tab.id === menu.tabId) : -1;
  const leftTabIds = menuIndex > 0 ? tabs.slice(0, menuIndex).map((tab) => tab.id) : [];
  const rightTabIds = menuIndex >= 0 ? tabs.slice(menuIndex + 1).map((tab) => tab.id) : [];

  const updateScrollbar = useCallback(() => {
    const node = tabsRef.current;
    if (!node) return;
    const { clientWidth, scrollLeft, scrollWidth } = node;
    const visible = scrollWidth > clientWidth + 1;
    const width = visible ? Math.max(36, (clientWidth / scrollWidth) * clientWidth) : 0;
    const maxLeft = Math.max(0, clientWidth - width);
    const left = visible ? (scrollLeft / Math.max(1, scrollWidth - clientWidth)) * maxLeft : 0;
    setScrollbar({ left, width, visible });
  }, []);

  useEffect(() => {
    if (!activeTabRef.current || !tabsRef.current) return;
    activeTabRef.current.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
    window.setTimeout(updateScrollbar, 240);
  }, [activeTabId, tabs.length]);

  useEffect(() => {
    updateScrollbar();
    const node = tabsRef.current;
    if (!node) return;
    const observer = new ResizeObserver(updateScrollbar);
    observer.observe(node);
    return () => observer.disconnect();
  }, [tabs.length, updateScrollbar]);

  useEffect(() => {
    if (!menu) return;
    const closeMenu = () => setMenu(null);
    const close = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu]);

  function startScrollbarDrag(event: ReactPointerEvent<HTMLSpanElement>) {
    const node = tabsRef.current;
    if (!node || !scrollbar.visible) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startScrollLeft = node.scrollLeft;
    const maxScrollLeft = node.scrollWidth - node.clientWidth;
    const maxThumbLeft = node.clientWidth - scrollbar.width;

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const delta = move.clientX - startX;
      node.scrollLeft = startScrollLeft + (delta / Math.max(1, maxThumbLeft)) * maxScrollLeft;
      updateScrollbar();
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function scrollTabsWithWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const node = tabsRef.current;
    if (!node || node.scrollWidth <= node.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    event.preventDefault();
    node.scrollLeft += delta;
    updateScrollbar();
  }

  function openTabMenu(event: ReactMouseEvent<HTMLDivElement>, tabId: string) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      tabId,
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 150),
    });
  }

  function runMenu(action: () => void) {
    setMenu(null);
    action();
  }

  return (
    <header className="workbench-bar">
      <div className="topbar-drag-strip" data-tauri-drag-region aria-hidden />
      <button type="button" className="connection-trigger" onClick={onOpenConnections} title="连接管理" aria-label={`连接管理，${serverCount} 台主机`}>
        <Server size={15} />
        <span>连接</span>
      </button>

      <div className="tabs-shell">
        <div className="tabs" ref={tabsRef} onScroll={updateScrollbar} onWheel={scrollTabsWithWheel}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              ref={tab.id === activeTabId ? activeTabRef : undefined}
              role="button"
              tabIndex={0}
              className={`tab ${tab.id === activeTabId ? "on" : ""}`}
              onClick={() => onActivate(tab.id)}
              onContextMenu={(event) => openTabMenu(event, tab.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onActivate(tab.id);
              }}
            >
              <span className={`tab-dot ${tab.state}`} style={{ color: tab.color }} />
              <span className="tab-title">{tab.title}</span>
              <span
                className="tab-x"
                role="button"
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <X size={12} />
              </span>
            </div>
          ))}
        </div>
        <div className={`tab-scrollbar ${scrollbar.visible ? "visible" : ""}`} aria-hidden>
          <span
            style={{ width: scrollbar.width, transform: `translateX(${scrollbar.left}px)` }}
            onPointerDown={startScrollbarDrag}
          />
        </div>
        <div className="tabs-drag-fill" data-tauri-drag-region aria-hidden />
      </div>

      <div className="bar-right">
        <div className="bar-right-drag-fill" data-tauri-drag-region aria-hidden />
        {notice && <span className="notice">{notice}</span>}
        <div className="dock-switcher" role="group" aria-label="工具">
          {activeTabId && (
            <>
            <button
              type="button"
              className={`dock-toggle ${filesOpen ? "on" : ""}`}
              onClick={onToggleFiles}
              title="文件面板"
              aria-label="文件面板"
              aria-pressed={filesOpen}
            >
              <span className="dock-toggle-icon">
                <FolderTree size={14} />
              </span>
            </button>
            <button
              type="button"
              className={`dock-toggle ${statusOpen ? "on" : ""}`}
              onClick={onToggleStatus}
              title="监控面板"
              aria-label="监控面板"
              aria-pressed={statusOpen}
            >
              <span className="dock-toggle-icon">
                <Activity size={14} />
              </span>
            </button>
            <button
              type="button"
              className={`dock-toggle ${historyOpen ? "on" : ""}`}
              onClick={onToggleHistory}
              title="历史命令"
              aria-label="历史命令"
              aria-pressed={historyOpen}
            >
              <span className="dock-toggle-icon">
                <Clock3 size={14} />
              </span>
            </button>
            </>
          )}
          <button
            type="button"
            className="dock-toggle"
            onClick={onOpenSettings}
            title="设置"
            aria-label="设置"
          >
            <span className="dock-toggle-icon">
              <Settings size={14} />
            </span>
          </button>
        </div>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="tab-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => runMenu(() => onReconnect(menu.tabId))}>
            <RefreshCw size={14} />
            重新连接
          </button>
          <button type="button" role="menuitem" onClick={() => runMenu(() => onClose(menu.tabId))}>
            <X size={14} />
            关闭标签
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={leftTabIds.length === 0}
            onClick={() => runMenu(() => onCloseTabs(leftTabIds))}
          >
            <ArrowLeft size={14} />
            关闭左侧标签
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={rightTabIds.length === 0}
            onClick={() => runMenu(() => onCloseTabs(rightTabIds))}
          >
            <ArrowRight size={14} />
            关闭右侧标签
          </button>
        </div>
      )}
    </header>
  );
}
