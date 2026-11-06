import { useEffect, useRef, useState } from "react";

/** Milliseconds between reveal steps (about 30 per second). */
const FRAME = 32;

/**
 * How much of a streamed reply to show on the next frame. Each frame closes a
 * fraction of the backlog, so text flows at a steady pace while tokens
 * trickle in and catches up quickly after a burst, instead of jumping by
 * whatever chunk the network delivered. Once the reply is complete it drains
 * faster. Never stops inside a UTF-16 surrogate pair.
 */
export function revealStep(
  text: string,
  shown: number,
  streaming: boolean,
): number {
  const remaining = text.length - shown;
  if (remaining <= 0) return text.length;
  const step = Math.max(
    streaming ? 1 : 3,
    Math.ceil(remaining / (streaming ? 8 : 3)),
  );
  let next = Math.min(text.length, shown + step);
  const code = text.charCodeAt(next - 1);
  if (code >= 0xd800 && code <= 0xdbff && next < text.length) next += 1;
  return next;
}

/**
 * The part of `text` to render for a reply that is still arriving. Text that
 * was already there when the message mounted (history, switching tabs) shows
 * at once; only what arrives afterwards is eased in.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text.length);
  const shownRef = useRef(shown);
  const lastFrame = useRef(0);
  useEffect(() => {
    if (shownRef.current > text.length) {
      shownRef.current = text.length;
      setShown(text.length);
    }
    if (shownRef.current >= text.length) return;
    let frame = 0;
    const tick = (now: number) => {
      if (now - lastFrame.current >= FRAME) {
        lastFrame.current = now;
        shownRef.current = revealStep(text, shownRef.current, streaming);
        setShown(shownRef.current);
      }
      if (shownRef.current < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, streaming]);
  return text.slice(0, shown);
}
