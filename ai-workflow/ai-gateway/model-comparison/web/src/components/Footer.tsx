import { useState } from "react";
import type { Snapshot } from "../lib/types";

// Attribution is required by the Artificial Analysis license. The unmatched list
// shows which gateway models are not yet scored, so gaps are visible, not hidden.
export function Footer({ snapshot }: { snapshot: Snapshot }) {
  const [open, setOpen] = useState(false);
  const unmatched = snapshot.unmatched_gateway_models ?? [];
  const details = snapshot.unmatched_details ?? [];
  const ambiguous = snapshot.ambiguous_matches ?? [];
  const counts = snapshot.counts;

  return (
    <footer className="flex flex-col gap-3 border-t border-line pt-4 text-sm text-muted">
      <p>
        Data:{" "}
        <a className="underline underline-offset-2 hover:text-ink" href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">
          Artificial Analysis
        </a>
        . Model availability and prices: {snapshot.source.gateway} catalog. Effective prices prefer the gateway, then the AA provider host, then AA's list price.
        {counts?.deprecated ? ` ${counts.deprecated} rows point at releases AA now marks deprecated.` : ""}
      </p>
      <p className="rounded-lg bg-frontier/15 px-3 py-2 text-xs text-ink">
        For personal analysis. Artificial Analysis terms restrict scraping and redistribution of their data; do not share this dashboard or its data files externally.
      </p>
      <div>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="text-left underline underline-offset-2 hover:text-ink"
        >
          {unmatched.length} catalog models not matched, {ambiguous.length} ambiguous
        </button>
        {open && (
          <div className="mt-2 grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider">Not matched</p>
              {details.length > 0 ? (
                <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
                  {details.map((m) => (
                    <li key={`${m.provider}-${m.gateway}`}>
                      <span className="font-medium text-ink">{m.gateway}</span>
                      {m.provider ? ` · ${m.provider}` : ""}
                      <span className="block text-muted">{m.reason}{m.closest?.length ? ` Closest: ${m.closest.join(", ")}.` : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="max-h-48 list-inside list-disc overflow-y-auto text-xs">
                  {unmatched.map((m) => <li key={m}>{m}</li>)}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider">Ambiguous</p>
              <ul className="max-h-56 list-inside list-disc overflow-y-auto text-xs">
                {ambiguous.map((a) => (
                  <li key={a.gateway}>
                    {a.gateway}
                    {a.chosen ? ` → ${a.chosen}` : ""}: {(a.candidates ?? []).join(", ")}
                  </li>
                ))}
                {ambiguous.length === 0 && <li>None.</li>}
              </ul>
              <p className="mt-3 text-xs font-medium uppercase tracking-wider">Source pages</p>
              <p className="text-xs">{snapshot.source.aa_pages?.join(", ") || "Artificial Analysis public pages"}</p>
              {snapshot.source.aa_methodology && <p className="mt-1 text-xs">{snapshot.source.aa_methodology}</p>}
            </div>
          </div>
        )}
      </div>
    </footer>
  );
}
