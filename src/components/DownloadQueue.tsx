import { CheckCircle2, ChevronDown, DownloadCloud, Loader2, OctagonX, X, XCircle } from "lucide-react";
import { useState } from "react";
import type { DownloadItem } from "../types";
import { formatBytes } from "../utils/format";

export function DownloadQueue({
  downloads,
  onDismiss,
  onStop,
  onClearDone,
}: {
  downloads: DownloadItem[];
  onDismiss: (id: string) => void;
  onStop: (id: string) => void;
  onClearDone: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (downloads.length === 0) return null;

  const active = downloads.filter((item) => item.status === "downloading" || item.status === "pending").length;
  const doneCount = downloads.filter((item) =>
    item.status === "done" || item.status === "error" || item.status === "canceled"
  ).length;

  return (
    <div className="upload-queue download-queue">
      <header className="uq-head">
        <button
          type="button"
          className="uq-title"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "展开" : "收起"}
        >
          <ChevronDown size={14} className={collapsed ? "uq-caret closed" : "uq-caret"} />
          <DownloadCloud size={14} />
          <span>{active > 0 ? `下载中 · ${active}` : "下载完成"}</span>
        </button>
        {doneCount > 0 && (
          <button type="button" className="uq-clear" onClick={onClearDone} title="清除已完成">
            清除
          </button>
        )}
      </header>

      {!collapsed && (
        <ul className="uq-list">
          {downloads.map((item) => {
            const percent =
              item.status === "done"
                ? 100
                : item.total > 0
                  ? Math.min(100, Math.round((item.transferred / item.total) * 100))
                  : 0;
            return (
              <li key={item.id} className={`uq-item ${item.status}`}>
                <span className="uq-icon">
                  {item.status === "done" ? (
                    <CheckCircle2 size={14} className="ok" />
                  ) : item.status === "error" || item.status === "canceled" ? (
                    <XCircle size={14} className="bad" />
                  ) : (
                    <Loader2 size={14} className={item.status === "downloading" ? "spin" : ""} />
                  )}
                </span>
                <div className="uq-body">
                  <div className="uq-row">
                    <span className="uq-name" title={item.name}>
                      {item.name}
                    </span>
                    <span className="uq-meta">
                      {item.status === "error"
                        ? "失败"
                        : item.status === "canceled"
                          ? "已取消"
                          : item.status === "done"
                          ? formatBytes(item.total)
                          : item.status === "downloading"
                              ? `${percent}%`
                              : "等待"}
                    </span>
                  </div>
                  {item.status === "error" || item.status === "canceled" ? (
                    <div className="uq-error" title={item.error}>
                      {item.status === "canceled" ? "已取消下载" : item.error}
                    </div>
                  ) : item.status === "done" ? (
                    <div className="uq-path" title={item.savedPath}>
                      {item.savedPath}
                    </div>
                  ) : (
                    <div className="uq-track">
                      <div className="uq-fill" style={{ width: `${percent}%` }} />
                    </div>
                  )}
                </div>
                {(item.status === "pending" || item.status === "downloading") && (
                  <button type="button" className="uq-x" onClick={() => onStop(item.id)} title="停止下载">
                    <OctagonX size={12} />
                  </button>
                )}
                {(item.status === "done" || item.status === "error" || item.status === "canceled") && (
                  <button type="button" className="uq-x" onClick={() => onDismiss(item.id)} title="移除">
                    <X size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
