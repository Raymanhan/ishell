import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { command, isTauri } from "./api/tauri";
import { ConnectionManager } from "./components/ConnectionManager";
import { CommandHistoryPanel } from "./components/CommandHistoryPanel";
import { DownloadQueue } from "./components/DownloadQueue";
import { ServerDetail } from "./components/ServerDetail";
import { ServerEditor, type ServerForm } from "./components/ServerEditor";
import { SettingsModal, type AppTheme } from "./components/SettingsModal";
import { SftpBrowser } from "./components/SftpBrowser";
import { StatusDashboard } from "./components/StatusDashboard";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/TerminalPane";
import { UploadQueue } from "./components/UploadQueue";
import { swatches } from "./constants/theme";
import { createTabId, type ShellTab } from "./features/shell/types";
import { demoFiles, demoServers, demoStatus } from "./mocks/demoData";
import type {
  AuthType,
  DownloadItem,
  DownloadProgressPayload,
  FileColumn,
  NetworkSample,
  ServerInput,
  ServerRecord,
  ServerStatus,
  SftpEntry,
  UploadItem,
  UploadProgressPayload,
} from "./types";
import { filterServers, groupServers } from "./utils/servers";

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

interface DeleteConfirmState {
  entries: SftpEntry[];
  columnIndex: number;
  tabId: string;
  serverId: string;
  busy?: boolean;
  error?: string;
}

