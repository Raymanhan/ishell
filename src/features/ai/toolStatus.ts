import type { AiEntry } from "./types";
import { msg, t } from "../../i18n";

// Whole phrases per tool, so each language can word them naturally.
const LABELS: Record<string, { running: string; failed: string; done: string }> = {
  shell: { running: msg("执行中"), failed: msg("执行失败"), done: msg("执行成功") },
  run_code: { running: msg("运行中"), failed: msg("运行失败"), done: msg("运行成功") },
  read_file: { running: msg("读取中"), failed: msg("读取失败"), done: msg("读取成功") },
  write_file: { running: msg("写入中"), failed: msg("写入失败"), done: msg("写入成功") },
};

function label(entry: AiEntry, state: "running" | "failed" | "done") {
  return t((LABELS[entry.name || ""] || LABELS.shell)[state]);
}

/**
 * A successful process exit is a tool result, not a count or proof of the
 * whole task. Errors are compared with the backend's original messages.
 */
export function toolStatus(entry: AiEntry) {
  if (entry.approvalPending) return { kind: "waiting", label: t("等待确认") };
  if (
    entry.approved === false ||
    entry.result?.error?.startsWith("用户拒绝了该操作")
  )
    return { kind: "neutral", label: t("已拒绝") };
  if (entry.running) return { kind: "running", label: label(entry, "running") };
  if (
    entry.result?.error === "已停止执行" ||
    entry.result?.error === "已停止，未执行"
  )
    return { kind: "neutral", label: t("已停止") };
  if (entry.result?.error === "执行超时")
    return { kind: "error", label: t("执行超时") };
  if (
    entry.result?.error ||
    (entry.result?.exitCode != null && entry.result.exitCode !== 0)
  )
    return { kind: "error", label: label(entry, "failed") };
  if (entry.result?.exitCode === 0)
    return { kind: "success", label: label(entry, "done") };
  return { kind: "neutral", label: t("未完成") };
}
