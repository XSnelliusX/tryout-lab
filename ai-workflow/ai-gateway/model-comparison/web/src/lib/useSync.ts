import { useCallback, useEffect, useState } from "react";

export interface SyncState {
  phase: "gateway" | "aa" | "idle" | "error" | "unavailable";
  message: string;
  revision: number;
  error: string | null;
  warning: string | null;
}

export function useSync() {
  const [state, setState] = useState<SyncState>({ phase: "gateway", message: "Connecting to sync…", revision: 0, error: null, warning: null });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        // A hidden tab still polls, but tells the server so it does not keep it alive.
        const visible = document.visibilityState === "visible" ? 1 : 0;
        const response = await fetch(`./api/status?visible=${visible}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Sync server unavailable");
        const next = await response.json() as SyncState;
        if (!stopped) setState(next);
      } catch {
        if (!stopped) setState((previous) => ({ ...previous, phase: "unavailable", message: "Sync server unavailable. Reopen /model-comparison.", error: null }));
      }
      if (!stopped) timer = setTimeout(poll, document.visibilityState === "visible" ? 1000 : 10_000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  const sync = useCallback(async () => {
    setState((previous) => ({ ...previous, phase: "gateway", message: "Checking gateway models…", error: null, warning: null }));
    try {
      const response = await fetch("./api/sync", { method: "POST", headers: { "X-Model-Comparison": "sync" } });
      if (!response.ok) throw new Error(`Sync request failed (${response.status})`);
      setState(await response.json() as SyncState);
    } catch (error) {
      setState((previous) => ({ ...previous, phase: "error", message: "Sync failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }, []);
  return { state, sync };
}
