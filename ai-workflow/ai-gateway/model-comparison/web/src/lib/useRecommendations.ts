import { useEffect, useState } from "react";
import type { RecommendationsDocument } from "./engine";

declare global {
  interface Window {
    __MODEL_RECOMMENDATIONS__?: RecommendationsDocument;
  }
}

// data/recommendations.js (written by compare.mjs) sets the global for file://.
// Under the local server the same path is computed live from the snapshot and the
// Herdr config, so it is fetched again after a sync and whenever the tab becomes
// visible (for example after `cc-models recommend --apply` in a terminal).
// nonce: bump it to fetch again, e.g. after applying picks to the Herdr config.
export function useRecommendations(revision = 0, nonce = 0): RecommendationsDocument | null {
  const [doc, setDoc] = useState<RecommendationsDocument | null>(() => (typeof window === "undefined" ? null : window.__MODEL_RECOMMENDATIONS__ ?? null));
  useEffect(() => {
    if (typeof window === "undefined" || window.location.protocol === "file:") return;
    let cancelled = false;
    const load = () => {
      fetch("data/recommendations.json", { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<RecommendationsDocument>) : null))
        .then((next) => { if (!cancelled && next) setDoc(next); })
        .catch(() => {});
    };
    load();
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVisible); };
  }, [revision, nonce]);
  return doc;
}
