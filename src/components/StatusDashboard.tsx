import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Cpu,
  Gauge as GaugeIcon,
  HardDrive,
  MemoryStick,
  RefreshCw,
} from "lucide-react";
import type { DiskMount } from "../types";
import type { ShellTab } from "../features/shell/types";
import { formatBytes, memoryPercent } from "../utils/format";

export function StatusDashboard({
  tab,
  loading,
  onRefresh,
}: {
  tab: ShellTab;
  loading: boolean;
  onRefresh: () => void;
}) {
  const status = tab.status;
  const mem = memoryPercent(status);
  const cpu = Math.round(status?.cpuPercent ?? 0);
  const cpuCores = Math.max(1, status?.cpuCores ?? 1);
  const load1Percent = Math.min(Math.round(((status?.load1 ?? 0) / cpuCores) * 100), 100);
  const memoryUsedGb =
    status?.memoryTotalMb != null
      ? (status.memoryTotalMb - (status.memoryAvailableMb ?? 0)) / 1024
      : null;
  const memoryTotalGb = status?.memoryTotalMb != null ? status.memoryTotalMb / 1024 : null;
  const memoryAvailableGb = status?.memoryAvailableMb != null ? status.memoryAvailableMb / 1024 : null;
  const swapTotalMb = status?.swapTotalMb;
  const swapFreeMb = status?.swapFreeMb;
  const swapUsedMb = swapTotalMb != null && swapFreeMb != null ? Math.max(0, swapTotalMb - swapFreeMb) : null;
  const swapEnabled = (swapTotalMb ?? 0) > 0;
  const swapPercent = swapEnabled && swapUsedMb != null && swapTotalMb ? Math.round((swapUsedMb / swapTotalMb) * 100) : 0;
  const diskMounts = getDiskMounts(status);

  return (
    <div className="dashboard">
      <div className="dash-head">
        <div>
          <span className="eyebrow">实时监控</span>
          <h2>{tab.title}</h2>
          <p>{tab.subtitle}</p>
        </div>
        <button type="button" className="btn-ghost" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} className={loading ? "spin" : ""} />
          刷新
        </button>
      </div>

      <section className="network-card">
        <div className="network-head">
          <span>网络速度</span>
          <div className="network-speeds">
            <SpeedPill icon={<ArrowDown size={12} />} value={tab.networkRxBps} label="下载" />
            <SpeedPill icon={<ArrowUp size={12} />} value={tab.networkTxBps} label="上传" />
          </div>
        </div>
        <NetworkWave history={tab.networkHistory} />
      </section>

      <section className="metric-section">
        <div className="metric-section-head">
          <span>
            <GaugeIcon size={14} />
            指标
          </span>
        </div>
        <div className="metric-list">
          <MetricBar
            icon={<Cpu size={14} />}
            label="CPU"
            value={cpu}
            valueText={`${cpu}%`}
            detail="按 CPU 时间实时采样"
            tone="ok"
          />
          <MetricBar
            icon={<MemoryStick size={14} />}
            label="内存"
            value={mem}
            valueText={`${mem}%`}
            detail={
              memoryUsedGb != null && memoryTotalGb != null && memoryAvailableGb != null
                ? `${memoryUsedGb.toFixed(1)} / ${memoryTotalGb.toFixed(1)} GB · 可用 ${memoryAvailableGb.toFixed(1)} GB`
                : "—"
            }
            tone="warn"
          />
          <MetricBar
            icon={<MemoryStick size={14} />}
            label="交换"
            value={swapPercent}
            valueText={swapTotalMb == null ? "—" : swapEnabled ? `${swapPercent}%` : "关闭"}
            detail={
              swapTotalMb == null
                ? "暂不可用"
                : swapEnabled && swapUsedMb != null
                  ? `${formatCapacityMb(swapUsedMb)} / ${formatCapacityMb(swapTotalMb)} · 可用 ${formatCapacityMb(swapFreeMb ?? 0)}`
                  : "未启用交换空间"
            }
            tone={swapEnabled && swapPercent >= 70 ? "warn" : "info"}
          />
          <MetricBar
            icon={<GaugeIcon size={14} />}
            label="负载"
            value={load1Percent}
            valueText={(status?.load1 ?? 0).toFixed(2)}
            detail={`${cpuCores} 核 · 5m ${(status?.load5 ?? 0).toFixed(2)} · 15m ${(status?.load15 ?? 0).toFixed(2)}`}
            tone="violet"
          />
        </div>
      </section>

      <section className="metric-section">
        <div className="metric-section-head">
          <span>
            <HardDrive size={14} />
            磁盘挂载
          </span>
        </div>
        <div className="mount-card">
          {diskMounts.length ? (
            diskMounts.map((mount) => (
              <MountBar
                key={`${mount.filesystem}-${mount.mountPoint}`}
                mount={mount}
              />
            ))
          ) : (
            <div className="metric-empty">暂无磁盘挂载数据</div>
          )}
        </div>
      </section>
    </div>
  );
}

