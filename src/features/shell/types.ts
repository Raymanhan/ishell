import type { FileColumn, NetworkPoint, NetworkSample, ServerStatus, SftpEntry } from "../../types";

export type ShellState = "connecting" | "connected" | "closed";

/** The tool shown in the side panel next to the terminal. */
export type SidePanel = "status" | "history" | "snippets" | "forwards";

export interface ShellTab {
  id: string;
  serverId: string;
  title: string;
  subtitle: string;
  host: string;
  color: string;
  sessionId: string | null;
  state: ShellState;
  status: ServerStatus | null;
  networkSample: NetworkSample | null;
  networkRxBps: number;
  networkTxBps: number;
  networkHistory: NetworkPoint[];
  files: FileColumn[];
  selectedPath: string | null;
  selectedPaths: string[];
  /** Cache of directory listings keyed by absolute path, for instant revisits. */
  cache: Record<string, SftpEntry[]>;
}

export function createTabId(serverId: string) {
  return `${serverId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
