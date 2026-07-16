import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Activity, Clock3, Copy, FolderTree, PanelLeft, PanelsTopLeft, Plus, RefreshCw, Settings, X } from "lucide-react";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ShellTab } from "../features/shell/types";

interface TabDropPoint {
  screenX: number;
  screenY: number;
}

interface TabDragPreview {
  tabId: string;
  title: string;
  subtitle: string;
  color: string;
  x: number;
  y: number;
  width: number;
  offsetX: number;
  offsetY: number;
  detached: boolean;
}

export function TabBar({
  autoHide,
  connectionsOpen,
  onNewServer,
  tabs,
  activeTabId,
  activeTabTitle,
  filesOpen,
  statusOpen,
  historyOpen,
  serverCount,
  onOpenConnections,
  onOpenSettings,
  onToggleFiles,
  onToggleStatus,
  onToggleHistory,
  onActivate,
  onClone,
  onReconnect,
  onDetach,
  onClose,
  onCloseTabs,
  onReorder,
}: {
  autoHide: boolean;
  connectionsOpen: boolean;
  onNewServer: () => void;
  tabs: ShellTab[];
  activeTabId: string | null;
  activeTabTitle: string | null;
  filesOpen: boolean;
  statusOpen: boolean;
  historyOpen: boolean;
  serverCount: number;
  onOpenConnections: () => void;
  onOpenSettings: () => void;
  onToggleFiles: () => void;
  onToggleStatus: () => void;
  onToggleHistory: () => void;
  onActivate: (id: string) => void;
  onClone: (id: string) => void;
  onReconnect: (id: string) => void;
  onDetach: (id: string, dropPoint?: TabDropPoint) => void;
  onClose: (id: string) => void;
  onCloseTabs: (ids: string[]) => void;
  onReorder: (draggedId: string, targetId: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const tabRectsBeforeReorder = useRef(new Map<string, DOMRect>());
  const tabDragRef = useRef<{
    tabId: string;
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    detached: boolean;
    captureTarget: HTMLDivElement;
    lastDropPoint: TabDropPoint;
    tabBarRect: DOMRect;
  } | null>(null);
  const nativeGhostRef = useRef<{
    token: number;
    windowRef: WebviewWindow | null;
    timer: number | null;
    moving: boolean;
  } | null>(null);
  const nativeGhostTokenRef = useRef(0);
  const tabDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressTabClickRef = useRef(false);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const menuIndex = menu ? tabs.findIndex((tab) => tab.id === menu.tabId) : -1;
  const leftTabIds = menuIndex > 0 ? tabs.slice(0, menuIndex).map((tab) => tab.id) : [];
  const rightTabIds = menuIndex >= 0 ? tabs.slice(menuIndex + 1).map((tab) => tab.id) : [];

  useLayoutEffect(() => {
    const previousRects = tabRectsBeforeReorder.current;
    if (previousRects.size === 0) return;

    for (const tab of tabs) {
      if (tab.id === draggingTabId) continue;
      const node = tabRefs.current.get(tab.id);
      const previous = previousRects.get(tab.id);
      if (!node || !previous) continue;

      const next = node.getBoundingClientRect();
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      node.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(1)` },
          { transform: "translate3d(0, 0, 0) scale(1)" },
        ],
        {
          duration: 190,
          easing: "cubic-bezier(0.2, 0.85, 0.25, 1)",
        },
      );
    }

    previousRects.clear();
  }, [tabs, draggingTabId]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const closeOnResize = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [menu]);

  useEffect(() => () => {
    tabDragCleanupRef.current?.();
    stopNativeDragGhost();
  }, []);

  function openTabMenu(event: MouseEvent<HTMLDivElement>, tabId: string) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      tabId,
      x: Math.min(event.clientX, window.innerWidth - 188),
      y: Math.min(event.clientY, window.innerHeight - 224),
    });
  }

  function runMenu(action: () => void) {
    setMenu(null);
    action();
  }

  function rememberTabRects() {
    const rects = new Map<string, DOMRect>();
    for (const [tabId, node] of tabRefs.current) {
      rects.set(tabId, node.getBoundingClientRect());
    }
    tabRectsBeforeReorder.current = rects;
  }

  function beginTabPointerDrag(event: ReactPointerEvent<HTMLDivElement>, tabId: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".terminal-tab-action")) return;
    tabDragRef.current = {
      tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      detached: false,
      captureTarget: event.currentTarget,
      lastDropPoint: { screenX: event.screenX, screenY: event.screenY },
      tabBarRect: event.currentTarget.closest(".terminal-tabs")?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    installTabDragFallback(event.pointerId);
  }

  function installTabDragFallback(pointerId: number) {
    tabDragCleanupRef.current?.();
    const onPointerMove = (event: PointerEvent) => {
      const drag = tabDragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      drag.lastDropPoint = { screenX: event.screenX, screenY: event.screenY };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      void finishTabDrag({ screenX: event.screenX, screenY: event.screenY });
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      void finishTabDrag();
    };
    const onBlur = () => {
      void finishTabDrag();
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("blur", onBlur);
    tabDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("blur", onBlur);
      tabDragCleanupRef.current = null;
    };
  }

  function canUseNativeGhost() {
    return typeof window !== "undefined" && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  }

  function startNativeDragGhost(preview: TabDragPreview) {
    if (!canUseNativeGhost() || nativeGhostRef.current) return;
    const token = ++nativeGhostTokenRef.current;
    nativeGhostRef.current = { token, windowRef: null, timer: null, moving: false };

    void (async () => {
      const [{ WebviewWindow }, { PhysicalPosition }, { cursorPosition }] = await Promise.all([
        import("@tauri-apps/api/webviewWindow"),
        import("@tauri-apps/api/dpi"),
        import("@tauri-apps/api/window"),
      ]);
      if (nativeGhostRef.current?.token !== token) return;

      const width = Math.min(184, Math.max(118, Math.round(preview.width)));
      const height = 22;
      const cursor = await cursorPosition();
      if (nativeGhostRef.current?.token !== token) return;
      const label = `tab-ghost-${preview.tabId.replace(/[^a-zA-Z0-9-/:_]/g, "-")}-${Date.now()}`;
      const payload = encodeURIComponent(JSON.stringify({
        title: preview.title,
        subtitle: preview.subtitle,
        color: preview.color,
        width,
      }));
      const windowRef = new WebviewWindow(label, {
        url: `/#tabGhost=${payload}`,
        title: preview.title,
        x: cursor.x - Math.round(preview.offsetX),
        y: cursor.y - Math.round(preview.offsetY),
        width,
        height,
        minWidth: width,
        minHeight: height,
        maxWidth: width,
        maxHeight: height,
        transparent: true,
        backgroundColor: "#00000000",
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focus: false,
        focusable: false,
        resizable: false,
        shadow: false,
        visible: true,
      });
      if (nativeGhostRef.current?.token !== token) {
        void windowRef.close().catch(() => undefined);
        return;
      }

      nativeGhostRef.current.windowRef = windowRef;
      void windowRef.once("tauri://created", () => {
        void windowRef.setIgnoreCursorEvents(true);
        void windowRef.setShadow(false).catch(() => undefined);
      });
      const intervalMs = document.documentElement.dataset.platform === "windows" ? 33 : 16;
      nativeGhostRef.current.timer = window.setInterval(async () => {
        const ghost = nativeGhostRef.current;
        if (!ghost || ghost.token !== token || ghost.moving) return;
        ghost.moving = true;
        try {
          const nextCursor = await cursorPosition().catch(() => null);
          if (!nextCursor || nativeGhostRef.current?.token !== token) return;
          await windowRef
            .setPosition(new PhysicalPosition(
              Math.round(nextCursor.x - preview.offsetX),
              Math.round(nextCursor.y - preview.offsetY - 6),
            ))
            .catch(() => undefined);
        } finally {
          if (nativeGhostRef.current?.token === token) nativeGhostRef.current.moving = false;
        }
      }, intervalMs);
    })().catch(() => stopNativeDragGhost());
  }

  function stopNativeDragGhost() {
    nativeGhostTokenRef.current += 1;
    const ghost = nativeGhostRef.current;
    nativeGhostRef.current = null;
    if (ghost?.timer !== null && ghost?.timer !== undefined) {
      window.clearInterval(ghost.timer);
    }
    void ghost?.windowRef?.close().catch(() => undefined);
  }

  function moveTabPointerDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = tabDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.lastDropPoint = { screenX: event.screenX, screenY: event.screenY };
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && moved < 4) return;

    event.preventDefault();
    drag.dragging = true;
    suppressTabClickRef.current = true;
    setDraggingTabId(drag.tabId);

    const verticalDistance = Math.abs(event.clientY - drag.startY);
    const outsideTabBar =
      event.clientY < drag.tabBarRect.top - 10 ||
      event.clientY > drag.tabBarRect.bottom + 10 ||
      event.clientX < drag.tabBarRect.left - 18 ||
      event.clientX > drag.tabBarRect.right + 18;
    if (!drag.detached && outsideTabBar && verticalDistance > 18) {
      drag.detached = true;
      const tab = tabs.find((item) => item.id === drag.tabId);
      const node = tabRefs.current.get(drag.tabId);
      const rect = node?.getBoundingClientRect();
      if (tab && rect) {
        startNativeDragGhost({
          tabId: tab.id,
          title: tab.title,
          subtitle: tab.subtitle,
          color: tab.color,
          x: event.clientX,
          y: event.clientY,
          width: rect.width,
          offsetX: drag.startX - rect.left,
          offsetY: drag.startY - rect.top,
          detached: true,
        });
      }
      return;
    }
    if (drag.detached) return;

    const target = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((element) => element instanceof HTMLElement && element.classList.contains("terminal-tab")) as HTMLElement | undefined;
    const targetId = target?.dataset.tabId;
    if (targetId && targetId !== drag.tabId) {
      rememberTabRects();
      onReorder(drag.tabId, targetId);
    }
  }

  function endTabPointerDrag(event: ReactPointerEvent<HTMLDivElement>) {
    void finishTabDrag({ screenX: event.screenX, screenY: event.screenY });
  }

  async function finishTabDrag(dropPoint?: TabDropPoint) {
    const drag = tabDragRef.current;
    if (!drag) return;
    const shouldActivate = !drag.dragging && !drag.detached;
    tabDragRef.current = null;
    tabDragCleanupRef.current?.();
    setDraggingTabId(null);
    stopNativeDragGhost();
    if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
      drag.captureTarget.releasePointerCapture(drag.pointerId);
    }
    if (shouldActivate) {
      onActivate(drag.tabId);
      return;
    }
    if (drag.detached) {
      const finalDropPoint = dropPoint ?? await lastCursorDropPoint(drag.lastDropPoint);
      onDetach(drag.tabId, finalDropPoint);
    }
    window.setTimeout(() => {
      suppressTabClickRef.current = false;
    }, 0);
  }

  async function lastCursorDropPoint(fallback: TabDropPoint) {
    if (!canUseNativeGhost()) return fallback;
    try {
      const { cursorPosition } = await import("@tauri-apps/api/window");
      const position = await cursorPosition();
      return { screenX: position.x, screenY: position.y };
    } catch {
      return fallback;
    }
  }

  return (
    <header
      className={`workbench-bar ${autoHide ? "auto-hide" : ""} ${connectionsOpen ? "connections-open" : ""} ${tabs.length > 0 ? "has-tabs" : ""} ${
        draggingTabId ? "tab-dragging" : ""
      }`}
    >
      <div className="topbar-drag-strip" data-tauri-drag-region aria-hidden />

      <div className="topbar-left">
        <button
          type="button"
          className={`connection-trigger ${connectionsOpen ? "on" : ""}`}
          onClick={onOpenConnections}
          title="连接管理"
          aria-label={`连接管理，${serverCount} 台主机`}
          aria-pressed={connectionsOpen}
        >
          <PanelLeft size={15} />
        </button>

        {connectionsOpen && (
          <button
            type="button"
            className="icon-button topbar-new"
            onClick={onNewServer}
            title="新建"
            aria-label="新建"
          >
            <Plus size={16} />
          </button>
        )}
      </div>

      <div
        className={`topbar-title ${tabs.length > 0 ? "has-tabs" : ""}`}
        {...(tabs.length === 0 ? { "data-tauri-drag-region": true } : {})}
      >
        {tabs.length > 0 ? (
          <div className={`terminal-tabs ${draggingTabId ? "is-sorting" : ""}`} role="tablist" aria-label="已连接服务器">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                ref={(node) => {
                  if (node) tabRefs.current.set(tab.id, node);
                  else tabRefs.current.delete(tab.id);
                }}
                className={`terminal-tab ${tab.id === activeTabId ? "active" : ""} ${tab.id === draggingTabId ? "dragging" : ""}`}
                data-tab-id={tab.id}
                role="presentation"
                title={`${tab.title} · ${tab.subtitle}`}
                onContextMenu={(event) => openTabMenu(event, tab.id)}
                onPointerDown={(event) => beginTabPointerDrag(event, tab.id)}
                onPointerMove={moveTabPointerDrag}
                onPointerUp={endTabPointerDrag}
                onPointerCancel={endTabPointerDrag}
              >
                <button
                  type="button"
                  className="terminal-tab-main"
                  role="tab"
                  aria-selected={tab.id === activeTabId}
                  onClick={(event) => {
                    if (suppressTabClickRef.current) {
                      event.preventDefault();
                      return;
                    }
                    if (event.detail !== 0) return;
                    onActivate(tab.id);
                  }}
                >
                  <span className={`tab-dot ${tab.state}`} style={{ color: tab.color }} />
                  <span className="terminal-tab-title">{tab.title}</span>
                </button>
                <button
                  type="button"
                  className="terminal-tab-action"
                  onClick={() => onClose(tab.id)}
                  title="关闭连接"
                  aria-label={`关闭 ${tab.title}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <div className="terminal-tabs-spacer" data-tauri-drag-region aria-hidden />
          </div>
        ) : (
          <span className="topbar-title-text">
            iShell{activeTabTitle ? ` · ${activeTabTitle}` : ""}
          </span>
        )}
      </div>

      <div className="bar-right">
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
          <button type="button" role="menuitem" onClick={() => runMenu(() => onClone(menu.tabId))}>
            <Copy size={14} />
            克隆
          </button>
          <button type="button" role="menuitem" onClick={() => runMenu(() => onReconnect(menu.tabId))}>
            <RefreshCw size={14} />
            重连
          </button>
          {tabs.length > 1 && (
            <button type="button" role="menuitem" onClick={() => runMenu(() => onDetach(menu.tabId))}>
              <PanelsTopLeft size={14} />
              移至新窗口
            </button>
          )}
          <div className="ctx-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={leftTabIds.length === 0}
            onClick={() => runMenu(() => onCloseTabs(leftTabIds))}
          >
            关闭左侧
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={rightTabIds.length === 0}
            onClick={() => runMenu(() => onCloseTabs(rightTabIds))}
          >
            关闭右侧
          </button>
          <button type="button" role="menuitem" onClick={() => runMenu(() => onClose(menu.tabId))}>
            关闭当前
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => runMenu(() => onCloseTabs(tabs.map((tab) => tab.id)))}>
            全部关闭
          </button>
        </div>
      )}
    </header>
  );
}
