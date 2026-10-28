import { getThemeDefinition, type AppTheme } from "../../constants/theme";

export async function applyNativeWindowTheme(theme: AppTheme) {
  const [{ Effect, EffectState, getCurrentWindow }, { getCurrentWebview }] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/webview"),
  ]);
  const appWindow = getCurrentWindow();
  const webview = getCurrentWebview();
  const nativeTheme = getThemeDefinition(theme).native;
  const windowBackgroundColor = nativeTheme.backgroundColor;
  // For transparent themes the macOS vibrancy view IS the window background. Painting
  // any non-clear color over it hides the blur, so the window/webview must be fully
  // transparent and let the NSVisualEffectView (set below) supply the gray frost.
  const transparent = { red: 0, green: 0, blue: 0, alpha: 0 };
  const webviewBackgroundColor = nativeTheme.transparentChrome ? transparent : windowBackgroundColor;
  const appWindowBackgroundColor = nativeTheme.transparentChrome ? transparent : windowBackgroundColor;

  await Promise.allSettled([
    appWindow.setBackgroundColor(appWindowBackgroundColor),
    webview.setBackgroundColor(webviewBackgroundColor),
  ]);

  if (nativeTheme.effect !== "glass") {
    await appWindow.clearEffects().catch(() => undefined);
    return;
  }

  const platform = document.documentElement.dataset.platform;
  const effects =
    platform === "macos"
      ? // UnderWindowBackground is the most translucent macOS material: it passes
        // the real desktop colors through (unlike HudWindow, which flattens them to
        // gray) so the CSS blur(40px) saturate(200%) can render a vivid glass.
        { effects: [Effect.UnderWindowBackground], state: EffectState.Active, radius: 14 }
      : platform === "windows"
        ? // Acrylic and Blur are known to make Windows window moves/resizes lag.
          // Mica is composed by DWM without that penalty; on Windows 10 it is
          // unsupported and intentionally becomes a no-op instead of falling back.
          { effects: [Effect.Mica] }
        : null;

  if (effects) {
    await appWindow.setEffects(effects).catch(() => undefined);
  }
}
