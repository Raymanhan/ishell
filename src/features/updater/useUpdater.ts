import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../../api/tauri";

export const AUTO_CHECK_UPDATES_KEY = "ishell.autoCheckUpdates";
/** Browser demo only: set to a version (e.g. "9.9.9") to simulate an available update. */
const DEMO_UPDATE_KEY = "ishell.demoUpdate";

const FIRST_CHECK_DELAY_MS = 5_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
}

export interface UpdaterState {
  status: UpdaterStatus;
  currentVersion: string | null;
  update: AvailableUpdate | null;
  /** Bytes downloaded so far and the total size when the server reports it. */
  progress: { downloaded: number; total: number | null } | null;
  error: string | null;
  /** The update prompt was closed with "later"; settings can reopen it. */
  dismissed: boolean;
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** What the hook needs from an updater; the Tauri plugin in the app, a fake in the browser demo. */
interface PendingUpdate extends AvailableUpdate {
  downloadAndInstall(onEvent: (event: DownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}

interface UpdaterBackend {
  currentVersion(): Promise<string>;
  check(): Promise<PendingUpdate | null>;
  relaunch(): Promise<void>;
}

const tauriBackend: UpdaterBackend = {
  async currentVersion() {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
  async check() {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 30_000 });
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body,
      date: update.date,
      downloadAndInstall: (onEvent) => update.downloadAndInstall(onEvent),
      close: () => update.close(),
    };
  },
  async relaunch() {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};

const demoBackend: UpdaterBackend = {
  async currentVersion() {
    return __APP_VERSION__;
  },
  async check() {
    await sleep(600);
    const version = window.localStorage.getItem(DEMO_UPDATE_KEY);
    if (!version) return null;
    return {
      version,
      currentVersion: __APP_VERSION__,
      notes: "· 演示用的更新说明\n· 浏览器预览中不会真正下载或安装",
      date: new Date().toISOString(),
      async downloadAndInstall(onEvent) {
        const total = 6 * 1024 * 1024;
        onEvent({ event: "Started", data: { contentLength: total } });
        for (let sent = 0; sent < total; sent += 512 * 1024) {
          await sleep(120);
          onEvent({ event: "Progress", data: { chunkLength: 512 * 1024 } });
        }
        onEvent({ event: "Finished" });
      },
      async close() {},
    };
  },
  async relaunch() {
    window.location.reload();
  },
};

const backend = isTauri ? tauriBackend : demoBackend;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message || "未知错误";
}

export function readAutoCheckUpdates() {
  return window.localStorage.getItem(AUTO_CHECK_UPDATES_KEY) !== "false";
}

export function useUpdater(autoCheck: boolean) {
  const [state, setState] = useState<UpdaterState>({
    status: "idle",
    currentVersion: null,
    update: null,
    progress: null,
    error: null,
    dismissed: false,
  });
  const pendingRef = useRef<PendingUpdate | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    backend
      .currentVersion()
      .then((version) => {
        if (!cancelled) setState((current) => ({ ...current, currentVersion: version }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Looks for a newer release. A silent check (automatic, in the background) keeps
   * failures out of the UI and does not reopen a prompt the user dismissed.
   */
  const checkForUpdate = useCallback(async ({ silent }: { silent: boolean }) => {
    if (busyRef.current) return;
    busyRef.current = true;
    // A background re-check must not hide a prompt that is already showing.
    setState((current) =>
      silent && current.update ? current : { ...current, status: "checking", error: null },
    );
    try {
      const found = await backend.check();
      const previous = pendingRef.current;
      pendingRef.current = found;
      if (previous && previous !== found) await previous.close().catch(() => undefined);
      setState((current) => {
        if (!found) return { ...current, status: "up-to-date", update: null, dismissed: false };
        const sameAsBefore = current.update?.version === found.version;
        return {
          ...current,
          status: "available",
          update: {
            version: found.version,
            currentVersion: found.currentVersion,
            notes: found.notes,
            date: found.date,
          },
          dismissed: silent && sameAsBefore ? current.dismissed : false,
        };
      });
    } catch (error) {
      setState((current) =>
        silent
          ? { ...current, status: current.update ? "available" : "idle" }
          : { ...current, status: "error", error: `检查更新失败：${describeError(error)}` },
      );
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** Downloads and installs the pending update, then restarts the app. */
  const installUpdate = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending || busyRef.current) return;
    busyRef.current = true;
    setState((current) => ({
      ...current,
      status: "downloading",
      progress: { downloaded: 0, total: null },
      error: null,
      dismissed: false,
    }));
    try {
      let downloaded = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          const total = event.data.contentLength ?? null;
          setState((current) => ({ ...current, progress: { downloaded: 0, total } }));
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setState((current) => ({
            ...current,
            progress: { downloaded, total: current.progress?.total ?? null },
          }));
        } else {
          setState((current) => ({ ...current, status: "installing" }));
        }
      });
      setState((current) => ({ ...current, status: "installing" }));
      await backend.relaunch();
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "error",
        progress: null,
        error: `更新失败：${describeError(error)}`,
      }));
    } finally {
      busyRef.current = false;
    }
  }, []);

  const dismiss = useCallback(() => {
    setState((current) => ({
      ...current,
      dismissed: true,
      status: current.status === "error" && current.update ? "available" : current.status,
      error: current.status === "error" ? null : current.error,
    }));
  }, []);

  const reopen = useCallback(() => {
    setState((current) => ({ ...current, dismissed: false }));
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    const first = window.setTimeout(() => void checkForUpdate({ silent: true }), FIRST_CHECK_DELAY_MS);
    const periodic = window.setInterval(() => void checkForUpdate({ silent: true }), RECHECK_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(periodic);
    };
  }, [autoCheck, checkForUpdate]);

  return { state, checkForUpdate, installUpdate, dismiss, reopen };
}
