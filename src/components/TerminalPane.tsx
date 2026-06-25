import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { command, isTauri } from "../api/tauri";
import type { ShellTab } from "../features/shell/types";
import type { TerminalClosedPayload, TerminalDataPayload } from "../types";
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

export function TerminalPane({
  tab,
  visible,
  theme,
  fontSize,
  layoutSignal,
  setNotice,
  onReady,
  onClosed,
}: {
  tab: ShellTab;
  visible: boolean;
  theme: AppTheme;
  fontSize: number;
  layoutSignal: string;
  setNotice: (notice: string) => void;
  onReady?: () => void;
  onClosed?: (reason: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(tab.sessionId);
  const readySessionRef = useRef<string | null>(null);
  const receivedDataSessionRef = useRef<string | null>(null);
  const connectingNoticeRef = useRef(false);
  const fitTimerRef = useRef<number | null>(null);
  const onReadyRef = useRef(onReady);
  const onClosedRef = useRef(onClosed);

  useEffect(() => {
    sessionRef.current = tab.sessionId;
  }, [tab.sessionId]);

  function markReady(sessionId: string) {
    if (readySessionRef.current === sessionId) return;
    readySessionRef.current = sessionId;
    onReadyRef.current?.();
  }

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  useEffect(() => {
    if (!containerRef.current) return;

    const fit = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, monospace',
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

    terminal.onData((data) => {
      const currentSession = sessionRef.current;
      if (isTauri && currentSession) {
        command("terminal_input", { sessionId: currentSession, data }).catch((error) => {
          setNotice(String(error));
        });
      } else if (!isTauri) {
        terminal.write(data);
        if (data === "\r") {
          terminal.write("\r\n$ ");
        }
      }
    });

    const fitWhenVisible = () => {
      // Skip while hidden (display:none) — the container has no size then.
      if (containerRef.current?.offsetParent === null) return;
      requestAnimationFrame(() => fit.fit());
    };
    const refit = () => {
      if (fitTimerRef.current !== null) window.clearTimeout(fitTimerRef.current);
      fitTimerRef.current = window.setTimeout(() => {
        fitTimerRef.current = null;
        fitWhenVisible();
      }, 90);
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
      observer.disconnect();
      terminal.dispose();
    };
  }, [setNotice, tab.title]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.theme = terminalThemes[theme];
  }, [theme]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = fontSize;
    requestAnimationFrame(() => fitRef.current?.fit());
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
        receivedDataSessionRef.current = event.payload.sessionId;
        terminalRef.current?.write(event.payload.data);
        if (event.payload.data.includes("[iShell] connected")) markReady(event.payload.sessionId);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenData = unlisten;
    });

    listen<TerminalClosedPayload>("terminal:closed", (event) => {
      if (event.payload.sessionId === sessionRef.current) {
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
      if (receivedDataSessionRef.current === sessionId) return;
      command<string>("terminal_snapshot", { sessionId })
        .then((snapshot) => {
          if (cancelled || sessionRef.current !== sessionId || !snapshot) return;
          if (receivedDataSessionRef.current === sessionId) return;
          terminalRef.current?.write(snapshot);
          receivedDataSessionRef.current = sessionId;
          if (snapshot.includes("[iShell] connected")) markReady(sessionId);
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
      terminalRef.current.writeln("\r\n[iShell] connecting...");
      connectingNoticeRef.current = true;
    }
    if (tab.state !== "connecting") {
      connectingNoticeRef.current = false;
    }
  }, [tab.sessionId, tab.state, tab.title]);

  useEffect(() => {
    if (visible) {
      window.setTimeout(() => fitRef.current?.fit(), 120);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => fitRef.current?.fit(), 220);
    return () => window.clearTimeout(timer);
  }, [layoutSignal, visible]);

  return (
    <section className={`terminal-panel ${visible ? "active" : ""}`} aria-hidden={!visible}>
      <div className="terminal-frame" ref={containerRef} />
    </section>
  );
}
