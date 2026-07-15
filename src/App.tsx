import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Save, X } from "lucide-react";
import { command, isTauri } from "./api/tauri";
import { ConnectionManager, type ConnectionMoveRequest } from "./components/ConnectionManager";
import { CommandHistoryPanel } from "./components/CommandHistoryPanel";
import { DownloadQueue } from "./components/DownloadQueue";
import { ServerDetail } from "./components/ServerDetail";
import { ServerEditor, type ServerForm } from "./components/ServerEditor";
import { SettingsModal } from "./components/SettingsModal";
import { StatusDashboard } from "./components/StatusDashboard";
import { TabBar } from "./components/TabBar";
import { UploadQueue } from "./components/UploadQueue";
import {
  getThemeDefinition,
  readSavedTheme,
  swatches,
  type AppTheme,
} from "./constants/theme";
import { createTabId, type ShellTab } from "./features/shell/types";
import { demoFiles, demoServers, demoStatus } from "./mocks/demoData";
import type {
  AuthType,
  DownloadItem,
  DownloadProgressPayload,
  FileColumn,
  FolderDownloadMode,
  NetworkSample,
  ServerInput,
  ServerRecord,
  ServerStatus,
  SftpEntry,
  UploadItem,
  UploadProgressPayload,
} from "./types";
import { formatBytes } from "./utils/format";
import { groupServers } from "./utils/servers";

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane })),
);
const SftpBrowser = lazy(() =>
  import("./components/SftpBrowser").then((module) => ({ default: module.SftpBrowser })),
);

const defaultForm: ServerForm = {
  id: null,
  name: "",
  host: "",
  port: 22,
  username: "",
  group: "Default",
  tags: [],
  tagsText: "",
  authType: "password",
  keyPath: "",
  color: swatches[0],
  notes: "",
  password: "",
};

const SFTP_BUSY_MIN_MS = 520;
const SFTP_COLUMN_MIN_MS = 420;
const NOTICE_DURATION_MS = 4200;
const COMMAND_HISTORY_LIMIT = 10_000;
const DEMO_COMMAND_HISTORY_KEY = "ishell.commandHistory";
const CONNECTION_FOLDERS_KEY = "ishell.connectionFolders";
const AUTO_HIDE_TOP_BAR_KEY = "ishell.autoHideTopBar";
const MAX_EDITABLE_TEXT_BYTES = 1024 * 1024;
const FILES_PANEL_RATIO = 0.4;
const STATUS_PANEL_WIDTH = 300;
const FOLDER_UPLOAD_CONFLICT_MARKER = "__ISHELL_UPLOAD_FOLDER_CONFLICT__";
interface DeleteConfirmState {
  entries: SftpEntry[];
  columnIndex: number;
  tabId: string;
  serverId: string;
  busy?: boolean;
  error?: string;
}

interface ConnectionDeleteConfirmState {
  target: { serverIds: string[]; folders: string[] };
  servers: ServerRecord[];
  busy?: boolean;
  error?: string;
}

interface FileEditorState {
  entry: SftpEntry;
  tabId: string;
  serverId: string;
  content: string;
  originalContent: string;
  loading: boolean;
  saving: boolean;
  error?: string;
}

interface UploadTargetContext {
  tabId: string;
  serverId: string;
  remoteDir: string;
}

interface FolderUploadReplaceConfirmState {
  item: UploadItem;
}

interface PendingFolderUploadReplaceConfirmation {
  item: UploadItem;
  resolve: (replace: boolean) => void;
}

type UploadPickerKind = "files" | "folder";

interface ConnectionImportPayload {
  folders: string[];
  servers: Array<ServerInput & { password?: string | null }>;
}

function serverInputFromForm(form: ServerForm): ServerInput {
  return {
    id: form.id,
    name: form.name,
    host: form.host,
    port: Number(form.port),
    username: form.username,
    group: form.group.trim() || "Default",
    tags: form.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean),
    authType: form.authType as AuthType,
    keyPath: form.authType === "key" ? form.keyPath || null : null,
    color: form.color,
    notes: form.notes,
  };
}

function serverInputFromRecord(server: ServerRecord): ServerInput {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    group: server.group || "Default",
    tags: server.tags,
    authType: server.authType,
    keyPath: server.keyPath ?? null,
    color: server.color,
    notes: server.notes,
    sortOrder: server.sortOrder,
  };
}

interface TabDropPoint {
  screenX: number;
  screenY: number;
}

interface TabGhostPayload {
  title: string;
  subtitle: string;
  color: string;
  width: number;
}

