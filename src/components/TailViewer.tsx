import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Pause, Play, RefreshCw } from "lucide-react";
import { command, isTauri } from "../api/tauri";
import {
  clampTailViewerLines,
  MAX_TAIL_VIEWER_LINES,
  MIN_TAIL_VIEWER_LINES,
} from "../constants/tail";
import { readSavedTheme } from "../constants/theme";
import type {
  TailDataPayload,
  TailMonitorState,
  TailStatusPayload,
  TailViewerConfig,
} from "../types";

const MAX_BUFFER_CHARS = 8 * 1024 * 1024;

export function readTailViewerConfigFromUrl(): TailViewerConfig | null {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const raw = new URLSearchParams(hash).get("tailViewer");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TailViewerConfig>;
    if (
      typeof parsed.viewerId !== "string" ||
      typeof parsed.serverId !== "string" ||
      typeof parsed.serverName !== "string" ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.path !== "string" ||
      typeof parsed.initialLines !== "number"
    ) {
      return null;
    }
    return {
      viewerId: parsed.viewerId,
      serverId: parsed.serverId,
      serverName: parsed.serverName,
      fileName: parsed.fileName,
      path: parsed.path,
      initialLines: clampTailViewerLines(parsed.initialLines),
    };
  } catch {
    return null;
  }
}

export function TailViewer({ config }: { config: TailViewerConfig }) {
  const [content, setContent] = useState("");
  const [lineLimit, setLineLimit] = useState(config.initialLines);
  const [lineDraft, setLineDraft] = useState(String(config.initialLines));
  const [following, setFollowing] = useState(true);
  const [unseenLines, setUnseenLines] = useState(0);
  const [status, setStatus] = useState<TailMonitorState>("connecting");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const lineLimitRef = useRef(config.initialLines);
  const followingRef = useRef(true);
  const startMonitorRef = useRef<(lines: number) => Promise<void>>(async () => undefined);

  useEffect(() => {
    document.documentElement.dataset.theme = readSavedTheme(window.localStorage.getItem("ishell.theme"));
    document.documentElement.classList.add("tail-viewer-root");
    document.body.classList.add("tail-viewer-body");
    if (isTauri) {
      void applyTailWindowFrost().catch(() => undefined);
    }
    return () => {
      document.documentElement.classList.remove("tail-viewer-root");
      document.body.classList.remove("tail-viewer-body");
    };
  }, []);

  useEffect(() => {
    followingRef.current = following;
    if (following) setUnseenLines(0);
  }, [following]);

  useEffect(() => {
    if (!following) return;
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [content, following]);

  const startMonitor = useCallback(async (lines: number) => {
    if (!isTauri) {
      setStatus("error");
      setStatusMessage("滚动查看仅支持桌面应用");
      return;
    }
    setStatus("connecting");
    setStatusMessage(null);
    try {
      await command("stop_tail_monitor", { viewerId: config.viewerId }).catch(() => undefined);
      await command("start_tail_monitor", {
        id: config.serverId,
        path: config.path,
        initialLines: lines,
        viewerId: config.viewerId,
      });
    } catch (error) {
      setStatus("error");
      setStatusMessage(String(error));
    }
  }, [config.path, config.serverId, config.viewerId]);

  useEffect(() => {
    startMonitorRef.current = startMonitor;
  }, [startMonitor]);

  useEffect(() => {
    if (!isTauri) {
      void startMonitor(config.initialLines);
      return;
    }
    let cancelled = false;
    let unlistenData: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const dataCleanup = await listen<TailDataPayload>("tail:data", (event) => {
        if (event.payload.viewerId !== config.viewerId) return;
        const data = event.payload.data;
        setContent((current) => trimToLineLimit(current + data, lineLimitRef.current));
        if (!followingRef.current) {
          const completedLines = countCompletedLines(data);
          if (completedLines > 0) setUnseenLines((current) => current + completedLines);
        }
      });
      const statusCleanup = await listen<TailStatusPayload>("tail:status", (event) => {
        if (event.payload.viewerId !== config.viewerId) return;
        setStatus(event.payload.state);
        setStatusMessage(event.payload.message ?? null);
      });
      if (cancelled) {
        dataCleanup();
        statusCleanup();
        return;
      }
      unlistenData = dataCleanup;
      unlistenStatus = statusCleanup;
      await startMonitor(config.initialLines);
    })().catch((error) => {
      if (!cancelled) {
        setStatus("error");
        setStatusMessage(String(error));
      }
    });

    return () => {
      cancelled = true;
      unlistenData?.();
      unlistenStatus?.();
      void command("stop_tail_monitor", { viewerId: config.viewerId }).catch(() => undefined);
    };
  }, [config.initialLines, config.viewerId, startMonitor]);

  async function applyLineLimit() {
    const parsed = Number(lineDraft);
    if (!Number.isFinite(parsed)) {
      setLineDraft(String(lineLimit));
      return;
    }
    const next = clampTailViewerLines(parsed);
    lineLimitRef.current = next;
    setLineLimit(next);
    setLineDraft(String(next));
    setContent("");
    setUnseenLines(0);
    setFollowing(true);
    await startMonitorRef.current(next);
  }

  function resumeFollowing() {
    setFollowing(true);
    setUnseenLines(0);
    window.requestAnimationFrame(() => {
      const output = outputRef.current;
      if (output) output.scrollTop = output.scrollHeight;
    });
  }

  const statusLabel = status === "streaming"
    ? following ? "监听中" : "已暂停滚动"
    : status === "connecting"
      ? "正在连接"
      : status === "stopped"
        ? "监听已结束"
        : "连接异常";

  return (
    <main className="tail-viewer">
      <div className="tail-viewer-drag-strip" data-tauri-drag-region aria-hidden />
      <header className="tail-viewer-head" data-tauri-drag-region>
        <div className="tail-viewer-title" data-tauri-drag-region>
          <span data-tauri-drag-region>Live Tail · {config.serverName}</span>
          <h1 data-tauri-drag-region>{config.fileName}</h1>
          <p title={config.path} data-tauri-drag-region>{config.path}</p>
        </div>
        <div className="tail-viewer-status" data-state={status} data-tauri-drag-region>
          <i data-tauri-drag-region />
          <span data-tauri-drag-region>{statusLabel}</span>
        </div>
      </header>

      <section className="tail-viewer-toolbar" aria-label="滚动查看控制">
        <label className="tail-lines-field">
          <span>保留最近</span>
          <input
            type="number"
            min={MIN_TAIL_VIEWER_LINES}
            max={MAX_TAIL_VIEWER_LINES}
            step={10}
            value={lineDraft}
            onChange={(event) => setLineDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void applyLineLimit();
            }}
          />
          <span>行</span>
          <button type="button" className="tail-toolbar-button" onClick={() => void applyLineLimit()}>
            应用
          </button>
        </label>
        <span className="tail-toolbar-spacer" />
        {status === "error" || status === "stopped" ? (
          <button type="button" className="tail-toolbar-button" onClick={() => void startMonitor(lineLimit)}>
            <RefreshCw size={14} /> 重新连接
          </button>
        ) : following ? (
          <button type="button" className="tail-toolbar-button" onClick={() => setFollowing(false)}>
            <Pause size={14} /> 暂停滚动
          </button>
        ) : (
          <button type="button" className="tail-toolbar-button primary" onClick={resumeFollowing}>
            <Play size={14} /> 开始滚动{unseenLines > 0 ? `（${unseenLines} 行）` : ""}
          </button>
        )}
        <button
          type="button"
          className="tail-toolbar-button"
          onClick={() => {
            setContent("");
            setUnseenLines(0);
          }}
        >
          <Eraser size={14} /> 清空
        </button>
      </section>

      {statusMessage && <div className={`tail-viewer-message ${status === "error" ? "error" : ""}`}>{statusMessage}</div>}

      <div ref={outputRef} className="tail-viewer-output" aria-label={`${config.fileName} 实时内容`}>
        {content ? <pre>{content}</pre> : (
          <div className="tail-viewer-empty">
            {status === "connecting" ? "正在建立远程监听…" : "等待文件产生新内容…"}
          </div>
        )}
      </div>
    </main>
  );
}

