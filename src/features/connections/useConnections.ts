import { useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { command, isTauri } from "../../api/tauri";
import type { ConnectionMoveRequest } from "../../components/ConnectionManager";
import type { ServerForm } from "../../components/ServerEditor";
import { swatches } from "../../constants/theme";
import { demoServers } from "../../mocks/demoData";
import type { ServerInput, ServerRecord } from "../../types";
import {
  canMoveConnectionNode,
  defaultForm,
  ensureFolder,
  groupServersForTree,
  moveConnectionFolders,
  moveConnectionServers,
  orderedConnectionFolders,
  serverInputFromForm,
  serverInputFromRecord,
  type ConnectionDeleteConfirmState,
} from "./tree";

const CONNECTION_FOLDERS_KEY = "ishell.connectionFolders";

interface ConnectionImportPayload {
  folders: string[];
  servers: Array<ServerInput & { password?: string | null }>;
}

export interface ConnectionTestFeedback {
  kind: "info" | "success" | "error";
  message: string;
}

/**
 * Saved servers and connection folders: loading, the server editor, renames,
 * drag-and-drop ordering, import/export and deletion. Open terminal tabs are
 * owned by the caller, which is told about renamed and deleted servers.
 */
export function useConnections({
  showNotice,
  onServerRenamed,
  onServersDeleted,
}: {
  showNotice: (message: string) => void;
  onServerRenamed: (serverId: string, name: string) => void;
  onServersDeleted: (serverIds: Set<string>) => void;
}) {
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
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ServerForm>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestFeedback, setConnectionTestFeedback] = useState<ConnectionTestFeedback | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ConnectionDeleteConfirmState | null>(null);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? null,
    [selectedServerId, servers],
  );
  const connectionFolderNames = useMemo(
    () => orderedConnectionFolders(connectionFolders, servers),
    [connectionFolders, servers],
  );
  const grouped = useMemo(
    () => groupServersForTree(servers, connectionFolderNames),
    [connectionFolderNames, servers],
  );

  useEffect(() => {
    window.localStorage.setItem(CONNECTION_FOLDERS_KEY, JSON.stringify(connectionFolders));
  }, [connectionFolders]);

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
    onServerRenamed(server.id, name);

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
    setDeleteConfirm({ target, servers: targets });
  }

  async function confirmDeleteConnections() {
    if (!deleteConfirm || deleteConfirm.busy) return;
    const { target } = deleteConfirm;
    const folderSet = new Set(target.folders);
    const idSet = new Set(target.serverIds);
    const targets = servers.filter((server) => idSet.has(server.id) || folderSet.has(server.group || "Default"));
    if (targets.length === 0 && target.folders.length === 0) {
      setDeleteConfirm(null);
      return;
    }

    setDeleteConfirm((current) => (current ? { ...current, busy: true, error: undefined } : current));
    try {
      if (isTauri) {
        for (const server of targets) {
          await command("delete_server", { id: server.id });
        }
      }
      const deleteIds = new Set(targets.map((server) => server.id));
      setServers((current) => current.filter((server) => !deleteIds.has(server.id)));
      onServersDeleted(deleteIds);
      setConnectionFolders((current) => current.filter((folder) => !folderSet.has(folder)));
      setSelectedServerId((current) => (current && deleteIds.has(current) ? null : current));
      setDeleteConfirm(null);
      showNotice(target.folders.length > 0 ? "已删除文件夹" : "已删除");
    } catch (error) {
      const message = String(error);
      showNotice(message);
      setDeleteConfirm((current) =>
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

  /** Delete the server currently open in the editor. */
  async function deleteEditedServer() {
    const server = servers.find((item) => item.id === form.id);
    if (!server) return;
    if (!window.confirm(`确定删除「${server.name}」吗？`)) return;
    try {
      if (isTauri) await command("delete_server", { id: server.id });
      setServers((current) => current.filter((item) => item.id !== server.id));
      onServersDeleted(new Set([server.id]));
      setSelectedServerId((current) => (current === server.id ? null : current));
      setEditing(false);
      showNotice("已删除");
    } catch (error) {
      showNotice(String(error));
    }
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

  function updateForm(next: ServerForm) {
    setConnectionTestFeedback(null);
    setForm(next);
  }

  return {
    servers,
    selectedServer,
    setSelectedServerId,
    grouped,
    refreshServers,
    createConnectionFolder,
    renameServer,
    renameConnectionFolder,
    moveConnectionNode,
    exportConnections,
    importConnections,
    deleteConfirm,
    requestDeleteConnections,
    confirmDeleteConnections,
    cancelDeleteConnections: () => setDeleteConfirm(null),
    editor: {
      open: editing,
      form,
      saving,
      testing: testingConnection,
      testFeedback: connectionTestFeedback,
      setForm: updateForm,
      close: () => setEditing(false),
      save: saveServer,
      test: testServerConnection,
      deleteServer: deleteEditedServer,
    },
    newServer,
    editServer,
    cloneServer,
  };
}
