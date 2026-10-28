import { useCallback, useEffect, useState } from "react";
import { command, isTauri } from "../../api/tauri";
import type { Snippet, SnippetInput } from "../../types";

/** Browser demo only: snippets live in localStorage instead of the app database. */
const DEMO_SNIPPETS_KEY = "ishell.demoSnippets";

const demoSeed: Snippet[] = [
  {
    id: "demo-disk",
    name: "磁盘占用",
    command: "df -h",
    description: "查看各挂载点的使用情况",
    run: true,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "demo-logs",
    name: "跟随系统日志",
    command: "journalctl -f -n 100",
    description: "",
    run: false,
    sortOrder: 1,
    createdAt: 0,
    updatedAt: 0,
  },
];

function readDemoSnippets(): Snippet[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DEMO_SNIPPETS_KEY) ?? "null");
    return Array.isArray(parsed) ? parsed : demoSeed;
  } catch {
    return demoSeed;
  }
}

function writeDemoSnippets(snippets: Snippet[]) {
  try {
    window.localStorage.setItem(DEMO_SNIPPETS_KEY, JSON.stringify(snippets));
  } catch {
    // The demo keeps working without persistence.
  }
}

/** Saved command snippets, loaded once and kept in sync with the app database. */
export function useSnippets(showNotice: (message: string) => void) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);

  useEffect(() => {
    if (!isTauri) {
      setSnippets(readDemoSnippets());
      return;
    }
    command<Snippet[]>("list_snippets")
      .then(setSnippets)
      .catch((error) => showNotice(String(error)));
  }, [showNotice]);

  const save = useCallback(async (input: SnippetInput) => {
    if (!isTauri) {
      const current = readDemoSnippets();
      const existing = current.find((item) => item.id === input.id);
      const now = Date.now() / 1000;
      const saved: Snippet = {
        id: existing?.id ?? crypto.randomUUID(),
        name: input.name.trim() || input.command.trim().split("\n")[0],
        command: input.command.trimEnd(),
        description: input.description.trim(),
        run: input.run,
        sortOrder: existing?.sortOrder ?? current.length,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const next = existing
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved];
      writeDemoSnippets(next);
      setSnippets(next);
      return saved;
    }
    const saved = await command<Snippet>("save_snippet", { input });
    setSnippets((current) =>
      current.some((item) => item.id === saved.id)
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved],
    );
    return saved;
  }, []);

  const remove = useCallback(async (id: string) => {
    if (isTauri) {
      await command("delete_snippet", { id });
    } else {
      writeDemoSnippets(readDemoSnippets().filter((item) => item.id !== id));
    }
    setSnippets((current) => current.filter((item) => item.id !== id));
  }, []);

  return { snippets, save, remove };
}

/** Terminal input for a snippet: line breaks become Enter, plus a final Enter when it should run. */
export function snippetInput(snippet: Pick<Snippet, "command" | "run">) {
  const text = snippet.command.replace(/\r?\n/g, "\r");
  return snippet.run ? `${text}\r` : text;
}
