import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { command, isTauri } from "./api/tauri";
import { CommandHistoryPanel } from "./components/CommandHistoryPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConnectionManager } from "./components/ConnectionManager";
import { DownloadQueue } from "./components/DownloadQueue";
import { FileEditorModal, type FileEditorState } from "./components/FileEditorModal";
import { ServerDetail } from "./components/ServerDetail";
import { ServerEditor } from "./components/ServerEditor";
import { useConnections } from "./features/connections/useConnections";
import { SettingsModal } from "./components/SettingsModal";
import { StatusDashboard } from "./components/StatusDashboard";
import { TabBar } from "./components/TabBar";
import { UpdateNotice } from "./components/UpdateNotice";
import { UploadQueue } from "./components/UploadQueue";
import {
  readSavedTailViewerLines,
  TAIL_VIEWER_DEFAULT_LINES_KEY,
} from "./constants/tail";
import { readSavedTheme, type AppTheme } from "./constants/theme";
import {
  connectionDeleteDescription,
  connectionDeleteTargetText,
} from "./features/connections/tree";
import { networkPatch } from "./features/monitor/network";
import {
  buildPathChain,
  buildPathColumns,
  currentDirForTab,
  parentPath,
  quoteShellArg,
  resolveKnownUploadDirectory,
  sftpDeleteDescription,
  sortEntries,
  uploadRemotePath,
} from "./features/sftp/paths";
import { useDownloadQueue } from "./features/sftp/useDownloadQueue";
import { useUploadQueue, type UploadTargetContext } from "./features/sftp/useUploadQueue";
import { createTabId, type ShellTab } from "./features/shell/types";
import {
  closeCurrentWindowIfPeerExists,
  handoffTabSnapshot,
  normalizeHandedOffTab,
  peerWindowAtPoint,
  readHandedOffTabFromUrl,
  readTabGhostFromUrl,
  TabGhostWindow,
  type TabDropPoint,
} from "./features/shell/windowHandoff";
import { applyNativeWindowTheme } from "./features/theme/nativeWindowTheme";
import { AUTO_CHECK_UPDATES_KEY, readAutoCheckUpdates, useUpdater } from "./features/updater/useUpdater";
import { demoStatus } from "./mocks/demoData";
import { loadDemoFiles } from "./mocks/demoSftp";
import type {
  FolderDownloadMode,
  NetworkSample,
  ProcessSamplePayload,
  ServerRecord,
  ServerStatus,
  SftpEntry,
  TailViewerConfig,
} from "./types";
import { startPointerDrag } from "./utils/pointerDrag";
import { waitAtLeast, waitForNextPaint } from "./utils/timing";

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane })),
);
const SftpBrowser = lazy(() =>
  import("./components/SftpBrowser").then((module) => ({ default: module.SftpBrowser })),
);

const SFTP_BUSY_MIN_MS = 520;
const SFTP_COLUMN_MIN_MS = 420;
const NOTICE_DURATION_MS = 4200;
const COMMAND_HISTORY_LIMIT = 10_000;
const DEMO_COMMAND_HISTORY_KEY = "ishell.commandHistory";
const AUTO_HIDE_TOP_BAR_KEY = "ishell.autoHideTopBar";
const MAX_EDITABLE_TEXT_BYTES = 1024 * 1024;
const FILES_PANEL_RATIO = 0.4;
const STATUS_PANEL_WIDTH = 300;
interface DeleteConfirmState {
  entries: SftpEntry[];
  columnIndex: number;
  tabId: string;
  serverId: string;
  busy?: boolean;
  error?: string;
}

type UploadPickerKind = "files" | "folder";

