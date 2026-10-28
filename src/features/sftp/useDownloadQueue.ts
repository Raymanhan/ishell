import { useEffect, useRef, useState } from "react";
import { command, isTauri } from "../../api/tauri";
import { simulateDemoDownload } from "../../mocks/demoSftp";
import type {
  DownloadItem,
  DownloadProgressPayload,
  FolderDownloadMode,
  SftpEntry,
} from "../../types";

/** Where queued downloads come from: a terminal tab and its server. */
export interface DownloadSource {
  tabId: string;
  serverId: string;
}

/** The download queue. Items run one at a time, newest shown first. */
export function useDownloadQueue({
  showNotice,
  beginBusy,
  endBusy,
}: {
  showNotice: (message: string) => void;
  beginBusy: () => void;
  endBusy: () => void;
}) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const downloadsRef = useRef<DownloadItem[]>([]);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  downloadsRef.current = downloads;

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

  function enqueueFiles(source: DownloadSource, entries: SftpEntry[]) {
    const files = entries.filter((entry) => !entry.isDir);
    if (files.length === 0) return;
    const items: DownloadItem[] = files.map((entry) => ({
      id: crypto.randomUUID(),
      tabId: source.tabId,
      name: entry.name,
      remotePath: entry.path,
      serverId: source.serverId,
      transferred: 0,
      total: entry.size ?? 0,
      status: "pending",
    }));
    setDownloads((current) => [...items, ...current]);
    showNotice(`已加入下载队列：${items.length} 个文件`);

    chainRef.current = chainRef.current.then(async () => {
      for (const item of items) {
        await run(item);
      }
    });
  }

  function enqueueFolder(source: DownloadSource, entry: SftpEntry, mode: FolderDownloadMode) {
    if (!entry.isDir) return;
    const item: DownloadItem = {
      id: crypto.randomUUID(),
      tabId: source.tabId,
      name: mode === "archive" ? `${entry.name}.tar.gz` : entry.name,
      remotePath: entry.path,
      serverId: source.serverId,
      transferred: 0,
      total: 0,
      status: "pending",
      folderMode: mode,
    };
    setDownloads((current) => [item, ...current]);
    showNotice(`已加入下载队列：${entry.name}`);

    chainRef.current = chainRef.current.then(async () => {
      await run(item);
    });
  }

  async function run(item: DownloadItem) {
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

    beginBusy();
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
      endBusy();
    }
  }

  async function stop(id: string) {
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

  function dismiss(id: string) {
    setDownloads((current) => current.filter((item) => item.id !== id));
  }

  function clearDone() {
    setDownloads((current) =>
      current.filter((item) => item.status !== "done" && item.status !== "error" && item.status !== "canceled"),
    );
  }

  return { downloads, enqueueFiles, enqueueFolder, stop, dismiss, clearDone };
}
