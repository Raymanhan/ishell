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

/**
 * The tool card heading: what the call is for, in the model's own words
 * (`description`), so a list of calls reads as a list of steps. Without one,
 * the command itself (`literal`, shown in monospace) or the file it touches.
 */
export function toolTitle(entry: AiEntry): { title: string; literal: boolean } {
  const args = entry.arguments || {};
  const described =
    typeof args.description === "string"
      ? args.description.replace(/\s+/g, " ").trim().slice(0, 120)
      : "";
  if (described) return { title: described, literal: false };
  const firstLine = (value: unknown) =>
    String(value ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || "";
  switch (entry.name) {
    case "shell": {
      const command = firstLine(args.command) || firstLine(entry.rawArguments);
      return command
        ? { title: command, literal: true }
        : { title: t("执行命令"), literal: false };
    }
    case "run_code":
      return {
        title: args.language
          ? t("运行 {0} 代码", String(args.language))
          : t("运行代码"),
        literal: false,
      };
    case "read_file":
      return args.path
        ? { title: t("读取 {0}", String(args.path)), literal: false }
        : { title: t("读取文件"), literal: false };
    case "write_file":
      return args.path
        ? { title: t("写入 {0}", String(args.path)), literal: false }
        : { title: t("写入文件"), literal: false };
    default:
      return { title: entry.name || "", literal: true };
  }
}
