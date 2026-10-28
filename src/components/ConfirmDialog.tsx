import { useId, type ReactNode } from "react";

/**
 * Modal confirmation for a destructive action. Escape and a click on the
 * backdrop cancel, except while the action is running.
 */
export function ConfirmDialog({
  title,
  description,
  target,
  targetLabel,
  targetTitle,
  error,
  busy = false,
  confirmLabel,
  busyLabel,
  cancelLabel = "取消",
  focusCancel = false,
  className,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: ReactNode;
  /** The thing being acted on, shown highlighted below the description. */
  target: ReactNode;
  /** Small label shown before the target, e.g. "远端目标". */
  targetLabel?: string;
  targetTitle?: string;
  error?: string;
  busy?: boolean;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  /** Focus the cancel button instead of the confirm button. */
  focusCancel?: boolean;
  className?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const cancel = () => {
    if (!busy) onCancel();
  };

  return (
    <div
      className="delete-confirm-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        className={`delete-confirm ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-description`}>{description}</p>
        <div className={`delete-target ${targetLabel ? "labeled" : ""}`} title={targetTitle}>
          {targetLabel && <span>{targetLabel}</span>}
          {target}
        </div>
        {error && <div className="delete-error">{error}</div>}
        <div className="delete-actions">
          <button type="button" className="btn-ghost" autoFocus={focusCancel} disabled={busy} onClick={cancel}>
            {cancelLabel}
          </button>
          <button type="button" className="danger-button" autoFocus={!focusCancel} disabled={busy} onClick={onConfirm}>
            {busy && busyLabel ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
