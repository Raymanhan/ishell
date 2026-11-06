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
export const DEFAULT_COMPACTION_THRESHOLD = 200_000;
/** Mirrors `context::Budget::for_window` in the desktop backend. */
export function compactionThreshold(contextWindow?: number | null): number {
  if (!contextWindow || contextWindow <= 0) return DEFAULT_COMPACTION_THRESHOLD;
  return Math.min(
    DEFAULT_COMPACTION_THRESHOLD,
    Math.max(8_000, Math.floor((contextWindow * 3) / 4)),
  );
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
        name: `${id}（手动）`,
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
}[] = [
  {
    value: "suggest",
    label: "仅建议",
    description: "只生成操作建议，不执行服务器工具",
  },
  { value: "ask", label: "执行前确认", description: "每次工具调用都需要确认" },
  {
    value: "auto",
    label: "自动 · 低风险",
    description: "低风险查询自动执行；修改文件、代码与未知命令需确认",
  },
  {
    value: "full",
    label: "完全访问",
    description: "自动执行任务中的所有工具操作，不再逐项确认",
  },
];
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
    { value: "default", label: "默认", description: "使用服务默认的思考程度" },
    ...supported,
  ];
  if (manualEffort && effort && !efforts.some((item) => item.value === effort))
    efforts.push({
      value: effort,
      label: `${effort}（手动）`,
      description: "手动指定的 API 参数",
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
      .slice(0, 80) || "新对话"
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
              text: "上次任务在应用关闭前未结束。请先检查服务器现状；继续对话不会自动重放此前操作。",
            },
          ]
        : []),
    ],
  };
}
