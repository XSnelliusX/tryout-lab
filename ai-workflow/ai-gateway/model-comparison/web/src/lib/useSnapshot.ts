import { useEffect, useState } from "react";
import type { Snapshot } from "./types";
import { WORKLOADS, workloadScore } from "./engine";
import { WORKLOAD_PREFIX } from "./tasks";

export type SnapshotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: Snapshot };

declare global {
  interface Window {
    __MODEL_COMPARISON__?: Snapshot;
  }
}

// Loads the generated snapshot once. compare.mjs writes data/models.js, a classic
// script that sets window.__MODEL_COMPARISON__, so the dashboard works when
// opened from file:// (browsers block fetch() of local files). Under `vite dev`
// there is no such script; fall back to fetching data/models.json.
export function useSnapshot(url = "data/models.json", revision = 0): SnapshotState {
  const [state, setState] = useState<SnapshotState>(() => {
    const embedded = typeof window === "undefined" ? undefined : window.__MODEL_COMPARISON__;
    return embedded ? { status: "ready", snapshot: normalize(embedded) } : { status: "loading" };
  });

  useEffect(() => {
    if (revision === 0 && typeof window !== "undefined" && window.__MODEL_COMPARISON__) return;
    let cancelled = false;
    fetch(url, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Snapshot>;
      })
      .then((raw) => {
        if (!cancelled) setState({ status: "ready", snapshot: normalize(raw) });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState((previous) => previous.status === "ready" ? previous : { status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [url, revision]);

  return state;
}

// Go encodes an empty slice as null. Normalise so the UI can always iterate, and
// add the recommendation workload scores (scores["workload:<name>"]).
export function normalize(raw: Snapshot): Snapshot {
  return {
    ...raw,
    unmatched_gateway_models: raw.unmatched_gateway_models ?? [],
    unmatched_details: raw.unmatched_details ?? [],
    ambiguous_matches: raw.ambiguous_matches ?? [],
    metrics: raw.metrics ?? [],
    models: (raw.models ?? []).map((m) => ({
      ...m,
      scores: withWorkloads(m.scores ?? {}),
      gateway_ids: m.gateway_ids ?? [],
      gateway_providers: m.gateway_providers ?? [],
      gateway_provider_names: m.gateway_provider_names ?? [],
      aliases: m.aliases ?? [],
      upstream_models: m.upstream_models ?? [],
      warnings: m.warnings ?? [],
      hosts: m.hosts ?? [],
      modalities: m.modalities ?? { input: [], output: [] },
    })),
  };
}

function withWorkloads(scores: Snapshot["models"][number]["scores"]) {
  const out = { ...scores };
  for (const name of Object.keys(WORKLOADS)) out[`${WORKLOAD_PREFIX}${name}`] = workloadScore({ scores }, name)?.value ?? null;
  return out;
}