export default function App() {
  const tabGhost = useMemo(() => readTabGhostFromUrl(), []);
  if (tabGhost) return <TabGhostWindow ghost={tabGhost} />;

  const handedOffInitialTab = useMemo(() => readHandedOffTabFromUrl(), []);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(
    () => readSavedTheme(window.localStorage.getItem("ishell.theme")),
  );
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    const saved = Number(window.localStorage.getItem("ishell.terminalFontSize"));
    return Number.isFinite(saved) ? Math.min(20, Math.max(11, saved)) : 14;
  });
  const [tailViewerDefaultLines, setTailViewerDefaultLines] = useState(
    () => readSavedTailViewerLines(window.localStorage.getItem(TAIL_VIEWER_DEFAULT_LINES_KEY)),
  );
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(readAutoCheckUpdates);
  const updater = useUpdater(autoCheckUpdates);
  const [autoHideTopBar, setAutoHideTopBar] = useState(
    () => window.localStorage.getItem(AUTO_HIDE_TOP_BAR_KEY) !== "false",
  );
  const [tabs, setTabs] = useState<ShellTab[]>(() => handedOffInitialTab ? [handedOffInitialTab] : []);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => handedOffInitialTab?.id ?? null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesRatio, setFilesRatio] = useState(FILES_PANEL_RATIO);
  const [filesDragging, setFilesDragging] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [statusPanelWidth, setStatusPanelWidth] = useState(STATUS_PANEL_WIDTH);
  const [pasteRequest, setPasteRequest] = useState<{ tabId: string; id: number; command: string } | null>(null);
  const [commandRequest, setCommandRequest] = useState<{
    tabId: string;
    id: number;
    command: string;
    requirePromptStart?: boolean;
    blockedNotice?: string;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [fileEditor, setFileEditor] = useState<FileEditorState | null>(null);
  const workbenchBodyRef = useRef<HTMLDivElement>(null);
  const terminalDockRef = useRef<HTMLDivElement>(null);
  const filesRegionRef = useRef<HTMLDivElement>(null);
  const statusPanelRef = useRef<HTMLElement>(null);
  const dockDragCleanupRef = useRef<(() => void) | null>(null);
  const statusDragCleanupRef = useRef<(() => void) | null>(null);
  // Latest values for the once-registered native drag-drop listener.
  const dropEnabledRef = useRef(false);
  const enqueueUploadsRef = useRef<(paths: string[], remoteDir?: string) => void>(() => {});
  const uploadPickerOpenRef = useRef(false);
  const [sftpBusy, setSftpBusy] = useState(false);
  const sftpBusyCount = useRef(0);
  const sftpBusySince = useRef(0);
  const sftpBusyTimer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const statusOpenRef = useRef(false);
  const statusRefreshInFlightRef = useRef<Set<string>>(new Set());
  const networkRefreshInFlightRef = useRef<Set<string>>(new Set());
  const tabsRef = useRef<ShellTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const nativeCloseInFlightRef = useRef(false);
  const terminalReadyTabs = useRef<Set<string>>(new Set());

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );


  // Keep the native drag-drop listener (registered once) reading fresh state.
  dropEnabledRef.current = filesOpen && Boolean(activeTab);
  enqueueUploadsRef.current = enqueueUploads;
  statusOpenRef.current = statusOpen;
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  useEffect(() => {
    connections.refreshServers();
    loadCommandHistory();
  }, []);

  useEffect(() => {
    if (!handedOffInitialTab) return;
    connections.setSelectedServerId(handedOffInitialTab.serverId);
    loadCommandHistory();
  }, [handedOffInitialTab]);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<ProcessSamplePayload>("server-process-sample", (event) => {
        const { id, topCpuProcesses, topMemoryProcesses } = event.payload;
        setTabs((current) =>
          current.map((tab) =>
            tab.serverId === id && tab.status
              ? {
                  ...tab,
                  status: {
                    ...tab.status,
                    topCpuProcesses,
                    topMemoryProcesses,
                  },
                }
              : tab,
          ),
        );
      });
      if (active) unlisten = un;
      else un();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<ShellTab>("ishell:receive-tab", (event) => {
        const tab = normalizeHandedOffTab(event.payload);
        if (!tab) return;
        setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
        setActiveTabId(tab.id);
        connections.setSelectedServerId(tab.serverId);
      }))
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("ishell.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!isTauri) return;
    void applyNativeWindowTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const un = await getCurrentWindow().onCloseRequested((event) => {
        if (nativeCloseInFlightRef.current) return;
        event.preventDefault();
        void closeTabsAndCloseOrHideApp();
      });
      if (active) unlisten = un;
      else un();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("ishell.terminalFontSize", String(terminalFontSize));
  }, [terminalFontSize]);

  useEffect(() => {
    window.localStorage.setItem(TAIL_VIEWER_DEFAULT_LINES_KEY, String(tailViewerDefaultLines));
  }, [tailViewerDefaultLines]);

  useEffect(() => {
    window.localStorage.setItem(AUTO_HIDE_TOP_BAR_KEY, String(autoHideTopBar));
  }, [autoHideTopBar]);

  useEffect(() => {
    window.localStorage.setItem(AUTO_CHECK_UPDATES_KEY, String(autoCheckUpdates));
  }, [autoCheckUpdates]);

  useEffect(() => {
    return () => {
      dockDragCleanupRef.current?.();
      statusDragCleanupRef.current?.();
      if (sftpBusyTimer.current !== null) window.clearTimeout(sftpBusyTimer.current);
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!activeTab) {
      setStatusOpen(false);
      setHistoryOpen(false);
    }
  }, [activeTab]);

  // Native OS file/folder drop onto the docked file panel → enqueue uploads.
  // Tauri delivers absolute local paths; the backend identifies each path type.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    let scaleFactor = window.devicePixelRatio || 1;
    const inFiles = (position: { x: number; y: number }) => {
      if (!dropEnabledRef.current) return false;
      const rect = filesRegionRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const logical =
        "toLogical" in position && typeof position.toLogical === "function"
          ? position.toLogical(scaleFactor)
          : position;
      const x = logical.x;
      const y = logical.y;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const webview = getCurrentWebview();
      scaleFactor = await webview.window.scaleFactor();
      const un = await webview.onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragOver(inFiles(payload.position));
        } else if (payload.type === "leave") {
          setDragOver(false);
        } else if (payload.type === "drop") {
          const accept = inFiles(payload.position);
          setDragOver(false);
          if (accept && payload.paths.length) enqueueUploadsRef.current(payload.paths);
        }
      });
      if (active) unlisten = un;
      else un();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Lazy-load files when the dock opens / status when its side panel opens.
  useEffect(() => {
    if (!activeTab) return;
    if (filesOpen && activeTab.files.length === 0) {
      loadFiles("/", 0);
    }
    if (statusOpen && !activeTab.status) {
      refreshStatus(activeTab.id, activeTab.serverId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusOpen, filesOpen, activeTabId]);

  function startDockDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dock = terminalDockRef.current;
    if (!dock) return;
    dockDragCleanupRef.current?.();

    const rect = dock.getBoundingClientRect();
    let nextRatio = filesRatio;
    const stop = startPointerDrag(event, {
      cursor: "row-resize",
      onMove: (move) => {
        const ratio = (rect.bottom - move.clientY) / rect.height;
        nextRatio = Math.min(0.8, Math.max(0.15, ratio));
      },
      onFrame: () => {
        const value = `${nextRatio * 100}%`;
        filesRegionRef.current?.style.setProperty("--files-panel-height", value);
        workbenchBodyRef.current?.style.setProperty("--connection-panel-bottom", value);
      },
      onEnd: () => {
        setFilesRatio(nextRatio);
        setFilesDragging(false);
        dockDragCleanupRef.current = null;
      },
    });
    if (!stop) return;
    setFilesDragging(true);
    dockDragCleanupRef.current = stop;
  }

  function startStatusDrag(event: ReactPointerEvent<HTMLDivElement>) {
    statusDragCleanupRef.current?.();

    const divider = event.currentTarget;
    const panel = divider.nextElementSibling instanceof HTMLElement ? divider.nextElementSibling : null;
    const startX = event.clientX;
    const startWidth = panel?.getBoundingClientRect().width || statusPanelWidth;
    let nextWidth = startWidth;
    statusDragCleanupRef.current = startPointerDrag(event, {
      cursor: "col-resize",
      onMove: (move) => {
        nextWidth = Math.min(560, Math.max(300, startWidth - (move.clientX - startX)));
      },
      onFrame: () => {
        statusPanelRef.current?.style.setProperty("--status-panel-width", `${nextWidth}px`);
      },
      onEnd: () => {
        setStatusPanelWidth(nextWidth);
        statusDragCleanupRef.current = null;
      },
    });
  }

  function toggleStatusPanel() {
    setStatusOpen((open) => {
      const next = !open;
      if (next) setHistoryOpen(false);
      return next;
    });
  }

  function toggleHistoryPanel() {
    setHistoryOpen((open) => {
      const next = !open;
      if (next) setStatusOpen(false);
      return next;
    });
  }

  function handleCommandSubmitted(commandText: string) {
    const trimmed = commandText.trim();
    if (!trimmed) return;
    setCommandHistory((current) => {
      const next = [trimmed, ...current].slice(0, COMMAND_HISTORY_LIMIT);
      if (!isTauri) {
        window.localStorage.setItem(DEMO_COMMAND_HISTORY_KEY, JSON.stringify(next));
      }
      return next;
    });
    if (isTauri) {
      command("save_command_history", { commandText: trimmed }).catch((error) =>
        showNotice(String(error)),
      );
    }
  }

  async function loadCommandHistory() {
    try {
      if (!isTauri) {
        const saved = window.localStorage.getItem(DEMO_COMMAND_HISTORY_KEY);
        const parsed = saved ? JSON.parse(saved) : [];
        setCommandHistory(
          Array.isArray(parsed)
            ? parsed.filter((item) => typeof item === "string").slice(0, COMMAND_HISTORY_LIMIT)
            : [],
        );
        return;
      }
      const next = await command<string[]>("list_command_history");
      setCommandHistory(next.slice(0, COMMAND_HISTORY_LIMIT));
    } catch (error) {
      showNotice(String(error));
    }
  }

  function pasteHistoryCommand(commandText: string) {
    if (!activeTab) return;
    setPasteRequest({ tabId: activeTab.id, id: Date.now() + Math.random(), command: commandText });
    showNotice("已粘贴历史命令");
  }

  function jumpTerminalToDir(targetDir: string) {
    if (!activeTab) return;
    if (!activeTab.sessionId) {
      showNotice("终端尚未连接，无法跳转目录");
      return;
    }
    setCommandRequest({
      tabId: activeTab.id,
      id: Date.now() + Math.random(),
      command: `cd -- ${quoteShellArg(targetDir)}\r`,
      requirePromptStart: true,
      blockedNotice: "终端当前不在普通命令行状态，未执行目录跳转",
    });
  }

  // Auto-refresh live monitoring every second; disk mounts stay on a slower cadence.
  useEffect(() => {
    if (!statusOpen || !activeTab || activeTab.state !== "connected") return;
    const tabId = activeTab.id;
    const serverId = activeTab.serverId;
    if (isTauri) {
      void command("start_process_monitor", { id: serverId, consumerId: tabId });
    }
    refreshNetwork(tabId, serverId, true);
    const warmupTimer = window.setTimeout(() => refreshNetwork(tabId, serverId, true), 650);
    const networkTimer = window.setInterval(() => refreshNetwork(tabId, serverId, true), 1000);
    const metricTimer = window.setInterval(() => refreshStatus(tabId, serverId, true, false), 1000);
    const diskTimer = window.setInterval(() => refreshStatus(tabId, serverId, true, true), 60000);
    return () => {
      window.clearTimeout(warmupTimer);
      window.clearInterval(networkTimer);
      window.clearInterval(metricTimer);
      window.clearInterval(diskTimer);
      if (isTauri) {
        void command("stop_process_monitor", { id: serverId, consumerId: tabId });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusOpen, activeTabId, activeTab?.state]);

  function patchTab(tabId: string, patch: Partial<ShellTab>) {
    setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)));
  }

  const showNotice = useCallback((message: string, durationMs = NOTICE_DURATION_MS) => {
    if (noticeTimer.current !== null) {
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    if (!message || durationMs <= 0) return;

    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
    }, durationMs);
  }, []);

  const uploadQueue = useUploadQueue({
    showNotice,
    beginBusy: beginSftpBusy,
    endBusy: endSftpBusy,
    onUploaded: (item) => refreshVisibleFiles(item.tabId, item.serverId, item.remoteDir),
  });
  const downloadQueue = useDownloadQueue({ showNotice, beginBusy: beginSftpBusy, endBusy: endSftpBusy });
  const connections = useConnections({
    showNotice,
    onServerRenamed: (serverId, name) =>
      setTabs((current) => current.map((tab) => (tab.serverId === serverId ? { ...tab, title: name } : tab))),
    onServersDeleted: (serverIds) =>
      setTabs((current) => current.filter((tab) => !serverIds.has(tab.serverId))),
  });

  function beginSftpBusy() {
    if (sftpBusyTimer.current !== null) {
      window.clearTimeout(sftpBusyTimer.current);
      sftpBusyTimer.current = null;
    }
    if (sftpBusyCount.current === 0) {
      sftpBusySince.current = performance.now();
      setSftpBusy(true);
    }
    sftpBusyCount.current += 1;
  }

  function endSftpBusy() {
    sftpBusyCount.current = Math.max(0, sftpBusyCount.current - 1);
    if (sftpBusyCount.current > 0) return;

    const remaining = Math.max(0, SFTP_BUSY_MIN_MS - (performance.now() - sftpBusySince.current));
    sftpBusyTimer.current = window.setTimeout(() => {
      sftpBusyTimer.current = null;
      if (sftpBusyCount.current === 0) setSftpBusy(false);
    }, remaining);
  }

  async function openShell(server: ServerRecord | null = connections.selectedServer) {
    if (!server) return;
    const tabId = createTabId(server.id);
    const nextTab: ShellTab = {
      id: tabId,
      serverId: server.id,
      title: server.name,
      subtitle: `${server.username}@${server.host}:${server.port}`,
      host: server.host,
      color: server.color,
      sessionId: null,
      state: "connecting",
      status: isTauri ? null : demoStatus,
      networkSample: null,
      networkRxBps: 0,
      networkTxBps: 0,
      networkHistory: [],
      files: [],
      selectedPath: null,
      selectedPaths: [],
      cache: {},
    };

    setTabs((current) => [...current, nextTab]);
    setActiveTabId(tabId);
    showNotice(`正在连接 ${server.name}…`);

    try {
      if (!isTauri) {
        await new Promise((resolve) => setTimeout(resolve, 320));
        patchTab(tabId, { sessionId: `demo-${tabId}`, state: "connected", status: demoStatus });
        showNotice(`${server.name} 已连接`);
        return;
      }
      const sessionId = await command<string>("open_terminal", { id: server.id });
      patchTab(tabId, { sessionId });
    } catch (error) {
      patchTab(tabId, { state: "closed" });
      showNotice(String(error));
    }
  }

  async function reconnectShell(tabId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;

    terminalReadyTabs.current.delete(tabId);
    patchTab(tabId, { sessionId: null, state: "connecting" });
    showNotice(`正在重新连接 ${tab.title}…`);

    try {
      if (isTauri && tab.sessionId) {
        await command("close_terminal", { sessionId: tab.sessionId }).catch(() => undefined);
      }
      if (isTauri) {
        await command("invalidate_connection", { id: tab.serverId }).catch(() => undefined);
      }
      if (!isTauri) {
        await new Promise((resolve) => setTimeout(resolve, 320));
        patchTab(tabId, { sessionId: `demo-${tabId}-${Date.now()}`, state: "connected" });
        showNotice(`${tab.title} 已连接`);
        return;
      }
      const sessionId = await command<string>("open_terminal", { id: tab.serverId });
      patchTab(tabId, { sessionId });
    } catch (error) {
      patchTab(tabId, { state: "closed" });
      showNotice(String(error));
    }
  }

  function cloneShell(tabId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    const server = tab ? connections.servers.find((item) => item.id === tab.serverId) : null;
    if (server) void openShell(server);
  }

  async function detachShell(tabId: string, dropPoint?: TabDropPoint) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab || !tab.sessionId) {
      showNotice("连接建立后才能拖出为新窗口");
      return;
    }
    if (!isTauri) {
      showNotice("桌面应用中才支持拖出窗口");
      return;
    }

    try {
      if (dropPoint) {
        const target = await peerWindowAtPoint(dropPoint);
        if (target) {
          await moveShellToWindow(tabId, target.label, true);
          return;
        }
      }
      if (tabs.length <= 1) return;

      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const handedOffTab = handoffTabSnapshot(tab);
      const payload = encodeURIComponent(JSON.stringify(handedOffTab));
      const label = `shell-${tab.id.replace(/[^a-zA-Z0-9-/:_]/g, "-")}`;
      const windowRef = new WebviewWindow(label, {
        url: `/#handoff=${payload}`,
        title: `iShell · ${tab.title}`,
        width: 960,
        height: 680,
        minWidth: 720,
        minHeight: 520,
        transparent: true,
        backgroundColor: "#00000000",
        decorations: true,
        hiddenTitle: true,
        titleBarStyle: "overlay",
        focus: true,
      });

      await new Promise<void>((resolve, reject) => {
        void windowRef.once("tauri://created", () => resolve());
        void windowRef.once<string>("tauri://error", (event) => reject(new Error(String(event.payload))));
      });
      removeShellWithoutClosing(tabId, false);
    } catch (error) {
      showNotice(String(error));
    }
  }

  async function moveShellToWindow(tabId: string, targetWindowLabel: string, closeWhenEmpty = true) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab || !tab.sessionId) {
      showNotice("连接建立后才能移动到其他窗口");
      return;
    }
    if (!isTauri) {
      showNotice("桌面应用中才支持窗口间移动");
      return;
    }
    try {
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo(targetWindowLabel, "ishell:receive-tab", handoffTabSnapshot(tab));
      removeShellWithoutClosing(tabId, closeWhenEmpty);
    } catch (error) {
      showNotice(String(error));
    }
  }

  function removeShellWithoutClosing(tabId: string, closeWhenEmpty: boolean) {
    const ids = new Set([tabId]);
    const firstClosedIndex = tabs.findIndex((tab) => tab.id === tabId);
    terminalReadyTabs.current.delete(tabId);
    const remaining = tabs.filter((tab) => tab.id !== tabId);
    setTabs(remaining);
    setActiveTabId((current) => {
      if (current && !ids.has(current)) return current;
      if (remaining.length === 0) return null;
      return remaining[Math.min(Math.max(0, firstClosedIndex), remaining.length - 1)]?.id ?? null;
    });
    if (closeWhenEmpty && remaining.length === 0 && isTauri) {
      void closeCurrentWindowIfPeerExists();
    }
  }

  function reorderShellTabs(draggedId: string, targetId: string) {
    setTabs((current) => {
      const from = current.findIndex((tab) => tab.id === draggedId);
      const to = current.findIndex((tab) => tab.id === targetId);
      if (from < 0 || to < 0 || from === to) return current;
      const next = [...current];
      const [dragged] = next.splice(from, 1);
      next.splice(to, 0, dragged);
      return next;
    });
  }

  function handleTerminalReady(tabId: string, serverId: string, title: string) {
    if (terminalReadyTabs.current.has(tabId)) return;
    terminalReadyTabs.current.add(tabId);
    patchTab(tabId, { state: "connected" });
    showNotice(`${title} 已连接`);
    connections.refreshServers();
    refreshSftpAfterTerminalReady(tabId, serverId);
  }

  // After connecting, warm the pooled SFTP session in the background so the
  // first click on Files is instant. Status requests stay tied to the dashboard.
  async function warmConnection(tabId: string, serverId: string) {
    if (!isTauri) return;
    try {
      const entries = await command<SftpEntry[]>("sftp_list", { id: serverId, path: "/" });
      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                files: tab.files.length ? tab.files : [{ path: "/", entries, loading: false }],
                cache: { ...tab.cache, "/": entries },
              }
            : tab,
        ),
      );
    } catch {
      // Warming is best-effort; ignore failures.
    }
  }

  async function refreshSftpAfterTerminalReady(tabId: string, serverId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    const files = tab?.files ?? [];
    if (!files.length) {
      warmConnection(tabId, serverId);
      return;
    }

    const columnIndex = files.length - 1;
    await loadFilesFor(tabId, serverId, files[columnIndex].path, columnIndex, true);
  }

  async function closeShell(tabId: string) {
    await closeShells([tabId]);
  }

  async function closeShells(tabIds: string[]) {
    const ids = new Set(tabIds);
    if (ids.size === 0) return;
    uploadQueue.declineFolderReplacement(ids);
    const closingTabs = tabsRef.current.filter((tab) => ids.has(tab.id));
    if (isTauri) {
      await Promise.all(
        closingTabs.map((tab) =>
          tab.sessionId
            ? command("close_terminal", { sessionId: tab.sessionId }).catch(() => undefined)
            : Promise.resolve(),
        ),
      );
    }
    closingTabs.forEach((tab) => terminalReadyTabs.current.delete(tab.id));
    const latestTabs = tabsRef.current;
    const firstClosedIndex = latestTabs.findIndex((tab) => ids.has(tab.id));
    const remaining = latestTabs.filter((tab) => !ids.has(tab.id));
    tabsRef.current = remaining;
    setTabs(remaining);
    setActiveTabId((current) => {
      if (current && !ids.has(current)) return current;
      if (remaining.length === 0) return null;
      return remaining[Math.min(Math.max(0, firstClosedIndex), remaining.length - 1)]?.id ?? null;
    });
  }

  async function closeTabsAndCloseOrHideApp() {
    if (nativeCloseInFlightRef.current) return;
    nativeCloseInFlightRef.current = true;
    try {
      uploadQueue.declineFolderReplacement();
      const tabIds = tabsRef.current.map((tab) => tab.id);
      if (tabIds.length > 0) await closeShells(tabIds);
      setFilesOpen(false);
      setStatusOpen(false);
      setHistoryOpen(false);
      setFileEditor(null);
      setDeleteConfirm(null);
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const currentWindow = getCurrentWindow();
      if (document.documentElement.dataset.platform === "macos") {
        await currentWindow.hide();
        nativeCloseInFlightRef.current = false;
      } else {
        await currentWindow.destroy();
      }
    } catch (error) {
      nativeCloseInFlightRef.current = false;
      showNotice(String(error));
    }
  }

  async function refreshStatus(
    tabId = activeTab?.id,
    serverId = activeTab?.serverId,
    silent = false,
    includeDisk = true,
  ) {
    if (!tabId || !serverId) return;
    if (!statusOpenRef.current) return;
    const requestKey = `${tabId}:${includeDisk ? "disk" : "metrics"}`;
    if (statusRefreshInFlightRef.current.has(requestKey)) return;
    statusRefreshInFlightRef.current.add(requestKey);
    try {
      if (!isTauri) {
        if (!silent) await new Promise((resolve) => setTimeout(resolve, 260));
        patchTab(tabId, { status: demoStatus });
        return;
      }
      const next = await command<ServerStatus>("fetch_server_status", { id: serverId, includeDisk });
      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== tabId) return tab;
          const liveProcessState = tab.status
            ? {
                topCpuProcesses: tab.status.topCpuProcesses,
                topMemoryProcesses: tab.status.topMemoryProcesses,
              }
            : {};
          if (includeDisk || !tab.status) {
            return { ...tab, status: { ...next, ...liveProcessState } };
          }
          return {
            ...tab,
            status: {
              ...next,
              ...liveProcessState,
              diskUsedPercent: tab.status.diskUsedPercent,
              diskUsedGb: tab.status.diskUsedGb,
              diskTotalGb: tab.status.diskTotalGb,
              diskMounts: tab.status.diskMounts,
            },
          };
        }),
      );
    } catch (error) {
      if (!silent) showNotice(String(error));
    } finally {
      statusRefreshInFlightRef.current.delete(requestKey);
    }
  }

  async function refreshNetwork(
    tabId = activeTab?.id,
    serverId = activeTab?.serverId,
    silent = false,
  ) {
    if (!tabId || !serverId) return;
    if (!statusOpenRef.current) return;
    if (networkRefreshInFlightRef.current.has(tabId)) return;
    networkRefreshInFlightRef.current.add(tabId);
    try {
      if (!isTauri) {
        const sampledAt = Date.now() / 1000;
        const rxBps = 180_000 + Math.max(0, Math.sin(sampledAt / 2) * 140_000) + Math.random() * 45_000;
        const txBps = 70_000 + Math.max(0, Math.cos(sampledAt / 2.4) * 75_000) + Math.random() * 28_000;
        setTabs((current) =>
          current.map((tab) =>
            tab.id === tabId
              ? networkPatch(tab, { rxBytes: 0, txBytes: 0, sampledAt }, rxBps, txBps)
              : tab,
          ),
        );
        return;
      }

      const sample = await command<NetworkSample>("fetch_network_sample", { id: serverId });
      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== tabId) return tab;
          const previous = tab.networkSample;
          if (previous && sample.sampledAt <= previous.sampledAt) return tab;
          const seconds = previous ? Math.max(0.2, sample.sampledAt - previous.sampledAt) : 1;
          const rxBps = previous
            ? Math.max(0, (sample.rxBytes - previous.rxBytes) / seconds)
            : tab.networkRxBps;
          const txBps = previous
            ? Math.max(0, (sample.txBytes - previous.txBytes) / seconds)
            : tab.networkTxBps;
          return networkPatch(tab, sample, rxBps, txBps);
        }),
      );
    } catch (error) {
      if (!silent) showNotice(String(error));
    } finally {
      networkRefreshInFlightRef.current.delete(tabId);
    }
  }

  async function loadFiles(path = "/", columnIndex = 0, force = false) {
    const tab = activeTab;
    if (!tab) return;
    await loadFilesFor(tab.id, tab.serverId, path, columnIndex, force);
  }

  async function loadFilesFor(
    tabId: string,
    serverId: string,
    path = "/",
    columnIndex = 0,
    force = false,
  ) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const cached = force ? undefined : tab.cache[path];
    const startedAt = performance.now();

    beginSftpBusy();
    // Show the column immediately: cached entries (if any) under a loading flag
    // so revisited folders never flash empty while we refresh in the background.
    setTabs((current) =>
      current.map((item) =>
        item.id === tabId
          ? {
              ...item,
              files: [...item.files.slice(0, columnIndex), { path, entries: cached ?? [], loading: true }],
            }
          : item,
      ),
    );
    await waitForNextPaint();

    try {
      const entries = isTauri
        ? await command<SftpEntry[]>("sftp_list", { id: serverId, path })
        : await loadDemoFiles(path);
      await waitAtLeast(startedAt, SFTP_COLUMN_MIN_MS);
      setTabs((current) =>
        current.map((item) =>
          item.id === tabId
            ? {
                ...item,
                files: item.files.map((column, index) =>
                  index === columnIndex && column.path === path
                    ? { path, entries, loading: false }
                    : column,
                ),
                cache: { ...item.cache, [path]: entries },
              }
            : item,
        ),
      );
    } catch (error) {
      await waitAtLeast(startedAt, SFTP_COLUMN_MIN_MS);
      setTabs((current) =>
        current.map((item) =>
          item.id === tabId
            ? {
                ...item,
                files: item.files.map((column, index) =>
                  index === columnIndex && column.path === path
                    ? { path, entries: cached ?? [], loading: false, error: String(error) }
                    : column,
                ),
              }
            : item,
        ),
      );
      showNotice(String(error));
    } finally {
      endSftpBusy();
    }
  }

  function currentDir() {
    const files = activeTab?.files ?? [];
    return files.length ? files[files.length - 1].path : "/";
  }

  function refreshFiles() {
    const files = activeTab?.files ?? [];
    loadFiles(files.length ? files[files.length - 1].path : "/", Math.max(files.length - 1, 0), true);
  }

  function refreshVisibleFiles(tabId: string, serverId: string, path: string) {
    const tab = tabs.find((item) => item.id === tabId);
    const columnIndex = tab?.files.findIndex((column) => column.path === path) ?? -1;
    if (columnIndex >= 0) {
      loadFilesFor(tabId, serverId, path, columnIndex, true);
    }
  }

  function jumpToPath(path: string) {
    if (!activeTab) return;
    const tabId = activeTab.id;
    const serverId = activeTab.serverId;
    const pathChain = buildPathChain(path);
    const targetIndex = pathChain.length - 1;
    patchTab(tabId, {
      selectedPath: null,
      selectedPaths: [],
      files: buildPathColumns(pathChain, activeTab.cache),
    });
    loadFilesFor(tabId, serverId, path, targetIndex);
  }

  function patchRenamedEntry(tabId: string, columnIndex: number, from: SftpEntry, toPath: string, nextName: string) {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== tabId) return tab;
        const files = tab.files
          .slice(0, from.isDir ? columnIndex + 1 : tab.files.length)
          .map((column, index) =>
            index === columnIndex
              ? {
                  ...column,
                  entries: column.entries.map((entry) =>
                    entry.path === from.path ? { ...entry, name: nextName, path: toPath } : entry,
                  ),
                }
              : column,
          );
        const cache = {
          ...tab.cache,
          [tab.files[columnIndex]?.path ?? "/"]: files[columnIndex]?.entries ?? [],
        };
        const selectedPaths = (tab.selectedPaths ?? []).map((path) => (path === from.path ? toPath : path));
        return { ...tab, selectedPath: toPath, selectedPaths, files, cache };
      }),
    );
  }

  function patchDeletedEntries(tabId: string, columnIndex: number, entriesToDelete: SftpEntry[]) {
    const deletedPaths = new Set(entriesToDelete.map((entry) => entry.path));
    const deletesDirectory = entriesToDelete.some((entry) => entry.isDir);
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== tabId) return tab;
        const files = tab.files
          .slice(0, deletesDirectory ? columnIndex + 1 : tab.files.length)
          .map((column, index) =>
            index === columnIndex
              ? { ...column, entries: column.entries.filter((item) => !deletedPaths.has(item.path)) }
              : column,
          );
        const cache = {
          ...tab.cache,
          [tab.files[columnIndex]?.path ?? "/"]: files[columnIndex]?.entries ?? [],
        };
        const selectedPaths = (tab.selectedPaths ?? []).filter((path) => !deletedPaths.has(path));
        return { ...tab, selectedPath: selectedPaths[selectedPaths.length - 1] ?? null, selectedPaths, files, cache };
      }),
    );
  }

  function uploadFile(targetDir?: string) {
    return pickUploadPaths("files", targetDir);
  }

  function uploadFolder(targetDir?: string) {
    return pickUploadPaths("folder", targetDir);
  }

  async function pickUploadPaths(kind: UploadPickerKind, targetDir?: string) {
    const sourceLabel = kind === "folder" ? "文件夹" : "文件";
    if (!isTauri) {
      showNotice(`演示模式不支持上传${sourceLabel}：${targetDir ?? currentDir()}`);
      return;
    }

    if (uploadPickerOpenRef.current) {
      showNotice("上传选择器已打开，请先完成或关闭当前选择窗口");
      return;
    }

    const openingTabId = activeTabIdRef.current;
    const openingTab = tabsRef.current.find((tab) => tab.id === openingTabId);
    if (!openingTab) {
      showNotice("当前上传连接已失效，请重新打开文件面板后再试");
      return;
    }
    const pickerContext: UploadTargetContext = {
      tabId: openingTab.id,
      serverId: openingTab.serverId,
      remoteDir: targetDir ?? currentDirForTab(openingTab),
    };

    uploadPickerOpenRef.current = true;
    try {
      const picked = await open({
        multiple: kind === "files",
        directory: kind === "folder",
        title: kind === "folder" ? "选择要上传的文件夹" : "选择要上传的文件",
      });
      const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
      if (!paths.length) return;

      const latestActiveTabId = activeTabIdRef.current;
      const latestTab = tabsRef.current.find((tab) => tab.id === latestActiveTabId);
      if (!latestTab || latestTab.id !== pickerContext.tabId) {
        showNotice(`选择${sourceLabel}期间活动连接已切换或关闭，请重新选择上传${sourceLabel}`);
        return;
      }
      if (latestTab.serverId !== pickerContext.serverId) {
        showNotice("原上传连接已失效，请重新打开文件面板后再试");
        return;
      }
      const remoteDir = resolveKnownUploadDirectory(latestTab, pickerContext.remoteDir);
      if (!remoteDir) {
        showNotice("原上传目录已失效，请刷新文件列表后重新选择上传位置");
        return;
      }

      uploadQueue.enqueue(paths, {
        tabId: latestTab.id,
        serverId: latestTab.serverId,
        remoteDir,
      });
    } catch (error) {
      showNotice(String(error));
    } finally {
      uploadPickerOpenRef.current = false;
    }
  }

  // Queue one or more local files or folders for the requested remote directory,
  // processed one at a time so bulk transfers do not compete with each other.
  function enqueueUploads(localPaths: string[], remoteDir?: string) {
    if (!isTauri) return;
    const latestActiveTabId = activeTabIdRef.current;
    const latestTab = tabsRef.current.find((tab) => tab.id === latestActiveTabId);
    if (!latestTab) {
      showNotice("当前上传连接已失效，请重新打开文件面板后再试");
      return;
    }
    uploadQueue.enqueue(localPaths, {
      tabId: latestTab.id,
      serverId: latestTab.serverId,
      remoteDir: remoteDir ?? currentDirForTab(latestTab),
    });
  }

  function downloadFiles(entries: SftpEntry[]) {
    if (!activeTab) return;
    downloadQueue.enqueueFiles({ tabId: activeTab.id, serverId: activeTab.serverId }, entries);
  }

  function downloadFolder(entry: SftpEntry, mode: FolderDownloadMode) {
    if (!activeTab) return;
    downloadQueue.enqueueFolder({ tabId: activeTab.id, serverId: activeTab.serverId }, entry, mode);
  }

  async function openFileEditor(entry: SftpEntry) {
    if (!activeTab || entry.isDir) return;
    if ((entry.size ?? 0) > MAX_EDITABLE_TEXT_BYTES) {
      showNotice("仅支持编辑 1 MB 以内的文本文件");
      return;
    }
    const tabId = activeTab.id;
    const serverId = activeTab.serverId;
    setFileEditor({
      entry,
      tabId,
      serverId,
      content: "",
      originalContent: "",
      loading: true,
      saving: false,
    });
    beginSftpBusy();
    try {
      const content = isTauri
        ? await command<string>("sftp_read_text_file", { id: serverId, path: entry.path })
        : `# 演示模式\n正在编辑 ${entry.path}\n`;
      setFileEditor((current) =>
        current?.entry.path === entry.path && current.tabId === tabId
          ? { ...current, content, originalContent: content, loading: false, error: undefined }
          : current,
      );
    } catch (error) {
      const message = String(error);
      setFileEditor((current) =>
        current?.entry.path === entry.path && current.tabId === tabId
          ? { ...current, loading: false, error: message }
          : current,
      );
      showNotice(message);
    } finally {
      endSftpBusy();
    }
  }

  async function openTailViewer(entry: SftpEntry) {
    if (!activeTab || entry.isDir) return;
    if (!isTauri) {
      showNotice("滚动查看仅支持桌面应用");
      return;
    }
    try {
      const { getAllWebviewWindows, WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const windows = await getAllWebviewWindows();
      if (windows.filter((windowRef) => windowRef.label.startsWith("tail-")).length >= 12) {
        showNotice("最多同时打开 12 个滚动查看窗口");
        return;
      }
      const viewerId = crypto.randomUUID();
      const label = `tail-${viewerId}`;
      const serverName = connections.servers.find((server) => server.id === activeTab.serverId)?.name ?? activeTab.title;
      const config: TailViewerConfig = {
        viewerId,
        serverId: activeTab.serverId,
        serverName,
        fileName: entry.name,
        path: entry.path,
        initialLines: tailViewerDefaultLines,
      };
      const payload = encodeURIComponent(JSON.stringify(config));
      const windowRef = new WebviewWindow(label, {
        url: `/#tailViewer=${payload}`,
        title: `${entry.name} · ${serverName}`,
        width: 860,
        height: 620,
        minWidth: 560,
        minHeight: 380,
        transparent: true,
        backgroundColor: "#00000000",
        decorations: true,
        hiddenTitle: true,
        titleBarStyle: "overlay",
        focus: true,
      });
      await new Promise<void>((resolve, reject) => {
        void windowRef.once("tauri://created", () => resolve());
        void windowRef.once<string>("tauri://error", (event) => reject(new Error(String(event.payload))));
      });
    } catch (error) {
      showNotice(String(error));
    }
  }

  async function saveFileEditor() {
    if (!fileEditor || fileEditor.loading || fileEditor.saving) return;
    const size = new TextEncoder().encode(fileEditor.content).length;
    if (size > MAX_EDITABLE_TEXT_BYTES) {
      setFileEditor((current) => current ? { ...current, error: "内容超过 1 MB，无法保存" } : current);
      return;
    }
    setFileEditor((current) => current ? { ...current, saving: true, error: undefined } : current);
    beginSftpBusy();
    try {
      if (isTauri) {
        await command("sftp_write_text_file", {
          id: fileEditor.serverId,
          path: fileEditor.entry.path,
          content: fileEditor.content,
        });
      }
      setFileEditor(null);
      showNotice(`已保存 ${fileEditor.entry.name}`);
      const parent = parentPath(fileEditor.entry.path);
      refreshVisibleFiles(fileEditor.tabId, fileEditor.serverId, parent);
    } catch (error) {
      const message = String(error);
      setFileEditor((current) => current ? { ...current, saving: false, error: message } : current);
      showNotice(message);
    } finally {
      endSftpBusy();
    }
  }

  function closeFileEditor() {
    if (!fileEditor || fileEditor.saving) return;
    if (fileEditor.content !== fileEditor.originalContent && !window.confirm("文件尚未保存，确定关闭编辑器吗？")) {
      return;
    }
    setFileEditor(null);
  }

  async function makeDir(rawName: string, targetDir = currentDir()) {
    if (!activeTab) return;
    const name = rawName.trim();
    if (!name) return;
    if (/[\\/]/.test(name)) {
      showNotice("文件夹名称不能包含路径分隔符");
      return;
    }
    const tabId = activeTab.id;
    const serverId = activeTab.serverId;
    const files = activeTab.files;
    const dir = targetDir;
    const targetColumnIndex = files.findIndex((column) => column.path === dir);
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const entry: SftpEntry = {
      name,
      path,
      isDir: true,
      size: null,
      uid: null,
      gid: null,
      owner: null,
      group: null,
      permissions: 0o40755,
      modifiedAt: null,
    };
    try {
      if (isTauri) await command("sftp_mkdir", { id: serverId, path });
      if (targetColumnIndex >= 0) patchCreatedEntry(tabId, targetColumnIndex, entry);
      showNotice(`已创建 ${name}`);
      if (isTauri && targetColumnIndex >= 0) {
        loadFilesFor(tabId, serverId, dir, targetColumnIndex);
      }
    } catch (error) {
      showNotice(String(error));
    }
  }

  function patchCreatedEntry(tabId: string, columnIndex: number, entry: SftpEntry) {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== tabId) return tab;
        const column = tab.files[columnIndex];
        if (!column) return tab;
        const exists = column.entries.some((item) => item.path === entry.path);
        const entries = exists ? column.entries : sortEntries([...column.entries, entry]);
        const files = tab.files
          .slice(0, columnIndex + 1)
          .map((item, index) => (index === columnIndex ? { ...item, entries } : item));
        return {
          ...tab,
          selectedPath: entry.path,
          selectedPaths: [entry.path],
          files,
          cache: { ...tab.cache, [column.path]: entries },
        };
      }),
    );
  }

  async function renameEntry(entry: SftpEntry, columnIndex: number, nextName: string) {
    if (!activeTab) return;
    const tabId = activeTab.id;
    const next = nextName.trim();
    if (!next || next === entry.name) return;
    const parent = entry.path.slice(0, entry.path.lastIndexOf("/")) || "";
    const to = `${parent}/${next}`;
    try {
      if (isTauri) await command("sftp_rename", { id: activeTab.serverId, from: entry.path, to });
      else showNotice(`演示模式：重命名为 ${to}`);
      showNotice(`已重命名为 ${next}`);
      patchRenamedEntry(tabId, columnIndex, entry, to, next);
    } catch (error) {
      showNotice(String(error));
    }
  }

  function deleteEntries(entries: SftpEntry[], columnIndex: number) {
    if (!activeTab) return;
    const targets = entries.filter(Boolean);
    if (targets.length === 0) return;
    setDeleteConfirm({
      entries: targets,
      columnIndex,
      tabId: activeTab.id,
      serverId: activeTab.serverId,
    });
  }

  async function confirmDeleteEntry() {
    if (!deleteConfirm || deleteConfirm.busy) return;
    const { entries, columnIndex, tabId, serverId } = deleteConfirm;
    setDeleteConfirm((current) => (current ? { ...current, busy: true, error: undefined } : current));
    beginSftpBusy();
    try {
      if (isTauri) {
        for (const entry of entries) {
          await command("sftp_remove", { id: serverId, path: entry.path, isDir: entry.isDir });
        }
      } else {
        showNotice(`演示模式：删除 ${entries.length} 项`);
      }
      patchDeletedEntries(tabId, columnIndex, entries);
      setDeleteConfirm(null);
    } catch (error) {
      const message = String(error);
      showNotice(message);
      setDeleteConfirm((current) =>
        current ? { ...current, busy: false, error: message } : current,
      );
    } finally {
      endSftpBusy();
    }
  }

  const folderReplaceItem = uploadQueue.folderReplaceConfirm?.item;

  return (
    <div className="app">
      <main className="workspace">
        <TabBar
          autoHide={autoHideTopBar}
          connectionsOpen={connectionsOpen}
          onNewServer={() => connections.newServer()}
          tabs={tabs}
          activeTabId={activeTabId}
          activeTabTitle={activeTab?.title ?? null}
          filesOpen={filesOpen}
          statusOpen={statusOpen}
          historyOpen={historyOpen}
          serverCount={connections.servers.length}
          onOpenConnections={() => setConnectionsOpen((open) => !open)}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleFiles={() => setFilesOpen((open) => !open)}
          onToggleStatus={toggleStatusPanel}
          onToggleHistory={toggleHistoryPanel}
          onActivate={setActiveTabId}
          onClone={cloneShell}
          onReconnect={reconnectShell}
          onDetach={detachShell}
          onClose={closeShell}
          onCloseTabs={closeShells}
          onReorder={reorderShellTabs}
        />

        <div
          ref={workbenchBodyRef}
          className={`workbench-body ${connectionsOpen ? "connections-open" : ""} ${
            filesOpen && activeTab ? "files-open" : ""
          } ${
            (statusOpen || historyOpen) && activeTab ? "has-status-panel" : ""
          }`}
          style={{
            "--connection-panel-width": "240px",
            "--connection-panel-bottom": activeTab && filesOpen ? `${filesRatio * 100}%` : "0px",
          } as CSSProperties}
        >
          <ConnectionManager
            open={connectionsOpen}
            grouped={connections.grouped}
            onSelect={(server) => connections.setSelectedServerId(server.id)}
            onConnect={openShell}
            onClone={connections.cloneServer}
            onEdit={connections.editServer}
            onRenameServer={connections.renameServer}
            onRenameFolder={connections.renameConnectionFolder}
            onNew={(group) => connections.newServer(group)}
            onCreateFolder={connections.createConnectionFolder}
            onExport={connections.exportConnections}
            onImport={connections.importConnections}
            onDelete={connections.requestDeleteConnections}
            onMove={connections.moveConnectionNode}
            onClose={() => setConnectionsOpen(false)}
          />

          <div className="workbench-main">
            {/* Terminal + docked file panel. Kept mounted so xterm survives tab switches. */}
            {tabs.length > 0 && (
              <div className={`terminal-dock ${filesOpen ? "files-open" : ""} ${filesDragging ? "dragging" : ""}`} ref={terminalDockRef}>
                <div className="terminal-region">
                  <div className="terminal-stack">
                    <Suspense fallback={null}>
                      {tabs.map((tab) => (
                        <TerminalPane
                          key={tab.id}
                          tab={tab}
                          visible={tab.id === activeTabId}
                          theme={theme}
                          fontSize={terminalFontSize}
                          layoutSignal={`${filesOpen}:${filesRatio}:${filesDragging}:${connectionsOpen}:${statusOpen}:${historyOpen}:${statusPanelWidth}:${tabs.length}`}
                          setNotice={showNotice}
                          onReady={() => handleTerminalReady(tab.id, tab.serverId, tab.title)}
                          onCommandSubmitted={handleCommandSubmitted}
                          pasteRequest={pasteRequest?.tabId === tab.id ? pasteRequest : null}
                          commandRequest={commandRequest?.tabId === tab.id ? commandRequest : null}
                          commandHistory={commandHistory}
                          onClosed={() => {
                            terminalReadyTabs.current.delete(tab.id);
                            patchTab(tab.id, { state: "closed" });
                          }}
                          onReconnect={() => reconnectShell(tab.id)}
                        />
                      ))}
                    </Suspense>
                  </div>
                </div>

                {activeTab && (
                  <>
                    <div
                      className={`dock-divider ${filesOpen ? "open" : ""}`}
                      onPointerDown={startDockDrag}
                      title="拖动调整比例"
                    />
                    <div
                      className={`files-region ${filesOpen ? "open" : ""}`}
                      ref={filesRegionRef}
                      style={{ "--files-panel-height": `${filesRatio * 100}%` } as CSSProperties}
                    >
                      <Suspense fallback={<div className="column-state">正在打开文件面板…</div>}>
                        <SftpBrowser
                          tab={activeTab}
                          busy={sftpBusy}
                          dragOver={dragOver}
                          onOpen={(entry, columnIndex) => loadFiles(entry.path, columnIndex)}
                          onPathSubmit={jumpToPath}
                          onSelect={(path, paths = path ? [path] : []) =>
                            patchTab(activeTab.id, { selectedPath: path, selectedPaths: paths })
                          }
                          onRefresh={refreshFiles}
                          onUpload={uploadFile}
                          onUploadFolder={uploadFolder}
                          onDownload={downloadFiles}
                          onDownloadFolder={downloadFolder}
                          onEdit={openFileEditor}
                          onTailView={openTailViewer}
                          onTerminalJump={jumpTerminalToDir}
                          onMkdir={makeDir}
                          onRename={renameEntry}
                          onDelete={deleteEntries}
                          onClose={() => setFilesOpen(false)}
                        />
                      </Suspense>
                      <div className="transfer-queues">
                        <UploadQueue
                          uploads={uploadQueue.uploads}
                          onDismiss={uploadQueue.dismiss}
                          onStop={uploadQueue.stop}
                          onClearDone={uploadQueue.clearDone}
                        />
                        <DownloadQueue
                          downloads={downloadQueue.downloads}
                          onDismiss={downloadQueue.dismiss}
                          onStop={downloadQueue.stop}
                          onClearDone={downloadQueue.clearDone}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {activeTab && (
            <>
              <div
                className={`status-divider ${statusOpen || historyOpen ? "open" : ""}`}
                onPointerDown={startStatusDrag}
                title="拖动调整面板宽度"
              />
              <aside
                ref={statusPanelRef}
                className={`status-panel ${statusOpen || historyOpen ? "open" : ""}`}
                style={{ "--status-panel-width": `${statusPanelWidth}px` } as CSSProperties}
              >
                {(statusOpen || historyOpen) && (
                  <div
                    key={statusOpen ? "status" : "history"}
                    className={`status-panel-content ${statusOpen ? "status-view" : "history-view"}`}
                  >
                    {statusOpen ? (
                      <StatusDashboard tab={activeTab} onHostCopied={(host) => showNotice(`已复制 ${host}`)} />
                    ) : (
                      <CommandHistoryPanel commands={commandHistory} onPick={pasteHistoryCommand} />
                    )}
                  </div>
                )}
              </aside>
            </>
          )}

          {!activeTab && (
            <div className="view-layer">
              <ServerDetail
                servers={connections.servers}
                onConnect={openShell}
                onNew={() => connections.newServer()}
                onOpenConnections={() => setConnectionsOpen(true)}
              />
            </div>
          )}
        </div>
      </main>

      {settingsOpen && (
        <SettingsModal
          theme={theme}
          terminalFontSize={terminalFontSize}
          tailViewerDefaultLines={tailViewerDefaultLines}
          autoHideTopBar={autoHideTopBar}
          updater={updater.state}
          autoCheckUpdates={autoCheckUpdates}
          onThemeChange={setTheme}
          onTerminalFontSizeChange={setTerminalFontSize}
          onTailViewerDefaultLinesChange={setTailViewerDefaultLines}
          onAutoHideTopBarChange={setAutoHideTopBar}
          onAutoCheckUpdatesChange={setAutoCheckUpdates}
          onCheckUpdates={() => void updater.checkForUpdate({ silent: false })}
          onInstallUpdate={() => void updater.installUpdate()}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <UpdateNotice
        state={updater.state}
        openSessions={tabs.length}
        onInstall={() => void updater.installUpdate()}
        onDismiss={updater.dismiss}
      />

      {folderReplaceItem && (
        <ConfirmDialog
          title="完整替换远端文件夹？"
          description="远端已存在同名文件夹。继续会用本地文件夹完整替换它，不会合并内容，远端独有的文件和子目录都会被删除。"
          targetLabel="远端目标"
          target={<code>{uploadRemotePath(folderReplaceItem)}</code>}
          confirmLabel="完整替换"
          cancelLabel="取消上传"
          focusCancel
          onConfirm={() => uploadQueue.resolveFolderReplacement(true, folderReplaceItem.id)}
          onCancel={() => uploadQueue.resolveFolderReplacement(false, folderReplaceItem.id)}
        />
      )}

      {connections.deleteConfirm && (
        <ConfirmDialog
          title="确认删除"
          description={connectionDeleteDescription(connections.deleteConfirm)}
          target={connectionDeleteTargetText(connections.deleteConfirm)}
          targetTitle={connectionDeleteTargetText(connections.deleteConfirm)}
          error={connections.deleteConfirm.error}
          busy={connections.deleteConfirm.busy}
          confirmLabel="删除"
          busyLabel="删除中…"
          onConfirm={connections.confirmDeleteConnections}
          onCancel={connections.cancelDeleteConnections}
        />
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title="确认删除"
          description={sftpDeleteDescription(deleteConfirm.entries)}
          target={deleteConfirm.entries.length > 1
            ? deleteConfirm.entries.map((entry) => entry.name).join("、")
            : deleteConfirm.entries[0]?.path}
          targetTitle={deleteConfirm.entries.map((entry) => entry.path).join("\n")}
          error={deleteConfirm.error}
          busy={deleteConfirm.busy}
          confirmLabel="删除"
          busyLabel="删除中…"
          onConfirm={confirmDeleteEntry}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {fileEditor && (
        <FileEditorModal
          editor={fileEditor}
          onChange={(content) =>
            setFileEditor((current) => (current ? { ...current, content, error: undefined } : current))
          }
          onSave={saveFileEditor}
          onClose={closeFileEditor}
        />
      )}

      {connections.editor.open && (
        <ServerEditor
          form={connections.editor.form}
          setForm={connections.editor.setForm}
          saving={connections.editor.saving}
          testing={connections.editor.testing}
          testFeedback={connections.editor.testFeedback}
          onSave={connections.editor.save}
          onTest={connections.editor.test}
          onClose={connections.editor.close}
          onDelete={connections.editor.form.id ? connections.editor.deleteServer : undefined}
        />
      )}
    </div>
  );
}
