import type { AiConversation, AiPermission } from "./types";

const KEY = "ishell.ai.preferences.v1";
type Selection = Pick<
  AiConversation,
  "model" | "effort" | "manualModel" | "manualEffort"
>;
type Preferences = {
  selection?: Selection;
  permissions: Record<string, AiPermission>;
};
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

function scope(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

function read(storage: StorageAccess): Record<string, Preferences> {
  try {
    const value = JSON.parse(storage.getItem(KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

export function readAiPreferences(
  storage: StorageAccess,
  baseUrl: string,
  serverId: string,
): Partial<Selection & { permission: AiPermission }> {
  const preferences = read(storage)[scope(baseUrl)];
  const selected = preferences?.selection;
  const valid =
    selected &&
    typeof selected.model === "string" &&
    selected.model.length > 0 &&
    selected.model.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(selected.model) &&
    typeof selected.effort === "string" &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(selected.effort) &&
    typeof selected.manualModel === "boolean" &&
    typeof selected.manualEffort === "boolean";
  const permission = preferences?.permissions?.[serverId];
  return {
    ...(valid
      ? {
          model: selected.model,
          effort: selected.effort,
          manualModel: selected.manualModel,
          manualEffort: selected.manualEffort,
        }
      : {}),
    ...(["suggest", "ask", "auto", "full"].includes(permission)
      ? { permission }
      : {}),
  };
}

export function sameAiPreferences(left: AiConversation, right: AiConversation) {
  return (
    left.model === right.model &&
    left.effort === right.effort &&
    left.manualModel === right.manualModel &&
    left.manualEffort === right.manualEffort &&
    left.permission === right.permission
  );
}

/** Store selection fields only; drafts, chat content, API keys and results stay out. */
export function rememberAiPreferences(
  storage: StorageAccess,
  baseUrl: string,
  conversation: AiConversation,
) {
  const all = read(storage);
  const key = scope(baseUrl);
  const { model, effort, manualModel, manualEffort, permission, serverId } =
    conversation;
  all[key] = {
    selection: { model, effort, manualModel, manualEffort },
    permissions: { ...all[key]?.permissions, [serverId]: permission },
  };
  storage.setItem(KEY, JSON.stringify(all));
}
