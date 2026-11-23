import { describe, expect, it } from "vitest";
import { makeRow } from "./testing";
import { taskById, valueFor } from "./tasks";
import { recommendByDifficulty } from "./recommendations";

const general = taskById("general");
const row = (slug: string, score: number, cost: number) =>
  makeRow({ slug, scores: { intelligence: score }, blended: 1, costPerTask: cost });

describe("relative cost-performance regression", () => {
  it("prefers the cheaper model for a 1.5% score improvement costing 128% more", () => {
    const sol = row("sol", 51.8, 0.72);
    const argon = row("argon", 52.6, 1.64);
    expect(valueFor(sol, general, "task", "quality")!).toBeGreaterThan(valueFor(argon, general, "task", "quality")!);
  });

  it("recommends Sol instead of Argon: +1.5% score is not worth +128% cost, even for difficult work", () => {
    const sol = row("sol", 51.8, 0.72);
    const argon = row("argon", 52.6, 1.64);
    const rows = [row("lower-a", 20, 1), row("lower-b", 40, 1), sol, argon];
    const [, medium, difficult] = recommendByDifficulty(rows, general, "task", "quality");
    expect(medium.result?.pick.slug).toBe("sol");
    expect(difficult.result?.pick.slug).toBe("sol");
  });

  it("pays for a large gain at a small premium", () => {
    const rows = [row("sol", 51.8, 0.72), row("better", 70, 1)];
    expect(recommendByDifficulty(rows, general, "task", "quality")[1].result?.pick.slug).toBe("better");
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

  it("names the next step up with its score and cost", () => {
    const sol = row("sol", 51.8, 0.72), argon = row("argon", 52.6, 1.64);
    const medium = recommendByDifficulty([sol, argon], general, "task", "quality")[1].result!;
    expect(medium.pick.slug).toBe("sol");
    expect(medium.stronger?.slug).toBe("argon");
    expect(medium.reason).toMatch(/next step up: argon \+0\.8 points for 2\.3x the cost/);
  });

  it("counts a $0 model as cheap, not infinitely good", () => {
    const free = row("free", 30, 0), paid = row("paid", 55, 1);
    free.pricing.gateway_input_per_1m = 0;
    free.pricing.gateway_output_per_1m = 0;
    free.pricing.effective_input_per_1m = 0;
    free.pricing.effective_output_per_1m = 0;
    free.pricing.blended_3_to_1_per_1m = 0;
    expect(Number.isFinite(valueFor(free, general, "task", "price")!)).toBe(true);
    expect(valueFor(paid, general, "task", "quality")!).toBeGreaterThan(valueFor(free, general, "task", "quality")!);
    const difficult = recommendByDifficulty([free, paid], general, "task", "quality")[2].result!;
    expect(difficult.pick.slug).toBe("paid");
  });

  it("lets a strong free model win when it clears the floor", () => {
    const free1 = makeRow({ slug: "f1", scores: { intelligence: 40 }, blended: 0 });
    const free2 = makeRow({ slug: "f2", scores: { intelligence: 66 }, blended: 0 });
    const paid = makeRow({ slug: "paid", scores: { intelligence: 70 }, blended: 1 });
    const results = recommendByDifficulty([free1, free2, paid], general, "blended", "quality");
    expect(results[2].result?.pick.slug).toBe("f2");
    expect(results[2].result?.pick.free).toBe(true);
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