export default function App() {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState("全部");
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(
    () => (window.localStorage.getItem("ishell.theme") === "light" ? "light" : "dark"),
  );
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    const saved = Number(window.localStorage.getItem("ishell.terminalFontSize"));
    return Number.isFinite(saved) ? Math.min(20, Math.max(11, saved)) : 14;
  });
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ServerForm>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [tabs, setTabs] = useState<ShellTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesRatio, setFilesRatio] = useState(0.4); // file dock height as a fraction
  const [filesDragging, setFilesDragging] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [statusPanelWidth, setStatusPanelWidth] = useState(360);
  const [pasteRequest, setPasteRequest] = useState<{ tabId: string; id: number; command: string } | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const terminalDockRef = useRef<HTMLDivElement>(null);
  const workbenchMainRef = useRef<HTMLDivElement>(null);
  const filesRegionRef = useRef<HTMLDivElement>(null);
  const dockDragCleanupRef = useRef<(() => void) | null>(null);
  const statusDragCleanupRef = useRef<(() => void) | null>(null);
  // Latest values for the once-registered native drag-drop listener.
  const dropEnabledRef = useRef(false);
  const enqueueUploadsRef = useRef<(paths: string[], remoteDir?: string) => void>(() => {});
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());
  const downloadChainRef = useRef<Promise<void>>(Promise.resolve());
  const uploadsRef = useRef<UploadItem[]>([]);
  const downloadsRef = useRef<DownloadItem[]>([]);
  const [statusLoading, setStatusLoading] = useState(false);
  const [sftpBusy, setSftpBusy] = useState(false);
  const sftpBusyCount = useRef(0);
  const sftpBusySince = useRef(0);
  const sftpBusyTimer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const statusOpenRef = useRef(false);
  const terminalReadyTabs = useRef<Set<string>>(new Set());

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? null,
    [selectedServerId, servers],
  );
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const filteredServers = useMemo(
    () => filterServers(servers, activeGroup, query),
    [activeGroup, query, servers],
  );
  const groups = useMemo(() => ["全部", ...Object.keys(groupServers(servers)).sort()], [servers]);
  const grouped = useMemo(() => groupServers(filteredServers), [filteredServers]);

  // Keep the native drag-drop listener (registered once) reading fresh state.
  dropEnabledRef.current = filesOpen && Boolean(activeTab);
  enqueueUploadsRef.current = enqueueUploads;
  uploadsRef.current = uploads;
  downloadsRef.current = downloads;
  statusOpenRef.current = statusOpen;

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
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("ishell.theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("ishell.terminalFontSize", String(terminalFontSize));
  }, [terminalFontSize]);

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

  // Native OS file drop onto the docked file panel → enqueue uploads. Tauri
  // delivers the absolute local paths, which we hand straight to sftp_upload.
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

  // Drag the divider between the terminal and the docked file panel.
  function startDockDrag(event: React.PointerEvent<HTMLDivElement>) {
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

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      move.preventDefault();
      const ratio = (rect.bottom - move.clientY) / rect.height;
      setFilesRatio(Math.min(0.8, Math.max(0.15, ratio)));
    };

    const stopDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", stopDrag);
      if (divider.hasPointerCapture(pointerId)) {
        divider.releasePointerCapture(pointerId);
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
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

  // Drag the divider between the terminal workspace and the status side panel.
  function startStatusDrag(event: React.PointerEvent<HTMLDivElement>) {
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

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      move.preventDefault();
      const width = startWidth - (move.clientX - startX);
      setStatusPanelWidth(Math.min(560, Math.max(300, width)));
    };

    const stopDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", stopDrag);
      if (divider.hasPointerCapture(pointerId)) {
        divider.releasePointerCapture(pointerId);
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
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

  // Auto-refresh the dashboard with different cadences:
  // network 1s, core metrics 5s, disk mounts 60s.
  useEffect(() => {
    if (!statusOpen || !activeTab || activeTab.state !== "connected") return;
    const tabId = activeTab.id;
    const serverId = activeTab.serverId;
    refreshNetwork(tabId, serverId, true);
    const networkTimer = window.setInterval(() => refreshNetwork(tabId, serverId, true), 1000);
    const metricTimer = window.setInterval(() => refreshStatus(tabId, serverId, true, false), 5000);
    const diskTimer = window.setInterval(() => refreshStatus(tabId, serverId, true, true), 60000);
    return () => {
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
    setNotice(message);
    if (!message || durationMs <= 0) return;

    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice((current) => (current === message ? "" : current));
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

  function editServer(server?: ServerRecord | null) {
    if (!server) {
      setForm(defaultForm);
      setEditing(true);
      return;
    }
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

  async function saveServer() {
    setSaving(true);
    const input: ServerInput = {
      id: form.id,
      name: form.name,
      host: form.host,
      port: Number(form.port),
      username: form.username,
      group: form.group || "Default",
      tags: form.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean),
      authType: form.authType as AuthType,
      keyPath: form.authType === "key" ? form.keyPath || null : null,
      color: form.color,
      notes: form.notes,
    };

    try {
      if (!isTauri) {
        const saved: ServerRecord = {
          ...input,
          id: input.id || crypto.randomUUID(),
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
      setEditing(false);
      showNotice("已保存");
    } catch (error) {
      showNotice(String(error));
    } finally {
      setSaving(false);
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

  async function testSelectedConnection() {
    if (!selectedServer) return;
    showNotice("连接测试中…");
    try {
      if (!isTauri) {
        await new Promise((resolve) => setTimeout(resolve, 420));
        showNotice(`已连接 ${selectedServer.username}@${selectedServer.host} · 42ms`);
        return;
      }
      const result = await command<{ message: string; latencyMs: number }>("test_connection", {
        id: selectedServer.id,
      });
      showNotice(`${result.message} · ${result.latencyMs}ms`);
      await refreshServers();
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

  function handleTerminalReady(tabId: string, serverId: string, title: string) {
    if (terminalReadyTabs.current.has(tabId)) return;
    terminalReadyTabs.current.add(tabId);
    patchTab(tabId, { state: "connected" });
    showNotice(`${title} 已连接`);
    refreshServers();
    warmConnection(tabId, serverId);
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

  async function closeShell(tabId: string) {
    await closeShells([tabId]);
  }

  async function closeShells(tabIds: string[]) {
    const ids = new Set(tabIds);
    if (ids.size === 0) return;
    const closingTabs = tabs.filter((tab) => ids.has(tab.id));
    const firstClosedIndex = tabs.findIndex((tab) => ids.has(tab.id));
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
    const remaining = tabs.filter((tab) => !ids.has(tab.id));
    setTabs(remaining);
    setActiveTabId((current) => {
      if (current && !ids.has(current)) return current;
      if (remaining.length === 0) return null;
      return remaining[Math.min(Math.max(0, firstClosedIndex), remaining.length - 1)]?.id ?? null;
    });
  }

  async function refreshStatus(
    tabId = activeTab?.id,
    serverId = activeTab?.serverId,
    silent = false,
    includeDisk = true,
  ) {
    if (!tabId || !serverId) return;
    if (!statusOpenRef.current) return;
    if (!silent) setStatusLoading(true);
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
      if (!silent) setStatusLoading(false);
    }
  }

  async function refreshNetwork(
    tabId = activeTab?.id,
    serverId = activeTab?.serverId,
    silent = false,
  ) {
    if (!tabId || !serverId) return;
    if (!statusOpenRef.current) return;
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
          const seconds = previous ? Math.max(1, sample.sampledAt - previous.sampledAt) : 1;
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

  async function uploadFile(targetDir = currentDir()) {
    if (!activeTab) return;
    if (!isTauri) {
      showNotice(`演示模式不支持真实上传：${targetDir}`);
      return;
    }
    try {
      const picked = await open({ multiple: true, directory: false, title: "选择要上传的文件" });
      const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
      if (paths.length) enqueueUploads(paths, targetDir);
    } catch (error) {
      showNotice(String(error));
    }
  }

  // Queue one or more local files for upload to the requested remote directory,
  // processed one at a time so they share the single pooled SFTP channel.
  function enqueueUploads(localPaths: string[], remoteDir = currentDir()) {
    if (!activeTab || !isTauri) return;
    const tabId = activeTab.id;
    const serverId = activeTab.serverId;
    const items: UploadItem[] = localPaths.map((localPath) => ({
      id: crypto.randomUUID(),
      tabId,
      name: basename(localPath),
      localPath,
      remoteDir,
      serverId,
      transferred: 0,
      total: 0,
      status: "pending",
    }));
    setUploads((current) => [...current, ...items]);

    uploadChainRef.current = uploadChainRef.current.then(async () => {
      for (const item of items) {
        await runUpload(item);
      }
    });
  }

  async function runUpload(item: UploadItem) {
    let skip = false;
    setUploads((current) =>
      current.map((upload) => {
        if (upload.id !== item.id) return upload;
        if (upload.status === "canceled") {
          skip = true;
          return upload;
        }
        return { ...upload, status: "uploading" };
      }),
    );
    if (skip || uploadsRef.current.find((upload) => upload.id === item.id)?.status === "canceled") return;
    beginSftpBusy();
    try {
      await command<string>("sftp_upload", {
        id: item.serverId,
        localPath: item.localPath,
        remoteDir: item.remoteDir,
        transferId: item.id,
      });
      setUploads((current) =>
        current.map((upload) =>
          upload.id === item.id
            ? { ...upload, status: "done", transferred: upload.total || upload.transferred }
            : upload,
        ),
      );
      refreshVisibleFiles(item.tabId, item.serverId, item.remoteDir);
    } catch (error) {
      const message = String(error);
      if (message.includes("上传已停止")) {
        setUploads((current) =>
          current.map((upload) =>
            upload.id === item.id ? { ...upload, status: "canceled", error: undefined } : upload,
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
      endSftpBusy();
    }
  }

  async function stopUpload(id: string) {
    const target = uploadsRef.current.find((item) => item.id === id);
    setUploads((current) =>
      current.map((item) =>
        item.id === id && (item.status === "pending" || item.status === "uploading")
          ? { ...item, status: "canceled", error: undefined }
          : item,
      ),
    );
    if (target?.status === "uploading" && isTauri) {
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
    setDownloads((current) => [...current, ...items]);
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
        ? await command<string>("sftp_download", {
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
          tabs={tabs}
          activeTabId={activeTabId}
          filesOpen={filesOpen}
          statusOpen={statusOpen}
          historyOpen={historyOpen}
          serverCount={servers.length}
          onOpenConnections={() => setConnectionsOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleFiles={() => setFilesOpen((open) => !open)}
          onToggleStatus={toggleStatusPanel}
          onToggleHistory={toggleHistoryPanel}
          notice={notice}
          onActivate={setActiveTabId}
          onClose={closeShell}
          onCloseTabs={closeShells}
        />

        <div className={`workbench-body ${statusOpen && activeTab ? "has-status-panel" : ""}`}>
          <div className="workbench-main" ref={workbenchMainRef}>
            {/* Terminal + docked file panel. Kept mounted so xterm survives tab switches. */}
            {tabs.length > 0 && (
              <div className={`terminal-dock ${filesDragging ? "dragging" : ""}`} ref={terminalDockRef}>
                <div className="terminal-region">
                  {tabs.map((tab) => (
                    <TerminalPane
                      key={tab.id}
                      tab={tab}
                      visible={tab.id === activeTabId}
                      theme={theme}
                      fontSize={terminalFontSize}
                      layoutSignal={`${filesOpen}:${filesRatio}:${filesDragging}:${statusOpen}:${statusPanelWidth}`}
                      setNotice={showNotice}
                      onReady={() => handleTerminalReady(tab.id, tab.serverId, tab.title)}
                      onCommandSubmitted={handleCommandSubmitted}
                      pasteRequest={pasteRequest?.tabId === tab.id ? pasteRequest : null}
                      onClosed={() => {
                        terminalReadyTabs.current.delete(tab.id);
                        patchTab(tab.id, { state: "closed" });
                      }}
                      onReconnect={() => reconnectShell(tab.id)}
                    />
                  ))}
                </div>

                {activeTab && (
                  <>
                    <div
                      className={`dock-divider ${filesOpen ? "open" : ""}`}
                      onPointerDown={startDockDrag}
                      title="拖动调整比例"
                    >
                      <span className="dock-grip" />
                    </div>
                    <div
                      className={`files-region ${filesOpen ? "open" : ""}`}
                      ref={filesRegionRef}
                      style={{ "--files-panel-height": `${filesRatio * 100}%` } as CSSProperties}
                    >
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
                        onDownload={downloadFiles}
                        onMkdir={makeDir}
                        onRename={renameEntry}
                        onDelete={deleteEntries}
                        onClose={() => setFilesOpen(false)}
                      />
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
              >
                <span className="status-grip" />
              </div>
              <aside
                className={`status-panel ${statusOpen || historyOpen ? "open" : ""}`}
                style={{ "--status-panel-width": `${statusPanelWidth}px` } as CSSProperties}
              >
                {statusOpen ? (
                  <StatusDashboard
                    tab={activeTab}
                    loading={statusLoading}
                    onRefresh={() => refreshStatus()}
                  />
                ) : historyOpen ? (
                  <CommandHistoryPanel commands={commandHistory} onPick={pasteHistoryCommand} />
                ) : null}
              </aside>
            </>
          )}

          {!activeTab && (
            <div className="view-layer">
              <ServerDetail
                servers={servers}
                onConnect={openShell}
                onNew={() => editServer()}
                onOpenConnections={() => setConnectionsOpen(true)}
              />
            </div>
          )}
        </div>
      </main>

      {connectionsOpen && (
        <ConnectionManager
          grouped={grouped}
          query={query}
          setQuery={setQuery}
          groups={groups}
          activeGroup={activeGroup}
          setActiveGroup={setActiveGroup}
          selectedServerId={selectedServerId}
          onSelect={(server) => setSelectedServerId(server.id)}
          onConnect={openShell}
          onEdit={editServer}
          onNew={() => editServer()}
          onClose={() => setConnectionsOpen(false)}
          count={servers.length}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          theme={theme}
          terminalFontSize={terminalFontSize}
          onThemeChange={setTheme}
          onTerminalFontSizeChange={setTerminalFontSize}
          onClose={() => setSettingsOpen(false)}
        />
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
            <p>
              {deleteConfirm.entries.length > 1
                ? `将删除 ${deleteConfirm.entries.length} 项，文件夹及其中所有内容也会被删除。`
                : deleteConfirm.entries[0]?.isDir
                  ? "该文件夹及其中所有内容都会被删除。"
                  : "该文件会被删除。"}
            </p>
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

      {editing && (
        <ServerEditor
          form={form}
          setForm={setForm}
          saving={saving}
          onSave={saveServer}
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
    permissions: null,
    modifiedAt: null,
  };
}
