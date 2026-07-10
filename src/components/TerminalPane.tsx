import { memo, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { RefreshCw } from "lucide-react";
import { command, isTauri } from "../api/tauri";
import { getTerminalTheme, type AppTheme } from "../constants/theme";
import type { ShellTab } from "../features/shell/types";
import type {
  TerminalClosedPayload,
  TerminalDataPayload,
  TerminalReadyPayload,
  TerminalSnapshotPayload,
} from "../types";

const passwordPromptPattern = /(?:password|passphrase|密码|口令)[^:\n\r]*[:：]\s*$/i;
const platformSource = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
const isWindowsPlatform = platformSource.includes("win");
const terminalFontFamily = platformSource.includes("win")
  ? '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", monospace'
  : '"SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace';
const HISTORY_SUGGESTION_LIMIT = 8;

interface HistorySuggestState {
  active: boolean;
  query: string;
  selectedIndex: number;
  x: number;
  y: number;
  maxHeight: number;
}

const closedHistorySuggest: HistorySuggestState = {
  active: false,
  query: "",
  selectedIndex: 0,
  x: 0,
  y: 0,
  maxHeight: 248,
};

function TerminalPaneBase({
  tab,
  visible,
  theme,
  fontSize,
  layoutSignal,
  setNotice,
  onReady,
  onClosed,
  onReconnect,
  onCommandSubmitted,
  pasteRequest,
  commandRequest,
  commandHistory,
}: {
  tab: ShellTab;
  visible: boolean;
  theme: AppTheme;
  fontSize: number;
  layoutSignal: string;
  setNotice: (notice: string) => void;
  onReady?: () => void;
  onClosed?: (reason: string) => void;
  onReconnect?: () => void;
  onCommandSubmitted?: (command: string) => void;
  pasteRequest?: { id: number; command: string } | null;
  commandRequest?: { id: number; command: string; requirePromptStart?: boolean; blockedNotice?: string } | null;
  commandHistory: string[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(tab.sessionId);
  const closedSessionRef = useRef<string | null>(null);
  const readySessionRef = useRef<string | null>(null);
  const renderedOffsetRef = useRef<Record<string, number>>({});
  const connectingNoticeRef = useRef(false);
  const fitTimerRef = useRef<number | null>(null);
  const fitSettledTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef("");
  const onReadyRef = useRef(onReady);
  const onClosedRef = useRef(onClosed);
  const onCommandSubmittedRef = useRef(onCommandSubmitted);
  const commandDraftRef = useRef("");
  const sensitiveInputRef = useRef(false);
  const commandHistoryRef = useRef(commandHistory);
  const historySuggestRef = useRef<HistorySuggestState>(closedHistorySuggest);
  const selectedSuggestionRef = useRef<HTMLButtonElement | null>(null);
  const [historySuggest, setHistorySuggest] = useState<HistorySuggestState>(closedHistorySuggest);
  commandHistoryRef.current = commandHistory;

  const suggestedCommands = useMemo(
    () => getHistoryMatches(historySuggest.query),
    [commandHistory, historySuggest.query],
  );

  useEffect(() => {
    sessionRef.current = tab.sessionId;
    commandDraftRef.current = "";
    sensitiveInputRef.current = false;
    closeHistorySuggest();
    lastSizeRef.current = "";
    if (tab.sessionId && closedSessionRef.current !== tab.sessionId) {
      if (terminalRef.current) terminalRef.current.options.disableStdin = false;
    }
    if (tab.sessionId && closedSessionRef.current && closedSessionRef.current !== tab.sessionId) {
      closedSessionRef.current = null;
    }
    window.setTimeout(reportTerminalSize, 0);
  }, [tab.sessionId]);

  function markReady(sessionId: string) {
    if (readySessionRef.current === sessionId) return;
    readySessionRef.current = sessionId;
    onReadyRef.current?.();
  }

  function writeTerminalData(sessionId: string, offset: number, data: string) {
    const renderedOffset = renderedOffsetRef.current[sessionId] ?? 0;
    const dataLength = Array.from(data).length;
    const eventEnd = offset + dataLength;
    if (eventEnd <= renderedOffset) return;

    const overlap = Math.max(0, renderedOffset - offset);
    const nextData = overlap > 0 ? Array.from(data).slice(overlap).join("") : data;
    terminalRef.current?.write(nextData);
    renderedOffsetRef.current[sessionId] = eventEnd;
    trackSensitivePrompt(nextData);
    // Scan the full payload, not just the part actually written: if an earlier
    // chunk carrying the marker was dropped (e.g. a `terminal:ready`/`terminal:data`
    // listener race on fast/reused sessions), the snapshot catch-up still delivers
    // the whole buffer here and `overlap` trims it out of `nextData` before we can see it.
    if (data.includes("[iShell] connected")) markReady(sessionId);
  }

  function reportTerminalSize() {
    const terminal = terminalRef.current;
    const sessionId = sessionRef.current;
    if (!isTauri || !terminal || !sessionId) return;
    const cols = terminal.cols;
    const rows = terminal.rows;
    if (!cols || !rows) return;
    const nextSize = `${sessionId}:${cols}:${rows}`;
    if (lastSizeRef.current === nextSize) return;
    lastSizeRef.current = nextSize;
    command("terminal_resize", { sessionId, cols, rows }).catch((error) => setNotice(String(error)));
  }

  function updateCommandDraft(data: string) {
    const text = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    let draft = commandDraftRef.current;
    for (const character of Array.from(text)) {
      if (character === "\r" || character === "\n") {
        if (!sensitiveInputRef.current) {
          const commandText = readVisibleCommand() || draft.trim();
          if (commandText) onCommandSubmittedRef.current?.(commandText);
        }
        sensitiveInputRef.current = false;
        draft = "";
      } else if (character === "\x03" || character === "\x15") {
        sensitiveInputRef.current = false;
        draft = "";
      } else if (character === "\x7f" || character === "\b") {
        draft = Array.from(draft).slice(0, -1).join("");
      } else if (character >= " ") {
        draft += character;
      }
    }
    commandDraftRef.current = draft;
  }

  function trackSensitivePrompt(data: string) {
    const plain = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const tail = plain.split(/\r?\n/).pop()?.trimEnd() ?? "";
    if (passwordPromptPattern.test(tail)) {
      sensitiveInputRef.current = true;
      commandDraftRef.current = "";
    }
  }

  function readVisibleCommand() {
    const terminal = terminalRef.current;
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true).trimEnd() ?? "";
    const promptIndex = Math.max(line.lastIndexOf("$ "), line.lastIndexOf("# "), line.lastIndexOf("> "));
    return promptIndex >= 0 ? line.slice(promptIndex + 2).trim() : "";
  }

  function isAtShellPromptCommandStart() {
    const terminal = terminalRef.current;
    if (!terminal) return false;
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(false) ?? "";
    const cursorX = buffer.cursorX;
    const promptEnds = ["$ ", "# ", "> "]
      .map((prompt) => {
        const index = line.lastIndexOf(prompt, cursorX);
        return index >= 0 ? index + prompt.length : -1;
      })
      .filter((index) => index >= 0);
    if (promptEnds.length === 0) return false;
    return Math.max(...promptEnds) === cursorX;
  }

  function getHistoryMatches(query: string) {
    const normalized = query.trim().toLowerCase();
    const seen = new Set<string>();
    const matches: string[] = [];
    for (const historyCommand of commandHistoryRef.current) {
      const commandText = historyCommand.trim();
      if (!commandText || seen.has(commandText)) continue;
      if (normalized && !commandText.toLowerCase().includes(normalized)) continue;
      seen.add(commandText);
      matches.push(commandText);
      if (matches.length >= HISTORY_SUGGESTION_LIMIT) break;
    }
    return matches;
  }

  function updateHistorySuggest(next: HistorySuggestState) {
    historySuggestRef.current = next;
    setHistorySuggest(next);
  }

  function closeHistorySuggest() {
    updateHistorySuggest(closedHistorySuggest);
  }

  function positionHistorySuggest() {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const frame = container?.parentElement;
    if (!terminal || !container || !frame) return { x: 16, y: 16, maxHeight: 248 };

    const frameRect = frame.getBoundingClientRect();
    const clampPosition = (x: number, y: number) => {
      const popupWidth = Math.min(420, Math.max(220, frameRect.width - 24));
      const maxHeight = Math.min(248, Math.max(104, frameRect.height - 16));
      return {
        x: Math.min(Math.max(8, x), Math.max(8, frameRect.width - popupWidth - 8)),
        y: Math.min(Math.max(8, y), Math.max(8, frameRect.height - maxHeight - 8)),
        maxHeight,
      };
    };
    const helper = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    const helperRect = helper?.getBoundingClientRect();
    if (helperRect && helperRect.width > 0 && helperRect.height > 0) {
      return clampPosition(helperRect.left - frameRect.left, helperRect.bottom - frameRect.top + 6);
    }

    const containerRect = container.getBoundingClientRect();
    const cellWidth = terminal.cols > 0 ? containerRect.width / terminal.cols : fontSize * 0.62;
    const cellHeight = terminal.rows > 0 ? containerRect.height / terminal.rows : fontSize * 1.35;
    const buffer = terminal.buffer.active;
    return clampPosition(
      containerRect.left - frameRect.left + buffer.cursorX * cellWidth,
      containerRect.top - frameRect.top + (buffer.cursorY + 1) * cellHeight + 6,
    );
  }

  function openHistorySuggest() {
    updateHistorySuggest({
      active: true,
      query: "",
      selectedIndex: 0,
      ...positionHistorySuggest(),
    });
  }

  function setHistorySuggestQuery(query: string, selectedIndex = 0) {
    updateHistorySuggest({
      active: true,
      query,
      selectedIndex,
      ...positionHistorySuggest(),
    });
  }

  function pickHistorySuggestion(commandText: string) {
    closeHistorySuggest();
    terminalRef.current?.focus();
    rawSendTerminalInput(commandText);
  }

  function handleHistorySuggestInput(data: string) {
    const current = historySuggestRef.current;
    if (!current.active) return false;

    if (data === "\x1b") {
      closeHistorySuggest();
      return true;
    }
    if (data === "\x03") {
      closeHistorySuggest();
      return true;
    }
    if (data === "\r" || data === "\t") {
      const matches = getHistoryMatches(current.query);
      const commandText = matches[Math.min(current.selectedIndex, matches.length - 1)];
      if (commandText) pickHistorySuggestion(commandText);
      return true;
    }
    if (data === "\x7f" || data === "\b") {
      if (!current.query) {
        closeHistorySuggest();
        return true;
      }
      setHistorySuggestQuery(Array.from(current.query).slice(0, -1).join(""));
      return true;
    }
    if (data === "\x1b[A" || data === "\x1b[B") {
      const matches = getHistoryMatches(current.query);
      if (matches.length === 0) return true;
      const direction = data === "\x1b[A" ? -1 : 1;
      const selectedIndex = (current.selectedIndex + direction + matches.length) % matches.length;
      updateHistorySuggest({ ...current, selectedIndex, ...positionHistorySuggest() });
      return true;
    }

    const text = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const printable = Array.from(text).filter((character) => character >= " " && character !== "\x7f").join("");
    if (printable) {
      setHistorySuggestQuery(current.query + printable);
      return true;
    }
    return true;
  }

  function sendTerminalInput(data: string) {
    if (handleHistorySuggestInput(data)) return;
    rawSendTerminalInput(data);
  }

  function rawSendTerminalInput(data: string) {
    const currentSession = sessionRef.current;
    if (currentSession && closedSessionRef.current === currentSession) return;
    updateCommandDraft(data);
    if (isTauri && currentSession) {
      command("terminal_input", { sessionId: currentSession, data }).catch((error) => {
        setNotice(String(error));
        if (terminalRef.current) terminalRef.current.options.disableStdin = true;
      });
    } else if (!isTauri) {
      terminalRef.current?.write(data);
      if (data === "\r") {
        terminalRef.current?.write("\r\n$ ");
      }
    }
  }

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  useEffect(() => {
    onCommandSubmittedRef.current = onCommandSubmitted;
  }, [onCommandSubmitted]);

  useEffect(() => {
    commandHistoryRef.current = commandHistory;
  }, [commandHistory]);

  useEffect(() => {
    if (!containerRef.current) return;

    const fit = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFontFamily,
      fontSize,
      lineHeight: 1.35,
      scrollback: 8000,
      // Required for the glass theme: without this xterm paints an opaque
      // background (ignoring the #00000000 theme color) and covers the macOS
      // vibrancy across the whole terminal region.
      allowTransparency: true,
      theme: getTerminalTheme(theme),
    });

    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminal.writeln(`iShell · ${tab.title}`);
    terminal.writeln("");

    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.key === "Alt" &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !historySuggestRef.current.active &&
        !sensitiveInputRef.current &&
        commandDraftRef.current.length === 0 &&
        isAtShellPromptCommandStart()
      ) {
        openHistorySuggest();
        event.preventDefault();
        return false;
      }

      // Product shortcut on Windows is intentionally Win+C / Win+V. Keep
      // Ctrl+C available for sending SIGINT to the remote shell.
      if (!isWindowsPlatform || event.type !== "keydown" || !event.metaKey || event.ctrlKey || event.altKey) {
        return true;
      }

      if (event.key.toLowerCase() === "c") {
        const selection = terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch((error) => setNotice(`复制失败：${String(error)}`));
        }
        event.preventDefault();
        return false;
      }

      if (event.key.toLowerCase() === "v") {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (!text) return;
            closeHistorySuggest();
            rawSendTerminalInput(text);
          })
          .catch((error) => setNotice(`粘贴失败：${String(error)}`));
        event.preventDefault();
        return false;
      }

      return true;
    });

    terminal.onData((data) => sendTerminalInput(data));

    const fitWhenVisible = () => {
      // Skip while hidden (display:none) — the container has no size then.
      if (containerRef.current?.offsetParent === null) return;
      requestAnimationFrame(() => {
        fit.fit();
        reportTerminalSize();
        requestAnimationFrame(() => {
          fit.fit();
          reportTerminalSize();
        });
      });
    };
    const refit = () => {
      if (fitTimerRef.current !== null) window.clearTimeout(fitTimerRef.current);
      if (fitSettledTimerRef.current !== null) window.clearTimeout(fitSettledTimerRef.current);
      fitTimerRef.current = window.setTimeout(() => {
        fitTimerRef.current = null;
        fitWhenVisible();
      }, 16);
      fitSettledTimerRef.current = window.setTimeout(() => {
        fitSettledTimerRef.current = null;
        fitWhenVisible();
      }, 210);
    };
    window.addEventListener("resize", refit);
    // Refit when the container itself resizes (e.g. dragging the file dock).
    const observer = new ResizeObserver(refit);
    observer.observe(containerRef.current);

    terminalRef.current = terminal;
    fitRef.current = fit;

    return () => {
      window.removeEventListener("resize", refit);
      if (fitTimerRef.current !== null) window.clearTimeout(fitTimerRef.current);
      if (fitSettledTimerRef.current !== null) window.clearTimeout(fitSettledTimerRef.current);
      observer.disconnect();
      terminal.dispose();
    };
  }, [setNotice, tab.title]);

  useEffect(() => {
    if (!visible || !pasteRequest) return;
    terminalRef.current?.focus();
    closeHistorySuggest();
    rawSendTerminalInput(pasteRequest.command);
  }, [pasteRequest?.id, visible]);

  useEffect(() => {
    if (!visible || !commandRequest) return;
    closeHistorySuggest();
    if (
      commandRequest.requirePromptStart &&
      (sensitiveInputRef.current || commandDraftRef.current.length > 0 || !isAtShellPromptCommandStart())
    ) {
      setNotice(commandRequest.blockedNotice ?? "终端当前不在普通命令行状态，已取消操作");
      return;
    }
    terminalRef.current?.focus();
    rawSendTerminalInput(commandRequest.command);
  }, [commandRequest?.id, visible]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.theme = getTerminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = fontSize;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      reportTerminalSize();
    });
  }, [fontSize]);

  useEffect(() => {
    if (!isTauri) return;
    // `listen` resolves asynchronously. Under StrictMode the effect can be
    // torn down before the promise settles; guard with a cancelled flag so a
    // late-arriving listener is removed immediately, otherwise duplicate
    // listeners write every byte of output twice.
    let cancelled = false;
    let unlistenData: (() => void) | undefined;
    let unlistenReady: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;

    listen<TerminalDataPayload>("terminal:data", (event) => {
      if (event.payload.sessionId === sessionRef.current) {
        writeTerminalData(event.payload.sessionId, event.payload.offset, event.payload.data);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenData = unlisten;
    });

    listen<TerminalReadyPayload>("terminal:ready", (event) => {
      if (event.payload.sessionId === sessionRef.current) {
        markReady(event.payload.sessionId);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenReady = unlisten;
    });

    listen<TerminalClosedPayload>("terminal:closed", (event) => {
      if (event.payload.sessionId === sessionRef.current) {
        closedSessionRef.current = event.payload.sessionId;
        if (terminalRef.current) terminalRef.current.options.disableStdin = true;
        terminalRef.current?.writeln(`\r\n[iShell] ${event.payload.reason}`);
        setNotice(event.payload.reason);
        onClosedRef.current?.(event.payload.reason);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenClosed = unlisten;
    });

    return () => {
      cancelled = true;
      unlistenData?.();
      unlistenReady?.();
      unlistenClosed?.();
    };
  }, [setNotice]);

  useEffect(() => {
    if (!isTauri || !tab.sessionId) return;
    const sessionId = tab.sessionId;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const renderedOffset = renderedOffsetRef.current[sessionId] ?? 0;
      command<TerminalSnapshotPayload>("terminal_snapshot", { sessionId })
        .then((snapshot) => {
          if (cancelled || sessionRef.current !== sessionId) return;
          if (snapshot.ready) markReady(sessionId);
          if (!snapshot.data) return;
          if ((renderedOffsetRef.current[sessionId] ?? 0) > renderedOffset) return;
          writeTerminalData(sessionId, snapshot.startOffset, snapshot.data);
        })
        .catch((error) => setNotice(String(error)));
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [setNotice, tab.sessionId]);

  useEffect(() => {
    if (!terminalRef.current) return;
    if (!isTauri && tab.sessionId?.startsWith("demo-")) {
      terminalRef.current.clear();
      terminalRef.current.writeln(`[iShell] connected to ${tab.title}`);
      terminalRef.current.write("$ ");
    }
    if (isTauri && tab.state === "connecting" && !connectingNoticeRef.current) {
      if (terminalRef.current) terminalRef.current.options.disableStdin = false;
      terminalRef.current.writeln("\r\n[iShell] connecting...");
      connectingNoticeRef.current = true;
    }
    if (isTauri && tab.state === "closed") {
      if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    }
    if (tab.state !== "connecting") {
      connectingNoticeRef.current = false;
    }
  }, [tab.sessionId, tab.state, tab.title]);

  useEffect(() => {
    if (visible) {
      window.setTimeout(() => {
        fitRef.current?.fit();
        reportTerminalSize();
      }, 120);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const timers = [0, 40, 120, 240].map((delay) =>
      window.setTimeout(() => {
        fitRef.current?.fit();
        reportTerminalSize();
      }, delay),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [layoutSignal, visible]);

  useEffect(() => {
    if (!visible) closeHistorySuggest();
  }, [visible]);

  useEffect(() => {
    if (!historySuggest.active) return;
    selectedSuggestionRef.current?.scrollIntoView({ block: "nearest" });
  }, [historySuggest.active, historySuggest.selectedIndex, suggestedCommands.length]);

  return (
    <section className={`terminal-panel ${visible ? "active" : ""}`} aria-hidden={!visible}>
      <div className="terminal-frame">
        <div className="terminal-host" ref={containerRef} />
        {historySuggest.active && (
          <div
            className="terminal-history-suggest"
            style={{ left: historySuggest.x, top: historySuggest.y, maxHeight: historySuggest.maxHeight }}
            role="listbox"
            aria-label="历史命令候选"
          >
            <div className="terminal-history-suggest-head">
              <span>{historySuggest.query || "历史命令"}</span>
              <kbd>Enter</kbd>
            </div>
            <div
              className="terminal-history-suggest-list"
              style={{ maxHeight: Math.max(52, historySuggest.maxHeight - 30) }}
            >
              {suggestedCommands.length > 0 ? (
                suggestedCommands.map((commandText, index) => (
                  <button
                    key={`${index}-${commandText}`}
                    ref={index === historySuggest.selectedIndex ? selectedSuggestionRef : undefined}
                    type="button"
                    className={`terminal-history-suggest-row ${
                      index === historySuggest.selectedIndex ? "selected" : ""
                    }`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pickHistorySuggestion(commandText)}
                    title={commandText}
                    role="option"
                    aria-selected={index === historySuggest.selectedIndex}
                  >
                    <code>{commandText}</code>
                  </button>
                ))
              ) : (
                <div className="terminal-history-suggest-empty">没有匹配命令</div>
              )}
            </div>
          </div>
        )}
      </div>
      {tab.state === "closed" && (
        <button type="button" className="terminal-reconnect" onClick={onReconnect}>
          <RefreshCw size={13} />
          重新连接
        </button>
      )}
    </section>
  );
}

export const TerminalPane = memo(TerminalPaneBase, (previous, next) => {
  const prevTab = previous.tab;
  const nextTab = next.tab;
  return (
    prevTab.id === nextTab.id &&
    prevTab.title === nextTab.title &&
    prevTab.sessionId === nextTab.sessionId &&
    prevTab.state === nextTab.state &&
    previous.visible === next.visible &&
    previous.theme === next.theme &&
    previous.fontSize === next.fontSize &&
    previous.layoutSignal === next.layoutSignal &&
    previous.pasteRequest?.id === next.pasteRequest?.id &&
    previous.commandRequest?.id === next.commandRequest?.id &&
    previous.commandHistory === next.commandHistory
  );
});
