import { useEffect, useRef, useState } from "react";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from "lucide-react";
import { getTerminalSearchDecorations, type AppTheme } from "../constants/theme";

const isMac = /mac/i.test(navigator.platform) || /mac os/i.test(navigator.userAgent);

/** The shortcut that opens terminal search: Cmd+F on macOS, Ctrl+Shift+F elsewhere (Ctrl+F belongs to the shell). */
export function isTerminalSearchShortcut(event: KeyboardEvent) {
  if (event.type !== "keydown" || event.key.toLowerCase() !== "f" || event.altKey) return false;
  return isMac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey;
}

export const terminalSearchShortcutLabel = isMac ? "⌘F" : "Ctrl+Shift+F";

/** Floating find bar for one terminal's scrollback. */
export function TerminalSearchBar({
  search,
  theme,
  openSignal,
  onClose,
}: {
  search: SearchAddon;
  theme: AppTheme;
  /** Changes every time the shortcut is pressed, so an open bar re-focuses and selects its text. */
  openSignal: number;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const subscription = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResults({ index: resultIndex, count: resultCount });
    });
    return () => subscription.dispose();
  }, [search]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [openSignal]);

  useEffect(() => () => search.clearDecorations(), [search]);

  function options(incremental = false): ISearchOptions {
    return {
      caseSensitive,
      regex,
      wholeWord,
      incremental,
      decorations: getTerminalSearchDecorations(theme),
    };
  }

  function run(direction: "next" | "previous", term = query, incremental = false) {
    if (!term) {
      search.clearDecorations();
      setResults(null);
      setInvalid(false);
      return;
    }
    if (regex) {
      try {
        new RegExp(term);
      } catch {
        search.clearDecorations();
        setResults(null);
        setInvalid(true);
        return;
      }
    }
    setInvalid(false);
    const found = direction === "next"
      ? search.findNext(term, options(incremental))
      : search.findPrevious(term, options());
    if (!found) setResults({ index: -1, count: 0 });
  }

  // Re-run when an option changes so the highlights match the toggles.
  useEffect(() => {
    run("next", query, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSensitive, regex, wholeWord, theme]);

  const status = invalid
    ? "正则无效"
    : !query || !results
      ? ""
      : results.count === 0
        ? "无结果"
        : results.index >= 0
          ? `${results.index + 1}/${results.count}`
          : `${results.count} 项`;

  return (
    <div
      className="terminal-search"
      role="search"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <input
        ref={inputRef}
        value={query}
        placeholder="搜索终端输出"
        aria-label="搜索终端输出"
        spellCheck={false}
        className={invalid ? "invalid" : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          run("next", event.target.value, true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            run(event.shiftKey ? "previous" : "next");
          }
        }}
      />
      <span className="terminal-search-status" aria-live="polite">{status}</span>
      <button
        type="button"
        className={`terminal-search-toggle ${caseSensitive ? "on" : ""}`}
        aria-pressed={caseSensitive}
        title="区分大小写"
        onClick={() => setCaseSensitive((value) => !value)}
      >
        <CaseSensitive size={14} />
      </button>
      <button
        type="button"
        className={`terminal-search-toggle ${wholeWord ? "on" : ""}`}
        aria-pressed={wholeWord}
        title="全字匹配"
        onClick={() => setWholeWord((value) => !value)}
      >
        <WholeWord size={14} />
      </button>
      <button
        type="button"
        className={`terminal-search-toggle ${regex ? "on" : ""}`}
        aria-pressed={regex}
        title="正则表达式"
        onClick={() => setRegex((value) => !value)}
      >
        <Regex size={14} />
      </button>
      <button type="button" title="上一个（Shift+Enter）" disabled={!query} onClick={() => run("previous")}>
        <ArrowUp size={14} />
      </button>
      <button type="button" title="下一个（Enter）" disabled={!query} onClick={() => run("next")}>
        <ArrowDown size={14} />
      </button>
      <button type="button" title="关闭（Esc）" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}
