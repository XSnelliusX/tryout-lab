import { describe, expect, it } from "vitest";
import { makeRow } from "./testing";
import { taskById, valueFor } from "./tasks";
import { costAxisPosition, costAxisValue, scoreExtent } from "./chartScales";
import { recommendByDifficulty } from "./recommendations";
import { paretoFrontier } from "./pareto";
import { buildOption as costChart } from "../components/ValueScatter";
import { buildOption as speedChart } from "../components/SpeedScatter";
import type { Filters } from "./filters";

const task = taskById("general");
const filters: Filters = { task, costMode: "blended", valueMode: "quality", priceSensitivity: 0.35, minScore: 0, maxPrice: 100, creators: [], modelQuery: "", includeFree: true, includeDeprecated: true, gatewayProvider: "", effort: "all", reasoning: "all" };
const theme = { ink: "#000", muted: "#555", line: "#eee", surface: "#fff" };

describe("decision-making regressions", () => {
  it("retains tied models on the cost frontier", () => {
    expect(paretoFrontier([{ id: "a", cost: 1, score: 50 }, { id: "b", cost: 1, score: 50 }, { id: "c", cost: 2, score: 50 }]).map((p) => p.id)).toEqual(["a", "b"]);
  });
  it("gives capability substantially more influence than price in both composite modes", () => {
    const weak = makeRow({ scores: { intelligence: 25 }, blended: 0.001 });
    const strong = makeRow({ scores: { intelligence: 65 }, blended: 1 });
    weak.performance.output_tokens_per_second = 100;
    strong.performance.output_tokens_per_second = 100;
    for (const mode of ["quality", "speed"] as const) {
      expect(valueFor(strong, task, "blended", mode)!).toBeGreaterThan(valueFor(weak, task, "blended", mode)!);
    }
  });

  it("plots free models at a real zero and maps positive prices reversibly", () => {
    expect(costAxisPosition(0, 0.1)).toBe(0);
    for (const n of [0.0045, 0.05, 1, 20]) expect(costAxisValue(costAxisPosition(n, 0.1), 0.1)).toBeCloseTo(n, 8);
    // Extremely cheap models should not consume an entire empty log decade.
    expect(costAxisPosition(0.0045, 0.1)).toBeLessThan(costAxisPosition(0.05, 0.1) / 4);
  });

  it("zooms score axes to the data without clipping endpoints", () => {
    const [min, max] = scoreExtent([35, 55]);
    expect(min).toBeGreaterThan(0);
    expect(min).toBeLessThan(35);
    expect(max).toBeGreaterThan(55);
  });

  it("uses the new scale in the real cost chart, including free models", () => {
    const rows = [makeRow({ slug: "free", name: "Free", scores: { intelligence: 40 }, blended: 0 }), makeRow({ slug: "paid", name: "Paid", scores: { intelligence: 55 }, blended: 1 })];
    const result = costChart(rows, filters, "creator", null, [], theme);
    expect(result.plotted).toBe(2);
    const series = result.option.series as Array<{ type: string; data: Array<{ slug?: string; value?: number[] }> }>;
    const free = series.filter((s) => s.type === "scatter").flatMap((s) => s.data).find((d) => d.slug === "free");
    expect(free?.value?.[0]).toBe(0);
    expect((result.option.xAxis as { type: string }).type).toBe("value");
  });

  it("keeps creator series visually distinct and consistent when filtered", () => {
    const openai = makeRow({ slug: "a", scores: { intelligence: 40 }, blended: 1 });
    const anthropic = makeRow({ slug: "b", scores: { intelligence: 50 }, blended: 2 });
    openai.creator = "OpenAI";
    anthropic.creator = "Anthropic";
    const series = (rows: typeof openai[]) => costChart(rows, filters, "creator", null, [], theme).option.series as Array<{ name: string; itemStyle?: { color: string } }>;
    const full = series([openai, anthropic]);
    const openaiColor = full.find((s) => s.name === "OpenAI")?.itemStyle?.color;
    expect(openaiColor).toBeDefined();
    expect(openaiColor).not.toEqual(full.find((s) => s.name === "Anthropic")?.itemStyle?.color);
    expect(series([openai])[0].itemStyle?.color).toEqual(openaiColor);
  });

  it("recomputes the cost frontier when a creator is hidden and dims other creators on hover", () => {
    const a = makeRow({ slug: "a", scores: { intelligence: 40 }, blended: 1 });
    const b = makeRow({ slug: "b", scores: { intelligence: 50 }, blended: 2 });
    a.creator = "OpenAI"; b.creator = "Anthropic";
    const full = costChart([a, b], filters, "creator", null, [], theme, "OpenAI");
    expect(full.frontierIds).toEqual(["a", "b"]);
    const series = full.option.series as Array<{ name: string; data: Array<{ itemStyle?: { opacity: number } }> }>;
    expect(series.find((s) => s.name === "Anthropic")?.data[0].itemStyle?.opacity).toBe(0.18);
    expect(costChart([b], filters, "creator", null, [], theme).frontierIds).toEqual(["b"]);
    const frontier = series.find((s) => s.name === "Pareto frontier") as unknown as { step: string };
    expect(frontier.step).toBe("end");
    const frontierData = series.find((s) => s.name === "Pareto frontier")!.data as unknown as number[][];
    expect(frontierData.at(-1)![0]).toBeGreaterThan(frontierData.at(-2)![0]);
  });

  it("zooms the real speed chart and preserves original speed in tooltips", () => {
    const row = makeRow({ scores: { intelligence: 40 }, blended: 1 });
    row.performance.output_tokens_per_second = 100;
    const chart = speedChart([row], filters, null, theme);
    const series = chart.series as Array<{ type: string; data: Array<{ speed?: number }> }>;
    expect(series[0].data[0].speed).toBe(100);
    expect((chart.yAxis as { min: number }).min).toBeGreaterThan(0);
    expect((chart.series as Array<{ step?: string }>)[1].step).toBe("start");
  });

  it("returns distinct explicitly estimated thresholds and never picks below one", () => {
    const rows = [10, 20, 30, 40, 50, 60].map((score) => makeRow({ slug: `m${score}`, scores: { intelligence: score }, blended: 1 }));
    const results = recommendByDifficulty(rows, task, "blended", "quality");
    expect(results).toHaveLength(3);
    expect(results[0].minimum).toBeLessThan(results[1].minimum);
    expect(results[1].minimum).toBeLessThan(results[2].minimum);
    for (const result of results) {
      expect(result.model!.scores.intelligence!).toBeGreaterThanOrEqual(result.minimum);
      if (result.maximum !== null) expect(result.model!.scores.intelligence!).toBeLessThan(result.maximum);
    }
    expect(new Set(results.map((r) => r.model!.slug)).size).toBe(3);
  });

  it("does not let missing-speed models distort speed-focused bands", () => {
    const rows = [20, 40, 60, 90].map((score) => {
      const row = makeRow({ slug: `m${score}`, scores: { intelligence: score }, blended: 1 });
      row.performance.output_tokens_per_second = score === 90 ? null : 100;
      return row;
    });
    const results = recommendByDifficulty(rows, task, "blended", "speed");
    expect(results[2].minimum).toBe(40);
    expect(results[2].model?.slug).toBe("m60");
  });

  it("does not fabricate a recommendation for a band with tied thresholds", () => {
    const rows = [1, 2].map((n) => makeRow({ slug: `m${n}`, scores: { intelligence: 40 }, blended: 1 }));
    const results = recommendByDifficulty(rows, task, "blended", "quality");
    expect(results[0].model).toBeNull();
    expect(results[1].model).toBeNull();
    expect(results[2].model).not.toBeNull();
  });
});
