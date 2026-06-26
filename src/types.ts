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
  memoryTotalMb?: number | null;
  memoryAvailableMb?: number | null;
  diskUsedPercent?: number | null;
  diskUsedGb?: number | null;
  diskTotalGb?: number | null;
  diskMounts?: DiskMount[];
  processes?: number | null;
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
  size?: number | null;
  uid?: number | null;
  gid?: number | null;
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

export interface TerminalSnapshotPayload {
  data: string;
  startOffset: number;
  endOffset: number;
}

export interface TerminalClosedPayload {
  sessionId: string;
  reason: string;
}
