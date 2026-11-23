import { describe, expect, it } from "vitest";
import { paretoFrontier } from "./pareto";
import { TASKS, defaultTask, priceFor, scoreFor, taskById, tasksFromMetrics, valueFor, type Task } from "./tasks";
import { displayName, formatNumber, formatUsd } from "./format";
import { applyFilters, priceFromSlider, rankByValue, sliderFromPrice, PRICE_MAX, SLIDER_STEPS, type Filters } from "./filters";
import { normalize } from "./useSnapshot";
import type { Snapshot } from "./types";
import { makeRow } from "./testing";

const general: Task = taskById("general");

function baseFilters(over: Partial<Filters> = {}): Filters {
  return {
    task: general,
    costMode: "blended",
    valueMode: "price",
    priceSensitivity: 0.35,
    minScore: 0,
    maxPrice: PRICE_MAX,
    creators: [],
    modelQuery: "",
    includeFree: true,
    includeDeprecated: true,
    gatewayProvider: "",
    effort: "all",
    reasoning: "all",
    ...over,
  };
}

describe("tasks", () => {
  it("defines fallback tasks with unique ids", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(9);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    expect(defaultTask(TASKS).id).toBe("general");
  });

  it("builds the full task list from snapshot metrics", () => {
    const tasks = tasksFromMetrics([
      { id: "intelligence", label: "General", short_label: "General", group: "Core", kind: "index", scale: "index", description: "", radar: true, default: true },
      { id: "scicode", label: "Coding", short_label: "Coding", group: "Coding", kind: "benchmark", scale: "percent", description: "", radar: false, default: false },
    ]);
    // The recommendation workloads follow the core index, before the benchmarks.
    expect(tasks.map((t) => t.id)).toEqual(["intelligence", "workload:general", "workload:coding", "workload:agentic", "workload:planning", "workload:writing", "scicode"]);
    expect(tasks.at(-1)!.scale).toBe("percent");
    expect(defaultTask(tasks).id).toBe("intelligence");
  });

  it("maps the coding task to SciCode and keeps legacy snapshots working", () => {
    const modern = makeRow({ scores: { scicode: 61 } });
    const legacy = makeRow({ scores: { coding: 42 } });
    expect(scoreFor(modern, taskById("coding"))).toBe(61);
    expect(scoreFor(legacy, taskById("coding"))).toBe(42);
  });

  it("uses effective fallback prices before gateway-only prices", () => {
    const row = makeRow({ scores: { intelligence: 50 }, blended: 2 });
    row.pricing.gateway_input_per_1m = null;
    row.pricing.gateway_output_per_1m = null;
    row.pricing.effective_input_per_1m = 3;
    row.pricing.effective_output_per_1m = 9;
    row.pricing.blended_3_to_1_per_1m = 4.5;
    expect(priceFor(row, "blended")).toBe(4.5);
  });

  it("uses the coding score for the coding task, not intelligence", () => {
    const r = makeRow({ scores: { intelligence: 50, coding: 20 }, blended: 2 });
    expect(valueFor(r, general, "blended")!).toBeGreaterThan(valueFor(r, taskById("coding"), "blended")!);
  });

  it("returns null when the task score is not measured", () => {
    const r = makeRow({ scores: { intelligence: 50, coding: null }, blended: 2 });
    expect(valueFor(r, taskById("coding"), "blended")).toBeNull();
  });

  it("distinguishes genuinely free models from unpriced models", () => {
    expect(valueFor(makeRow({ scores: { intelligence: 50 }, blended: 0 }), general, "blended")).toBeCloseTo(50 / 0.005);
    expect(valueFor(makeRow({ scores: { intelligence: 50 }, blended: null }), general, "blended")).toBeNull();
  });

  it("switches between blended price and cost per task", () => {
    const r = makeRow({ scores: { intelligence: 60 }, blended: 3, costPerTask: 12 });
    expect(valueFor(r, general, "blended")!).toBeGreaterThan(valueFor(r, general, "task")!);
  });

  it("offers quality-first and speed-sensitive scores without cheap-price singularities", () => {
    const cheap = makeRow({ slug: "cheap", scores: { intelligence: 20 }, blended: 0.001 });
    const strong = makeRow({ slug: "strong", scores: { intelligence: 60 }, blended: 1 });
    expect(valueFor(strong, general, "blended", "quality")!).toBeGreaterThan(valueFor(cheap, general, "blended", "quality")!);
    expect(valueFor(strong, general, "blended", "speed")).toBeNull();
    const faster = { ...strong, performance: { ...strong.performance, output_tokens_per_second: 200 } };
    const slower = { ...strong, performance: { ...strong.performance, output_tokens_per_second: 20 } };
    expect(valueFor(faster, general, "blended", "speed")!).toBeGreaterThan(valueFor(slower, general, "blended", "speed")!);
  });

  it("uses gateway zero for free models even when AA measured a paid benchmark", () => {
    const free = makeRow({ scores: { intelligence: 40 }, blended: 0, costPerTask: 3 });
    expect(valueFor(free, general, "task", "price")).toBeCloseTo(40 / 0.005);
    expect(valueFor(free, general, "task", "quality")).toBeGreaterThan(0);
    expect(applyFilters([free], baseFilters({ costMode: "task" }))).toHaveLength(1);
  });
});

