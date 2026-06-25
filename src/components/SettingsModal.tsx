import { Moon, Sun, X } from "lucide-react";

export type AppTheme = "dark" | "light";

export function SettingsModal({
  theme,
  terminalFontSize,
  onThemeChange,
  onTerminalFontSizeChange,
  onClose,
}: {
  theme: AppTheme;
  terminalFontSize: number;
  onThemeChange: (theme: AppTheme) => void;
  onTerminalFontSizeChange: (size: number) => void;
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
            <h3>主题</h3>
            <p>选择界面的显示风格。终端内容保持高对比度，便于阅读。</p>
          </div>

          <div className="theme-options" role="radiogroup" aria-label="主题">
            <button
              type="button"
              className={`theme-option ${theme === "dark" ? "on" : ""}`}
              role="radio"
              aria-checked={theme === "dark"}
              onClick={() => onThemeChange("dark")}
            >
              <span className="theme-preview dark">
                <span />
                <span />
              </span>
              <span className="theme-option-text">
                <Moon size={15} />
                暗色
              </span>
            </button>

            <button
              type="button"
              className={`theme-option ${theme === "light" ? "on" : ""}`}
              role="radio"
              aria-checked={theme === "light"}
              onClick={() => onThemeChange("light")}
            >
              <span className="theme-preview light">
                <span />
                <span />
              </span>
              <span className="theme-option-text">
                <Sun size={15} />
                亮色
              </span>
            </button>
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
