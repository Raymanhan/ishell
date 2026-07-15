import { Droplets, Layers, X } from "lucide-react";
import {
  appThemeDefinitions,
  appThemeOrder,
  type AppTheme,
  type ThemeIcon,
} from "../constants/theme";

const themeIcons: Record<ThemeIcon, typeof Layers> = {
  droplets: Droplets,
  layers: Layers,
};

export function SettingsModal({
  theme,
  terminalFontSize,
  autoHideTopBar,
  onThemeChange,
  onTerminalFontSizeChange,
  onAutoHideTopBarChange,
  onClose,
}: {
  theme: AppTheme;
  terminalFontSize: number;
  autoHideTopBar: boolean;
  onThemeChange: (theme: AppTheme) => void;
  onTerminalFontSizeChange: (size: number) => void;
  onAutoHideTopBarChange: (autoHide: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
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
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭设置">
            <X size={17} />
          </button>
        </div>

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
      </section>
    </div>
  );
}
