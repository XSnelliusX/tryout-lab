import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailDrawer } from "./DetailDrawer";
import { DEFAULT_PRICE_SENSITIVITY, defaultTask, tasksFromMetrics } from "../lib/tasks";
import { PRICE_MAX, type Filters } from "../lib/filters";
import type { Metric, Row } from "../lib/types";
import { makeRow } from "../lib/testing";

// Entirely synthetic data: no snapshot file is read.
const metrics: Metric[] = [
  { id: "intelligence", label: "General reasoning", short_label: "General", group: "Core index", kind: "index", scale: "index", description: "Synthetic index.", radar: true, default: true },
  { id: "scicode", label: "Coding · SciCode", short_label: "SciCode", group: "Coding", kind: "benchmark", scale: "percent", description: "Synthetic benchmark.", radar: false, default: false },
];
const rows: Row[] = [
  makeRow({
    slug: "orbit-pro", name: "Orbit Pro", creator: "Orbit Labs", gateway_ids: ["orbit-pro"],
    scores: { intelligence: 50, scicode: 40 }, blended: 3, costPerTask: 12,
    hosts: [{ host: "Demo Host", host_slug: "demo", input_per_1m: 2, output_per_1m: 8, cost_per_task_usd: 12, output_tokens_per_second: 90, time_to_first_token_seconds: 0.6 }],
  }),
  makeRow({ slug: "old-chat", name: "Old Chat", creator: "Legacy Inc", gateway_ids: ["old-chat"], release_deprecated: true, scores: { intelligence: 10 } }),
];
const snapshot = { metrics, models: rows };
const tasks = tasksFromMetrics(snapshot.metrics);
const filters: Filters = {
  task: defaultTask(tasks),
  costMode: "task",
  valueMode: "quality",
  priceSensitivity: DEFAULT_PRICE_SENSITIVITY,
  minScore: 0,
  maxPrice: PRICE_MAX,
  creators: [],
  modelQuery: "",
  includeFree: true,
  includeDeprecated: true,
  gatewayProvider: "",
  effort: "all",
  reasoning: "all",
};

describe("DetailDrawer", () => {
  it("renders provenance, scores, pricing and provider rows for a synthetic row", () => {
    const row = snapshot.models.find((r) => r.scores.scicode != null && (r.hosts?.length ?? 0) > 0);
    expect(row).toBeDefined();
    const html = renderToStaticMarkup(
      <DetailDrawer row={row!} filters={filters} tasks={tasks} metrics={snapshot.metrics ?? []} onClose={() => {}} />,
    );
    expect(html).toContain("Match &amp; provenance");
    expect(html).toContain("SciCode");
    expect(html).toContain("Provider availability");
    expect(html).toContain("Gateway cost per task");
  });

  it("renders a deprecated row without crashing", () => {
    const row = snapshot.models.find((r) => r.release_deprecated);
    expect(row).toBeDefined();
    const html = renderToStaticMarkup(
      <DetailDrawer row={row!} filters={filters} tasks={tasks} metrics={snapshot.metrics ?? []} onClose={() => {}} />,
    );
    expect(html).toContain("deprecated release");
  });
});
