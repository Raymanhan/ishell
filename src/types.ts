export type AuthType = "password" | "key";

export interface ServerRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group: string;
  tags: string[];
  authType: AuthType;
  keyPath?: string | null;
  color: string;
  notes: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  lastConnectedAt?: number | null;
}

export interface ServerInput {
  id?: string | null;
  name: string;
  host: string;
  port: number;
  username: string;
  group: string;
  tags: string[];
  authType: AuthType;
  keyPath?: string | null;
  color: string;
  notes: string;
  sortOrder?: number | null;
}

export interface ServerStatus {
  id: string;
  os: string;
  uptimeSeconds?: number | null;
  load1: number;
  load5: number;
  load15: number;
  cpuCores?: number | null;
  cpuPercent: number;
  gpuPercent?: number | null;
  gpuMemoryUsedMb?: number | null;
  gpuMemoryTotalMb?: number | null;
  memoryTotalMb?: number | null;
  memoryAvailableMb?: number | null;
  swapTotalMb?: number | null;
  swapFreeMb?: number | null;
  diskUsedPercent?: number | null;
  diskUsedGb?: number | null;
  diskTotalGb?: number | null;
  diskMounts?: DiskMount[];
  processes?: number | null;
  topCpuProcesses?: ProcessUsage[];
  topMemoryProcesses?: ProcessUsage[];
  sampledAt: number;
}

export interface ProcessUsage {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
}

export interface ProcessSamplePayload {
  id: string;
  topCpuProcesses: ProcessUsage[];
  topMemoryProcesses: ProcessUsage[];
  sampledAt: number;
}

export interface DiskMount {
  filesystem: string;
  mountPoint: string;
  usedPercent: number;
  usedGb: number;
  totalGb: number;
}

export interface NetworkSample {
  rxBytes: number;
  txBytes: number;
  sampledAt: number;
}

export interface NetworkPoint {
  sampledAt: number;
  rxBps: number;
  txBps: number;
}

export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink?: boolean;
  linkTarget?: string | null;
  targetIsDir?: boolean | null;
  size?: number | null;
  uid?: number | null;
  gid?: number | null;
  owner?: string | null;
  group?: string | null;
  permissions?: number | null;
  modifiedAt?: number | null;
}

export interface FileColumn {
  path: string;
  entries: SftpEntry[];
  loading: boolean;
  error?: string;
}

export type UploadStatus = "pending" | "uploading" | "done" | "error" | "canceled";
export type DownloadStatus = "pending" | "downloading" | "done" | "error" | "canceled";

export interface UploadItem {
  id: string;
  tabId: string;
  name: string;
  localPath: string;
  remoteDir: string;
  serverId: string;
  transferred: number;
  total: number;
  status: UploadStatus;
  error?: string;
}

export type FolderDownloadMode = "archive" | "raw";

export interface DownloadItem {
  id: string;
  tabId: string;
  name: string;
  remotePath: string;
  serverId: string;
  transferred: number;
  total: number;
  status: DownloadStatus;
  savedPath?: string;
  error?: string;
  /** Set for folder downloads; absent for regular single-file downloads. */
  folderMode?: FolderDownloadMode;
}

export interface UploadProgressPayload {
  transferId: string;
  transferred: number;
  total: number;
  done: boolean;
}

export interface DownloadProgressPayload {
  transferId: string;
  transferred: number;
  total: number;
  done: boolean;
}

export interface TerminalDataPayload {
  sessionId: string;
  offset: number;
  data: string;
}

export interface TerminalReadyPayload {
  sessionId: string;
}

export interface TerminalSnapshotPayload {
  data: string;
  startOffset: number;
  endOffset: number;
  ready: boolean;
}

export interface TerminalClosedPayload {
  sessionId: string;
  reason: string;
}
