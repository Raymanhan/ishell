import { msg, t } from "../../i18n";

export interface AiConfig {
  baseUrl: string;
  models: string[];
  manualModels: string[];
  modelMetadata: AiModel[];
  metadataError?: string | null;
  defaultModel: string;
  hasApiKey: boolean;
  defaultPermission: AiPermission;
}
export interface AiConfigInput {
  baseUrl: string;
  models: string[];
  manualModels: string[];
  defaultModel: string;
  apiKey: string | null;
  defaultPermission: AiPermission;
}
export type AiEffort = string;
export interface AiModel {
  id: string;
  name: string;
  reasoningEfforts: { value: string; label: string; description: string }[];
  defaultReasoningEffort: string | null;
  /** Declared context window in tokens, when the service reports one. */
  contextWindow?: number | null;
  manual?: boolean;
}
/** Used when the model metadata declares no context window. */
export const DEFAULT_COMPACTION_THRESHOLD = 200_000;
/** Mirrors `context::Budget::for_window` in the desktop backend. */
export function compactionThreshold(contextWindow?: number | null): number {
  if (!contextWindow || contextWindow <= 0) return DEFAULT_COMPACTION_THRESHOLD;
  return Math.max(8_000, Math.floor((contextWindow * 3) / 4));
}
/** Saving re-encrypts the whole conversation; batch more while a task streams. */
export function historyWriteDelay(running: boolean): number {
  return running ? 2000 : 500;
}
export function mergeModelSources(
  models: AiModel[],
  manualIds: string[] = [],
): AiModel[] {
  const merged = models.map((model) =>
    manualIds.includes(model.id) ? { ...model, manual: true } : model,
  );
  for (const id of manualIds)
    if (id && !merged.some((model) => model.id === id))
      merged.push({
        id,
        name: t("{0}（手动）", id),
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        manual: true,
      });
  return merged;
}
export type AiPermission = "suggest" | "ask" | "auto" | "full";
export const permissionOptions: {
  value: AiPermission;
  label: string;
  description: string;
}[] = (
  [
    ["suggest", msg("仅建议"), msg("只生成操作建议，不执行服务器工具")],
    ["ask", msg("执行前确认"), msg("每次工具调用都需要确认")],
    [
      "auto",
      msg("自动 · 低风险"),
      msg("只读操作自动执行；写入文件、修改服务器、运行代码或读取凭证前需确认"),
    ],
    ["full", msg("完全访问"), msg("自动执行任务中的所有工具操作，不再逐项确认")],
  ] as const
).map(([value, label, description]) => ({
  value,
  // Getters translate on every read, so the list follows language changes.
  get label() {
    return t(label);
  },
  get description() {
    return t(description);
  },
}));
export interface AiRisk {
  level: "low" | "medium" | "high";
  label: string;
  reason: string;
}
export function modelSelection(
  models: AiModel[],
  modelId: string,
  effort: string,
  preferredModel = "",
  manualModel = false,
  manualEffort = false,
) {
  if (manualModel) models = mergeModelSources(models, [modelId]);
  const model =
    models.find((item) => item.id === modelId) ||
    models.find((item) => item.id === preferredModel) ||
    models[0];
  const supported = model?.reasoningEfforts || [];
  const selectedEffort =
    manualEffort ||
    effort === "default" ||
    supported.some((item) => item.value === effort)
      ? effort
      : model?.defaultReasoningEffort || "default";
  const efforts = [
    { value: "default", label: t("默认"), description: t("使用服务默认的思考程度") },
    ...supported,
  ];
  if (manualEffort && effort && !efforts.some((item) => item.value === effort))
    efforts.push({
      value: effort,
      label: t("{0}（手动）", effort),
      description: t("手动指定的 API 参数"),
    });
  return {
    model: model?.id || "",
    effort: selectedEffort,
    manualModel: Boolean(manualModel || model?.manual),
    manualEffort,
    efforts,
  };
}
export interface ToolResult {
  status?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: string;
  truncated?: boolean;
}
export interface AiEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "error" | "notice";
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  rawArguments?: string;
  result?: ToolResult;
  running?: boolean;
  risk?: AiRisk;
  approvalId?: string;
  approvalPending?: boolean;
  approvalBusy?: boolean;
  approvalError?: string;
  approved?: boolean;
}
export interface AiConversation {
  id: string;
  serverId: string;
  createdAt: number;
  updatedAt: number;
  entries: AiEntry[];
  messages: Record<string, unknown>[];
  model: string;
  effort: AiEffort;
  manualModel: boolean;
  manualEffort: boolean;
  permission: AiPermission;
  contextTokens: number;
  compacting: boolean;
  draft: string;
  requestId: string | null;
  stopping: boolean;
  sessionId: string | null;
}
export interface AiEvent {
  type:
    | "round"
    | "text"
    | "thinking"
    | "tool_start"
    | "tool_output"
    | "tool_end"
    | "tool_risk"
    | "approval"
    | "compaction_start"
    | "compaction_end";
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  rawArguments?: string;
  result?: ToolResult;
  risk?: AiRisk;
  approvalId?: string;
  beforeTokens?: number;
  afterTokens?: number;
}
export const defaultAiConfig: AiConfig = {
  baseUrl: "https://api.openai.com/v1",
  models: [],
  manualModels: [],
  modelMetadata: [],
  defaultModel: "",
  hasApiKey: false,
  defaultPermission: "auto",
};
export function emptyConversation(config: AiConfig): AiConversation {
  return {
    id: "",
    serverId: "",
    createdAt: 0,
    updatedAt: 0,
    entries: [],
    messages: [],
    model: config.defaultModel || config.models[0] || "",
    effort: "default",
    manualModel: false,
    manualEffort: false,
    permission: config.defaultPermission || "auto",
    contextTokens: 0,
    compacting: false,
    draft: "",
    requestId: null,
    stopping: false,
    sessionId: null,
  };
}
/** Tool progress events can arrive repeatedly; keep one card for each tool call. */
export function applyAiEvent(
  entries: AiEntry[],
  event: AiEvent,
  assistantId: string,
): AiEntry[] {
  if (event.type === "text" || event.type === "thinking") {
    const found = entries.find((entry) => entry.id === assistantId);
    const next: AiEntry = found
      ? { ...found }
      : { id: assistantId, kind: "assistant", text: "", thinking: "" };
    const field = event.type === "text" ? "text" : "thinking";
    next[field] = (next[field] || "") + (event.text || "");
    return found
      ? entries.map((entry) => (entry.id === assistantId ? next : entry))
      : [...entries, next];
  }
  if (event.type === "tool_start") {
    return [
      ...entries,
      {
        id: event.id!,
        kind: "tool",
        name: event.name,
        arguments: event.arguments,
        rawArguments: event.rawArguments,
        running: true,
      },
    ];
  }
  if (event.type === "tool_output" || event.type === "tool_end") {
    return entries.map((entry) =>
      entry.id === event.id
        ? {
            ...entry,
            result: event.result,
            running: event.type !== "tool_end",
            approvalPending: false,
          }
        : entry,
    );
  }
  if (event.type === "tool_risk" || event.type === "approval") {
    return entries.map((entry) =>
      entry.id === event.id
        ? {
            ...entry,
            risk: event.risk,
            ...(event.type === "approval"
              ? {
                  approvalId: event.approvalId,
                  approvalPending: true,
                  running: false,
                }
              : {}),
          }
        : entry,
    );
  }
  return entries;
}

