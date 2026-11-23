import { useCallback, useMemo, useState } from "react";
import { GlassSystemProvider } from "open-glass-ui";
import { useSnapshot } from "./lib/useSnapshot";
import { useSync, type SyncState } from "./lib/useSync";
import { applyFilters, exponentFor, rankByValue, PRICE_MAX, type Filters } from "./lib/filters";
import { SENSITIVITY } from "./lib/engine";
import { TASKS, defaultTask, scoreFor, tasksFromMetrics } from "./lib/tasks";
import { useThemeMode } from "./lib/theme";
import { ControlBar } from "./components/ControlBar";
import { KpiRow } from "./components/KpiRow";
import { ValueScatter, type ColorBy } from "./components/ValueScatter";
import { TopValueBars } from "./components/TopValueBars";
import { SpeedScatter } from "./components/SpeedScatter";
import { ComparePanel } from "./components/ComparePanel";
import { RankingTable, MAX_PINNED } from "./components/RankingTable";
import { DetailDrawer } from "./components/DetailDrawer";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { DecisionPanel } from "./components/DecisionPanel";
import { RolePanel } from "./components/RoleModels";
import { HowItWorks } from "./components/HowItWorks";
import { PRESETS } from "./components/ControlBar";
import { planRoles, presetFor } from "./lib/recommendations";
import type { ApplyResult } from "./lib/applyRoles";
import { useRecommendations } from "./lib/useRecommendations";
import type { ProviderOption, Row, Snapshot } from "./lib/types";

// The rail sets task, max cost, provider and speed; the recommendations panel the
// cost sensitivity. The rest are fixed: costs are per task at the gateway, $0
// models count at the engine's minimum cost, superseded releases are hidden.
const DEFAULT_FILTERS: Filters = {
  task: defaultTask(TASKS),
  costMode: "task",
  valueMode: "quality",
  sensitivity: SENSITIVITY.balanced,
  priceSensitivity: exponentFor(SENSITIVITY.balanced),
  minScore: 0,
  maxPrice: PRICE_MAX,
  creators: [],
  modelQuery: "",
  includeFree: true,
  // Superseded releases clutter the view and are never the best pick; the toggle shows them.
  includeDeprecated: false,
  gatewayProvider: "",
  effort: "all",
  reasoning: "all",
};

export default function App() {
  const { state: syncState, sync } = useSync();
  const state = useSnapshot("data/models.json", syncState.revision);
  const [theme, toggleTheme] = useThemeMode();

  if (state.status === "loading") return <GlassSystemProvider renderer="css" theme={{ appearance: theme }} toasts={false}><Shell><Header theme={theme} onToggleTheme={toggleTheme} syncState={syncState} onSync={sync} /><Status text="Loading dashboard data…" /></Shell></GlassSystemProvider>;
  if (state.status === "error") {
    return (
      <GlassSystemProvider renderer="css" theme={{ appearance: theme }} toasts={false}><Shell>
        <Header theme={theme} onToggleTheme={toggleTheme} syncState={syncState} onSync={sync} />
        <Status text={syncState.phase === "gateway" || syncState.phase === "aa" ? "Building your first snapshot…" : `No dashboard data available (${state.message}). Use Sync to try again.`} />
      </Shell></GlassSystemProvider>
    );
  }
  return <GlassSystemProvider renderer="css" theme={{ appearance: theme }} toasts={false}><Dashboard snapshot={state.snapshot} theme={theme} onToggleTheme={toggleTheme} syncState={syncState} onSync={sync} /></GlassSystemProvider>;
}

interface DashboardProps {
  snapshot: Snapshot;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  syncState: SyncState;
  onSync: () => void;
}

