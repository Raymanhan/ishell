import { useState } from "react";
import { Download, Droplets, Layers, RefreshCw, X } from "lucide-react";
import {
  clampTailViewerLines,
  MAX_TAIL_VIEWER_LINES,
  MIN_TAIL_VIEWER_LINES,
} from "../constants/tail";
import {
  appThemeDefinitions,
  appThemeOrder,
  type AppTheme,
  type ThemeIcon,
} from "../constants/theme";
import type { UpdaterState } from "../features/updater/useUpdater";

const themeIcons: Record<ThemeIcon, typeof Layers> = {
  droplets: Droplets,
  layers: Layers,
};

export function SettingsModal({
  theme,
  terminalFontSize,
  tailViewerDefaultLines,
  autoHideTopBar,
  updater,
  autoCheckUpdates,
  onThemeChange,
  onTerminalFontSizeChange,
  onTailViewerDefaultLinesChange,
  onAutoHideTopBarChange,
  onAutoCheckUpdatesChange,
  onCheckUpdates,
  onInstallUpdate,
  onClose,
}: {
  theme: AppTheme;
  terminalFontSize: number;
  tailViewerDefaultLines: number;
  autoHideTopBar: boolean;
  updater: UpdaterState;
  autoCheckUpdates: boolean;
  onThemeChange: (theme: AppTheme) => void;
  onTerminalFontSizeChange: (size: number) => void;
  onTailViewerDefaultLinesChange: (lines: number) => void;
  onAutoHideTopBarChange: (autoHide: boolean) => void;
  onAutoCheckUpdatesChange: (enabled: boolean) => void;
  onCheckUpdates: () => void;
  onInstallUpdate: () => void;
  onClose: () => void;
}) {
  const [tailLinesDraft, setTailLinesDraft] = useState(String(tailViewerDefaultLines));

  function commitTailViewerDefaultLines() {
    const parsed = Number(tailLinesDraft);
    const next = Number.isFinite(parsed)
      ? clampTailViewerLines(parsed)
      : tailViewerDefaultLines;
    setTailLinesDraft(String(next));
    onTailViewerDefaultLinesChange(next);
  }

  function closeSettings() {
    commitTailViewerDefaultLines();
    onClose();
  }

  return (
    <div className="settings-backdrop" onMouseDown={closeSettings}>
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="eyebrow">Settings</span>
            <h2 id="settings-title">设置</h2>
          </div>
          <button type="button" className="icon-button" onClick={closeSettings} aria-label="关闭设置">
            <X size={17} />
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <div className="settings-section-copy">
              <h3>顶部栏</h3>
              <p>开启后，顶部栏会在鼠标离开时隐藏，移到窗口顶端时重新显示。</p>
            </div>

            <label className="settings-toggle">
              <span>自动隐藏顶部栏</span>
              <input
                type="checkbox"
                checked={autoHideTopBar}
                onChange={(event) => onAutoHideTopBarChange(event.target.checked)}
              />
            </label>
          </div>

          <div className="settings-section">
            <div className="settings-section-copy">
              <h3>主题</h3>
              <p>选择界面的显示风格。终端内容保持高对比度，便于阅读。</p>
            </div>

            <div className="theme-options" role="radiogroup" aria-label="主题">
              {appThemeOrder.map((themeId) => {
                const option = appThemeDefinitions[themeId];
                const Icon = themeIcons[option.icon];

                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`theme-option ${theme === option.id ? "on" : ""}`}
                    role="radio"
                    aria-checked={theme === option.id}
                    onClick={() => onThemeChange(option.id)}
                  >
                    <span className={`theme-preview ${option.previewClassName}`}>
                      <span />
                      <span />
                    </span>
                    <span className="theme-option-text">
                      <Icon size={15} />
                      {option.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-copy">
              <h3>终端文字</h3>
              <p>调整 Shell 内容的字号，已打开的会话会立即生效。</p>
            </div>

            <label className="settings-range">
              <span>字号</span>
              <input
                type="range"
                min={11}
                max={20}
                step={1}
                value={terminalFontSize}
                onChange={(event) => onTerminalFontSizeChange(Number(event.target.value))}
              />
              <strong>{terminalFontSize}px</strong>
            </label>
          </div>

          <div className="settings-section">
            <div className="settings-section-copy">
              <h3>实时查看</h3>
              <p>设置新打开的实时查看窗口默认保留的最近日志行数。</p>
            </div>

            <label className="settings-number">
              <span className="settings-number-label">默认保留</span>
              <span className="settings-number-control">
                <input
                  type="number"
                  min={MIN_TAIL_VIEWER_LINES}
                  max={MAX_TAIL_VIEWER_LINES}
                  step={10}
                  value={tailLinesDraft}
                  onChange={(event) => setTailLinesDraft(event.target.value)}
                  onBlur={commitTailViewerDefaultLines}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <span>行</span>
              </span>
            </label>
          </div>

          <div className="settings-section">
            <div className="settings-section-copy">
              <h3>关于与更新</h3>
              <p>新版本发布后可以在应用内直接下载安装，安装完成会自动重启。</p>
            </div>

            <div className="settings-update">
              <div className="settings-update-copy">
                <span>
                  当前版本 {updater.currentVersion ? `v${updater.currentVersion}` : "—"}
                </span>
                <UpdateStatusLine updater={updater} />
              </div>
              {updater.status === "available" && updater.update ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    onInstallUpdate();
                    closeSettings();
                  }}
                >
                  <Download size={14} />
                  立即更新
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={onCheckUpdates}
                  disabled={updater.status === "checking" || updater.status === "downloading" || updater.status === "installing"}
                >
                  <RefreshCw size={14} className={updater.status === "checking" ? "spin" : undefined} />
                  检查更新
                </button>
              )}
            </div>

            <label className="settings-toggle">
              <span>
                自动检查更新
                <small>启动后及每 6 小时检查一次</small>
              </span>
              <input
                type="checkbox"
                checked={autoCheckUpdates}
                onChange={(event) => onAutoCheckUpdatesChange(event.target.checked)}
              />
            </label>
          </div>
        </div>
      </section>
    </div>
  );
}

function UpdateStatusLine({ updater }: { updater: UpdaterState }) {
  let text = "";
  let tone = "";
  switch (updater.status) {
    case "checking":
      text = "正在检查更新…";
      break;
    case "up-to-date":
      text = "已是最新版本";
      tone = "ok";
      break;
    case "available":
      text = updater.update ? `发现新版本 v${updater.update.version}` : "";
      tone = "accent";
      break;
    case "downloading":
    case "installing":
      text = "正在更新…";
      break;
    case "error":
      text = updater.error ?? "";
      tone = "bad";
      break;
  }
  if (!text) return null;
  return <small className={`settings-update-status ${tone}`}>{text}</small>;
}
