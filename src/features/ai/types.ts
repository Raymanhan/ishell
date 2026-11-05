export interface AiConfig {
  baseUrl: string;
  models: string[];
  modelMetadata: AiModel[];
  metadataError?: string | null;
  defaultModel: string;
  hasApiKey: boolean;
  defaultPermission: AiPermission;
}
export interface AiConfigInput {
  baseUrl: string;
  models: string[];
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
) {
  const model =
    models.find((item) => item.id === modelId) ||
    models.find((item) => item.id === preferredModel) ||
    models[0];
  const supported = model?.reasoningEfforts || [];
  const selectedEffort =
    effort === "default" || supported.some((item) => item.value === effort)
      ? effort
      : model?.defaultReasoningEffort || "default";
  return {
    model: model?.id || "",
    effort: selectedEffort,
    efforts: [
      {
        value: "default",
        label: "默认",
        description: "使用服务默认的思考程度",
      },
      ...supported,
    ],
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
  entries: AiEntry[];
  messages: Record<string, unknown>[];
  model: string;
  effort: AiEffort;
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
  modelMetadata: [],
  defaultModel: "",
  hasApiKey: false,
  defaultPermission: "auto",
};
export function emptyConversation(config: AiConfig): AiConversation {
  return {
    entries: [],
    messages: [],
    model: config.defaultModel || config.models[0] || "",
    effort: "default",
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
