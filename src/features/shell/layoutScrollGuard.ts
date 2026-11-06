/**
 * Layout containers that clip their content and must never scroll. A browser
 * can still scroll an `overflow: hidden` box programmatically: macOS WebKit
 * does it to reveal a focused element or the terminal's caret, and
 * `scrollIntoView` does it everywhere. When that happens the terminal card
 * slides out of line with the neighbouring cards and stays there, so put any
 * such scroll straight back.
 */
export const FIXED_LAYOUT_SELECTOR = [
  ".app",
  ".workspace",
  ".workbench-body",
  ".workbench-main",
  ".terminal-dock",
  ".terminal-region",
  ".terminal-stack",
  ".terminal-panel",
  ".terminal-frame",
  ".terminal-host",
  ".status-panel",
  ".status-panel-content",
].join(", ");

export function resetLayoutScroll(target: EventTarget | null): boolean {
  if (
    !(target instanceof HTMLElement) ||
    (!target.scrollTop && !target.scrollLeft) ||
    !target.matches(FIXED_LAYOUT_SELECTOR)
  )
    return false;
  target.scrollTop = 0;
  target.scrollLeft = 0;
  return true;
}

/** Scroll events do not bubble, but a capturing listener sees them all. */
export function installLayoutScrollGuard(root: Document = document): () => void {
  const onScroll = (event: Event) => {
    resetLayoutScroll(event.target);
  };
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => root.removeEventListener("scroll", onScroll, { capture: true });
}