describe("paretoFrontier", () => {
  it("keeps only points no other point beats on cost and score", () => {
    const pts = [
      { id: "cheap-weak", cost: 1, score: 10 },
      { id: "mid", cost: 5, score: 40 },
      { id: "dominated", cost: 6, score: 30 },
      { id: "pricey-best", cost: 20, score: 60 },
      { id: "dominated2", cost: 25, score: 55 },
    ];
    expect(paretoFrontier(pts).map((p) => p.id)).toEqual(["cheap-weak", "mid", "pricey-best"]);
  });

  it("returns an empty list for no points", () => {
    expect(paretoFrontier([])).toEqual([]);
  });

  it("handles equal cost by keeping the higher score", () => {
    const pts = [
      { id: "a", cost: 2, score: 30 },
      { id: "b", cost: 2, score: 50 },
    ];
    expect(paretoFrontier(pts).map((p) => p.id)).toEqual(["b"]);
  });
});

describe("snapshot normalisation", () => {
  it("turns null lists from older exports into empty arrays", () => {
    const raw = {
      schema_version: 1,
      generated_at: "2026-10-27T00:00:00Z",
      intelligence_index_version: 4.3,
      source: { artificial_analysis: "", gateway: "", attribution: "" },
      counts: { gateway_chat_models: 0, matched: 0, unmatched: 0, ambiguous: 0, rows: 0 },
      unmatched_gateway_models: null,
      ambiguous_matches: null,
      models: null,
    } as unknown as Snapshot;
    const out = normalize(raw);
    expect(out.unmatched_gateway_models).toEqual([]);
    expect(out.ambiguous_matches).toEqual([]);
    expect(out.models).toEqual([]);
  });
});

describe("format", () => {
  it("shows missing values as an en dash, never zero", () => {
    expect(formatNumber(null)).toBe("–");
    expect(formatUsd(null)).toBe("–");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats USD with two decimals", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
  });

  it("drops the internal Default Fallback tag from display names", () => {
    expect(displayName("Claude Opus 5.5 (Max, Default Fallback)")).toBe("Claude Opus 5.5 (Max)");
    expect(displayName("Claude Fable 5.1 (Low, Default Fallback)")).toBe("Claude Fable 5.1 (Low)");
    expect(displayName("Plain Model (High)")).toBe("Plain Model (High)");
    expect(displayName("Odd (Default Fallback)")).toBe("Odd");
  });
});

