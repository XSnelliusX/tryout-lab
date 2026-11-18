import type { Snapshot } from "../lib/types";
import { Glass } from "open-glass-ui";
import { formatAge, formatDateTime } from "../lib/format";

interface Props {
  snapshot: Snapshot;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export function Header({ snapshot, theme, onToggleTheme }: Props) {
  const generated = snapshot.generated_at;
  const aaFetched = snapshot.aa_fetched_at ?? generated;
  const gatewayFetched = snapshot.gateway_fetched_at ?? generated;
  const age = ageHours(aaFetched);
  const stale = age !== null && age > 24;

  return (
    <header className="masthead">
      <Glass as="div" material="regular" look={{ blur: 0.8, rim: 1.2, lensing: 1.5 }} className="topbar glass">
        <a className="brand" href="#analysis" aria-label="Model Atlas, explore">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span>Model Atlas <small>AI GATEWAY</small></span>
        </a>
        <nav className="topnav" aria-label="Dashboard sections">
          <a href="#overview">Explore</a><a href="#ranking">Models</a><a href="#compare">Compare</a>
        </nav>
        <div className="top-actions">
          <details className="snapshot-menu">
            <summary aria-label={age === null ? "Data date unavailable" : stale ? "Data needs refresh" : "Data updated"} className={stale || age === null ? "snapshot-trigger stale" : "snapshot-trigger"}>
              <span className="status-dot" /> <span>{age === null ? "Date unavailable" : stale ? "Data needs refresh" : "Data updated"}</span>
            </summary>
            <div className="snapshot-popover">
              <strong>Data snapshot</strong>
              <p>Artificial Analysis: {formatDateTime(aaFetched)} ({formatAge(aaFetched)})</p>
              <p>Gateway: {formatDateTime(gatewayFetched)}</p>
              <p>Snapshot built: {formatDateTime(generated)}</p>
              {stale && <p className="snapshot-warning">AA data is {Math.round(age!)}h old. Run <code>node compare.mjs --refresh</code> (or /model-comparison) to refresh.</p>}
              <a href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">Data by Artificial Analysis ↗</a>
            </div>
          </details>
          <button type="button" onClick={onToggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} className="theme-button">
            <span aria-hidden="true">{theme === "dark" ? "☀" : "◐"}</span><span className="theme-label">{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
        </div>
      </Glass>
    </header>
  );
}

function ageHours(iso: string): number | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : (Date.now() - date.getTime()) / 3_600_000;
}
