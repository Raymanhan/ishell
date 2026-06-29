import { memo, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { RefreshCw } from "lucide-react";
import { command, isTauri } from "../api/tauri";
import type { ShellTab } from "../features/shell/types";
import type { TerminalClosedPayload, TerminalDataPayload, TerminalSnapshotPayload } from "../types";
import type { AppTheme } from "./SettingsModal";

const terminalThemes = {
  dark: {
    background: "#0a0b0d",
    foreground: "#d9dde3",
    cursor: "#5b9dff",
    selectionBackground: "#27406b",
    black: "#0a0b0d",
    red: "#f56b6b",
    green: "#43c98b",
    yellow: "#f2b45a",
    blue: "#5b9dff",
    magenta: "#b18cff",
    cyan: "#46c7c7",
    white: "#e6e8ec",
  },
  light: {
    background: "#fbfcfe",
    foreground: "#1d2430",
    cursor: "#2f7df6",
    selectionBackground: "#cfe0ff",
    black: "#1d2430",
    red: "#d94848",
    green: "#1f9d67",
    yellow: "#a86a12",
    blue: "#2f7df6",
    magenta: "#7d5ae8",
    cyan: "#168a8a",
    white: "#f8fafc",
  },
} satisfies Record<AppTheme, ITheme>;

const passwordPromptPattern = /(?:password|passphrase|密码|口令)[^:\n\r]*[:：]\s*$/i;
const platformSource = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
const terminalFontFamily = platformSource.includes("win")
  ? '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", monospace'
  : '"SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace';

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

  useEffect(() => {
    sessionRef.current = tab.sessionId;
    commandDraftRef.current = "";
    sensitiveInputRef.current = false;
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
    if (nextData.includes("[iShell] connected")) markReady(sessionId);
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

  function sendTerminalInput(data: string) {
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
    if (!containerRef.current) return;

    const fit = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFontFamily,
      fontSize,
      lineHeight: 1.35,
      scrollback: 8000,
      theme: terminalThemes[theme],
    });

    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminal.writeln(`iShell · ${tab.title}`);
    terminal.writeln("");

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
    sendTerminalInput(pasteRequest.command);
  }, [pasteRequest?.id, visible]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.theme = terminalThemes[theme];
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
    let unlistenClosed: (() => void) | undefined;

    listen<TerminalDataPayload>("terminal:data", (event) => {
      if (event.payload.sessionId === sessionRef.current) {
        writeTerminalData(event.payload.sessionId, event.payload.offset, event.payload.data);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenData = unlisten;
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
          if (cancelled || sessionRef.current !== sessionId || !snapshot.data) return;
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

  return (
    <section className={`terminal-panel ${visible ? "active" : ""}`} aria-hidden={!visible}>
      <div className="terminal-frame">
        <div className="terminal-host" ref={containerRef} />
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
    previous.pasteRequest?.id === next.pasteRequest?.id
  );
});
