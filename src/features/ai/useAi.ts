import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { command, isTauri } from "../../api/tauri";
import { currentDirForTab } from "../sftp/paths";
import type { ShellTab } from "../shell/types";
import {
  applyAiEvent,
  defaultAiConfig,
  createConversation,
  restoreConversation,
  serverHistory,
  modelSelection,
  mergeModelSources,
  type AiConfig,
  type AiConversation,
  type AiEvent,
  type AiModel,
} from "./types";

interface ChatResult {
  messages: Record<string, unknown>[];
  stopped: boolean;
  error: string | null;
  contextTokens: number;
}

export function useAi(tabs: ShellTab[]) {
  const [config, setConfig] = useState<AiConfig>(defaultAiConfig);
  const [configError, setConfigError] = useState("");
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [configLoaded, setConfigLoaded] = useState(!isTauri);
  const [historyLoaded, setHistoryLoaded] = useState(!isTauri);
  const [historyError, setHistoryError] = useState("");
  const [activeIds, setActiveIds] = useState<Record<string, string>>({});
  const active = useRef(activeIds);
  const pendingWrites = useRef(new Map<string, AiConversation | null>());
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writing = useRef<Promise<void> | null>(null);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const modelsGeneration = useRef(0);
  const [conversations, setConversations] = useState<
    Record<string, AiConversation>
  >({});
  const current = useRef(conversations);
  const configRef = useRef(config);
  const automaticStops = useRef(new Set<string>());
  configRef.current = config;
  const availableModels = mergeModelSources(models, config.manualModels || []);

  // One serialized queue prevents an older save from reviving a deleted task.
  function removeHistory(id: string) {
    const next = { ...current.current };
    delete next[id];
    current.current = next;
    setConversations(next);
    const remaining = Object.fromEntries(
      Object.entries(active.current).filter(([, selected]) => selected !== id),
    );
    active.current = remaining;
    setActiveIds(remaining);
    setDeletingIds((ids) => ids.filter((value) => value !== id));
  }

  function flushHistory(): Promise<void> {
    if (!isTauri || !pendingWrites.current.size) return Promise.resolve();
    if (writing.current) return writing.current;
    writing.current = (async () => {
      try {
        while (pendingWrites.current.size) {
          const [id, value] = pendingWrites.current.entries().next().value!;
          if (value) await command("ai_save_history", { input: value });
          else {
            await command("ai_delete_history", { id });
            removeHistory(id);
          }
          if (pendingWrites.current.get(id) === value)
            pendingWrites.current.delete(id);
        }
        setHistoryError("");
      } catch (error) {
        setHistoryError(`历史记录保存或删除失败：${error}`);
      } finally {
        writing.current = null;
      }
    })();
    return writing.current;
  }

  function persist(id: string, value: AiConversation | null) {
    if (!isTauri) return;
    pendingWrites.current.set(id, value);
    if (!writeTimer.current)
      writeTimer.current = setTimeout(() => {
        writeTimer.current = null;
        void flushHistory();
      }, 500);
  }

  function update(
    id: string,
    change: (conversation: AiConversation) => AiConversation,
  ) {
    const previous = current.current[id];
    if (!previous || pendingWrites.current.get(id) === null) return;
    const value = { ...change(previous), updatedAt: Date.now() };
    current.current = { ...current.current, [id]: value };
    setConversations(current.current);
    if (value.entries.length) persist(id, value);
  }

  function activate(tabId: string, id: string) {
    active.current = { ...active.current, [tabId]: id };
    setActiveIds(active.current);
  }

  function newChat(tab: ShellTab) {
    if (!historyLoaded) return;
    const previous = current.current[active.current[tab.id]];
    if (previous && !previous.entries.length) return;
    const value = {
      ...createConversation(configRef.current, tab.serverId),
      ...(previous
        ? {
            model: previous.model,
            effort: previous.effort,
            manualModel: previous.manualModel,
            manualEffort: previous.manualEffort,
            permission: previous.permission,
          }
        : {}),
    };
    current.current = { ...current.current, [value.id]: value };
    setConversations(current.current);
    activate(tab.id, value.id);
  }

  async function loadHistory() {
    try {
      const saved = await command<AiConversation[]>("ai_get_history");
      current.current = Object.fromEntries(
        saved.map((value) => [value.id, restoreConversation(value)]),
      );
      setConversations(current.current);
      setHistoryLoaded(true);
      setHistoryError("");
    } catch (error) {
      setHistoryError(`历史记录读取失败：${error}`);
    }
  }

  async function deleteHistory(id: string) {
    const value = current.current[id];
    if (!value || value.requestId) return;
    if (!isTauri) {
      removeHistory(id);
      return;
    }
    setDeletingIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
    persist(id, null);
    await flushHistory();
  }

  useEffect(() => {
    if (isTauri) void loadHistory();
  }, []);

  useEffect(() => {
    if (!historyLoaded || !configLoaded) return;
    for (const tab of tabs) {
      if (!current.current[active.current[tab.id]]) {
        const last = serverHistory(current.current, tab.serverId)[0];
        if (last) activate(tab.id, last.id);
        else newChat(tab);
      }
    }
  }, [tabs, historyLoaded, configLoaded, activeIds]);

  useEffect(() => {
    if (isTauri)
      command<AiConfig>("ai_get_config")
        .then((value) => {
          setConfig(value);
          setConfigLoaded(true);
        })
        .catch((e) => setConfigError(String(e)));
    return () => {
      if (writeTimer.current) clearTimeout(writeTimer.current);
      void flushHistory();
      for (const conversation of Object.values(current.current)) {
        if (isTauri && conversation.requestId)
          void command("ai_cancel", {
            requestId: conversation.requestId,
          }).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    setModels(config.modelMetadata || []);
    setModelsError("");
    setModelsLoading(false);
    if (
      configLoaded &&
      (config.defaultModel ||
        config.hasApiKey ||
        config.baseUrl !== defaultAiConfig.baseUrl)
    )
      void refreshModels();
    return () => {
      modelsGeneration.current += 1;
    };
  }, [config, configLoaded]);

  async function refreshModels() {
    if (!isTauri) return;
    const generation = ++modelsGeneration.current;
    setModelsLoading(true);
    setModelsError("");
    try {
      const catalog = await command<AiModel[]>("ai_list_models", {
        input: null,
      });
      if (generation === modelsGeneration.current) setModels(catalog);
    } catch (error) {
      if (generation === modelsGeneration.current)
        setModelsError(String(error));
    } finally {
      if (generation === modelsGeneration.current) setModelsLoading(false);
    }
  }

  useEffect(() => {
    for (const [id, conversation] of Object.entries(current.current)) {
      const tab = tabs.find(
        (tab) =>
          tab.serverId === conversation.serverId &&
          tab.sessionId === conversation.sessionId &&
          tab.state === "connected",
      );
      if (
        conversation.requestId &&
        !conversation.stopping &&
        !automaticStops.current.has(conversation.requestId) &&
        !tab
      ) {
        automaticStops.current.add(conversation.requestId);
        void stop(id);
      }
    }
  }, [tabs, conversations]);

  async function stop(id: string) {
    const conversation = current.current[id];
    if (!conversation?.requestId || conversation.stopping) return;
    update(id, (value) => ({ ...value, stopping: true }));
    try {
      await command("ai_cancel", { requestId: conversation.requestId });
    } catch (error) {
      update(id, (value) => ({
        ...value,
        stopping: false,
        entries: [
          ...value.entries,
          {
            id: crypto.randomUUID(),
            kind: "error",
            text: `停止请求失败：${error}`,
          },
        ],
      }));
    }
  }

  async function send(tab: ShellTab) {
    const id = active.current[tab.id];
    const conversation = current.current[id];
    if (
      !conversation ||
      !historyLoaded ||
      pendingWrites.current.get(id) === null
    )
      return;
    const selection = modelSelection(
      availableModels,
      conversation.model,
      conversation.effort,
      configRef.current.defaultModel,
      conversation.manualModel,
      conversation.manualEffort,
    );
    const text = conversation.draft.trim();
    if (
      !text ||
      Object.values(current.current).some(
        (value) => value.serverId === tab.serverId && value.requestId,
      ) ||
      tab.state !== "connected" ||
      !selection.model ||
      (modelsLoading && !selection.manualModel)
    )
      return;
    if (!isTauri) {
      update(id, (value) => ({
        ...value,
        entries: [
          ...value.entries,
          {
            id: crypto.randomUUID(),
            kind: "notice",
            text: "请在桌面客户端连接服务器后使用 AI，浏览器预览不会执行命令。",
          },
        ],
      }));
      return;
    }
    const requestId = crypto.randomUUID();
    const messages = [
      ...conversation.messages,
      { role: "user", content: text },
    ];
    update(id, (value) => ({
      ...value,
      draft: "",
      model: selection.model,
      effort: selection.effort,
      manualModel: selection.manualModel,
      manualEffort: selection.manualEffort,
      messages,
      requestId,
      stopping: false,
      sessionId: tab.sessionId,
      entries: [
        ...value.entries,
        { id: crypto.randomUUID(), kind: "user", text },
      ],
    }));
    void flushHistory();
    let assistantId = crypto.randomUUID();
    let compactionId = crypto.randomUUID();
    const onEvent = new Channel<AiEvent>();
    onEvent.onmessage = (event) => {
      if (current.current[id]?.requestId !== requestId) return;
      if (event.type === "compaction_start") {
        compactionId = crypto.randomUUID();
        update(id, (value) => ({
          ...value,
          compacting: true,
          contextTokens: event.beforeTokens || value.contextTokens,
          entries: [
            ...value.entries,
            {
              id: compactionId,
              kind: "notice",
              text: "上下文正在自动压缩，保留任务目标、关键结果与近期消息…",
            },
          ],
        }));
      } else if (event.type === "compaction_end") {
        update(id, (value) => ({
          ...value,
          compacting: false,
          contextTokens: event.afterTokens || 0,
          entries: value.entries.map((entry) =>
            entry.id === compactionId
              ? {
                  ...entry,
                  text: `已自动压缩上下文：约 ${Math.round((event.beforeTokens || 0) / 1000)}k → ${Math.round((event.afterTokens || 0) / 1000)}k tokens。聊天记录仍可查看。`,
                }
              : entry,
          ),
        }));
      } else if (event.type === "round") assistantId = crypto.randomUUID();
      else
        update(id, (value) => ({
          ...value,
          entries: applyAiEvent(value.entries, event, assistantId),
        }));
    };
    try {
      const result = await command<ChatResult>("ai_chat", {
        input: {
          requestId,
          serverId: tab.serverId,
          sessionId: tab.sessionId,
          model: selection.model,
          effort: selection.effort,
          manualModel: selection.manualModel,
          manualEffort: selection.manualEffort,
          permission: conversation.permission,
          cwd: currentDirForTab(tab),
          messages,
        },
        onEvent,
      });
      update(id, (value) => ({
        ...value,
        messages: result.messages,
        contextTokens: result.contextTokens ?? value.contextTokens,
        entries: [
          ...value.entries,
          ...(result.stopped
            ? [
                {
                  id: crypto.randomUUID(),
                  kind: "notice" as const,
                  text: "已停止。已完成的操作会保留，可继续对话。",
                },
              ]
            : []),
          ...(result.error
            ? [
                {
                  id: crypto.randomUUID(),
                  kind: "error" as const,
                  text: result.error,
                },
              ]
            : []),
        ],
      }));
    } catch (error) {
      update(id, (value) => ({
        ...value,
        entries: [
          ...value.entries,
          { id: crypto.randomUUID(), kind: "error", text: String(error) },
        ],
      }));
    } finally {
      automaticStops.current.delete(requestId);
      update(id, (value) => ({
        ...value,
        requestId: null,
        stopping: false,
        compacting: false,
        entries: value.entries.map((entry) => ({
          ...entry,
          ...(value.compacting && entry.id === compactionId
            ? { text: "本次压缩未完成，原上下文已保留。" }
            : {}),
          running: false,
          approvalPending: false,
        })),
      }));
      void flushHistory();
    }
  }

  async function approve(id: string, entryId: string, allow: boolean) {
    const conversation = current.current[id];
    const entry = conversation?.entries.find((entry) => entry.id === entryId);
    if (
      !conversation?.requestId ||
      !entry?.approvalPending ||
      entry.approvalBusy
    )
      return;
    const patch = (change: Partial<typeof entry>) =>
      update(id, (value) => ({
        ...value,
        entries: value.entries.map((item) =>
          item.id === entryId ? { ...item, ...change } : item,
        ),
      }));
    patch({ approvalBusy: true, approvalError: "" });
    try {
      await command("ai_approve", {
        requestId: conversation.requestId,
        approvalId: entry.approvalId,
        allow,
      });
      update(id, (value) => ({
        ...value,
        entries: value.entries.map((item) =>
          item.id === entryId
            ? {
                ...item,
                approvalPending: false,
                approvalBusy: false,
                approved: allow,
                running:
                  allow &&
                  item.result?.status !== "done" &&
                  Boolean(value.requestId),
              }
            : item,
        ),
      }));
    } catch (error) {
      patch({ approvalBusy: false, approvalError: String(error) });
    }
  }
  return {
    config,
    configError,
    models: availableModels,
    modelsLoading,
    modelsError,
    refreshModels,
    setConfig: (value: AiConfig) => {
      setConfig(value);
      setConfigLoaded(true);
      setConfigError("");
    },
    conversations: Object.fromEntries(
      tabs.map((tab) => [tab.id, conversations[activeIds[tab.id]]]),
    ),
    history: conversations,
    historyLoaded,
    historyError,
    deletingIds,
    retryHistory: () => (historyLoaded ? flushHistory() : loadHistory()),
    serverBusy: (serverId: string) =>
      Object.values(conversations).some(
        (value) => value.serverId === serverId && value.requestId,
      ),
    selectHistory: (tab: ShellTab, id: string) => {
      if (current.current[id]?.serverId === tab.serverId) activate(tab.id, id);
    },
    deleteHistory,
    newChat,
    update: (
      tabId: string,
      change: (value: AiConversation) => AiConversation,
    ) => update(active.current[tabId], change),
    send,
    stop: (tabId: string) => stop(active.current[tabId]),
    approve: (tabId: string, entryId: string, allow: boolean) =>
      approve(active.current[tabId], entryId, allow),
  };
}
export type AiController = ReturnType<typeof useAi>;