async function applyTailWindowFrost() {
  const [{ Effect, EffectState, getCurrentWindow }, { getCurrentWebview }] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/webview"),
  ]);
  const appWindow = getCurrentWindow();
  const webview = getCurrentWebview();
  const transparent = { red: 0, green: 0, blue: 0, alpha: 0 };
  await Promise.allSettled([
    appWindow.setBackgroundColor(transparent),
    webview.setBackgroundColor(transparent),
  ]);

  const platform = document.documentElement.dataset.platform;
  const effects = platform === "macos"
    ? { effects: [Effect.UnderWindowBackground], state: EffectState.Active, radius: 14 }
    : platform === "windows"
      ? { effects: [Effect.Mica] }
      : null;
  if (effects) await appWindow.setEffects(effects).catch(() => undefined);
}

function countCompletedLines(value: string) {
  let count = 0;
  for (const character of value) {
    if (character === "\n") count += 1;
  }
  return count;
}

function trimToLineLimit(value: string, lineLimit: number) {
  let remaining = lineLimit;
  let index = value.endsWith("\n") ? value.length - 2 : value.length - 1;
  for (; index >= 0; index -= 1) {
    if (value[index] !== "\n") continue;
    remaining -= 1;
    if (remaining === 0) {
      value = value.slice(index + 1);
      break;
    }
  }
  return value.length > MAX_BUFFER_CHARS ? value.slice(-MAX_BUFFER_CHARS) : value;
}
