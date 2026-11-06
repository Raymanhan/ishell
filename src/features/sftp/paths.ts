import type { ShellTab } from "../shell/types";
import type { FileColumn, SftpEntry, UploadItem } from "../../types";

import { t } from "../../i18n";
export const FOLDER_UPLOAD_CONFLICT_MARKER = "__ISHELL_UPLOAD_FOLDER_CONFLICT__";

export function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function currentDirForTab(tab: ShellTab) {
  return tab.files.length ? tab.files[tab.files.length - 1].path : "/";
}

export function resolveKnownUploadDirectory(tab: ShellTab, requestedPath: string) {
  if (requestedPath === "/" || currentDirForTab(tab) === requestedPath) return requestedPath;
  if (Object.prototype.hasOwnProperty.call(tab.cache, requestedPath)) return requestedPath;
  return tab.files.some((column) =>
    column.entries.some((entry) => entry.isDir && entry.path === requestedPath)
  )
    ? requestedPath
    : null;
}

export function isFolderUploadConflict(message: string) {
  return message.includes(FOLDER_UPLOAD_CONFLICT_MARKER);
}

export function uploadRemotePath(item: UploadItem) {
  const remoteDir = item.remoteDir.replace(/\/+$/, "") || "/";
  return remoteDir === "/" ? `/${item.name}` : `${remoteDir}/${item.name}`;
}

export function parentPath(path: string) {
  const normalized = path.replace(/\/+/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

export function buildPathChain(path: string) {
  const parts = path.split("/").filter(Boolean);
  const chain = ["/"];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    chain.push(acc);
  }
  return chain;
}

export function sftpDeleteDescription(entries: SftpEntry[]) {
  if (entries.length > 1) {
    const hasRealDirectory = entries.some((entry) => entry.isDir && !entry.isSymlink);
    const hasSymlink = entries.some((entry) => entry.isSymlink);
    return hasRealDirectory
      ? t("将删除 {0} 项，文件夹及其中所有内容也会被删除。", entries.length)
      : hasSymlink
        ? t("将删除 {0} 项。软链接只会删除链接本身。", entries.length)
        : t("将删除 {0} 项。", entries.length);
  }
  const entry = entries[0];
  if (!entry) return t("该项目会被删除。");
  if (entry.isSymlink) return t("该软链接会被删除，链接目标会保留。");
  if (entry.isDir) return t("该文件夹及其中所有内容都会被删除。");
  return t("该文件会被删除。");
}

export function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildPathColumns(pathChain: string[], cache: Record<string, SftpEntry[]>): FileColumn[] {
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

export function ensureTrailEntry(entries: SftpEntry[], nextPath: string) {
  if (entries.some((entry) => entry.path === nextPath)) return entries;
  return [entryForPath(nextPath), ...entries];
}

export function sortEntries(entries: SftpEntry[]) {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function entryForPath(path: string): SftpEntry {
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
