import { useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CircuitBoard,
  Cpu,
  Gauge as GaugeIcon,
  MemoryStick,
} from "lucide-react";
import type { DiskMount, ProcessUsage } from "../types";
import type { ShellTab } from "../features/shell/types";
import { formatBytes, memoryPercent } from "../utils/format";

export function StatusDashboard({
  tab,
  onHostCopied,
}: {
  tab: ShellTab;
  onHostCopied?: (host: string) => void;
}) {
  const status = tab.status;
  const [hostCopied, setHostCopied] = useState(false);
  const mem = memoryPercent(status);
  const cpu = Math.round(status?.cpuPercent ?? 0);
  const gpu = status?.gpuPercent == null ? null : Math.round(status.gpuPercent);
  const gpuMemoryUsedMb = status?.gpuMemoryUsedMb;
  const gpuMemoryTotalMb = status?.gpuMemoryTotalMb;
  const gpuMemoryPercent =
    gpuMemoryUsedMb != null && gpuMemoryTotalMb != null && gpuMemoryTotalMb > 0
      ? Math.min(Math.round((gpuMemoryUsedMb / gpuMemoryTotalMb) * 100), 100)
      : 0;
  const gpuMemoryAvailableMb =
    gpuMemoryUsedMb != null && gpuMemoryTotalMb != null
      ? Math.max(0, gpuMemoryTotalMb - gpuMemoryUsedMb)
      : null;
  const cpuCores = Math.max(1, status?.cpuCores ?? 1);
  const load1Percent = Math.min(Math.round(((status?.load1 ?? 0) / cpuCores) * 100), 100);
  const memoryUsedGb =
    status?.memoryTotalMb != null
      ? (status.memoryTotalMb - (status.memoryAvailableMb ?? 0)) / 1024
      : null;
  const memoryTotalGb = status?.memoryTotalMb != null ? status.memoryTotalMb / 1024 : null;
  const memoryAvailableGb = status?.memoryAvailableMb != null ? status.memoryAvailableMb / 1024 : null;
  const memoryValueText =
    memoryUsedGb != null && memoryTotalGb != null
      ? `${formatCapacityGb(memoryUsedGb, true)}/${formatCapacityGb(memoryTotalGb, true)}`
      : `${mem}%`;
  const swapTotalMb = status?.swapTotalMb;
  const swapFreeMb = status?.swapFreeMb;
  const swapUsedMb = swapTotalMb != null && swapFreeMb != null ? Math.max(0, swapTotalMb - swapFreeMb) : null;
  const swapEnabled = (swapTotalMb ?? 0) > 0;
  const swapPercent = swapEnabled && swapUsedMb != null && swapTotalMb ? Math.round((swapUsedMb / swapTotalMb) * 100) : 0;
  const diskMounts = getDiskMounts(status);

  async function copyHost() {
    if (!tab.host) return;
    try {
      await copyText(tab.host);
      setHostCopied(true);
      onHostCopied?.(tab.host);
      window.setTimeout(() => setHostCopied(false), 1200);
    } catch (error) {
      console.error(error);
    }
  }

  return (
    <div className="dashboard">
      <div className="dash-head">
        <div className="dash-id" title={tab.subtitle}>
          <strong>{tab.title}</strong>
          {tab.host && (
            <button
              type="button"
              className={`dash-host ${hostCopied ? "copied" : ""}`}
              onClick={copyHost}
              title={hostCopied ? "已复制 IP 地址" : "点击复制 IP 地址"}
            >
              {hostCopied ? "已复制" : tab.host}
            </button>
          )}
        </div>
      </div>

      <section className="network-card">
        <div className="network-head">
          <div className="network-speeds">
            <SpeedPill icon={<ArrowDown size={12} />} value={tab.networkRxBps} label="下载" />
            <SpeedPill icon={<ArrowUp size={12} />} value={tab.networkTxBps} label="上传" />
          </div>
        </div>
        <NetworkWave history={tab.networkHistory} />
      </section>

      <section className="metric-section">
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
            valueText={memoryValueText}
            detail={
              memoryUsedGb != null && memoryTotalGb != null && memoryAvailableGb != null
                ? `${memoryUsedGb.toFixed(1)} / ${memoryTotalGb.toFixed(1)} GB · 可用 ${memoryAvailableGb.toFixed(1)} GB`
                : "—"
            }
            tone="warn"
          />
          <MetricBar
            icon={<CircuitBoard size={14} />}
            label="GPU"
            value={gpu ?? 0}
            valueText={gpu == null ? "—" : `${gpu}%`}
            detail={gpu == null ? "未检测到受支持的 GPU" : "当前 GPU 中的最高占用率"}
            tone="violet"
          />
          {gpuMemoryUsedMb != null && gpuMemoryTotalMb != null && gpuMemoryAvailableMb != null && (
            <MetricBar
              icon={<MemoryStick size={14} />}
              label="显存"
              value={gpuMemoryPercent}
              valueText={`${formatCapacityMb(gpuMemoryUsedMb, true)}/${formatCapacityMb(gpuMemoryTotalMb, true)}`}
              detail={`已用 ${formatCapacityMb(gpuMemoryUsedMb)} / ${formatCapacityMb(gpuMemoryTotalMb)} · 可用 ${formatCapacityMb(gpuMemoryAvailableMb)}`}
              tone="info"
            />
          )}
          <MetricBar
            icon={<MemoryStick size={14} />}
            label="交换"
            value={swapPercent}
            valueText={
              swapTotalMb == null
                ? "—"
                : swapEnabled && swapUsedMb != null
                  ? `${formatCapacityMb(swapUsedMb, true)}/${formatCapacityMb(swapTotalMb, true)}`
                  : "关闭"
            }
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
        <ProcessTopCard
          cpuProcesses={status?.topCpuProcesses ?? []}
          memoryProcesses={status?.topMemoryProcesses ?? []}
        />
      </section>

      <section className="metric-section">
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

function ProcessTopCard({
  cpuProcesses,
  memoryProcesses,
}: {
  cpuProcesses: ProcessUsage[];
  memoryProcesses: ProcessUsage[];
}) {
  const [mode, setMode] = useState<"cpu" | "memory">("cpu");
  const processes = mode === "cpu" ? cpuProcesses : memoryProcesses;
  const valueFor = (process: ProcessUsage) =>
    mode === "cpu" ? process.cpuPercent : process.memoryBytes;
  const maxValue = Math.max(1, ...processes.map(valueFor));

  return (
    <div className={`process-card process-card-${mode}`}>
      <div className="process-card-head">
        <span className="process-card-title">
          <Activity size={14} />
          进程 Top 5
        </span>
        <div className="process-switch" role="group" aria-label="进程排行指标">
          <button
            type="button"
            className={mode === "cpu" ? "on" : ""}
            aria-pressed={mode === "cpu"}
            onClick={() => setMode("cpu")}
          >
            CPU
          </button>
          <button
            type="button"
            className={mode === "memory" ? "on" : ""}
            aria-pressed={mode === "memory"}
            onClick={() => setMode("memory")}
          >
            内存
          </button>
        </div>
      </div>

      {processes.length ? (
        <div className="process-list">
          {processes.map((process, index) => {
            const value = valueFor(process);
            return (
              <div
                className="process-row"
                key={`${mode}-${process.pid}`}
                title={`${process.name} · PID ${process.pid} · CPU ${formatPercent(process.cpuPercent)} · 内存 ${formatBytes(process.memoryBytes)}`}
              >
                <span className="process-rank">{index + 1}</span>
                <span className="process-name">
                  <strong>{process.name}</strong>
                  <small>PID {process.pid}</small>
                </span>
                {mode === "memory" && (
                  <span className="process-track" aria-hidden="true">
                    <span className="process-fill" style={{ width: `${(value / maxValue) * 100}%` }} />
                  </span>
                )}
                <strong className="process-value">
                  {mode === "cpu" ? formatPercent(value) : formatBytes(value)}
                </strong>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="process-empty">正在采样进程数据…</div>
      )}
    </div>
  );
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function SpeedPill({ icon, value, label }: { icon: ReactNode; value: number; label: string }) {
  return (
    <span className="speed-pill" title={label}>
      {icon}
      {value > 0 ? formatBytes(value) : "0 B"}/s
    </span>
  );
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("复制失败");
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
      </div>
      <strong>{valueText}</strong>
    </article>
  );
}

function formatCapacityMb(value: number, compact = false) {
  if (value >= 1024) {
    const gigabytes = value / 1024;
    const formatted = gigabytes.toFixed(gigabytes >= 10 || Number.isInteger(gigabytes) ? 0 : 1);
    return compact ? `${formatted}G` : `${formatted} GB`;
  }
  return compact ? `${Math.round(value)}M` : `${Math.round(value)} MB`;
}

function formatCapacityGb(value: number, compact = false) {
  if (value < 1) return `${Math.round(value * 1024)} ${compact ? "M" : "MB"}`;
  return `${value.toFixed(compact ? 0 : 1)} ${compact ? "G" : "GB"}`;
}

function MountBar({ mount }: { mount: DiskMount }) {
  const value = Math.round(mount.usedPercent);
  const clamped = Math.max(0, Math.min(value, 100));
  const usedText = formatCapacityGb(mount.usedGb);
  const totalText = formatCapacityGb(mount.totalGb);
  const compactUsedText = formatCapacityGb(mount.usedGb, true);
  const compactTotalText = formatCapacityGb(mount.totalGb, true);

  return (
    <div
      className="mount-row tone-info"
      title={`${mount.mountPoint} · ${mount.filesystem} · ${usedText} / ${totalText}`}
    >
      <div className="mount-id">
        <strong>{mount.mountPoint}</strong>
      </div>
      <div className="mount-track" aria-label={`${mount.mountPoint} ${value}%`}>
        <span className="metric-fill" style={{ width: `${clamped}%` }} />
      </div>
      <span className="mount-size">
        {compactUsedText}/{compactTotalText}
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
