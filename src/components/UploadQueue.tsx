import { CheckCircle2, ChevronDown, Loader2, OctagonX, UploadCloud, X, XCircle } from "lucide-react";
import { useState } from "react";
import type { UploadItem } from "../types";
import { formatBytes } from "../utils/format";

export function UploadQueue({
  uploads,
  onDismiss,
  onStop,
  onClearDone,
}: {
  uploads: UploadItem[];
  onDismiss: (id: string) => void;
  onStop: (id: string) => void;
  onClearDone: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (uploads.length === 0) return null;

  const active = uploads.filter((item) => item.status === "uploading" || item.status === "pending").length;
  const doneCount = uploads.filter((item) =>
    item.status === "done" || item.status === "error" || item.status === "canceled"
  ).length;

  return (
    <div className="upload-queue">
      <header className="uq-head">
        <button
          type="button"
          className="uq-title"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "展开" : "收起"}
        >
          <ChevronDown size={14} className={collapsed ? "uq-caret closed" : "uq-caret"} />
          <UploadCloud size={14} />
          <span>{active > 0 ? `上传中 · ${active}` : "上传完成"}</span>
        </button>
        {doneCount > 0 && (
          <button type="button" className="uq-clear" onClick={onClearDone} title="清除已完成">
            清除
          </button>
        )}
      </header>

      {!collapsed && (
        <ul className="uq-list">
          {uploads.map((item) => {
            const percent =
              item.status === "done"
                ? 100
                : item.total > 0
                  ? Math.min(100, Math.round((item.transferred / item.total) * 100))
                  : 0;
            const finalizing =
              item.status === "uploading" && item.total > 0 && item.transferred >= item.total;
            return (
              <li key={item.id} className={`uq-item ${item.status}`}>
                <span className="uq-icon">
                  {item.status === "done" ? (
                    <CheckCircle2 size={14} className="ok" />
                  ) : item.status === "error" || item.status === "canceled" ? (
                    <XCircle size={14} className="bad" />
                  ) : (
                    <Loader2 size={14} className="spin" />
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
                          ? (item.error ? "已取消" : "已停止")
                          : item.status === "done"
                            ? formatBytes(item.total)
                            : finalizing
                              ? "正在提交"
                              : `${percent}%`}
                    </span>
                  </div>
                  {item.status === "error" || item.status === "canceled" ? (
                    <div className="uq-error" title={item.error}>
                      {item.status === "canceled" ? item.error ?? "已停止上传" : item.error}
                    </div>
                  ) : (
                    <div className="uq-track">
                      <div className="uq-fill" style={{ width: `${percent}%` }} />
                    </div>
                  )}
                </div>
                {(item.status === "pending" || (item.status === "uploading" && !finalizing)) && (
                  <button type="button" className="uq-x" onClick={() => onStop(item.id)} title="停止上传">
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
