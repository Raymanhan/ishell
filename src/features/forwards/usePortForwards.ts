import { useCallback, useEffect, useRef, useState } from "react";
import { command, isTauri } from "../../api/tauri";
import type { PortForward, PortForwardInput, PortForwardStatus } from "../../types";

/** Browser demo only: rules live in localStorage and "run" without a server. */
const DEMO_FORWARDS_KEY = "ishell.demoPortForwards";

function readDemoForwards(): PortForward[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DEMO_FORWARDS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeDemoForwards(forwards: PortForward[]) {
  try {
    window.localStorage.setItem(DEMO_FORWARDS_KEY, JSON.stringify(forwards));
  } catch {
    // The demo keeps working without persistence.
  }
}

/** Saved port forwards of every server and the live state of each. */
export function usePortForwards(showNotice: (message: string) => void) {
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [statuses, setStatuses] = useState<Record<string, PortForwardStatus>>({});
  const forwardsRef = useRef(forwards);
  const statusesRef = useRef(statuses);
  forwardsRef.current = forwards;
  statusesRef.current = statuses;

  const applyStatus = useCallback((status: PortForwardStatus) => {
    setStatuses((current) => ({ ...current, [status.id]: status }));
  }, []);

  useEffect(() => {
    if (!isTauri) {
      setForwards(readDemoForwards());
      return;
    }
    let unlisten: (() => void) | undefined;
    let active = true;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<PortForwardStatus>("port-forward:status", (event) => {
        applyStatus(event.payload);
        if (event.payload.state === "error" && event.payload.message) {
          const forward = forwardsRef.current.find((item) => item.id === event.payload.id);
          showNotice(`端口转发 ${forward ? forward.bindPort : ""} 失败：${event.payload.message}`);
        }
      });
      if (active) unlisten = un;
      else un();
    })();
    Promise.all([
      command<PortForward[]>("list_port_forwards"),
      command<PortForwardStatus[]>("port_forward_statuses"),
    ])
      .then(([list, current]) => {
        setForwards(list);
        setStatuses(Object.fromEntries(current.map((status) => [status.id, status])));
      })
      .catch((error) => showNotice(String(error)));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [applyStatus, showNotice]);

  const save = useCallback(async (input: PortForwardInput) => {
    if (!isTauri) {
      const current = readDemoForwards();
      const existing = current.find((item) => item.id === input.id);
      const now = Date.now() / 1000;
      const saved: PortForward = {
        ...input,
        id: existing?.id ?? crypto.randomUUID(),
        bindHost: input.bindHost.trim() || "127.0.0.1",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const next = existing ? current.map((item) => (item.id === saved.id ? saved : item)) : [...current, saved];
      writeDemoForwards(next);
      setForwards(next);
      return saved;
    }
    const saved = await command<PortForward>("save_port_forward", { input });
    setForwards((current) =>
      current.some((item) => item.id === saved.id)
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved],
    );
    return saved;
  }, []);

  const remove = useCallback(async (id: string) => {
    if (isTauri) {
      await command("delete_port_forward", { id });
    } else {
      writeDemoForwards(readDemoForwards().filter((item) => item.id !== id));
    }
    setForwards((current) => current.filter((item) => item.id !== id));
    setStatuses((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const start = useCallback(async (id: string) => {
    if (!isTauri) {
      applyStatus({ id, state: "starting" });
      window.setTimeout(() => applyStatus({ id, state: "running" }), 400);
      return;
    }
    try {
      await command("start_port_forward", { id });
    } catch (error) {
      // The status event carries the reason and raises the notice.
      applyStatus({ id, state: "error", message: String(error) });
    }
  }, [applyStatus]);

  const stop = useCallback(async (id: string) => {
    if (isTauri) await command("stop_port_forward", { id }).catch((error) => showNotice(String(error)));
    else applyStatus({ id, state: "stopped" });
  }, [applyStatus, showNotice]);

  /** Start a server's auto-start forwards that are not already running. */
  const autoStart = useCallback((serverId: string) => {
    for (const forward of forwardsRef.current) {
      if (forward.serverId !== serverId || !forward.autoStart) continue;
      const state = statusesRef.current[forward.id]?.state;
      if (state === "running" || state === "starting") continue;
      void start(forward.id);
    }
  }, [start]);

  return { forwards, statuses, save, remove, start, stop, autoStart };
}

/** `host:port`, with brackets around IPv6 literals. */
export function formatAddress(host: string, port: number) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}
