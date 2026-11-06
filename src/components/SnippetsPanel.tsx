import { useMemo, useState, type FormEvent } from "react";
import { CornerDownLeft, Pencil, Plus, Search, SquareCode, Trash2, Type } from "lucide-react";
import type { Snippet, SnippetInput } from "../types";

import { t } from "../i18n";
const emptyDraft: SnippetInput = { id: null, name: "", command: "", description: "", run: true };

/** Saved commands for the side panel: click one to send it to the focused terminal. */
export function SnippetsPanel({
  snippets,
  broadcasting,
  onSend,
  onSave,
  onDelete,
}: {
  snippets: Snippet[];
  /** Broadcast input is on, so a sent snippet reaches every broadcast session. */
  broadcasting: boolean;
  onSend: (snippet: Snippet) => void;
  onSave: (input: SnippetInput) => Promise<unknown>;
  onDelete: (snippet: Snippet) => void;
}) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<SnippetInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return snippets;
    return snippets.filter((snippet) =>
      [snippet.name, snippet.command, snippet.description].some((text) => text.toLowerCase().includes(normalized)),
    );
  }, [query, snippets]);

  function edit(snippet: Snippet) {
    setError(null);
    setDraft({
      id: snippet.id,
      name: snippet.name,
      command: snippet.command,
      description: snippet.description,
      run: snippet.run,
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    if (!draft.command.trim()) {
      setError(t("命令不能为空"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setDraft(null);
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="history-panel snippets-panel" aria-label={t("命令片段")}>
      <div className="snippets-toolbar">
        <label className="history-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("搜索片段")}
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="snippets-add"
          title={t("新建片段")}
          aria-label={t("新建片段")}
          onClick={() => {
            setError(null);
            setDraft(emptyDraft);
          }}
        >
          <Plus size={14} />
        </button>
      </div>

      {draft && (
        <form className="snippet-editor" onSubmit={submit}>
          <input
            value={draft.name}
            placeholder={t("名称（可选）")}
            aria-label={t("名称")}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <textarea
            value={draft.command}
            placeholder={t("命令，可多行\n例如：sudo systemctl restart nginx")}
            aria-label={t("命令")}
            rows={4}
            spellCheck={false}
            autoFocus
            onChange={(event) => setDraft({ ...draft, command: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(event);
            }}
          />
          <input
            value={draft.description}
            placeholder={t("说明（可选）")}
            aria-label={t("说明")}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
          <label className="snippet-run-toggle">
            <input
              type="checkbox"
              checked={draft.run}
              onChange={(event) => setDraft({ ...draft, run: event.target.checked })}
            />
            {t("发送后立即执行（自动回车）")}</label>
          {error && <div className="snippet-error">{error}</div>}
          <div className="snippet-editor-actions">
            <button type="button" className="btn-ghost" onClick={() => setDraft(null)}>
              {t("取消")}</button>
            <button type="submit" className="solid-button" disabled={saving}>
              {saving ? t("保存中…") : t("保存")}
            </button>
          </div>
        </form>
      )}

      <div className="history-list snippets-list">
        {filtered.length > 0 ? (
          filtered.map((snippet) => (
            <div key={snippet.id} className="snippet-row">
              <button
                type="button"
                className="snippet-send"
                onClick={() => onSend(snippet)}
                title={snippet.run ? t("发送并执行") : t("发送到终端（不执行）")}
              >
                <span className="snippet-name">
                  {snippet.run ? <CornerDownLeft size={12} /> : <Type size={12} />}
                  {snippet.name}
                </span>
                <code>{snippet.command}</code>
                {snippet.description && <span className="snippet-description">{snippet.description}</span>}
              </button>
              <div className="snippet-actions">
                <button type="button" title={t("编辑")} aria-label={t("编辑 {0}", snippet.name)} onClick={() => edit(snippet)}>
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  title={t("删除")}
                  aria-label={t("删除 {0}", snippet.name)}
                  className="danger"
                  onClick={() => onDelete(snippet)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="history-empty">
            <SquareCode size={16} />
            <span>{snippets.length === 0 ? t("还没有片段，点 + 保存常用命令") : t("没有匹配的片段")}</span>
          </div>
        )}
      </div>

      <p className="snippets-hint">
        {broadcasting ? t("广播已开启：片段会发送到所有广播会话") : t("点击片段发送到当前终端")}
      </p>
    </section>
  );
}
