import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { Clock3, Search, TerminalSquare } from "lucide-react";

const HISTORY_PAGE_SIZE = 120;

export function CommandHistoryPanel({
  commands,
  onPick,
}: {
  commands: string[];
  onPick: (command: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const listRef = useRef<HTMLDivElement | null>(null);
  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) => command.toLowerCase().includes(normalized));
  }, [commands, query]);
  const visibleCommands = filteredCommands.slice(0, visibleCount);

  useEffect(() => {
    setVisibleCount(HISTORY_PAGE_SIZE);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query, commands.length]);

  function loadNextPage(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 48) return;
    setVisibleCount((current) => Math.min(filteredCommands.length, current + HISTORY_PAGE_SIZE));
  }

  return (
    <section className="history-panel" aria-label="历史命令">
      <div className="history-head">
        <div>
          <span className="eyebrow">历史命令</span>
          <strong>{commands.length}/10000</strong>
        </div>
        <Clock3 size={16} />
      </div>

      <label className="history-search">
        <Search size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索命令"
          spellCheck={false}
        />
      </label>

      <div className="history-list" ref={listRef} onScroll={loadNextPage}>
        {visibleCommands.length > 0 ? (
          <>
            {visibleCommands.map((command, index) => (
              <button
                key={`${index}-${command}`}
                type="button"
                className="history-row"
                onClick={() => onPick(command)}
                title={command}
              >
                <TerminalSquare size={12} />
                <code>{command}</code>
              </button>
            ))}
            {visibleCommands.length < filteredCommands.length && (
              <div className="history-more">继续向下滚动加载更多</div>
            )}
          </>
        ) : (
          <div className="history-empty">
            <TerminalSquare size={16} />
            <span>{commands.length === 0 ? "暂无历史命令" : "没有匹配命令"}</span>
          </div>
        )}
      </div>
    </section>
  );
}
