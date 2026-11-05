import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { command, isTauri } from "../../api/tauri";
import { currentDirForTab } from "../sftp/paths";
import type { ShellTab } from "../shell/types";
import {
  applyAiEvent,
  defaultAiConfig,
  emptyConversation,
  type AiConfig,
  type AiConversation,
  type AiEvent,
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
  const [conversations, setConversations] = useState<
    Record<string, AiConversation>
  >({});
  const current = useRef(conversations);
  const configRef = useRef(config);
  const automaticStops = useRef(new Set<string>());
  configRef.current = config;

  function update(
    id: string,
    change: (conversation: AiConversation) => AiConversation,
  ) {
    const value = change(
      current.current[id] || emptyConversation(configRef.current),
    );
    current.current = { ...current.current, [id]: value };
    setConversations(current.current);
  }

  useEffect(() => {
    if (isTauri)
      command<AiConfig>("ai_get_config")
        .then(setConfig)
        .catch((e) => setConfigError(String(e)));
    return () => {
      for (const conversation of Object.values(current.current)) {
        if (isTauri && conversation.requestId)
          void command("ai_cancel", {
            requestId: conversation.requestId,
          }).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    for (const [id, conversation] of Object.entries(current.current)) {
      const tab = tabs.find((tab) => tab.id === id);
      if (
        conversation.requestId &&
        !conversation.stopping &&
        !automaticStops.current.has(conversation.requestId) &&
        (!tab ||
          tab.state !== "connected" ||
          tab.sessionId !== conversation.sessionId)
      ) {
        automaticStops.current.add(conversation.requestId);
        void stop(id);
      }
      if (!tab && !conversation.requestId) {
        const next = { ...current.current };
        delete next[id];
        current.current = next;
        setConversations(next);
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
    const conversation =
      current.current[tab.id] || emptyConversation(configRef.current);
    const text = conversation.draft.trim();
    if (
      !text ||
      conversation.requestId ||
      tab.state !== "connected" ||
      !conversation.model
    )
      return;
    if (!isTauri) {
      update(tab.id, (value) => ({
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
    update(tab.id, (value) => ({
      ...value,
      draft: "",
      messages,
      requestId,
      stopping: false,
      sessionId: tab.sessionId,
      entries: [
        ...value.entries,
        { id: crypto.randomUUID(), kind: "user", text },
      ],
    }));
    let assistantId = crypto.randomUUID();
    let compactionId = crypto.randomUUID();
    const onEvent = new Channel<AiEvent>();
    onEvent.onmessage = (event) => {
      if (current.current[tab.id]?.requestId !== requestId) return;
      if (event.type === "compaction_start") {
        compactionId = crypto.randomUUID();
        update(tab.id, (value) => ({
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
        update(tab.id, (value) => ({
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
        update(tab.id, (value) => ({
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
          model: conversation.model,
          effort: conversation.effort,
          permission: conversation.permission,
          cwd: currentDirForTab(tab),
          messages,
        },
        onEvent,
      });
      update(tab.id, (value) => ({
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
      update(tab.id, (value) => ({
        ...value,
        entries: [
          ...value.entries,
          { id: crypto.randomUUID(), kind: "error", text: String(error) },
        ],
      }));
    } finally {
      automaticStops.current.delete(requestId);
      update(tab.id, (value) => ({
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
    }
  }

  function clear(id: string) {
    if (current.current[id]?.requestId) return;
    update(id, (value) => ({
      ...emptyConversation(configRef.current),
      model: value.model,
      effort: value.effort,
      permission: value.permission,
    }));
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
    setConfig: (value: AiConfig) => {
      setConfig(value);
      setConfigError("");
    },
    conversations,
    update,
    send,
    stop,
    clear,
    approve,
  };
}
export type AiController = ReturnType<typeof useAi>;