export function createConversation(
  config: AiConfig,
  serverId: string,
): AiConversation {
  const now = Date.now();
  return {
    ...emptyConversation(config),
    id: crypto.randomUUID(),
    serverId,
    createdAt: now,
    updatedAt: now,
  };
}

export function conversationTitle(conversation: AiConversation): string {
  return (
    conversation.entries
      .find((entry) => entry.kind === "user")
      ?.text?.trim()
      .replace(/\s+/g, " ")
      .slice(0, 80) || t("新对话")
  );
}

export function serverHistory(
  conversations: Record<string, AiConversation>,
  serverId: string,
): AiConversation[] {
  return Object.values(conversations)
    .filter((value) => value.serverId === serverId && value.entries.length > 0)
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id),
    );
}

/** Restoring history never resumes a tool or reuses an old approval. */
export function restoreConversation(saved: AiConversation): AiConversation {
  const interrupted = Boolean(saved.requestId);
  return {
    ...saved,
    requestId: null,
    sessionId: null,
    stopping: false,
    compacting: false,
    entries: [
      ...saved.entries.map((entry) => ({
        ...entry,
        running: false,
        approvalPending: false,
        approvalBusy: false,
        approvalId: undefined,
      })),
      ...(interrupted
        ? [
            {
              id: crypto.randomUUID(),
              kind: "notice" as const,
              text: t("上次任务在应用关闭前未结束。请先检查服务器现状；继续对话不会自动重放此前操作。"),
            },
          ]
        : []),
    ],
  };
}

/**
 * `/compact [what to keep]` compacts the conversation instead of sending a
 * message. Returns the focus text ("" when none), or null for other input.
 */
export function parseCompactCommand(text: string): string | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1] || "").trim() : null;
}

/** Start of the message that replaces compacted history (`context::compact`). */
const COMPACTED_HISTORY_PREFIX = "[已压缩的历史上下文";

/** A user bubble that was sent to the model (a `/compact` command is not). */
function sentToModel(entry: AiEntry): boolean {
  return (
    entry.kind === "user" &&
    Boolean(entry.text) &&
    parseCompactCommand(entry.text || "") === null
  );
}

/**
 * The conversation as it was just before the user message `entryId` was sent,
 * for editing that message and running the task again from there. The model
 * context keeps each request verbatim as `{role: "user", content}`, so the
 * message is found by counting the user requests sent after it from the end,
 * and checked by its text. Null when it cannot be rewound exactly: it was
 * folded into a compaction summary, or it is not a sent message.
 */
export function rewindTo(
  conversation: Pick<AiConversation, "entries" | "messages">,
  entryId: string,
): { entries: AiEntry[]; messages: Record<string, unknown>[] } | null {
  const { entries, messages } = conversation;
  const index = entries.findIndex((entry) => entry.id === entryId);
  const entry = entries[index];
  if (!entry || !sentToModel(entry)) return null;
  const later = entries.slice(index + 1).filter(sentToModel).length;
  let seen = 0;
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at];
    if (message.role !== "user" || typeof message.content !== "string")
      continue;
    if (message.content.startsWith(COMPACTED_HISTORY_PREFIX)) return null;
    if (seen++ < later) continue;
    return message.content === entry.text
      ? { entries: entries.slice(0, index), messages: messages.slice(0, at) }
      : null;
  }
  return null;
}

/** The user messages `rewindTo` can rewind to, found in one pass. */
export function editableUserEntries(
  conversation: Pick<AiConversation, "entries" | "messages">,
): Set<string> {
  const { entries, messages } = conversation;
  const ids = new Set<string>();
  let at = messages.length - 1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!sentToModel(entry)) continue;
    while (
      at >= 0 &&
      (messages[at].role !== "user" || typeof messages[at].content !== "string")
    )
      at--;
    const content = at >= 0 ? (messages[at].content as string) : null;
    if (content === null || content.startsWith(COMPACTED_HISTORY_PREFIX))
      break;
    if (content === entry.text) ids.add(entry.id);
    at--;
  }
  return ids;
}
