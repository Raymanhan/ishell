import { useState } from "react";
import { Eye, EyeOff, PlugZap, X } from "lucide-react";
import { swatches } from "../constants/theme";
import type { ServerInput } from "../types";

export type ServerForm = ServerInput & { password: string; tagsText: string };

export function ServerEditor({
  form,
  setForm,
  saving,
  testing,
  testFeedback,
  onSave,
  onTest,
  onClose,
  onDelete,
}: {
  form: ServerForm;
  setForm: (form: ServerForm) => void;
  saving: boolean;
  testing: boolean;
  testFeedback: { kind: "info" | "success" | "error"; message: string } | null;
  onSave: () => void;
  onTest: () => void;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm({ ...form, [key]: value });
  };
  const title = form.id ? "编辑服务器" : "新增服务器";

  return (
    <div
      className="editor-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="editor-sheet server-editor-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <header className="server-editor-head">
          <div>
            <span>SSH CONNECTION</span>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="server-editor-layout">
          <div className="editor-body server-editor-main">
            <section className="editor-section">
              <div className="form-grid">
                <label className="field">
                  <span>名称</span>
                  <input value={form.name} onChange={(event) => update("name", event.target.value)} autoFocus />
                </label>
                <label className="field username-field">
                  <span>用户</span>
                  <input value={form.username} onChange={(event) => update("username", event.target.value)} />
                </label>
                <label className="field host-field">
                  <span>主机</span>
                  <input value={form.host} onChange={(event) => update("host", event.target.value)} />
                </label>
                <label className="field port-field">
                  <span>端口</span>
                  <input type="number" min={1} max={65535} value={form.port} onChange={(event) => update("port", Number(event.target.value))} />
                </label>
              </div>
            </section>

            <section className="editor-section">
              <span className="field-group-label">认证</span>
              <div className="auth-switch">
                <button type="button" className={form.authType === "password" ? "active" : ""} onClick={() => update("authType", "password")}>
                  <span>密码</span>
                </button>
                <button type="button" className={form.authType === "key" ? "active" : ""} onClick={() => update("authType", "key")}>
                  <span>私钥</span>
                </button>
              </div>

              {form.authType === "key" && (
                <label className="field">
                  <span>私钥路径</span>
                  <input value={form.keyPath ?? ""} onChange={(event) => update("keyPath", event.target.value)} />
                </label>
              )}

              <label className="field">
                <span>{form.authType === "key" ? "私钥密码" : "密码"}</span>
                <div className="password-input-wrap">
                  <input type={passwordVisible ? "text" : "password"} value={form.password} onChange={(event) => update("password", event.target.value)} placeholder={form.id ? "留空则不修改" : ""} />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setPasswordVisible((visible) => !visible)}
                    title={passwordVisible ? "隐藏密码" : "显示密码"}
                    aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                  >
                    {passwordVisible ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                </div>
              </label>
            </section>

            <section className="editor-section">
              <span className="field-group-label">归档</span>
              <label className="field">
                <span>标签</span>
                <input value={form.tagsText} onChange={(event) => update("tagsText", event.target.value)} />
              </label>
              <div className="swatches" aria-label="连接颜色">
                {swatches.map((color) => (
                  <button key={color} type="button" className={form.color === color ? "active" : ""} style={{ backgroundColor: color }} onClick={() => update("color", color)} aria-label={color} />
                ))}
              </div>
            </section>

            <section className="editor-section">
              <label className="field">
                <span>备注</span>
                <textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} />
              </label>
            </section>
          </div>
        </div>

        <div className="editor-actions">
          {onDelete && (
            <button className="danger-button" type="button" onClick={onDelete}>
              删除
            </button>
          )}
          <span
            className={`connection-test-feedback ${testFeedback ? testFeedback.kind : ""}`}
            aria-live="polite"
          >
            {testFeedback?.message}
          </span>
          <button className="btn-ghost" type="button" onClick={onClose}>
            取消
          </button>
          <button className="btn-ghost" type="button" onClick={onTest} disabled={saving || testing}>
            <PlugZap size={14} />
            {testing ? "测试中" : "测试连接"}
          </button>
          <button className="solid-button" type="submit" disabled={saving}>
            {saving ? "保存中" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
