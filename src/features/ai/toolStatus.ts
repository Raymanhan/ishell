import type { AiEntry } from "./types";

/** A successful process exit is a tool result, not a count or proof of the whole task. */
export function toolStatus(entry: AiEntry) {
  const action =
    (
      {
        shell: "执行",
        run_code: "运行",
        read_file: "读取",
        write_file: "写入",
      } as Record<string, string>
    )[entry.name || ""] || "执行";
  if (entry.approvalPending) return { kind: "waiting", label: "等待确认" };
  if (
    entry.approved === false ||
    entry.result?.error?.startsWith("用户拒绝了该操作")
  )
    return { kind: "neutral", label: "已拒绝" };
  if (entry.running) return { kind: "running", label: `${action}中` };
  if (
    entry.result?.error === "已停止执行" ||
    entry.result?.error === "已停止，未执行"
  )
    return { kind: "neutral", label: "已停止" };
  if (entry.result?.error === "执行超时")
    return { kind: "error", label: "执行超时" };
  if (
    entry.result?.error ||
    (entry.result?.exitCode != null && entry.result.exitCode !== 0)
  )
    return { kind: "error", label: `${action}失败` };
  if (entry.result?.exitCode === 0)
    return { kind: "success", label: `${action}成功` };
  return { kind: "neutral", label: "未完成" };
}
