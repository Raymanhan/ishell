import type { ServerStatus } from "../types";

export function formatBytes(size?: number | null) {
  if (!size) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatUptime(seconds?: number | null) {
  if (!seconds) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function memoryPercent(status?: ServerStatus | null) {
  if (!status?.memoryTotalMb || status.memoryAvailableMb == null) return 0;
  return Math.round(((status.memoryTotalMb - status.memoryAvailableMb) / status.memoryTotalMb) * 100);
}
