import type { ConnectionMoveRequest } from "../../components/ConnectionManager";
import type { ServerForm } from "../../components/ServerEditor";
import { swatches } from "../../constants/theme";
import type { AuthType, ServerInput, ServerRecord } from "../../types";
import { groupServers } from "../../utils/servers";

export const defaultForm: ServerForm = {
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

export interface ConnectionDeleteConfirmState {
  target: { serverIds: string[]; folders: string[] };
  servers: ServerRecord[];
  busy?: boolean;
  error?: string;
}

export function serverInputFromForm(form: ServerForm): ServerInput {
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

export function serverInputFromRecord(server: ServerRecord): ServerInput {
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

export function ensureFolder(current: string[], folder: string) {
  const name = folder.trim() || "Default";
  if (current.some((item) => item.toLowerCase() === name.toLowerCase())) return current;
  return [...current, name].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function orderedConnectionFolders(savedFolders: string[], servers: ServerRecord[]) {
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

export function canMoveConnectionNode(request: ConnectionMoveRequest) {
  if (request.draggedKey === request.targetKey) return false;
  if (request.draggedKey.startsWith("folder:") && request.position === "inside") return false;
  if (request.draggedKey.startsWith("folder:") && request.targetKey.startsWith("server:")) return false;
  return true;
}

export function moveConnectionFolders(folders: string[], request: ConnectionMoveRequest) {
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

export function moveConnectionServers(
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

export function flattenServersByFolders(servers: ServerRecord[], folders: string[]) {
  const byGroup = groupServers(servers);
  return folders.flatMap((folder) => byGroup[folder] ?? []);
}

export function targetGroupForConnectionMove(request: ConnectionMoveRequest, servers: ServerRecord[]) {
  if (request.targetKey.startsWith("folder:")) return request.targetKey.slice("folder:".length);
  const targetId = request.targetKey.startsWith("server:") ? request.targetKey.slice("server:".length) : "";
  return servers.find((server) => server.id === targetId)?.group || null;
}

export function insertionIndexForConnectionMove(
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

export function sameServerOrder(previous: ServerRecord[], next: ServerRecord[]) {
  if (previous.length !== next.length) return false;
  return previous.every((server, index) =>
    server.id === next[index]?.id &&
    server.group === next[index]?.group &&
    server.sortOrder === next[index]?.sortOrder
  );
}

export function connectionDeleteDescription(state: ConnectionDeleteConfirmState) {
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

export function connectionDeleteTargetText(state: ConnectionDeleteConfirmState) {
  const folders = state.target.folders.map((folder) => `文件夹：${folder}`);
  const servers = state.target.folders.length > 0
    ? []
    : state.servers.map((server) => server.name);
  return [...folders, ...servers].join("、") || "所选连接";
}

export function groupServersForTree(
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
