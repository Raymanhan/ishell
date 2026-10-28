import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Save, X } from "lucide-react";
import type { SftpEntry } from "../types";
import { formatBytes } from "../utils/format";
import { renderHighlightedCode, textOffsetAtPoint } from "../utils/highlight";

export interface FileEditorState {
  entry: SftpEntry;
  tabId: string;
  serverId: string;
  content: string;
  originalContent: string;
  loading: boolean;
  saving: boolean;
  error?: string;
}

/** Modal editor for small remote text files, with a syntax-highlight overlay. */
export function FileEditorModal({
  editor,
  onChange,
  onSave,
  onClose,
}: {
  editor: FileEditorState;
  onChange: (content: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectionCleanupRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const highlight = highlightRef.current;
    const textarea = textareaRef.current;
    if (!highlight || !textarea) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, [editor.entry.path, editor.content]);

  useEffect(() => () => selectionCleanupRef.current?.(), []);

  // A textarea stops extending the selection once the pointer leaves it. Keep
  // scrolling and extending it while a drag-select goes past an edge.
  function startSelectionDrag(event: ReactPointerEvent<HTMLTextAreaElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const textarea = event.currentTarget;
    const highlight = highlightRef.current;
    if (!highlight) return;

    selectionCleanupRef.current?.();

    const pointerId = event.pointerId;
    let pointerX = event.clientX;
    let pointerY = event.clientY;
    let selectionAnchor: number | null = null;
    let frame = 0;

    const syncHighlight = () => {
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("blur", cleanup);
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      if (selectionCleanupRef.current === cleanup) {
        selectionCleanupRef.current = null;
      }
    };
    const scrollSelection = () => {
      frame = 0;
      const rect = textarea.getBoundingClientRect();
      const horizontalOverflow = pointerX < rect.left
        ? pointerX - rect.left
        : pointerX > rect.right
          ? pointerX - rect.right
          : 0;
      const verticalOverflow = pointerY < rect.top
        ? pointerY - rect.top
        : pointerY > rect.bottom
          ? pointerY - rect.bottom
          : 0;
      if (!horizontalOverflow && !verticalOverflow) return;

      const previousScrollLeft = textarea.scrollLeft;
      const previousScrollTop = textarea.scrollTop;
      if (horizontalOverflow) {
        const horizontalSpeed = Math.sign(horizontalOverflow)
          * Math.min(32, Math.max(4, Math.abs(horizontalOverflow) * 0.2));
        textarea.scrollLeft += horizontalSpeed;
      }
      if (verticalOverflow) {
        const verticalSpeed = Math.sign(verticalOverflow)
          * Math.min(24, Math.max(4, Math.abs(verticalOverflow) * 0.2));
        textarea.scrollTop += verticalSpeed;
      }
      const didScroll =
        textarea.scrollLeft !== previousScrollLeft
        || textarea.scrollTop !== previousScrollTop;
      if (!didScroll) return;

      syncHighlight();
      if (selectionAnchor === null) {
        selectionAnchor = textarea.selectionDirection === "backward"
          ? textarea.selectionEnd
          : textarea.selectionStart;
      }

      const offset = textOffsetAtPoint(
        textarea,
        highlight,
        Math.min(rect.right - 12, Math.max(rect.left + 2, pointerX)),
        Math.min(rect.bottom - 12, Math.max(rect.top + 2, pointerY)),
      );
      if (offset !== null) {
        if (offset < selectionAnchor) {
          textarea.setSelectionRange(offset, selectionAnchor, "backward");
        } else {
          textarea.setSelectionRange(selectionAnchor, offset, "forward");
        }
      }

      frame = window.requestAnimationFrame(scrollSelection);
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (move.pointerType === "mouse" && (move.buttons & 1) === 0) {
        cleanup();
        return;
      }
      pointerX = move.clientX;
      pointerY = move.clientY;
      const rect = textarea.getBoundingClientRect();
      if (
        (
          pointerX < rect.left
          || pointerX > rect.right
          || pointerY < rect.top
          || pointerY > rect.bottom
        )
        && !frame
      ) {
        frame = window.requestAnimationFrame(scrollSelection);
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
    window.addEventListener("blur", cleanup, { once: true });
    selectionCleanupRef.current = cleanup;
  }

  return (
    <div className="file-editor-backdrop" role="presentation">
      <section className="file-editor" role="dialog" aria-modal="true" aria-labelledby="file-editor-title">
        <header className="file-editor-head">
          <div>
            <span>Text Editor</span>
            <h2 id="file-editor-title">{editor.entry.name}</h2>
            <p title={editor.entry.path}>{editor.entry.path}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>
        {editor.error && <div className="file-editor-error">{editor.error}</div>}
        <div className="file-editor-code">
          <pre ref={highlightRef} className="file-editor-highlight" aria-hidden="true">{renderHighlightedCode(editor.entry.name, editor.content)}</pre>
          <textarea
            ref={textareaRef}
            className="file-editor-textarea"
            value={editor.content}
            disabled={editor.loading || editor.saving}
            spellCheck={false}
            wrap="off"
            onPointerDown={startSelectionDrag}
            onScroll={(event) => {
              const highlight = highlightRef.current;
              if (!highlight) return;
              highlight.scrollTop = event.currentTarget.scrollTop;
              highlight.scrollLeft = event.currentTarget.scrollLeft;
            }}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                onSave();
              }
            }}
          />
        </div>
        <footer className="file-editor-actions">
          <span>{editor.loading ? "读取中…" : `${formatBytes(new TextEncoder().encode(editor.content).length)} / 1 MB`}</span>
          <div>
            <button type="button" className="btn-ghost" disabled={editor.saving} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="solid-button"
              disabled={editor.loading || editor.saving || editor.content === editor.originalContent}
              onClick={onSave}
            >
              <Save size={15} />
              {editor.saving ? "保存中…" : "保存"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
