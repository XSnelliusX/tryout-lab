import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CreatorLegend, chartLegendRows } from "./CreatorLegend";
import { makeRow } from "../lib/testing";
import { DEFAULT_PRICE_SENSITIVITY, taskById } from "../lib/tasks";
import { PRICE_MAX, type Filters } from "../lib/filters";

describe("creator legend", () => {
  it("keeps hidden creators available to restore and identifies their models", () => {
    const model = makeRow({ slug: "a", name: "Alpha", scores: { intelligence: 30 }, blended: 1 });
    model.creator = "OpenAI";
    const html = renderToStaticMarkup(<CreatorLegend rows={[model]} hidden={["OpenAI"]} highlighted="OpenAI" theme={{ ink: "#000", muted: "#555", line: "#eee", surface: "#fff" }} onToggle={() => {}} onHighlight={() => {}} />);
    expect(html).toContain('aria-label="Show OpenAI on charts"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Alpha");
    expect(html).toContain("not the ranking or recommendations");
  });

  it("lists only models plotted in the active speed chart", () => {
    const measured = makeRow({ slug: "a", name: "Alpha", scores: { intelligence: 30 }, blended: 1 });
    const missing = makeRow({ slug: "b", name: "Beta", scores: { intelligence: 30 }, blended: 1 });
    measured.performance.output_tokens_per_second = 20;
    missing.performance.output_tokens_per_second = null;
    const filters: Filters = { task: taskById("general"), costMode: "blended", valueMode: "quality", sensitivity: 6, priceSensitivity: DEFAULT_PRICE_SENSITIVITY, minScore: 0, maxPrice: PRICE_MAX, creators: [], modelQuery: "", includeFree: true, includeDeprecated: true, gatewayProvider: "", effort: "all", reasoning: "all" };
    expect(chartLegendRows([measured, missing], filters, "speed").map((r) => r.slug)).toEqual(["a"]);
  });
});
