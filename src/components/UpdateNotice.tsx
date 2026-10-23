import { Download, RefreshCw, X } from "lucide-react";
import type { UpdaterState } from "../features/updater/useUpdater";

function formatMegabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bottom-right card that offers an available update and shows its progress. */
export function UpdateNotice({
  state,
  openSessions,
  onInstall,
  onDismiss,
}: {
  state: UpdaterState;
  openSessions: number;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  const { status, update, progress, error, dismissed } = state;
  const installing = status === "downloading" || status === "installing";
  const failedInstall = status === "error" && update !== null;
  if (!update || dismissed || !(status === "available" || installing || failedInstall)) return null;

  const percent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <section className="update-notice" role="status" aria-live="polite" aria-label="应用更新">
      <div className="update-notice-head">
        <span className="update-notice-icon" aria-hidden="true">
          <Download size={15} />
        </span>
        <div className="update-notice-title">
          <strong>发现新版本 v{update.version}</strong>
          <span>当前版本 v{update.currentVersion}</span>
        </div>
        {!installing && (
          <button type="button" className="update-notice-close" onClick={onDismiss} aria-label="稍后提醒">
            <X size={14} />
          </button>
        )}
      </div>

      {update.notes && !installing && <p className="update-notice-notes">{update.notes}</p>}

      {status === "downloading" && (
        <div className="update-notice-progress">
          <div className={`uq-track ${percent === null ? "indeterminate" : ""}`}>
            <div className="uq-fill" style={{ width: `${percent ?? 0}%` }} />
          </div>
          <span>
            正在下载
            {progress && progress.downloaded > 0 ? ` ${formatMegabytes(progress.downloaded)}` : "…"}
            {progress?.total ? ` / ${formatMegabytes(progress.total)}` : ""}
          </span>
        </div>
      )}
      {status === "installing" && <p className="update-notice-hint">正在安装，完成后会自动重启…</p>}
      {failedInstall && error && (
        <p className="update-notice-error">
          {error}
          <br />
          也可以前往 GitHub Releases 手动下载安装包。
        </p>
      )}

      {!installing && (
        <>
          {openSessions > 0 && (
            <p className="update-notice-hint">更新后会自动重启，当前 {openSessions} 个会话将断开。</p>
          )}
          <div className="update-notice-actions">
            <button type="button" className="btn-ghost" onClick={onDismiss}>
              稍后
            </button>
            <button type="button" className="btn-primary" onClick={onInstall}>
              {failedInstall ? <RefreshCw size={14} /> : <Download size={14} />}
              {failedInstall ? "重试" : "立即更新"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
