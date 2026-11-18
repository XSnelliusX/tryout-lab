import { describe, expect, it } from "vitest";
import { makeRow } from "./testing";
import { taskById, valueFor } from "./tasks";
import { nextEfficientUpgrade, premiumComparison, recommendByDifficulty } from "./recommendations";

const general = taskById("general");
const row = (slug: string, score: number, cost: number) =>
  makeRow({ slug, scores: { intelligence: score }, blended: 1, costPerTask: cost });

describe("relative cost-performance regression", () => {
  it("prefers the cheaper model for a 1.5% score improvement costing 128% more", () => {
    const sol = row("sol", 51.8, 0.72);
    const argon = row("argon", 52.6, 1.64);
    expect(valueFor(sol, general, "task", "quality")!).toBeGreaterThan(valueFor(argon, general, "task", "quality")!);
  });

  it("recommends Sol instead of Argon in the same quality tier", () => {
    const sol = row("sol", 51.8, 0.72);
    const argon = row("argon", 52.6, 1.64);
    const rows = [row("lower-a", 20, 1), row("lower-b", 40, 1), sol, argon, row("higher-a", 60, 1), row("higher-b", 70, 1)];
    expect(recommendByDifficulty(rows, general, "task", "quality")[1].model?.slug).toBe("sol");
  });

  it("does not ignore proportional price differences at high absolute prices", () => {
    const cheaper = row("cheaper", 50, 100);
    const premium = row("premium", 51, 1000);
    expect(valueFor(cheaper, general, "task", "quality")!).toBeGreaterThan(valueFor(premium, general, "task", "quality")!);
  });

  it("treats the same percentage tradeoff the same after a currency scale change", () => {
    const lower = [row("low1", 50, 1), row("high1", 51, 10)];
    const higher = [row("low2", 50, 100), row("high2", 51, 1000)];
    expect(valueFor(lower[0], general, "task", "quality")! > valueFor(lower[1], general, "task", "quality")!).toBe(
      valueFor(higher[0], general, "task", "quality")! > valueFor(higher[1], general, "task", "quality")!,
    );
  });

  it("allows explicit premium sensitivity to change the result", () => {
    const a = row("standard", 50, 1), b = row("premium", 60, 1.3);
    expect(valueFor(b, general, "task", "quality", 0.3)!).toBeGreaterThan(valueFor(a, general, "task", "quality", 0.3)!);
    expect(valueFor(a, general, "task", "quality", 0.8)!).toBeGreaterThan(valueFor(b, general, "task", "quality", 0.8)!);
  });

  it("shows the actual score and cost percentage for a premium", () => {
    const sol = row("sol", 51.8, 0.72), argon = row("argon", 52.6, 1.64);
    const comparison = premiumComparison(argon, [sol, argon], general, "task");
    expect(comparison?.scoreGainPercent).toBeCloseTo(1.5444, 3);
    expect(comparison?.costIncreasePercent).toBeCloseTo(127.7778, 3);
    const upgrade = nextEfficientUpgrade(sol, [sol, argon], general, "task");
    expect(upgrade?.model.slug).toBe("argon");
    expect(upgrade?.costIncreasePercent).toBeCloseTo(127.7778, 3);
  });

  it("does not calculate a percentage increase from zero", () => {
    const free = row("free", 50, 0), paid = row("paid", 55, 1);
    free.pricing.gateway_input_per_1m = 0;
    free.pricing.gateway_output_per_1m = 0;
    free.pricing.effective_input_per_1m = 0;
    free.pricing.effective_output_per_1m = 0;
    free.pricing.blended_3_to_1_per_1m = 0;
    expect(premiumComparison(paid, [free, paid], general, "task")).toBeNull();
    expect(nextEfficientUpgrade(free, [free, paid], general, "task")).toBeNull();
  });

  it("sorts multiple free models by score, never by a NaN from Infinity minus Infinity", () => {
    const free1 = makeRow({ slug: "f1", scores: { intelligence: 40 }, blended: 0 });
    const free2 = makeRow({ slug: "f2", scores: { intelligence: 60 }, blended: 0 });
    const paid = makeRow({ slug: "paid", scores: { intelligence: 70 }, blended: 1 });
    const results = recommendByDifficulty([free1, free2, paid], general, "blended", "quality");
    expect(results[2].model?.slug).toBe("f2");
  });

  it("compares both relative improvements, with a percent-for-percent price focus", () => {
    const baseline = row("baseline", 50, 1);
    const scoreUp10 = row("score-up", 55, 1);
    const priceUp10 = row("price-up", 50, 1.1);
    const v = valueFor(baseline, general, "task", "price")!;
    expect(valueFor(scoreUp10, general, "task", "price")! / v).toBeCloseTo(1.1);
    expect(valueFor(priceUp10, general, "task", "price")! / v).toBeCloseTo(1 / 1.1);
  });

  it("cannot rank a free model without the selected score or required speed", () => {
    const free = makeRow({ slug: "free", scores: { intelligence: 50 }, blended: 0 });
    expect(valueFor(free, general, "blended", "speed")).toBeNull();
    expect(valueFor(free, taskById("coding"), "blended", "quality")).toBeNull();
  });
});
