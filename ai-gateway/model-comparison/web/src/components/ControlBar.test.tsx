import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlBar } from "./ControlBar";
import { PRICE_MAX, type Filters } from "../lib/filters";
import { DEFAULT_PRICE_SENSITIVITY, TASKS, defaultTask } from "../lib/tasks";

const filters: Filters = {
  task: defaultTask(TASKS), costMode: "task", valueMode: "quality",
  priceSensitivity: DEFAULT_PRICE_SENSITIVITY, minScore: 0, maxPrice: PRICE_MAX,
  creators: [], modelQuery: "", includeFree: true, includeDeprecated: true,
  gatewayProvider: "", effort: "all", reasoning: "all",
};

describe("comparison controls", () => {
  it("keeps model search visible and advanced options available through disclosure", () => {
    const html = renderToStaticMarkup(<ControlBar filters={filters} setFilters={() => {}} creators={[]} gatewayProviders={[]} taskOptions={TASKS} colorBy="creator" setColorBy={() => {}} onReset={() => {}} />);
    expect(html.indexOf('aria-label="Search models"')).toBeLessThan(html.indexOf('class="advanced-filters"'));
    expect(html).toContain("More filters &amp; settings");
    expect(html).toContain("How the utility score is calculated");
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('role="radio"');
  });
});