export default function App() {
  const tabGhost = useMemo(() => readTabGhostFromUrl(), []);
  if (tabGhost) return <TabGhostWindow ghost={tabGhost} />;

  const handedOffInitialTab = useMemo(() => readHandedOffTabFromUrl(), []);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [connectionFolders, setConnectionFolders] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(CONNECTION_FOLDERS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  });
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(
    () => readSavedTheme(window.localStorage.getItem("ishell.theme")),
  );
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    const saved = Number(window.localStorage.getItem("ishell.terminalFontSize"));
    return Number.isFinite(saved) ? Math.min(20, Math.max(11, saved)) : 14;
  });
  const [autoHideTopBar, setAutoHideTopBar] = useState(
    () => window.localStorage.getItem(AUTO_HIDE_TOP_BAR_KEY) !== "false",
  );
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ServerForm>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestFeedback, setConnectionTestFeedback] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);
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
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [connectionDeleteConfirm, setConnectionDeleteConfirm] = useState<ConnectionDeleteConfirmState | null>(null);
  const [folderUploadReplaceConfirm, setFolderUploadReplaceConfirm] =
    useState<FolderUploadReplaceConfirmState | null>(null);
  const [fileEditor, setFileEditor] = useState<FileEditorState | null>(null);
  const workbenchBodyRef = useRef<HTMLDivElement>(null);
  const terminalDockRef = useRef<HTMLDivElement>(null);
  const filesRegionRef = useRef<HTMLDivElement>(null);
  const statusPanelRef = useRef<HTMLElement>(null);
  const fileEditorHighlightRef = useRef<HTMLPreElement>(null);
  const fileEditorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileEditorSelectionCleanupRef = useRef<(() => void) | null>(null);
  const dockDragCleanupRef = useRef<(() => void) | null>(null);
  const statusDragCleanupRef = useRef<(() => void) | null>(null);
  // Latest values for the once-registered native drag-drop listener.
  const dropEnabledRef = useRef(false);
  const enqueueUploadsRef = useRef<(paths: string[], remoteDir?: string) => void>(() => {});
  const uploadPickerOpenRef = useRef(false);
  const pendingFolderUploadReplaceRef = useRef<PendingFolderUploadReplaceConfirmation | null>(null);
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());
  const downloadChainRef = useRef<Promise<void>>(Promise.resolve());
  const scheduledUploadIdsRef = useRef<Set<string>>(new Set());
  const canceledUploadIdsRef = useRef<Set<string>>(new Set());
  const inFlightUploadIdsRef = useRef<Set<string>>(new Set());
  const downloadsRef = useRef<DownloadItem[]>([]);
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

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? null,
    [selectedServerId, servers],
  );
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const connectionFolderNames = useMemo(
    () => orderedConnectionFolders(connectionFolders, servers),
    [connectionFolders, servers],
  );
  const grouped = useMemo(
    () => groupServersForTree(servers, connectionFolderNames),
    [connectionFolderNames, servers],
  );

  // Keep the native drag-drop listener (registered once) reading fresh state.
  dropEnabledRef.current = filesOpen && Boolean(activeTab);
  enqueueUploadsRef.current = enqueueUploads;
  downloadsRef.current = downloads;
  statusOpenRef.current = statusOpen;
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  useLayoutEffect(() => {
    const highlight = fileEditorHighlightRef.current;
    const textarea = fileEditorTextareaRef.current;
    if (!highlight || !textarea) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, [fileEditor?.entry.path, fileEditor?.content]);

  useEffect(() => () => fileEditorSelectionCleanupRef.current?.(), []);

  function startFileEditorSelectionDrag(event: ReactPointerEvent<HTMLTextAreaElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const textarea = event.currentTarget;
    const highlight = fileEditorHighlightRef.current;
    if (!highlight) return;

    fileEditorSelectionCleanupRef.current?.();

    const pointerId = event.pointerId;
    let pointerX = event.clientX;
    let pointerY = event.clientY;
    let selectionAnchor: number | null = null;
    let frame = 0;

    const syncHighlight = () => {
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("blur", cleanup);
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      if (fileEditorSelectionCleanupRef.current === cleanup) {
        fileEditorSelectionCleanupRef.current = null;
      }
    };
    const scrollSelection = () => {
      frame = 0;
      const rect = textarea.getBoundingClientRect();
      const overflow = pointerX < rect.left
        ? pointerX - rect.left
        : pointerX > rect.right
          ? pointerX - rect.right
          : 0;
      if (!overflow) return;

      const previousScrollLeft = textarea.scrollLeft;
      const speed = Math.sign(overflow) * Math.min(32, Math.max(4, Math.abs(overflow) * 0.2));
      textarea.scrollLeft += speed;
      if (textarea.scrollLeft === previousScrollLeft) return;

      syncHighlight();
      if (selectionAnchor === null) {
        selectionAnchor = textarea.selectionDirection === "backward"
          ? textarea.selectionEnd
          : textarea.selectionStart;
      }

      const offset = textOffsetAtPoint(
        textarea,
        highlight,
        Math.min(rect.right - 12, Math.max(rect.left + 2, pointerX)),
        Math.min(rect.bottom - 12, Math.max(rect.top + 2, pointerY)),
      );
      if (offset !== null) {
        if (offset < selectionAnchor) {
          textarea.setSelectionRange(offset, selectionAnchor, "backward");
        } else {
          textarea.setSelectionRange(selectionAnchor, offset, "forward");
        }
      }

      frame = window.requestAnimationFrame(scrollSelection);
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (move.pointerType === "mouse" && (move.buttons & 1) === 0) {
        cleanup();
        return;
      }
      pointerX = move.clientX;
      pointerY = move.clientY;
      const rect = textarea.getBoundingClientRect();
      if ((pointerX < rect.left || pointerX > rect.right) && !frame) {
        frame = window.requestAnimationFrame(scrollSelection);
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
    window.addEventListener("blur", cleanup, { once: true });
    fileEditorSelectionCleanupRef.current = cleanup;
  }

  async function refreshServers() {
    if (!isTauri) {
      setServers(demoServers);
      setSelectedServerId((current) => current ?? demoServers[0]?.id ?? null);
      return;
    }
    try {
      const next = await command<ServerRecord[]>("list_servers");
      setServers(next);
      setSelectedServerId((current) => current ?? next[0]?.id ?? null);
    } catch (error) {
      showNotice(String(error));
    }
  }

  useEffect(() => {
    refreshServers();
    loadCommandHistory();
  }, []);

  useEffect(() => {
    if (!handedOffInitialTab) return;
    setSelectedServerId(handedOffInitialTab.serverId);
    loadCommandHistory();
  }, [handedOffInitialTab]);

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
        setSelectedServerId(tab.serverId);
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
    window.localStorage.setItem(AUTO_HIDE_TOP_BAR_KEY, String(autoHideTopBar));
  }, [autoHideTopBar]);

  useEffect(() => {
    window.localStorage.setItem(CONNECTION_FOLDERS_KEY, JSON.stringify(connectionFolders));
  }, [connectionFolders]);

  useEffect(() => {
    return () => {
      dockDragCleanupRef.current?.();
      statusDragCleanupRef.current?.();
      if (sftpBusyTimer.current !== null) window.clearTimeout(sftpBusyTimer.current);
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
      const pendingConfirmation = pendingFolderUploadReplaceRef.current;
      pendingFolderUploadReplaceRef.current = null;
      pendingConfirmation?.resolve(false);
    };
  }, []);

  useEffect(() => {
    if (!activeTab) {
      setStatusOpen(false);
      setHistoryOpen(false);
    }
  }, [activeTab]);

  // Live upload progress emitted from the Rust side, keyed by transfer id.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<UploadProgressPayload>("sftp-upload-progress", (event) => {
        const { transferId, transferred, total } = event.payload;
        setUploads((current) =>
          current.map((item) =>
            item.id === transferId ? { ...item, transferred, total } : item,
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

  // Live download progress emitted from the Rust side, keyed by transfer id.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<DownloadProgressPayload>("sftp-download-progress", (event) => {
        const { transferId, transferred, total } = event.payload;
        setDownloads((current) =>
          current.map((item) =>
            item.id === transferId ? { ...item, transferred, total } : item,
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
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const dock = terminalDockRef.current;
    if (!dock) return;

    dockDragCleanupRef.current?.();

    const divider = event.currentTarget;
    const pointerId = event.pointerId;
    const rect = dock.getBoundingClientRect();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let nextRatio = filesRatio;
    let frame = 0;

    const applyRatio = () => {
      frame = 0;
      const value = `${nextRatio * 100}%`;
      filesRegionRef.current?.style.setProperty("--files-panel-height", value);
      workbenchBodyRef.current?.style.setProperty("--connection-panel-bottom", value);
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      move.preventDefault();
      const ratio = (rect.bottom - move.clientY) / rect.height;
      nextRatio = Math.min(0.8, Math.max(0.15, ratio));
      if (!frame) frame = window.requestAnimationFrame(applyRatio);
    };

    const stopDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", stopDrag);
      if (frame) {
        window.cancelAnimationFrame(frame);
        applyRatio();
      }
      if (divider.hasPointerCapture(pointerId)) {
        divider.releasePointerCapture(pointerId);
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setFilesRatio(nextRatio);
      setFilesDragging(false);
      dockDragCleanupRef.current = null;
    };

    const onUp = (up: PointerEvent) => {
      if (up.pointerId === pointerId) stopDrag();
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    setFilesDragging(true);
    if (!divider.hasPointerCapture(pointerId)) {
      divider.setPointerCapture(pointerId);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", stopDrag);
    dockDragCleanupRef.current = stopDrag;
  }

  function startStatusDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();

    statusDragCleanupRef.current?.();

    const divider = event.currentTarget;
    const pointerId = event.pointerId;
    const panel = divider.nextElementSibling instanceof HTMLElement ? divider.nextElementSibling : null;
    const startX = event.clientX;
    const startWidth = panel?.getBoundingClientRect().width || statusPanelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let nextWidth = startWidth;
    let frame = 0;

    const applyWidth = () => {
      frame = 0;
      statusPanelRef.current?.style.setProperty("--status-panel-width", `${nextWidth}px`);
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      move.preventDefault();
      const width = startWidth - (move.clientX - startX);
      nextWidth = Math.min(560, Math.max(300, width));
      if (!frame) frame = window.requestAnimationFrame(applyWidth);
    };

    const stopDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", stopDrag);
      if (frame) {
        window.cancelAnimationFrame(frame);
        applyWidth();
      }
      if (divider.hasPointerCapture(pointerId)) {
        divider.releasePointerCapture(pointerId);
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setStatusPanelWidth(nextWidth);
      statusDragCleanupRef.current = null;
    };

    const onUp = (up: PointerEvent) => {
      if (up.pointerId === pointerId) stopDrag();
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    if (!divider.hasPointerCapture(pointerId)) {
      divider.setPointerCapture(pointerId);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", stopDrag);
    statusDragCleanupRef.current = stopDrag;
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

  // Auto-refresh the dashboard with different cadences:
  // network 1s, core metrics 5s, disk mounts 60s.
  useEffect(() => {
    if (!statusOpen || !activeTab || activeTab.state !== "connected") return;
    const tabId = activeTab.id;
    const serverId = activeTab.serverId;
    refreshNetwork(tabId, serverId, true);
    const warmupTimer = window.setTimeout(() => refreshNetwork(tabId, serverId, true), 650);
    const networkTimer = window.setInterval(() => refreshNetwork(tabId, serverId, true), 1000);
    const metricTimer = window.setInterval(() => refreshStatus(tabId, serverId, true, false), 5000);
    const diskTimer = window.setInterval(() => refreshStatus(tabId, serverId, true, true), 60000);
    return () => {
      window.clearTimeout(warmupTimer);
      window.clearInterval(networkTimer);
      window.clearInterval(metricTimer);
      window.clearInterval(diskTimer);
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

  function newServer(group?: string) {
    setConnectionTestFeedback(null);
    setForm({
      ...defaultForm,
      group: group?.trim() || "Default",
    });
    setEditing(true);
  }

  function editServer(server: ServerRecord) {
    setConnectionTestFeedback(null);
    setForm({
      id: server.id,
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      group: server.group || "Default",
      tags: server.tags,
      tagsText: server.tags.join(", "),
      authType: server.authType,
      keyPath: server.keyPath ?? "",
      color: server.color || swatches[0],
      notes: server.notes,
      password: "",
    });
    setEditing(true);
  }

  function cloneServer(server: ServerRecord) {
    setConnectionTestFeedback(null);
    setForm({
      id: null,
      name: `${server.name} 副本`,
      host: server.host,
      port: server.port,
      username: server.username,
      group: server.group || "Default",
      tags: server.tags,
      tagsText: server.tags.join(", "),
      authType: server.authType,
      keyPath: server.keyPath ?? "",
      color: server.color || swatches[0],
      notes: server.notes,
      password: "",
    });
    setEditing(true);
  }

  function createConnectionFolder(raw: string) {
    const name = raw.trim();
    if (!name) return;
    if (name === "全部") {
      showNotice("文件夹不能命名为“全部”");
      return;
    }
    setConnectionFolders((current) => {
      const existingFolders = new Set(connectionFolderNames.map((folder) => folder.toLowerCase()));
      if (existingFolders.has(name.toLowerCase())) return current;
      return ensureFolder(current, name);
    });
  }

  async function renameServer(server: ServerRecord, rawName: string) {
    const name = rawName.trim();
    if (!name || name === server.name) return;

    const renamed = { ...server, name, updatedAt: Date.now() / 1000 };
    setServers((current) => current.map((item) => (item.id === server.id ? renamed : item)));
    setTabs((current) =>
      current.map((tab) => (tab.serverId === server.id ? { ...tab, title: name } : tab)),
    );

    try {
      if (isTauri) {
        await command("save_server", { input: serverInputFromRecord(renamed), password: null });
        await refreshServers();
      }
      showNotice("已重命名");
    } catch (error) {
      showNotice(String(error));
      await refreshServers();
    }
  }

  async function renameConnectionFolder(group: string, rawName: string) {
    const nextGroup = rawName.trim();
    if (!nextGroup || nextGroup === group) return;
    if (nextGroup === "全部") {
      showNotice("文件夹不能命名为“全部”");
      return;
    }
    if (connectionFolderNames.some((folder) => folder !== group && folder.toLowerCase() === nextGroup.toLowerCase())) {
      showNotice("已存在同名文件夹");
      return;
    }

    const renamedServers = servers.map((server) =>
      (server.group || "Default") === group
        ? { ...server, group: nextGroup, updatedAt: Date.now() / 1000 }
        : server,
    );
    setServers(renamedServers);
    setConnectionFolders((current) => {
      const renamed = current.map((folder) => (folder === group ? nextGroup : folder));
      return ensureFolder(renamed, nextGroup).filter((folder, index, list) =>
        list.findIndex((item) => item.toLowerCase() === folder.toLowerCase()) === index,
      );
    });

    try {
      if (isTauri) {
        for (const server of renamedServers.filter((item) => (item.group || "Default") === nextGroup)) {
          await command("save_server", { input: serverInputFromRecord(server), password: null });
        }
        await refreshServers();
      }
      showNotice("已重命名目录");
    } catch (error) {
      showNotice(String(error));
      await refreshServers();
    }
  }

  async function exportConnections(target: { serverIds: string[]; folders: string[] }) {
    if (!isTauri) {
      showNotice("演示模式不支持导出连接");
      return;
    }
    const selectedFolders = target.folders;
    const selectedServerIds = new Set(target.serverIds);
    const selectedFolderSet = new Set(selectedFolders);
    const exportingAll = selectedFolders.length === 0 && selectedServerIds.size === 0;
    const exportFolders = exportingAll ? connectionFolderNames : selectedFolders;
    const exportServers = servers.filter((server) =>
      exportingAll || selectedServerIds.has(server.id) || selectedFolderSet.has(server.group || "Default"),
    );
    if (exportServers.length === 0 && exportFolders.length === 0) {
      showNotice("没有可导出的连接");
      return;
    }
    const passphrase = window.prompt("设置导出密钥，用于加密已保存的密码。留空将只导出连接配置。")?.trim() || null;

    const asZip = exportFolders.length > 0 || exportServers.length > 1;
    const picked = await save({
      title: "导出连接",
      defaultPath: `ishell-connections-${new Date().toISOString().slice(0, 10)}.${asZip ? "zip" : "json"}`,
      filters: [{ name: asZip ? "ZIP 压缩包" : "JSON 文件", extensions: [asZip ? "zip" : "json"] }],
    });
    if (!picked) return;

    try {
      await command("export_connections", {
        path: picked,
        payload: {
          folders: exportFolders,
          servers: exportServers,
        },
        asZip,
        passphrase,
      });
      showNotice(`已导出 ${exportServers.length} 台主机`);
    } catch (error) {
      showNotice(String(error));
    }
  }

  async function importConnections() {
    if (!isTauri) {
      showNotice("演示模式不支持导入连接");
      return;
    }
    const picked = await open({
      multiple: false,
      directory: false,
      title: "导入连接",
      filters: [{ name: "连接导入文件", extensions: ["json", "zip"] }],
    });
    const path = typeof picked === "string" ? picked : Array.isArray(picked) ? picked[0] : null;
    if (!path) return;

    try {
      let imported: ConnectionImportPayload;
      try {
        imported = await command<ConnectionImportPayload>("import_connections", { path, passphrase: null });
      } catch (error) {
        const message = String(error);
        if (!message.includes("加密密码") && !message.includes("导入密钥")) throw error;
        const passphrase = window.prompt("导入文件包含加密密码，请输入导入密钥")?.trim();
        if (!passphrase) return;
        imported = await command<ConnectionImportPayload>("import_connections", { path, passphrase });
      }
      for (const input of imported.servers) {
        const { password, ...serverInput } = input;
        await command("save_server", { input: serverInput, password: password || null });
      }
      setConnectionFolders((current) =>
        imported.folders.reduce((next, folder) => ensureFolder(next, folder), current),
      );
      await refreshServers();
      showNotice(`已导入 ${imported.servers.length} 台主机`);
    } catch (error) {
      showNotice(String(error));
    }
  }

  function requestDeleteConnections(target: { serverIds: string[]; folders: string[] }) {
    const folderSet = new Set(target.folders);
    const idSet = new Set(target.serverIds);
    const targets = servers.filter((server) => idSet.has(server.id) || folderSet.has(server.group || "Default"));
    if (targets.length === 0 && target.folders.length === 0) return;
    setConnectionDeleteConfirm({ target, servers: targets });
  }

  async function confirmDeleteConnections() {
    if (!connectionDeleteConfirm || connectionDeleteConfirm.busy) return;
    const { target } = connectionDeleteConfirm;
    const folderSet = new Set(target.folders);
    const idSet = new Set(target.serverIds);
    const targets = servers.filter((server) => idSet.has(server.id) || folderSet.has(server.group || "Default"));
    if (targets.length === 0 && target.folders.length === 0) {
      setConnectionDeleteConfirm(null);
      return;
    }

    setConnectionDeleteConfirm((current) => (current ? { ...current, busy: true, error: undefined } : current));
    try {
      if (isTauri) {
        for (const server of targets) {
          await command("delete_server", { id: server.id });
        }
      }
      const deleteIds = new Set(targets.map((server) => server.id));
      setServers((current) => current.filter((server) => !deleteIds.has(server.id)));
      setTabs((current) => current.filter((tab) => !deleteIds.has(tab.serverId)));
      setConnectionFolders((current) => current.filter((folder) => !folderSet.has(folder)));
      setSelectedServerId((current) => (current && deleteIds.has(current) ? null : current));
      setConnectionDeleteConfirm(null);
      showNotice(target.folders.length > 0 ? "已删除文件夹" : "已删除");
    } catch (error) {
      const message = String(error);
      showNotice(message);
      setConnectionDeleteConfirm((current) =>
        current ? { ...current, busy: false, error: message } : current,
      );
    }
  }

  async function saveServer() {
    setSaving(true);
    const input = serverInputFromForm(form);

    try {
      if (!isTauri) {
        const saved: ServerRecord = {
          ...input,
          id: input.id || crypto.randomUUID(),
          sortOrder: servers.length,
          createdAt: Date.now() / 1000,
          updatedAt: Date.now() / 1000,
          lastConnectedAt: null,
        };
        setServers((current) =>
          current.some((server) => server.id === saved.id)
            ? current.map((server) => (server.id === saved.id ? saved : server))
            : [...current, saved],
        );
        setSelectedServerId(saved.id);
      } else {
        const saved = await command<ServerRecord>("save_server", {
          input,
          password: form.password || null,
        });
        await refreshServers();
        setSelectedServerId(saved.id);
      }
      setConnectionFolders((current) => ensureFolder(current, input.group || "Default"));
      setEditing(false);
      showNotice("已保存");
    } catch (error) {
      showNotice(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function testServerConnection() {
    if (testingConnection) return;
    const input = serverInputFromForm(form);
    setTestingConnection(true);
    setConnectionTestFeedback({ kind: "info", message: "正在测试连接…" });
    showNotice(`正在测试 ${input.host || "连接"}…`);
    try {
      if (!isTauri) {
        await new Promise((resolve) => setTimeout(resolve, 420));
      } else {
        await command("test_server_connection", {
          input,
          password: form.password || null,
        });
      }
      setConnectionTestFeedback({ kind: "success", message: "测试连接成功" });
      showNotice("测试连接成功");
    } catch (error) {
      const message = String(error);
      setConnectionTestFeedback({ kind: "error", message });
      showNotice(message);
    } finally {
      setTestingConnection(false);
    }
  }

  async function deleteSelectedServer() {
    if (!selectedServer) return;
    if (!window.confirm(`确定删除「${selectedServer.name}」吗？`)) return;
    try {
      if (isTauri) await command("delete_server", { id: selectedServer.id });
      setServers((current) => current.filter((server) => server.id !== selectedServer.id));
      setTabs((current) => current.filter((tab) => tab.serverId !== selectedServer.id));
      setSelectedServerId(null);
      setEditing(false);
      showNotice("已删除");
    } catch (error) {
      showNotice(String(error));
    }
  }

  async function openShell(server: ServerRecord | null = selectedServer) {
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
    const server = tab ? servers.find((item) => item.id === tab.serverId) : null;
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

  function moveConnectionNode(request: ConnectionMoveRequest) {
    if (!canMoveConnectionNode(request)) return;
    const nextFolders = moveConnectionFolders(connectionFolderNames, request);
    if (nextFolders !== connectionFolderNames) setConnectionFolders(nextFolders);

    const nextServers = moveConnectionServers(servers, nextFolders, request);
    if (nextServers === servers) return;

    setServers(nextServers);
    const items = nextServers.map((server, index) => ({
      id: server.id,
      group: server.group || "Default",
      sortOrder: index,
    }));
    if (isTauri) {
      command("reorder_servers", { items })
        .catch((error) => {
          showNotice(String(error));
          refreshServers();
        });
    }
  }

  function handleTerminalReady(tabId: string, serverId: string, title: string) {
    if (terminalReadyTabs.current.has(tabId)) return;
    terminalReadyTabs.current.add(tabId);
    patchTab(tabId, { state: "connected" });
    showNotice(`${title} 已连接`);
    refreshServers();
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
    const pendingFolderReplace = pendingFolderUploadReplaceRef.current;
    if (pendingFolderReplace && ids.has(pendingFolderReplace.item.tabId)) {
      resolveFolderUploadReplacement(false);
    }
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
      if (pendingFolderUploadReplaceRef.current) resolveFolderUploadReplacement(false);
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
          if (includeDisk || !tab.status) return { ...tab, status: next };
          return {
            ...tab,
            status: {
              ...next,
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

      enqueueUploadsForTarget(paths, {
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
    enqueueUploadsForTarget(localPaths, {
      tabId: latestTab.id,
      serverId: latestTab.serverId,
      remoteDir: remoteDir ?? currentDirForTab(latestTab),
    });
  }

  function enqueueUploadsForTarget(localPaths: string[], target: UploadTargetContext) {
    const items: UploadItem[] = localPaths.map((localPath) => ({
      id: crypto.randomUUID(),
      tabId: target.tabId,
      name: basename(localPath),
      localPath,
      remoteDir: target.remoteDir,
      serverId: target.serverId,
      transferred: 0,
      total: 0,
      status: "pending",
    }));
    items.forEach((item) => scheduledUploadIdsRef.current.add(item.id));
    setUploads((current) => [...items, ...current]);

    uploadChainRef.current = uploadChainRef.current.then(async () => {
      for (const item of items) {
        await runUpload(item);
      }
    });
  }

  async function runUpload(item: UploadItem, replaceExistingFolder = false) {
    if (canceledUploadIdsRef.current.has(item.id)) {
      scheduledUploadIdsRef.current.delete(item.id);
      canceledUploadIdsRef.current.delete(item.id);
      return;
    }
    setUploads((current) =>
      current.map((upload) =>
        upload.id === item.id
          ? { ...upload, status: "uploading", transferred: 0, error: undefined }
          : upload,
      ),
    );
    beginSftpBusy();
    inFlightUploadIdsRef.current.add(item.id);
    try {
      if (canceledUploadIdsRef.current.has(item.id)) return;
      await command<string>("sftp_upload", {
        id: item.serverId,
        localPath: item.localPath,
        remoteDir: item.remoteDir,
        transferId: item.id,
        replaceExistingFolder,
      });
      inFlightUploadIdsRef.current.delete(item.id);
      // A successful command result is authoritative: cancellation may have
      // raced with the remote commit after it was already too late to stop.
      canceledUploadIdsRef.current.delete(item.id);
      setUploads((current) =>
        current.map((upload) =>
          upload.id === item.id
            ? { ...upload, status: "done", transferred: upload.total || upload.transferred }
            : upload,
        ),
      );
      refreshVisibleFiles(item.tabId, item.serverId, item.remoteDir);
    } catch (error) {
      inFlightUploadIdsRef.current.delete(item.id);
      const message = String(error);
      if (message.includes("上传已停止")) {
        setUploads((current) =>
          current.map((upload) =>
            upload.id === item.id ? { ...upload, status: "canceled", error: undefined } : upload,
          ),
        );
        return;
      }
      if (!replaceExistingFolder && isFolderUploadConflict(message)) {
        if (canceledUploadIdsRef.current.has(item.id)) {
          setUploads((current) =>
            current.map((upload) =>
              upload.id === item.id ? { ...upload, status: "canceled", error: undefined } : upload,
            ),
          );
          return;
        }
        setUploads((current) =>
          current.map((upload) =>
            upload.id === item.id
              ? { ...upload, status: "pending", transferred: 0, error: undefined }
              : upload,
          ),
        );
        const replace = await requestFolderUploadReplacement(item);
        if (canceledUploadIdsRef.current.has(item.id)) return;
        // Keep this attempt's finally block pending until the replacement
        // attempt finishes, otherwise it would clear the shared in-flight
        // cancellation guards while the retry is still running.
        if (replace) return await runUpload(item, true);
        setUploads((current) =>
          current.map((upload) =>
            upload.id === item.id
              ? {
                  ...upload,
                  status: "canceled",
                  transferred: 0,
                  error: "已取消完整替换，远端文件夹未更改",
                }
              : upload,
          ),
        );
        return;
      }
      setUploads((current) =>
        current.map((upload) =>
          upload.id === item.id ? { ...upload, status: "error", error: message } : upload,
        ),
      );
      showNotice(message);
    } finally {
      inFlightUploadIdsRef.current.delete(item.id);
      scheduledUploadIdsRef.current.delete(item.id);
      canceledUploadIdsRef.current.delete(item.id);
      endSftpBusy();
    }
  }

  function requestFolderUploadReplacement(item: UploadItem) {
    if (pendingFolderUploadReplaceRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      pendingFolderUploadReplaceRef.current = { item, resolve };
      setFolderUploadReplaceConfirm({ item });
    });
  }

  function resolveFolderUploadReplacement(replace: boolean, expectedItemId?: string) {
    const pendingConfirmation = pendingFolderUploadReplaceRef.current;
    if (!pendingConfirmation || (expectedItemId && pendingConfirmation.item.id !== expectedItemId)) return;
    pendingFolderUploadReplaceRef.current = null;
    setFolderUploadReplaceConfirm(null);
    pendingConfirmation.resolve(replace);
  }

  async function stopUpload(id: string) {
    const isScheduled = scheduledUploadIdsRef.current.has(id);
    const isInFlight = inFlightUploadIdsRef.current.has(id);
    if (isScheduled) canceledUploadIdsRef.current.add(id);
    if (pendingFolderUploadReplaceRef.current?.item.id === id) {
      resolveFolderUploadReplacement(false);
    }
    setUploads((current) =>
      current.map((item) =>
        item.id === id && (item.status === "pending" || item.status === "uploading")
          ? { ...item, status: "canceled", error: undefined }
          : item,
      ),
    );
    if (isInFlight && isTauri) {
      await command("cancel_upload", { transferId: id }).catch(() => undefined);
    }
  }

  function dismissUpload(id: string) {
    setUploads((current) => current.filter((item) => item.id !== id));
  }

  function clearDoneUploads() {
    setUploads((current) =>
      current.filter((item) => item.status !== "done" && item.status !== "error" && item.status !== "canceled"),
    );
  }

  function downloadFiles(entries: SftpEntry[]) {
    if (!activeTab) return;
    const files = entries.filter((entry) => !entry.isDir);
    if (files.length === 0) return;
    enqueueDownloads(files);
  }

  function downloadFolder(entry: SftpEntry, mode: FolderDownloadMode) {
    if (!activeTab || !entry.isDir) return;
    const tabId = activeTab.id;
    const serverId = activeTab.serverId;
    const item: DownloadItem = {
      id: crypto.randomUUID(),
      tabId,
      name: mode === "archive" ? `${entry.name}.tar.gz` : entry.name,
      remotePath: entry.path,
      serverId,
      transferred: 0,
      total: 0,
      status: "pending",
      folderMode: mode,
    };
    setDownloads((current) => [item, ...current]);
    showNotice(`已加入下载队列：${entry.name}`);

    downloadChainRef.current = downloadChainRef.current.then(async () => {
      await runDownload(item);
    });
  }

  function enqueueDownloads(entries: SftpEntry[]) {
    if (!activeTab) return;
    const tabId = activeTab.id;
    const serverId = activeTab.serverId;
    const items: DownloadItem[] = entries.map((entry) => ({
      id: crypto.randomUUID(),
      tabId,
      name: entry.name,
      remotePath: entry.path,
      serverId,
      transferred: 0,
      total: entry.size ?? 0,
      status: "pending",
    }));
    setDownloads((current) => [...items, ...current]);
    showNotice(`已加入下载队列：${items.length} 个文件`);

    downloadChainRef.current = downloadChainRef.current.then(async () => {
      for (const item of items) {
        await runDownload(item);
      }
    });
  }

  async function runDownload(item: DownloadItem) {
    let skip = false;
    setDownloads((current) =>
      current.map((download) => {
        if (download.id !== item.id) return download;
        if (download.status === "canceled") {
          skip = true;
          return download;
        }
        return { ...download, status: "downloading" };
      }),
    );
    if (skip || downloadsRef.current.find((download) => download.id === item.id)?.status === "canceled") return;

    beginSftpBusy();
    try {
      const saved = isTauri
        ? item.folderMode
          ? await command<string>("sftp_download_folder", {
              id: item.serverId,
              path: item.remotePath,
              transferId: item.id,
              mode: item.folderMode,
            })
          : await command<string>("sftp_download", {
              id: item.serverId,
              path: item.remotePath,
              transferId: item.id,
            })
        : await simulateDemoDownload(item, (transferred, total) => {
            setDownloads((current) =>
              current.map((download) =>
                download.id === item.id && download.status !== "canceled"
                  ? { ...download, transferred, total }
                  : download,
              ),
            );
          });
      if (downloadsRef.current.find((download) => download.id === item.id)?.status === "canceled") return;
      setDownloads((current) =>
        current.map((download) =>
          download.id === item.id
            ? {
                ...download,
                status: "done",
                transferred: download.total || download.transferred,
                savedPath: saved,
              }
            : download,
        ),
      );
      showNotice(`已保存 ${item.name}`);
    } catch (error) {
      const message = String(error);
      if (message.includes("下载已停止")) {
        setDownloads((current) =>
          current.map((download) =>
            download.id === item.id ? { ...download, status: "canceled", error: undefined } : download,
          ),
        );
        return;
      }
      setDownloads((current) =>
        current.map((download) =>
          download.id === item.id ? { ...download, status: "error", error: message } : download,
        ),
      );
      showNotice(message);
    } finally {
      endSftpBusy();
    }
  }

  async function stopDownload(id: string) {
    const target = downloadsRef.current.find((item) => item.id === id);
    setDownloads((current) =>
      current.map((item) =>
        item.id === id && (item.status === "pending" || item.status === "downloading")
          ? { ...item, status: "canceled", error: undefined }
          : item,
      ),
    );
    if (target?.status === "downloading" && isTauri) {
      await command("cancel_download", { transferId: id }).catch(() => undefined);
    }
  }

  function dismissDownload(id: string) {
    setDownloads((current) => current.filter((item) => item.id !== id));
  }

  function clearDoneDownloads() {
    setDownloads((current) =>
      current.filter((item) => item.status !== "done" && item.status !== "error" && item.status !== "canceled"),
    );
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

  return (
    <div className="app">
      <main className="workspace">
        <TabBar
          autoHide={autoHideTopBar}
          connectionsOpen={connectionsOpen}
          onNewServer={() => newServer()}
          tabs={tabs}
          activeTabId={activeTabId}
          activeTabTitle={activeTab?.title ?? null}
          filesOpen={filesOpen}
          statusOpen={statusOpen}
          historyOpen={historyOpen}
          serverCount={servers.length}
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
            grouped={grouped}
            onSelect={(server) => setSelectedServerId(server.id)}
            onConnect={openShell}
            onClone={cloneServer}
            onEdit={editServer}
            onRenameServer={renameServer}
            onRenameFolder={renameConnectionFolder}
            onNew={(group) => newServer(group)}
            onCreateFolder={createConnectionFolder}
            onExport={exportConnections}
            onImport={importConnections}
            onDelete={requestDeleteConnections}
            onMove={moveConnectionNode}
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
                          onTerminalJump={jumpTerminalToDir}
                          onMkdir={makeDir}
                          onRename={renameEntry}
                          onDelete={deleteEntries}
                          onClose={() => setFilesOpen(false)}
                        />
                      </Suspense>
                      <div className="transfer-queues">
                        <UploadQueue
                          uploads={uploads}
                          onDismiss={dismissUpload}
                          onStop={stopUpload}
                          onClearDone={clearDoneUploads}
                        />
                        <DownloadQueue
                          downloads={downloads}
                          onDismiss={dismissDownload}
                          onStop={stopDownload}
                          onClearDone={clearDoneDownloads}
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
                servers={servers}
                onConnect={openShell}
                onNew={() => newServer()}
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
          autoHideTopBar={autoHideTopBar}
          onThemeChange={setTheme}
          onTerminalFontSizeChange={setTerminalFontSize}
          onAutoHideTopBarChange={setAutoHideTopBar}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {folderUploadReplaceConfirm && (
        <div
          className="delete-confirm-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              resolveFolderUploadReplacement(false, folderUploadReplaceConfirm.item.id);
            }
          }}
        >
          <div
            className="delete-confirm folder-upload-replace-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="folder-upload-replace-title"
            aria-describedby="folder-upload-replace-description"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                resolveFolderUploadReplacement(false, folderUploadReplaceConfirm.item.id);
              }
            }}
          >
            <h2 id="folder-upload-replace-title">完整替换远端文件夹？</h2>
            <p id="folder-upload-replace-description">
              远端已存在同名文件夹。继续会用本地文件夹完整替换它，不会合并内容，远端独有的文件和子目录都会被删除。
            </p>
            <div className="delete-target folder-upload-replace-target">
              <span>远端目标</span>
              <code>{uploadRemotePath(folderUploadReplaceConfirm.item)}</code>
            </div>
            <div className="delete-actions">
              <button
                type="button"
                className="btn-ghost"
                autoFocus
                onClick={() =>
                  resolveFolderUploadReplacement(false, folderUploadReplaceConfirm.item.id)
                }
              >
                取消上传
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() =>
                  resolveFolderUploadReplacement(true, folderUploadReplaceConfirm.item.id)
                }
              >
                完整替换
              </button>
            </div>
          </div>
        </div>
      )}

      {connectionDeleteConfirm && (
        <div className="delete-confirm-backdrop" role="presentation">
          <div
            className="delete-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-delete-confirm-title"
          >
            <h2 id="connection-delete-confirm-title">确认删除</h2>
            <p>{connectionDeleteDescription(connectionDeleteConfirm)}</p>
            <div
              className="delete-target"
              title={connectionDeleteTargetText(connectionDeleteConfirm)}
            >
              {connectionDeleteTargetText(connectionDeleteConfirm)}
            </div>
            {connectionDeleteConfirm.error && <div className="delete-error">{connectionDeleteConfirm.error}</div>}
            <div className="delete-actions">
              <button
                type="button"
                className="btn-ghost"
                disabled={connectionDeleteConfirm.busy}
                onClick={() => setConnectionDeleteConfirm(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="danger-button"
                autoFocus
                disabled={connectionDeleteConfirm.busy}
                onClick={confirmDeleteConnections}
              >
                {connectionDeleteConfirm.busy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="delete-confirm-backdrop" role="presentation">
          <div
            className="delete-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
          >
            <h2 id="delete-confirm-title">确认删除</h2>
            <p>{sftpDeleteDescription(deleteConfirm.entries)}</p>
            <div className="delete-target" title={deleteConfirm.entries.map((entry) => entry.path).join("\n")}>
              {deleteConfirm.entries.length > 1
                ? deleteConfirm.entries.map((entry) => entry.name).join("、")
                : deleteConfirm.entries[0]?.path}
            </div>
            {deleteConfirm.error && <div className="delete-error">{deleteConfirm.error}</div>}
            <div className="delete-actions">
              <button
                type="button"
                className="btn-ghost"
                disabled={deleteConfirm.busy}
                onClick={() => setDeleteConfirm(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="danger-button"
                autoFocus
                disabled={deleteConfirm.busy}
                onClick={confirmDeleteEntry}
              >
                {deleteConfirm.busy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {fileEditor && (
        <div className="file-editor-backdrop" role="presentation">
          <section className="file-editor" role="dialog" aria-modal="true" aria-labelledby="file-editor-title">
            <header className="file-editor-head">
              <div>
                <span>Text Editor</span>
                <h2 id="file-editor-title">{fileEditor.entry.name}</h2>
                <p title={fileEditor.entry.path}>{fileEditor.entry.path}</p>
              </div>
              <button type="button" className="icon-button" onClick={closeFileEditor} title="关闭">
                <X size={16} />
              </button>
            </header>
            {fileEditor.error && <div className="file-editor-error">{fileEditor.error}</div>}
            <div className="file-editor-code">
              <pre ref={fileEditorHighlightRef} className="file-editor-highlight" aria-hidden="true">{renderHighlightedCode(fileEditor.entry.name, fileEditor.content)}</pre>
              <textarea
                ref={fileEditorTextareaRef}
                className="file-editor-textarea"
                value={fileEditor.content}
                disabled={fileEditor.loading || fileEditor.saving}
                spellCheck={false}
                wrap="off"
                onPointerDown={startFileEditorSelectionDrag}
                onScroll={(event) => {
                  const highlight = fileEditorHighlightRef.current;
                  if (!highlight) return;
                  highlight.scrollTop = event.currentTarget.scrollTop;
                  highlight.scrollLeft = event.currentTarget.scrollLeft;
                }}
                onChange={(event) =>
                  setFileEditor((current) =>
                    current ? { ...current, content: event.target.value, error: undefined } : current,
                  )
                }
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    saveFileEditor();
                  }
                }}
              />
            </div>
            <footer className="file-editor-actions">
              <span>{fileEditor.loading ? "读取中…" : `${formatBytes(new TextEncoder().encode(fileEditor.content).length)} / 1 MB`}</span>
              <div>
                <button type="button" className="btn-ghost" disabled={fileEditor.saving} onClick={closeFileEditor}>
                  取消
                </button>
                <button
                  type="button"
                  className="solid-button"
                  disabled={fileEditor.loading || fileEditor.saving || fileEditor.content === fileEditor.originalContent}
                  onClick={saveFileEditor}
                >
                  <Save size={15} />
                  {fileEditor.saving ? "保存中…" : "保存"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}

      {editing && (
        <ServerEditor
          form={form}
          setForm={(next) => {
            setConnectionTestFeedback(null);
            setForm(next);
          }}
          saving={saving}
          testing={testingConnection}
          testFeedback={connectionTestFeedback}
          onSave={saveServer}
          onTest={testServerConnection}
          onClose={() => setEditing(false)}
          onDelete={form.id ? deleteSelectedServer : undefined}
        />
      )}
    </div>
  );
}

function networkPatch(
  tab: ShellTab,
  sample: NetworkSample,
  rxBps: number,
  txBps: number,
): ShellTab {
  return {
    ...tab,
    networkSample: sample,
    networkRxBps: rxBps,
    networkTxBps: txBps,
    networkHistory: [...tab.networkHistory, { sampledAt: sample.sampledAt, rxBps, txBps }].slice(-40),
  };
}

async function applyNativeWindowTheme(theme: AppTheme) {
  const [{ Effect, EffectState, getCurrentWindow }, { getCurrentWebview }] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/webview"),
  ]);
  const appWindow = getCurrentWindow();
  const webview = getCurrentWebview();
  const nativeTheme = getThemeDefinition(theme).native;
  const windowBackgroundColor = nativeTheme.backgroundColor;
  // For transparent themes the macOS vibrancy view IS the window background. Painting
  // any non-clear color over it hides the blur, so the window/webview must be fully
  // transparent and let the NSVisualEffectView (set below) supply the gray frost.
  const transparent = { red: 0, green: 0, blue: 0, alpha: 0 };
  const webviewBackgroundColor = nativeTheme.transparentChrome ? transparent : windowBackgroundColor;
  const appWindowBackgroundColor = nativeTheme.transparentChrome ? transparent : windowBackgroundColor;

  await Promise.allSettled([
    appWindow.setBackgroundColor(appWindowBackgroundColor),
    webview.setBackgroundColor(webviewBackgroundColor),
  ]);

  if (nativeTheme.effect !== "glass") {
    await appWindow.clearEffects().catch(() => undefined);
    return;
  }

  const platform = document.documentElement.dataset.platform;
  const effects =
    platform === "macos"
      ? // UnderWindowBackground is the most translucent macOS material: it passes
        // the real desktop colors through (unlike HudWindow, which flattens them to
        // gray) so the CSS blur(40px) saturate(200%) can render a vivid glass.
        { effects: [Effect.UnderWindowBackground], state: EffectState.Active, radius: 14 }
      : platform === "windows"
        ? // Acrylic and Blur are known to make Windows window moves/resizes lag.
          // Mica is composed by DWM without that penalty; on Windows 10 it is
          // unsupported and intentionally becomes a no-op instead of falling back.
          { effects: [Effect.Mica] }
        : null;

  if (effects) {
    await appWindow.setEffects(effects).catch(() => undefined);
  }
}

function loadDemoFiles(path: string) {
  return new Promise<SftpEntry[]>((resolve) => {
    setTimeout(() => {
      const suffix = path === "/" ? "" : path;
      resolve(
        demoFiles.map((entry, index) => ({
          ...entry,
          path: entry.path.startsWith("/") ? `${suffix}${entry.path}`.replace("//", "/") : entry.path,
          name: index > 2 && path !== "/" ? `${entry.name.replace(".", `-${path.split("/").pop()}.`)}` : entry.name,
        })),
      );
    }, 220);
  });
}

function simulateDemoDownload(
  item: DownloadItem,
  onProgress?: (transferred: number, total: number) => void,
) {
  return new Promise<string>((resolve) => {
    const total = item.total || 1_000_000;
    let transferred = 0;
    const step = Math.max(1, Math.ceil(total / 20));
    const timer = window.setInterval(() => {
      transferred = Math.min(total, transferred + step);
      onProgress?.(transferred, total);
      if (transferred >= total) {
        window.clearInterval(timer);
        resolve(`~/Downloads/${item.name}`);
      }
    }, 120);
  });
}

function waitAtLeast(startedAt: number, minimumMs: number) {
  const remaining = minimumMs - (performance.now() - startedAt);
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, remaining));
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function currentDirForTab(tab: ShellTab) {
  return tab.files.length ? tab.files[tab.files.length - 1].path : "/";
}

function resolveKnownUploadDirectory(tab: ShellTab, requestedPath: string) {
  if (requestedPath === "/" || currentDirForTab(tab) === requestedPath) return requestedPath;
  if (Object.prototype.hasOwnProperty.call(tab.cache, requestedPath)) return requestedPath;
  return tab.files.some((column) =>
    column.entries.some((entry) => entry.isDir && entry.path === requestedPath)
  )
    ? requestedPath
    : null;
}

function isFolderUploadConflict(message: string) {
  return message.includes(FOLDER_UPLOAD_CONFLICT_MARKER);
}

function uploadRemotePath(item: UploadItem) {
  const remoteDir = item.remoteDir.replace(/\/+$/, "") || "/";
  return remoteDir === "/" ? `/${item.name}` : `${remoteDir}/${item.name}`;
}

function ensureFolder(current: string[], folder: string) {
  const name = folder.trim() || "Default";
  if (current.some((item) => item.toLowerCase() === name.toLowerCase())) return current;
  return [...current, name].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function readTabGhostFromUrl() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const raw = params.get("tabGhost");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TabGhostPayload>;
    if (
      typeof parsed.title !== "string" ||
      typeof parsed.subtitle !== "string" ||
      typeof parsed.color !== "string" ||
      typeof parsed.width !== "number"
    ) {
      return null;
    }
    return {
      title: parsed.title,
      subtitle: parsed.subtitle,
      color: parsed.color,
      width: Math.min(260, Math.max(120, parsed.width)),
    } satisfies TabGhostPayload;
  } catch {
    return null;
  }
}

function TabGhostWindow({ ghost }: { ghost: TabGhostPayload }) {
  useEffect(() => {
    document.documentElement.classList.add("tab-ghost-root");
    document.documentElement.dataset.theme = readSavedTheme(window.localStorage.getItem("ishell.theme"));
    document.body.classList.add("tab-ghost-body");
    if (isTauri) {
      void Promise.all([
        import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
          getCurrentWindow().setBackgroundColor({ red: 0, green: 0, blue: 0, alpha: 0 }),
        ),
        import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
          getCurrentWebview().setBackgroundColor({ red: 0, green: 0, blue: 0, alpha: 0 }),
        ),
      ]).catch(() => undefined);
    }
    return () => {
      document.documentElement.classList.remove("tab-ghost-root");
      document.body.classList.remove("tab-ghost-body");
    };
  }, []);

  return (
    <div className="tab-ghost-window" style={{ width: ghost.width }}>
      <span className="tab-dot connected" style={{ color: ghost.color }} />
      <span>
        <strong>{ghost.title}</strong>
        <small>{ghost.subtitle}</small>
      </span>
    </div>
  );
}

function readHandedOffTabFromUrl() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const raw = params.get("handoff");
  if (!raw) return null;
  try {
    return normalizeHandedOffTab(JSON.parse(raw) as Partial<ShellTab>);
  } catch {
    return null;
  }
}

function normalizeHandedOffTab(tab: Partial<ShellTab>) {
  if (
    typeof tab.id !== "string" ||
    typeof tab.serverId !== "string" ||
    typeof tab.title !== "string" ||
    typeof tab.subtitle !== "string" ||
    typeof tab.host !== "string" ||
    typeof tab.color !== "string" ||
    typeof tab.sessionId !== "string"
  ) {
    return null;
  }
  return {
    id: tab.id,
    serverId: tab.serverId,
    title: tab.title,
    subtitle: tab.subtitle,
    host: tab.host,
    color: tab.color,
    sessionId: tab.sessionId,
    state: tab.state === "closed" || tab.state === "connecting" ? tab.state : "connected",
    status: tab.status ?? null,
    networkSample: tab.networkSample ?? null,
    networkRxBps: Number(tab.networkRxBps ?? 0),
    networkTxBps: Number(tab.networkTxBps ?? 0),
    networkHistory: Array.isArray(tab.networkHistory) ? tab.networkHistory : [],
    files: [],
    selectedPath: null,
    selectedPaths: [],
    cache: {},
  } satisfies ShellTab;
}

function handoffTabSnapshot(tab: ShellTab): ShellTab {
  return {
    ...tab,
    files: [],
    selectedPath: null,
    selectedPaths: [],
    cache: {},
  };
}

async function peerWindowAtPoint(point: TabDropPoint) {
  const { getAllWebviewWindows, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  const scaleFactor = await current.scaleFactor().catch(() => 1);
  const candidates = [
    { x: point.screenX, y: point.screenY },
    { x: point.screenX * scaleFactor, y: point.screenY * scaleFactor },
  ];
  const windows = await getAllWebviewWindows();
  for (const windowRef of windows) {
    if (windowRef.label === current.label) continue;
    const [position, size] = await Promise.all([
      windowRef.outerPosition(),
      windowRef.outerSize(),
    ]);
    if (
      candidates.some(({ x, y }) =>
        x >= position.x &&
        x <= position.x + size.width &&
        y >= position.y &&
        y <= position.y + size.height
      )
    ) {
      return {
        label: windowRef.label,
        title: windowRef.label === "main" ? "iShell" : windowRef.label.replace(/^shell-/, "窗口 "),
      };
    }
  }
  return null;
}

async function closeCurrentWindowIfPeerExists() {
  const { getAllWebviewWindows, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  const windows = await getAllWebviewWindows();
  if (windows.some((windowRef) => windowRef.label !== current.label)) {
    await current.close();
  }
}

function orderedConnectionFolders(savedFolders: string[], servers: ServerRecord[]) {
  const groupedServers = groupServers(servers);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const folder of savedFolders) {
    const name = folder.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }
  const missing = Object.keys(groupedServers)
    .filter((group) => group && !seen.has(group))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return [...ordered, ...missing];
}

function canMoveConnectionNode(request: ConnectionMoveRequest) {
  if (request.draggedKey === request.targetKey) return false;
  if (request.draggedKey.startsWith("folder:") && request.position === "inside") return false;
  if (request.draggedKey.startsWith("folder:") && request.targetKey.startsWith("server:")) return false;
  return true;
}

function moveConnectionFolders(folders: string[], request: ConnectionMoveRequest) {
  if (!request.draggedKey.startsWith("folder:") || !request.targetKey.startsWith("folder:")) return folders;
  const dragged = request.draggedKey.slice("folder:".length);
  const target = request.targetKey.slice("folder:".length);
  const from = folders.indexOf(dragged);
  const targetIndex = folders.indexOf(target);
  if (from < 0 || targetIndex < 0 || from === targetIndex) return folders;

  const next = [...folders];
  const [item] = next.splice(from, 1);
  const adjustedTarget = next.indexOf(target);
  const insertAt = request.position === "after" ? adjustedTarget + 1 : adjustedTarget;
  next.splice(insertAt, 0, item);
  return next;
}

function moveConnectionServers(
  servers: ServerRecord[],
  folders: string[],
  request: ConnectionMoveRequest,
) {
  const ordered = flattenServersByFolders(servers, folders);
  if (request.draggedKey.startsWith("folder:")) {
    const next = ordered.map((server, index) => ({ ...server, sortOrder: index }));
    return sameServerOrder(servers, next) ? servers : next;
  }
  if (!request.draggedKey.startsWith("server:")) return servers;

  const draggedId = request.draggedKey.slice("server:".length);
  const dragged = ordered.find((server) => server.id === draggedId);
  if (!dragged) return servers;

  const withoutDragged = ordered.filter((server) => server.id !== draggedId);
  const targetGroup = targetGroupForConnectionMove(request, ordered);
  if (!targetGroup) return servers;

  const targetIndex = insertionIndexForConnectionMove(request, withoutDragged, targetGroup);
  const moved = { ...dragged, group: targetGroup };
  const next = [...withoutDragged];
  next.splice(targetIndex, 0, moved);
  const normalized = next.map((server, index) => ({ ...server, sortOrder: index }));
  return sameServerOrder(servers, normalized) ? servers : normalized;
}

function flattenServersByFolders(servers: ServerRecord[], folders: string[]) {
  const byGroup = groupServers(servers);
  return folders.flatMap((folder) => byGroup[folder] ?? []);
}

function targetGroupForConnectionMove(request: ConnectionMoveRequest, servers: ServerRecord[]) {
  if (request.targetKey.startsWith("folder:")) return request.targetKey.slice("folder:".length);
  const targetId = request.targetKey.startsWith("server:") ? request.targetKey.slice("server:".length) : "";
  return servers.find((server) => server.id === targetId)?.group || null;
}

function insertionIndexForConnectionMove(
  request: ConnectionMoveRequest,
  servers: ServerRecord[],
  targetGroup: string,
) {
  if (request.targetKey.startsWith("folder:")) {
    const groupIndexes = servers
      .map((server, index) => (server.group === targetGroup ? index : -1))
      .filter((index) => index >= 0);
    if (request.position === "before") return groupIndexes[0] ?? servers.length;
    return groupIndexes.length ? groupIndexes[groupIndexes.length - 1] + 1 : servers.length;
  }

  const targetId = request.targetKey.slice("server:".length);
  const targetIndex = servers.findIndex((server) => server.id === targetId);
  if (targetIndex < 0) return servers.length;
  return request.position === "after" ? targetIndex + 1 : targetIndex;
}

function sameServerOrder(previous: ServerRecord[], next: ServerRecord[]) {
  if (previous.length !== next.length) return false;
  return previous.every((server, index) =>
    server.id === next[index]?.id &&
    server.group === next[index]?.group &&
    server.sortOrder === next[index]?.sortOrder
  );
}

function connectionDeleteDescription(state: ConnectionDeleteConfirmState) {
  const folderCount = state.target.folders.length;
  const serverCount = state.servers.length;
  if (folderCount > 0) {
    return `将删除 ${folderCount} 个文件夹及其中 ${serverCount} 台服务器。`;
  }
  if (serverCount > 1) {
    return `将删除所选 ${serverCount} 台服务器。`;
  }
  return "该服务器会被删除。";
}

function connectionDeleteTargetText(state: ConnectionDeleteConfirmState) {
  const folders = state.target.folders.map((folder) => `文件夹：${folder}`);
  const servers = state.target.folders.length > 0
    ? []
    : state.servers.map((server) => server.name);
  return [...folders, ...servers].join("、") || "所选连接";
}

function groupServersForTree(
  servers: ServerRecord[],
  folders: string[],
) {
  const groupedServers = groupServers(servers);
  const folderNames = new Set(folders);
  for (const group of Object.keys(groupedServers)) folderNames.add(group);

  return folders
    .filter((folder) => folder && folderNames.has(folder))
    .reduce<Record<string, ServerRecord[]>>((acc, folder) => {
      const list = groupedServers[folder] ?? [];
      acc[folder] = list;
      return acc;
    }, {});
}

function parentPath(path: string) {
  const normalized = path.replace(/\/+/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

interface HighlightToken {
  text: string;
  kind?: string;
}

function textOffsetAtPoint(
  textarea: HTMLTextAreaElement,
  highlight: HTMLPreElement,
  x: number,
  y: number,
) {
  const textareaPointerEvents = textarea.style.pointerEvents;
  const highlightPointerEvents = highlight.style.pointerEvents;
  const highlightZIndex = highlight.style.zIndex;
  textarea.style.pointerEvents = "none";
  highlight.style.pointerEvents = "auto";
  highlight.style.zIndex = "2";

  let node: Node | null = null;
  let nodeOffset = 0;
  try {
    const documentWithCaretRange = document as Document & {
      caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
    };
    const caretPosition = document.caretPositionFromPoint?.(x, y);
    const caretRange = caretPosition ? null : documentWithCaretRange.caretRangeFromPoint?.(x, y);
    node = caretPosition?.offsetNode ?? caretRange?.startContainer ?? null;
    nodeOffset = caretPosition?.offset ?? caretRange?.startOffset ?? 0;
  } finally {
    textarea.style.pointerEvents = textareaPointerEvents;
    highlight.style.pointerEvents = highlightPointerEvents;
    highlight.style.zIndex = highlightZIndex;
  }

  if (!node || !highlight.contains(node)) return null;
  try {
    const range = document.createRange();
    range.setStart(highlight, 0);
    range.setEnd(node, nodeOffset);
    return Math.min(textarea.value.length, range.toString().length);
  } catch {
    return null;
  }
}

const HIGHLIGHT_MAX_BYTES = 220_000;
const CODE_KEYWORDS = new Set([
  "abstract", "and", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "def", "default", "defer", "delete", "do", "else", "enum", "export", "extends", "false", "final",
  "finally", "for", "from", "func", "function", "go", "if", "implements", "import", "in", "interface",
  "let", "match", "mod", "new", "nil", "null", "or", "package", "private", "protected", "public",
  "return", "self", "static", "struct", "super", "switch", "this", "throw", "throws", "trait", "true",
  "try", "type", "undefined", "use", "var", "void", "while", "yield",
]);
const SQL_KEYWORDS = new Set([
  "alter", "and", "as", "between", "by", "case", "create", "delete", "desc", "distinct", "drop",
  "else", "end", "exists", "from", "group", "having", "in", "inner", "insert", "into", "is", "join",
  "left", "like", "limit", "not", "null", "on", "or", "order", "outer", "right", "select", "set",
  "table", "then", "union", "update", "values", "when", "where",
]);

function renderHighlightedCode(fileName: string, content: string): ReactNode {
  if (!content) return " ";
  // A <textarea> renders a phantom empty line for a trailing newline while a <pre>
  // swallows it, making this highlight overlay one line shorter than the textarea.
  // That height mismatch clamps the synced scrollTop and shifts the highlighted text
  // one line away from the textarea's selection. Append a trailing <br> to keep the
  // two scroll heights in sync so selections line up with the code they cover.
  const eol = <br key="__eol" />;
  if (new TextEncoder().encode(content).length > HIGHLIGHT_MAX_BYTES) return [content, eol];
  const language = languageForFile(fileName);
  const tokens = tokenizeForLanguage(content, language);
  return [
    ...tokens.map((token, index) =>
      token.kind
        ? <span key={index} className={`syntax-${token.kind}`}>{token.text}</span>
        : token.text,
    ),
    eol,
  ];
}

function languageForFile(fileName: string) {
  const name = fileName.toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  if (["json"].includes(extension)) return "json";
  if (["ts", "tsx", "js", "jsx", "mjs", "java", "c", "h", "cpp", "hpp", "cs", "go", "rs", "kt", "php", "rb", "py", "lua"].includes(extension)) return "code";
  if (["css", "scss", "less"].includes(extension)) return "css";
  if (["html", "htm", "xml", "svg"].includes(extension)) return "markup";
  if (["md", "markdown"].includes(extension) || name === "readme") return "markdown";
  if (["sh", "bash", "zsh"].includes(extension) || name.startsWith(".bash") || name.startsWith(".zsh")) return "shell";
  if (["sql"].includes(extension)) return "sql";
  if (["yaml", "yml", "toml", "ini", "env", "properties"].includes(extension) || name === ".env") return "config";
  return "plain";
}

function tokenizeForLanguage(content: string, language: string) {
  switch (language) {
    case "json":
      return tokenizeByPattern(content, /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b(?:true|false|null)\b|[{}\[\]:,]/gi, classifyJsonToken);
    case "css":
      return tokenizeByPattern(content, /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[0-9a-fA-F]{3,8}\b|--?[A-Za-z_][\w-]*(?=\s*:)|@[A-Za-z-]+|\b(?:from|to|important)\b|[{}():;,]/g, classifyCssToken);
    case "markup":
      return tokenizeByPattern(content, /<!--[\s\S]*?-->|<\/?[A-Za-z][^>\s/]*|\/?>|[A-Za-z_:][-A-Za-z0-9_:.]*(?==)|"(?:&quot;|[^"])*"|'[^']*'|&[A-Za-z0-9#]+;/g, classifyMarkupToken);
    case "markdown":
      return tokenizeByPattern(content, /```[\s\S]*?```|`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)]+\)|^#{1,6} [^\n]*(?:\n|$)/gm, classifyMarkdownToken);
    case "shell":
    case "code":
      return tokenizeByPattern(content, /\/\*[\s\S]*?\*\/|\/\/[^\n\r]*|#[^\n\r]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+(?:\.\d+)?\b|[{}()[\];,.]/g, classifyCodeToken);
    case "sql":
      return tokenizeByPattern(content, /--[^\n\r]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+(?:\.\d+)?\b|[(),.;=*<>+-]/g, classifySqlToken);
    case "config":
      return tokenizeByPattern(content, /#[^\n\r]*|;[^\n\r]*|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|^[ \t-]*[A-Za-z0-9_.-]+(?=\s*[:=])|\b(?:true|false|null|yes|no|on|off)\b|-?\b\d+(?:\.\d+)?\b|[:=[\]{},-]/gim, classifyConfigToken);
    default:
      return [{ text: content }];
  }
}

function tokenizeByPattern(content: string, pattern: RegExp, classify: (token: string) => string | undefined) {
  const tokens: HighlightToken[] = [];
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const text = match[0];
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ text: content.slice(cursor, index) });
    tokens.push({ text, kind: classify(text) });
    cursor = index + text.length;
  }
  if (cursor < content.length) tokens.push({ text: content.slice(cursor) });
  return tokens;
}

function classifyJsonToken(token: string) {
  if (token.startsWith("\"")) return token.match(/"\s*$/) ? "string" : "key";
  if (/^-?\d/.test(token)) return "number";
  if (/^(true|false|null)$/i.test(token)) return "literal";
  return "punct";
}

function classifyCodeToken(token: string) {
  if (token.startsWith("//") || token.startsWith("/*") || token.startsWith("#")) return "comment";
  if (/^["'`]/.test(token)) return "string";
  if (/^\d/.test(token)) return "number";
  if (CODE_KEYWORDS.has(token)) return token === "true" || token === "false" || token === "null" || token === "undefined" || token === "nil" ? "literal" : "keyword";
  if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) return "type";
  if (/^[{}()[\];,.]$/.test(token)) return "punct";
  return undefined;
}

function classifyCssToken(token: string) {
  if (token.startsWith("/*")) return "comment";
  if (/^["']/.test(token)) return "string";
  if (token.startsWith("#")) return "number";
  if (token.startsWith("@") || token === "important") return "keyword";
  if (/^-?-?[A-Za-z_]/.test(token)) return "key";
  return "punct";
}

function classifyMarkupToken(token: string) {
  if (token.startsWith("<!--")) return "comment";
  if (token.startsWith("<")) return "keyword";
  if (/^["']/.test(token)) return "string";
  if (token.startsWith("&")) return "literal";
  if (token === ">" || token === "/>") return "punct";
  return "key";
}

function classifyMarkdownToken(token: string) {
  if (token.startsWith("#")) return "keyword";
  if (token.startsWith("```") || token.startsWith("`")) return "string";
  if (token.startsWith("[")) return "literal";
  return "type";
}

function classifySqlToken(token: string) {
  if (token.startsWith("--") || token.startsWith("/*")) return "comment";
  if (/^["']/.test(token)) return "string";
  if (/^\d/.test(token)) return "number";
  if (SQL_KEYWORDS.has(token.toLowerCase())) return "keyword";
  return /^[(),.;=*<>+-]$/.test(token) ? "punct" : undefined;
}

function classifyConfigToken(token: string) {
  if (token.startsWith("#") || token.startsWith(";")) return "comment";
  if (/^["']/.test(token)) return "string";
  if (/^\d|^-?\d/.test(token)) return "number";
  if (/^(true|false|null|yes|no|on|off)$/i.test(token)) return "literal";
  if (/^[ \t-]*[A-Za-z0-9_.-]+$/.test(token)) return "key";
  return "punct";
}

function buildPathChain(path: string) {
  const parts = path.split("/").filter(Boolean);
  const chain = ["/"];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    chain.push(acc);
  }
  return chain;
}

function sftpDeleteDescription(entries: SftpEntry[]) {
  if (entries.length > 1) {
    const hasRealDirectory = entries.some((entry) => entry.isDir && !entry.isSymlink);
    const hasSymlink = entries.some((entry) => entry.isSymlink);
    return hasRealDirectory
      ? `将删除 ${entries.length} 项，文件夹及其中所有内容也会被删除。`
      : hasSymlink
        ? `将删除 ${entries.length} 项。软链接只会删除链接本身。`
        : `将删除 ${entries.length} 项。`;
  }
  const entry = entries[0];
  if (!entry) return "该项目会被删除。";
  if (entry.isSymlink) return "该软链接会被删除，链接目标会保留。";
  if (entry.isDir) return "该文件夹及其中所有内容都会被删除。";
  return "该文件会被删除。";
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildPathColumns(pathChain: string[], cache: Record<string, SftpEntry[]>): FileColumn[] {
  return pathChain.map((path, index) => {
    const nextPath = pathChain[index + 1];
    const entries = cache[path] ?? (nextPath ? [entryForPath(nextPath)] : []);
    return {
      path,
      entries: nextPath ? ensureTrailEntry(entries, nextPath) : entries,
      loading: false,
    };
  });
}

function ensureTrailEntry(entries: SftpEntry[], nextPath: string) {
  if (entries.some((entry) => entry.path === nextPath)) return entries;
  return [entryForPath(nextPath), ...entries];
}

function sortEntries(entries: SftpEntry[]) {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function entryForPath(path: string): SftpEntry {
  return {
    name: basename(path),
    path,
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
