import type { Snapshot } from "../lib/types";
import { Glass } from "open-glass-ui";
import { formatAge, formatDateTime } from "../lib/format";
import type { SyncState } from "../lib/useSync";

interface Props {
  snapshot?: Snapshot;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  syncState: SyncState;
  onSync: () => void;
}

export function Header({ snapshot, theme, onToggleTheme, syncState, onSync }: Props) {
  const generated = snapshot?.generated_at;
  const aaFetched = snapshot?.aa_fetched_at ?? generated;
  const gatewayFetched = snapshot?.gateway_fetched_at ?? generated;
  const age = aaFetched ? ageHours(aaFetched) : null;
  const stale = age !== null && age > 24;
  const busy = syncState.phase === "gateway" || syncState.phase === "aa";

  return (
    <header className="masthead">
      <Glass as="div" material="regular" look={{ blur: 0.8, rim: 1.2, lensing: 1.5 }} className="topbar glass">
        <a className="brand" href="#analysis" aria-label="Model Atlas, explore">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span>Model Atlas <small>AI GATEWAY</small></span>
        </a>
        <nav className="topnav" aria-label="Dashboard sections">
          <a href="#overview">Explore</a><a href="#roles">Roles</a><a href="#ranking">Models</a><a href="#compare">Compare</a>
          <a href={usageDashboardHref()} className="topnav-out" title="AI usage and cost dashboard">Usage <span aria-hidden="true">↗</span></a>
        </nav>
        <div className="top-actions">
          <button type="button" className="sync-button" onClick={onSync} disabled={busy || syncState.phase === "unavailable"} aria-describedby="sync-status">
            <span className={busy ? "sync-icon spinning" : "sync-icon"} aria-hidden="true">↻</span>
            <span>{busy ? "Syncing" : "Sync"}</span>
          </button>
          <details className="snapshot-menu">
            <summary aria-label={age === null ? "Data date unavailable" : stale ? "Data needs refresh" : "Data updated"} className={stale || age === null ? "snapshot-trigger stale" : "snapshot-trigger"}>
              <span className="status-dot" /> <span>{age === null ? "Date unavailable" : stale ? "Data needs refresh" : "Data updated"}</span>
            </summary>
            <div className="snapshot-popover">
              <strong>Data snapshot</strong>
              <p>Artificial Analysis: {aaFetched ? `${formatDateTime(aaFetched)} (${formatAge(aaFetched)})` : "Not available"}</p>
              <p>Gateway: {gatewayFetched ? formatDateTime(gatewayFetched) : "Not available"}</p>
              <p>Snapshot built: {generated ? formatDateTime(generated) : "Not available"}</p>
              {stale && <p className="snapshot-warning">AA data is {Math.round(age!)}h old. Use Sync to refresh.</p>}
              <a href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">Data by Artificial Analysis ↗</a>
            </div>
          </details>
          <button type="button" onClick={onToggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} className="theme-button">
            <span aria-hidden="true">{theme === "dark" ? "☀" : "◐"}</span><span className="theme-label">{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
        </div>
      </Glass>
      <div id="sync-status" className={syncState.error || syncState.warning ? "sync-status sync-warning" : "sync-status"} role="status" aria-live="polite">
        {busy && <progress aria-label={syncState.message} className="sr-only" />}
        {busy || syncState.error || syncState.warning || syncState.phase === "unavailable" ? <span>{syncState.error ? `${syncState.message}: ${syncState.error}` : syncState.warning || syncState.message}</span> : null}
      </div>
    </header>
  );
}

function ageHours(iso: string): number | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : (Date.now() - date.getTime()) / 3_600_000;
}

// The usage dashboard lives next to this one: ~/.gateway-cost/dashboard.html for a
// file:// snapshot, <token>/usage/ under the local server (same origin, same token).
export function usageDashboardHref(protocol = typeof window === "undefined" ? "http:" : window.location.protocol): string {
  return protocol === "file:" ? "../dashboard.html" : "usage/";
}
