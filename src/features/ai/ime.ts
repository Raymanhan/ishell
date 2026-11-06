import { useRef } from "react";

/**
 * Whether a key event belongs to an input method composition (Chinese,
 * Japanese, …), where Enter commits the candidate text instead of submitting.
 *
 * `isComposing` alone is not enough: macOS WebKit (the Tauri webview there)
 * fires `compositionend` before the Enter keydown that commits it, so that
 * keydown arrives with `isComposing === false`. It still carries the IME
 * keyCode 229, and `composing` (from the composition events) covers browsers
 * that report neither.
 */
export function isImeKey(
  event: { isComposing?: boolean; keyCode?: number },
  composing = false,
): boolean {
  return composing || Boolean(event.isComposing) || event.keyCode === 229;
}

/** Composition tracking for a text field whose Enter key submits. */
export function useImeGuard() {
  const composing = useRef(false);
  return {
    onCompositionStart: () => {
      composing.current = true;
    },
    // Cleared after the current task, so the Enter keydown that WebKit
    // dispatches right after compositionend is still seen as composing.
    onCompositionEnd: () => {
      setTimeout(() => {
        composing.current = false;
      }, 0);
    },
    isComposing: (event: { nativeEvent: KeyboardEvent }) =>
      isImeKey(event.nativeEvent, composing.current),
  };
}
