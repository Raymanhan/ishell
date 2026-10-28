import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Track a pointer drag that started on a divider. `onMove` records the new
 * position, `onFrame` applies it at most once per animation frame (and once
 * more when the drag ends), and `onEnd` commits the final value. Returns a
 * function that stops the drag early (for unmount cleanup), or null when the
 * event was not a primary-button press.
 */
export function startPointerDrag(
  event: ReactPointerEvent<HTMLElement>,
  {
    cursor,
    onMove,
    onFrame,
    onEnd,
  }: {
    cursor: string;
    onMove: (move: PointerEvent) => void;
    onFrame: () => void;
    onEnd: () => void;
  },
): (() => void) | null {
  if (event.pointerType === "mouse" && event.button !== 0) return null;
  event.preventDefault();

  const divider = event.currentTarget;
  const pointerId = event.pointerId;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  let frame = 0;

  const runFrame = () => {
    frame = 0;
    onFrame();
  };

  const handleMove = (move: PointerEvent) => {
    if (move.pointerId !== pointerId) return;
    move.preventDefault();
    onMove(move);
    if (!frame) frame = window.requestAnimationFrame(runFrame);
  };

  const stop = () => {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    window.removeEventListener("pointercancel", handleUp);
    window.removeEventListener("blur", stop);
    if (frame) {
      window.cancelAnimationFrame(frame);
      runFrame();
    }
    if (divider.hasPointerCapture(pointerId)) {
      divider.releasePointerCapture(pointerId);
    }
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    onEnd();
  };

  const handleUp = (up: PointerEvent) => {
    if (up.pointerId === pointerId) stop();
  };

  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
  if (!divider.hasPointerCapture(pointerId)) {
    divider.setPointerCapture(pointerId);
  }
  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
  window.addEventListener("pointercancel", handleUp);
  window.addEventListener("blur", stop);
  return stop;
}
