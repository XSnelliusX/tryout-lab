import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlBar } from "./ControlBar";
import { PRICE_MAX, type Filters } from "../lib/filters";
import { DEFAULT_PRICE_SENSITIVITY, TASKS, defaultTask } from "../lib/tasks";

const filters: Filters = {
  task: defaultTask(TASKS), costMode: "task", valueMode: "quality",
  sensitivity: 6, priceSensitivity: DEFAULT_PRICE_SENSITIVITY, minScore: 0, maxPrice: PRICE_MAX,
  creators: [], modelQuery: "", includeFree: true, includeDeprecated: true,
  gatewayProvider: "", effort: "all", reasoning: "all",
};

describe("criteria rail", () => {
  it("offers only the criteria that drive the picks: benchmark, price of quality, max cost, provider and speed", () => {
    const html = renderToStaticMarkup(<ControlBar filters={filters} setFilters={() => {}} onSensitivity={() => {}} gatewayProviders={[{ id: "gw-a", name: "A" }]} taskOptions={TASKS} onReset={() => {}} />);
    for (const text of ["Benchmark", "Price of quality", "Max quality", "Balanced", "Lean", "Max cost per task", "Gateway provider", "Speed counts"]) expect(html).toContain(text);
    for (const gone of ["More filters", "Cost basis", "Min score", "Include deprecated", "Artificial Analysis", "Search models"]) expect(html).not.toContain(gone);
    expect(html).toContain('role="switch"');
  });
});