describe("log price slider", () => {
  it("maps the ends of the slider to the price range", () => {
    expect(priceFromSlider(0)).toBeCloseTo(0.001, 6);
    expect(priceFromSlider(SLIDER_STEPS)).toBe(PRICE_MAX);
  });

  it("round-trips a price within 1% through the slider", () => {
    for (const p of [0.1, 1, 5, 20]) {
      expect(Math.abs(priceFromSlider(sliderFromPrice(p)) - p) / p).toBeLessThan(0.01);
    }
  });
});

describe("applyFilters", () => {
  const rows = [
    makeRow({ slug: "cheap", creator: "A", scores: { intelligence: 30 }, blended: 0.5 }),
    makeRow({ slug: "pricey", creator: "B", scores: { intelligence: 60 }, blended: 20 }),
    makeRow({ slug: "free", creator: "A", scores: { intelligence: 40 }, blended: 0 }),
    makeRow({ slug: "unpriced", creator: "A", scores: { intelligence: 40 }, blended: null }),
    makeRow({ slug: "noscore", creator: "A", scores: { intelligence: null }, blended: 1 }),
  ];

  it("drops rows without a score for the task", () => {
    expect(applyFilters(rows, baseFilters()).map((r) => r.slug)).not.toContain("noscore");
  });

  it("includes free rows and excludes unpriced rows", () => {
    const slugs = applyFilters(rows, baseFilters()).map((r) => r.slug);
    expect(slugs).toEqual(["cheap", "pricey", "free"]);
  });

  it("can exclude free models without including unpriced models", () => {
    expect(applyFilters(rows, baseFilters({ includeFree: false })).map((r) => r.slug)).toEqual(["cheap", "pricey"]);
  });

  it("applies the max price cap", () => {
    const slugs = applyFilters(rows, baseFilters({ maxPrice: 5 })).map((r) => r.slug);
    expect(slugs).toContain("cheap");
    expect(slugs).not.toContain("pricey");
  });

  it("filters by creator and minimum score", () => {
    const slugs = applyFilters(rows, baseFilters({ creators: ["B"], minScore: 50 })).map((r) => r.slug);
    expect(slugs).toEqual(["pricey"]);
  });

  it("searches names, slugs, aliases, releases and gateway ids", () => {
    expect(applyFilters(rows, baseFilters({ modelQuery: "CHEAP" })).map((r) => r.slug)).toEqual(["cheap"]);
    expect(applyFilters(rows, baseFilters({ modelQuery: "not a model" }))).toEqual([]);
    const aliased = makeRow({ slug: "alias-row", scores: { intelligence: 40 }, blended: 1 });
    aliased.aliases = ["friendly-alias"];
    aliased.release_slug = "release-family";
    aliased.gateway_providers = ["gw-azure"];
    expect(applyFilters([aliased], baseFilters({ modelQuery: "friendly-alias" }))).toHaveLength(1);
    expect(applyFilters([aliased], baseFilters({ modelQuery: "release-family" }))).toHaveLength(1);
    expect(applyFilters([aliased], baseFilters({ gatewayProvider: "gw-azure" }))).toHaveLength(1);
    expect(applyFilters([aliased], baseFilters({ gatewayProvider: "gw-openai" }))).toHaveLength(0);
  });

  it("filters by primary versus non-primary variants", () => {
    const primary = makeRow({ slug: "primary", scores: { intelligence: 50 }, blended: 1, is_primary: true, effort: "max" });
    const variant = makeRow({ slug: "variant", scores: { intelligence: 40 }, blended: 1, is_primary: false, effort: "low" });
    expect(applyFilters([primary, variant], baseFilters({ effort: "base" })).map((r) => r.slug)).toEqual(["primary"]);
    expect(applyFilters([primary, variant], baseFilters({ effort: "effort" })).map((r) => r.slug)).toEqual(["variant"]);
  });

  it("ranks by value and puts unpriced rows last", () => {
    const ranked = rankByValue(applyFilters(rows, baseFilters()), baseFilters()).map((r) => r.slug);
    expect(ranked[0]).toBe("free");
    expect(ranked).not.toContain("unpriced");
  });
});
