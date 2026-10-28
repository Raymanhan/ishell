import { useEffect } from "react";
import { isTauri } from "../../api/tauri";
import { readSavedTheme } from "../../constants/theme";
import type { ShellTab } from "./types";

export interface TabDropPoint {
  screenX: number;
  screenY: number;
}

export interface TabGhostPayload {
  title: string;
  subtitle: string;
  color: string;
  width: number;
}

export function readTabGhostFromUrl() {
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

export function TabGhostWindow({ ghost }: { ghost: TabGhostPayload }) {
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

export function readHandedOffTabFromUrl() {
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

export function normalizeHandedOffTab(tab: Partial<ShellTab>) {
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

export function handoffTabSnapshot(tab: ShellTab): ShellTab {
  return {
    ...tab,
    files: [],
    selectedPath: null,
    selectedPaths: [],
    cache: {},
  };
}

export async function peerWindowAtPoint(point: TabDropPoint) {
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

export async function closeCurrentWindowIfPeerExists() {
  const { getAllWebviewWindows, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  const windows = await getAllWebviewWindows();
  if (windows.some((windowRef) => windowRef.label !== current.label)) {
    await current.close();
  }
}
