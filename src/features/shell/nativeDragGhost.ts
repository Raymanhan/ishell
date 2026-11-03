import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";

type GhostWindow = Pick<WebviewWindow, "once" | "show" | "destroy" | "setIgnoreCursorEvents" | "setShadow">;

/** A ghost starts hidden: cancellation can happen before native creation finishes. */
export function manageNativeDragGhost(windowRef: GhostWindow, isActive: () => boolean) {
  let created = false;
  let stopped = false;
  let destroyed = false;

  function destroy() {
    if (!created || destroyed) return;
    destroyed = true;
    // This is a disposable preview, so bypass close-request handlers.
    void windowRef.destroy().catch((error) => console.warn("Unable to destroy tab drag preview", error));
  }

  void windowRef.once("tauri://created", async () => {
    created = true;
    if (stopped || !isActive()) {
      destroy();
      return;
    }
    try {
      await windowRef.setIgnoreCursorEvents(true);
      if (stopped || !isActive()) {
        destroy();
        return;
      }
      await windowRef.setShadow(false).catch(() => undefined);
      if (stopped || !isActive()) {
        destroy();
        return;
      }
      await windowRef.show();
    } catch (error) {
      console.warn("Unable to show tab drag preview", error);
      stopped = true;
    }
    if (stopped || !isActive()) destroy();
  });

  return () => {
    stopped = true;
    // If creation is pending, the created handler performs deferred destruction.
    destroy();
  };
}