function SpeedPill({ icon, value, label }: { icon: ReactNode; value: number; label: string }) {
  return (
    <span className="speed-pill" title={label}>
      {icon}
      {value > 0 ? formatBytes(value) : "0 B"}/s
    </span>
  );
}

function NetworkWave({ history }: { history: ShellTab["networkHistory"] }) {
  const width = 220;
  const height = 58;
  const max = Math.max(1, ...history.flatMap((point) => [point.rxBps, point.txBps]));
  const downloadPath = wavePath(history.map((point) => point.rxBps), max, width, height);
  const uploadPath = wavePath(history.map((point) => point.txBps), max, width, height);
  const downloadArea = areaPath(downloadPath.points, downloadPath.d, height);
  const uploadArea = areaPath(uploadPath.points, uploadPath.d, height);

  return (
    <svg className="network-wave" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="net-rx" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#0a84ff" />
          <stop offset="100%" stopColor="#64d2ff" />
        </linearGradient>
        <linearGradient id="net-tx" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#bf5af2" />
          <stop offset="100%" stopColor="#ff9f0a" />
        </linearGradient>
      </defs>
      <path className="wave-grid" d={`M0 ${height - 12} H${width} M0 ${height / 2} H${width}`} />
      <path className="wave-area wave-area-rx" d={downloadArea} />
      <path className="wave-area wave-area-tx" d={uploadArea} />
      <path className="wave-line wave-rx" d={downloadPath.d} />
      <path className="wave-line wave-tx" d={uploadPath.d} />
    </svg>
  );
}

function wavePath(values: number[], max: number, width: number, height: number) {
  const smoothed = smoothValues(values.length ? values : [0]);
  const step = smoothed.length > 1 ? width / (smoothed.length - 1) : width;
  const points = smoothed.map((value, index) => {
      const x = index * step;
      const y = height - 6 - (Math.max(0, value) / max) * (height - 14);
      return { x, y };
    });

  if (points.length === 1) {
    const point = points[0];
    return { d: `M0 ${point.y.toFixed(1)} H${width}`, points };
  }

  const d = points.reduce((path, point, index) => {
    if (index === 0) return `M${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    const previous = points[index - 1];
    const cx = (previous.x + point.x) / 2;
    return `${path} C${cx.toFixed(1)} ${previous.y.toFixed(1)}, ${cx.toFixed(1)} ${point.y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }, "");

  return { d, points };
}

function areaPath(points: { x: number; y: number }[], line: string, height: number) {
  if (!points.length) return "";
  const last = points[points.length - 1];
  const first = points[0];
  const baseline = height - 5;
  return `${line} L${last.x.toFixed(1)} ${baseline} L${first.x.toFixed(1)} ${baseline} Z`;
}

function smoothValues(values: number[]) {
  return values.map((value, index) => {
    const previous = values[index - 1] ?? value;
    const next = values[index + 1] ?? value;
    return previous * 0.22 + value * 0.56 + next * 0.22;
  });
}

function MetricBar({
  icon,
  label,
  value,
  valueText,
  detail,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  valueText: string;
  detail: string;
  tone: "ok" | "warn" | "info" | "violet";
}) {
  const clamped = Math.max(0, Math.min(value, 100));

  return (
    <article className={`metric-row tone-${tone}`} title={`${label} · ${valueText} · ${detail}`}>
      <span className="metric-label">
        {icon}
        {label}
      </span>
      <div className="metric-main">
        <div className="metric-track" aria-label={`${label} ${valueText}`}>
          <span className="metric-fill" style={{ width: `${clamped}%` }} />
        </div>
        <span className="metric-detail">{detail}</span>
      </div>
      <strong>{valueText}</strong>
    </article>
  );
}

function formatCapacityMb(value: number) {
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
}

function MountBar({ mount }: { mount: DiskMount }) {
  const value = Math.round(mount.usedPercent);
  const clamped = Math.max(0, Math.min(value, 100));

  return (
    <div
      className="mount-row tone-info"
      title={`${mount.mountPoint} · ${mount.filesystem} · ${mount.usedGb.toFixed(1)} / ${mount.totalGb.toFixed(1)} GB`}
    >
      <div className="mount-id">
        <strong>{mount.mountPoint}</strong>
      </div>
      <div className="mount-track" aria-label={`${mount.mountPoint} ${value}%`}>
        <span className="metric-fill" style={{ width: `${clamped}%` }} />
      </div>
      <span className="mount-size">
        {mount.usedGb.toFixed(0)}/{mount.totalGb.toFixed(0)}G
      </span>
    </div>
  );
}

function getDiskMounts(status: ShellTab["status"]): DiskMount[] {
  if (status?.diskMounts?.length) return status.diskMounts;
  if (
    status?.diskUsedPercent == null ||
    status.diskUsedGb == null ||
    status.diskTotalGb == null
  ) {
    return [];
  }

  return [
    {
      filesystem: "/",
      mountPoint: "/",
      usedPercent: status.diskUsedPercent,
      usedGb: status.diskUsedGb,
      totalGb: status.diskTotalGb,
    },
  ];
}
