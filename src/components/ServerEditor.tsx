import { FileText, Folder, KeyRound, Lock, Palette, Server, ShieldCheck, Trash2, X } from "lucide-react";
import { swatches } from "../constants/theme";
import type { ServerInput } from "../types";

export type ServerForm = ServerInput & { password: string; tagsText: string };

export function ServerEditor({
  form,
  setForm,
  saving,
  onSave,
  onClose,
  onDelete,
}: {
  form: ServerForm;
  setForm: (form: ServerForm) => void;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm({ ...form, [key]: value });
  };

  return (
    <div className="editor-backdrop">
      <form
        className="editor-sheet server-editor-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div className="editor-header">
          <div className="editor-title-block">
            <span>Connection</span>
            <h2>{form.id ? "编辑服务器" : "新建服务器"}</h2>
            <small>
              <Folder size={12} />
              {form.group || "Default"}
            </small>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <div className="editor-body">
          <section className="editor-section">
            <div className="section-heading">
              <Server size={15} />
              <div>
                <strong>连接信息</strong>
                <span>服务器名称、地址和登录用户</span>
              </div>
            </div>
            <div className="form-grid">
              <label className="field wide">
                <span>名称</span>
                <input value={form.name} onChange={(event) => update("name", event.target.value)} autoFocus />
              </label>
              <label className="field host-field">
                <span>主机</span>
                <input value={form.host} onChange={(event) => update("host", event.target.value)} />
              </label>
              <label className="field port-field">
                <span>端口</span>
                <input type="number" min={1} max={65535} value={form.port} onChange={(event) => update("port", Number(event.target.value))} />
              </label>
              <label className="field wide">
                <span>用户</span>
                <input value={form.username} onChange={(event) => update("username", event.target.value)} />
              </label>
            </div>
          </section>

          <section className="editor-section">
            <div className="section-heading">
              <KeyRound size={15} />
              <div>
                <strong>认证方式</strong>
                <span>选择密码或私钥登录</span>
              </div>
            </div>
            <div className="auth-switch">
              <button type="button" className={form.authType === "password" ? "active" : ""} onClick={() => update("authType", "password")}>
                <KeyRound size={16} />
                <span>
                  <strong>密码</strong>
                  <small>使用账户密码连接</small>
                </span>
              </button>
              <button type="button" className={form.authType === "key" ? "active" : ""} onClick={() => update("authType", "key")}>
                <ShieldCheck size={16} />
                <span>
                  <strong>私钥</strong>
                  <small>使用本地密钥文件</small>
                </span>
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
              <input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} placeholder={form.id ? "留空则不修改" : ""} />
            </label>
          </section>

          <section className="editor-section">
            <div className="section-heading">
              <Palette size={15} />
              <div>
                <strong>标识</strong>
                <span>用于连接树中的颜色和检索</span>
              </div>
            </div>
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
            <div className="section-heading">
              <FileText size={15} />
              <div>
                <strong>备注</strong>
                <span>记录用途、跳板机或维护说明</span>
              </div>
            </div>
            <label className="field">
              <span>备注内容</span>
              <textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} />
            </label>
          </section>
        </div>

        <div className="editor-actions">
          {onDelete && (
            <button className="danger-button" type="button" onClick={onDelete}>
              <Trash2 size={16} />
              删除
            </button>
          )}
          <button className="solid-button" type="submit" disabled={saving}>
            <Lock size={16} />
            {saving ? "保存中" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
