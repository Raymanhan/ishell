import { useEffect, useRef, useState } from "react";
import { command, isTauri } from "../../api/tauri";
import type { UploadItem, UploadProgressPayload } from "../../types";
import { basename, isFolderUploadConflict } from "./paths";

export interface UploadTargetContext {
  tabId: string;
  serverId: string;
  remoteDir: string;
}

interface PendingFolderReplacement {
  item: UploadItem;
  resolve: (replace: boolean) => void;
}

/**
 * The upload queue. Items run one at a time so bulk transfers do not compete
 * with each other. When a folder upload hits an existing remote folder, the
 * queue pauses on `folderReplaceConfirm` until the user answers.
 */
export function useUploadQueue({
  showNotice,
  beginBusy,
  endBusy,
  onUploaded,
}: {
  showNotice: (message: string) => void;
  beginBusy: () => void;
  endBusy: () => void;
  onUploaded: (item: UploadItem) => void;
}) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [folderReplaceConfirm, setFolderReplaceConfirm] = useState<{ item: UploadItem } | null>(null);
  const pendingFolderReplaceRef = useRef<PendingFolderReplacement | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const scheduledIdsRef = useRef<Set<string>>(new Set());
  const canceledIdsRef = useRef<Set<string>>(new Set());
  const inFlightIdsRef = useRef<Set<string>>(new Set());

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

  useEffect(() => {
    return () => {
      const pendingConfirmation = pendingFolderReplaceRef.current;
      pendingFolderReplaceRef.current = null;
      pendingConfirmation?.resolve(false);
    };
  }, []);

  function enqueue(localPaths: string[], target: UploadTargetContext) {
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
    items.forEach((item) => scheduledIdsRef.current.add(item.id));
    setUploads((current) => [...items, ...current]);

    chainRef.current = chainRef.current.then(async () => {
      for (const item of items) {
        await run(item);
      }
    });
  }

  async function run(item: UploadItem, replaceExistingFolder = false) {
    if (canceledIdsRef.current.has(item.id)) {
      scheduledIdsRef.current.delete(item.id);
      canceledIdsRef.current.delete(item.id);
      return;
    }
    setUploads((current) =>
      current.map((upload) =>
        upload.id === item.id
          ? { ...upload, status: "uploading", transferred: 0, error: undefined }
          : upload,
      ),
    );
    beginBusy();
    inFlightIdsRef.current.add(item.id);
    try {
      if (canceledIdsRef.current.has(item.id)) return;
      await command<string>("sftp_upload", {
        id: item.serverId,
        localPath: item.localPath,
        remoteDir: item.remoteDir,
        transferId: item.id,
        replaceExistingFolder,
      });
      inFlightIdsRef.current.delete(item.id);
      // A successful command result is authoritative: cancellation may have
      // raced with the remote commit after it was already too late to stop.
      canceledIdsRef.current.delete(item.id);
      setUploads((current) =>
        current.map((upload) =>
          upload.id === item.id
            ? { ...upload, status: "done", transferred: upload.total || upload.transferred }
            : upload,
        ),
      );
      onUploaded(item);
    } catch (error) {
      inFlightIdsRef.current.delete(item.id);
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
        if (canceledIdsRef.current.has(item.id)) {
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
        const replace = await requestFolderReplacement(item);
        if (canceledIdsRef.current.has(item.id)) return;
        // Keep this attempt's finally block pending until the replacement
        // attempt finishes, otherwise it would clear the shared in-flight
        // cancellation guards while the retry is still running.
        if (replace) return await run(item, true);
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
      inFlightIdsRef.current.delete(item.id);
      scheduledIdsRef.current.delete(item.id);
      canceledIdsRef.current.delete(item.id);
      endBusy();
    }
  }

  function requestFolderReplacement(item: UploadItem) {
    if (pendingFolderReplaceRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      pendingFolderReplaceRef.current = { item, resolve };
      setFolderReplaceConfirm({ item });
    });
  }

  function resolveFolderReplacement(replace: boolean, expectedItemId?: string) {
    const pendingConfirmation = pendingFolderReplaceRef.current;
    if (!pendingConfirmation || (expectedItemId && pendingConfirmation.item.id !== expectedItemId)) return;
    pendingFolderReplaceRef.current = null;
    setFolderReplaceConfirm(null);
    pendingConfirmation.resolve(replace);
  }

  /** Answer "no" to a pending replace question, if it belongs to one of `tabIds` (or any tab). */
  function declineFolderReplacement(tabIds?: Set<string>) {
    const pending = pendingFolderReplaceRef.current;
    if (pending && (!tabIds || tabIds.has(pending.item.tabId))) resolveFolderReplacement(false);
  }

  async function stop(id: string) {
    const isScheduled = scheduledIdsRef.current.has(id);
    const isInFlight = inFlightIdsRef.current.has(id);
    if (isScheduled) canceledIdsRef.current.add(id);
    if (pendingFolderReplaceRef.current?.item.id === id) {
      resolveFolderReplacement(false);
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

  function dismiss(id: string) {
    setUploads((current) => current.filter((item) => item.id !== id));
  }

  function clearDone() {
    setUploads((current) =>
      current.filter((item) => item.status !== "done" && item.status !== "error" && item.status !== "canceled"),
    );
  }

  return {
    uploads,
    folderReplaceConfirm,
    enqueue,
    stop,
    dismiss,
    clearDone,
    resolveFolderReplacement,
    declineFolderReplacement,
  };
}