function Dashboard({ snapshot, theme, onToggleTheme, syncState, onSync }: DashboardProps) {
  const tasks = useMemo(() => tasksFromMetrics(snapshot.metrics), [snapshot.metrics]);
  // After Apply the Herdr config changed: fetch the recommendations again so "now" follows.
  const [lastApplied, setLastApplied] = useState<ApplyResult | null>(null);
  const [applyCount, setApplyCount] = useState(0);
  const recommendations = useRecommendations(syncState.revision, applyCount);
  const onApplied = useCallback((result: ApplyResult) => { setLastApplied(result); setApplyCount((n) => n + 1); }, []);
  const [filters, setFilters] = useState<Filters>(() => ({ ...DEFAULT_FILTERS, task: defaultTask(tasks) }));
  const [colorBy, setColorBy] = useState<ColorBy>("creator");
  // The side panel shows one thing at a time: a model (selected), a Herdr role or the method.
  const [selected, setSelectedModel] = useState<string | null>(null);
  const [side, setSide] = useState<{ kind: "role"; role: string } | { kind: "how" } | null>(null);
  const setSelected = useCallback((slug: string | null) => { setSelectedModel(slug); if (slug) setSide(null); }, []);
  const openRole = useCallback((role: string) => { setSelectedModel(null); setSide({ kind: "role", role }); }, []);
  const openHow = useCallback(() => { setSelectedModel(null); setSide({ kind: "how" }); }, []);
  const closeSide = useCallback(() => setSide(null), []);
  const [pinned, setPinned] = useState<string[]>([]);
  const [chart, setChart] = useState<"cost" | "speed">("cost");
  const [hiddenCreators, setHiddenCreators] = useState<string[]>([]);
  const [highlightCreator, setHighlightCreator] = useState<string | null>(null);

  const gatewayProviders = useMemo(() => uniqueProviders(snapshot.models), [snapshot.models]);
  // The search only narrows the table; picks, charts and KPIs follow the criteria.
  const criteria = useMemo(() => ({ ...filters, modelQuery: "" }), [filters]);
  const scoped = useMemo(() => applyFilters(snapshot.models, criteria), [snapshot.models, criteria]);
  const ranked = useMemo(() => rankByValue(scoped, filters), [scoped, filters]);
  const tableRows = useMemo(() => (filters.modelQuery.trim() ? rankByValue(applyFilters(snapshot.models, filters), filters) : ranked), [snapshot.models, filters, ranked]);
  const plan = useMemo(() => planRoles(snapshot, recommendations, criteria), [snapshot, recommendations, criteria]);
  const setSensitivity = useCallback((k: number) => setFilters((f) => ({ ...f, sensitivity: k, priceSensitivity: exponentFor(k) })), []);
  const chartRows = useMemo(() => scoped.filter((row) => !hiddenCreators.includes(row.creator)), [scoped, hiddenCreators]);
  const chartRanked = useMemo(() => rankByValue(chartRows, filters), [chartRows, filters]);
  const excludedForTask = useMemo(
    () => snapshot.models.filter((r) => scoreFor(r, filters.task) === null).length,
    [snapshot.models, filters.task],
  );

  const bySlug = useMemo(() => new Map(snapshot.models.map((r) => [r.slug, r])), [snapshot.models]);
  const pinnedRows = pinned.map((s) => bySlug.get(s)).filter((r): r is Row => r !== undefined);
  const selectedRow = selected ? bySlug.get(selected) ?? null : null;

  const togglePin = useCallback(
    (slug: string) => {
      setPinned((cur) => {
        if (cur.includes(slug)) return cur.filter((s) => s !== slug);
        if (cur.length >= MAX_PINNED) return cur;
        return [...cur, slug];
      });
    },
    [],
  );
  const closeDrawer = useCallback(() => setSelected(null), [setSelected]);
  const preset = presetFor(filters.sensitivity);
  const sideRole = side?.kind === "role" ? plan?.roles.roles.find((r) => r.role === side.role) ?? null : null;
  const sidePanel = selectedRow
    ? <DetailDrawer row={selectedRow} filters={filters} tasks={tasks} metrics={snapshot.metrics ?? []} onClose={closeDrawer} />
    : sideRole
      ? <RolePanel r={sideRole} pickKey="custom" pickTitle={preset ? `${PRESETS.find((p) => p.key === preset)!.label} pick` : "Pick"} preset={preset} onClose={closeSide} onSelect={setSelected} onApplied={onApplied} />
      : side?.kind === "how" ? <HowItWorks onClose={closeSide} /> : null;

  return (
    <Shell>
      <Header snapshot={snapshot} theme={theme} onToggleTheme={onToggleTheme} syncState={syncState} onSync={onSync} />
      <div className={`workspace-layout${sidePanel ? " has-side" : ""}`}>
      <aside className="criteria-rail" aria-label="Comparison criteria">
      <ControlBar
        filters={filters}
        setFilters={setFilters}
        onSensitivity={setSensitivity}
        gatewayProviders={gatewayProviders}
        taskOptions={tasks}
        onReset={() => { setFilters({ ...DEFAULT_FILTERS, task: defaultTask(tasks) }); setHiddenCreators([]); }}
      />
      </aside>
      <div className="workspace-content">
      <DecisionPanel rows={scoped} plan={plan} filters={criteria} lastApplied={lastApplied} onSensitivity={setSensitivity} onSelect={setSelected} onOpenRole={openRole} onHow={openHow} onApplied={onApplied} />
      <div className="landscape-layout">
      <section id="analysis" aria-label="Visual analysis" className="analysis-workspace">
        <div className="analysis-toolbar">
          <div><p className="section-kicker">TRADE-OFF MAP</p><h2>Explore the landscape</h2></div>
          <div className="analysis-switches">
          <div role="group" aria-label="Color by" className="chart-view-switch is-small">
            <button type="button" aria-pressed={colorBy === "creator"} onClick={() => setColorBy("creator")}>Creator</button>
            <button type="button" aria-pressed={colorBy === "effort"} onClick={() => setColorBy("effort")}>Effort</button>
          </div>
          <div role="group" aria-label="Chart view" className="chart-view-switch">
            <button type="button" aria-pressed={chart === "cost"} onClick={() => setChart("cost")}>Cost &amp; score</button>
            <button type="button" aria-pressed={chart === "speed"} onClick={() => setChart("speed")}>Speed &amp; score</button>
          </div>
          </div>
        </div>
        <div className="charts-pair">
        {chart === "cost" && (
          <ValueScatter
            rows={chartRows}
            legendRows={scoped}
            filters={filters}
            colorBy={colorBy}
            selected={selected}
            pinned={pinned}
            hiddenCreators={hiddenCreators}
            highlightCreator={highlightCreator}
            onHighlightCreator={setHighlightCreator}
            onToggleCreator={(creator) => setHiddenCreators((cur) => cur.includes(creator) ? cur.filter((name) => name !== creator) : [...cur, creator])}
            onSelect={setSelected}
          />
        )}
        {chart === "speed" && <SpeedScatter rows={chartRows} filters={filters} colorBy={colorBy} selected={selected} onSelect={setSelected} legendRows={scoped} hiddenCreators={hiddenCreators} highlightCreator={highlightCreator} onHighlightCreator={setHighlightCreator} onToggleCreator={(creator) => setHiddenCreators((cur) => cur.includes(creator) ? cur.filter((name) => name !== creator) : [...cur, creator])} />}
        <TopValueBars rows={chartRanked} filters={filters} selected={selected} onSelect={setSelected} />
        </div>
      </section>
      <aside className="insight-rail" aria-label="Selection insights">
        <div className="insight-heading"><p className="section-kicker">DECISION GUIDE</p><h2>In this view</h2><p>Based on your criteria</p></div>
        <KpiRow rows={ranked} total={snapshot.models.length} excludedForTask={excludedForTask} filters={filters} onSelect={setSelected} />
      </aside>
      </div>
      <RankingTable
        rows={tableRows}
        filters={filters}
        query={filters.modelQuery}
        onQuery={(modelQuery) => setFilters((f) => ({ ...f, modelQuery }))}
        selected={selected}
        pinned={pinned}
        onSelect={setSelected}
        onTogglePin={togglePin}
      />
      <section id="compare" className="compare-section" aria-label="Model comparison">
        <ComparePanel pinned={pinnedRows} allRows={snapshot.models} metrics={snapshot.metrics ?? []} costMode={filters.costMode} task={filters.task} onUnpin={togglePin} onClear={() => setPinned([])} />
      </section>
      <Footer snapshot={snapshot} />
      </div>
      {sidePanel}
      </div>
      {pinnedRows.length > 0 && <div className="shortlist-dock glass" role="region" aria-label="Current shortlist">
        <div className="dock-stack" aria-hidden="true">{pinnedRows.map((r, i) => <span key={r.slug} style={{ backgroundColor: ["#316bd6", "#a05b9d", "#148477"][i] }} />)}</div>
        <span><strong>{pinnedRows.length} {pinnedRows.length === 1 ? "model" : "models"} pinned</strong><small>Up to {MAX_PINNED} models</small></span>
        <a href="#compare">Compare <span aria-hidden="true">↗</span></a>
        <button type="button" onClick={() => setPinned([])} aria-label="Clear shortlist">×</button>
      </div>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="dashboard-shell">{children}</main>;
}

function Status({ text }: { text: string }) {
  return <p className="py-24 text-center text-sm text-muted">{text}</p>;
}

function uniqueProviders(rows: Row[]): ProviderOption[] {
  const map = new Map<string, string>();
  for (const r of rows) {
    const ids = r.gateway_providers ?? [];
    const names = r.gateway_provider_names ?? [];
    ids.forEach((id, i) => {
      if (!map.has(id)) map.set(id, names[i] ?? id);
    });
  }
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
