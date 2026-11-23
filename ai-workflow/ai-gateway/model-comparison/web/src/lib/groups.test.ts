import { describe, expect, it } from "vitest";
import { bestValue, groupByBase } from "./groups";
import { taskById } from "./tasks";
import { makeRow } from "./testing";

const general = taskById("general");

describe("groupByBase", () => {
  it("retains all descendants when variant slugs themselves have variants", () => {
    const rows = [
      makeRow({ slug: "a", name: "A (Max)", scores: { intelligence: 50 }, blended: 1 }),
      makeRow({ slug: "a-low", name: "A (Low)", scores: { intelligence: 40 }, blended: 1 }),
      makeRow({ slug: "a-low-extra", name: "A (Low)", scores: { intelligence: 30 }, blended: 1 }),
    ];
    const groups = groupByBase(rows, general, "blended");
    expect(groups).toHaveLength(1);
    expect(groups[0].variants.map((r) => r.slug)).toEqual(["a-low", "a-low-extra"]);
  });

  it("orders groups by the chosen utility rather than the price-only ratio", () => {
    const rows = [
      makeRow({ slug: "cheap", name: "Cheap", scores: { intelligence: 20 }, blended: 0.4 }),
      makeRow({ slug: "strong", name: "Strong", scores: { intelligence: 38 }, blended: 1 }),
    ];
    expect(groupByBase(rows, general, "blended", "price")[0].key).toBe("cheap");
    expect(groupByBase(rows, general, "blended", "quality")[0].key).toBe("strong");
  });
  it("nests effort variants under their base model", () => {
    const rows = [
      makeRow({ slug: "gpt-6-sol", name: "GPT-6 Sol (Max)", scores: { intelligence: 60 }, blended: 5 }),
      makeRow({ slug: "gpt-6-sol-low", name: "GPT-6 Sol (Low)", effort: "low", scores: { intelligence: 45 }, blended: 5 }),
      makeRow({ slug: "gpt-6-sol-high", name: "GPT-6 Sol (High)", effort: "high", scores: { intelligence: 55 }, blended: 5 }),
    ];
    const groups = groupByBase(rows, general, "blended");
    expect(groups).toHaveLength(1);
    expect(groups[0].base.slug).toBe("gpt-6-sol");
    expect(groups[0].variants.map((v) => v.slug)).toEqual(["gpt-6-sol-high", "gpt-6-sol-low"]);
  });

  it("groups by release_slug when the enriched snapshot provides it", () => {
    const rows = [
      makeRow({ slug: "release-a", name: "A (Max)", release_slug: "release-a", scores: { intelligence: 50 }, blended: 1 }),
      makeRow({ slug: "release-a-low", name: "A (Low)", release_slug: "release-a", scores: { intelligence: 40 }, blended: 1 }),
      makeRow({ slug: "release-b", name: "B", release_slug: "release-b", scores: { intelligence: 30 }, blended: 1 }),
    ];
    const groups = groupByBase(rows, general, "blended");
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.key === "release-a")!;
    expect(a.base.slug).toBe("release-a");
    expect(a.variants.map((v) => v.slug)).toEqual(["release-a-low"]);
  });

  it("keeps a base model with no variants as a group of one", () => {
    const groups = groupByBase([makeRow({ slug: "solo", scores: { intelligence: 30 }, blended: 1 })], general, "blended");
    expect(groups).toHaveLength(1);
    expect(groups[0].variants).toEqual([]);
  });

  it("never claims a sibling model as a variant", () => {
    const rows = [
      makeRow({ slug: "claude-opus-5", name: "Claude Opus 5 (Max)", scores: { intelligence: 50 }, blended: 5 }),
      makeRow({ slug: "claude-opus-5-5", name: "Claude Opus 5.5 (Max)", scores: { intelligence: 58 }, blended: 5 }),
      makeRow({ slug: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", effort: "low", scores: { intelligence: 40 }, blended: 5 }),
    ];
    const groups = groupByBase(rows, general, "blended");
    const byKey = Object.fromEntries(groups.map((g) => [g.base.slug, g.variants.map((v) => v.slug)]));
    expect(byKey["claude-opus-5-5"]).toEqual(["claude-opus-5-5-low"]);
    expect(byKey["claude-opus-5"]).toEqual([]);
  });

  it("keeps an orphaned variant as its own group when its base is filtered out", () => {
    const rows = [makeRow({ slug: "gpt-6-sol-low", name: "GPT-6 Sol (Low)", effort: "low", scores: { intelligence: 45 }, blended: 5 })];
    const groups = groupByBase(rows, general, "blended");
    expect(groups).toHaveLength(1);
    expect(groups[0].base.slug).toBe("gpt-6-sol-low");
  });

  it("orders groups by their best member value", () => {
    const rows = [
      makeRow({ slug: "weak", scores: { intelligence: 10 }, blended: 1 }),
      makeRow({ slug: "strong", name: "Strong (Max)", scores: { intelligence: 40 }, blended: 1 }),
      makeRow({ slug: "strong-low", name: "Strong (Low)", effort: "low", scores: { intelligence: 80 }, blended: 1 }),
    ];
    const groups = groupByBase(rows, general, "blended");
    expect(groups[0].base.slug).toBe("strong");
    expect(bestValue(groups[0], general, "blended")).toBeCloseTo(80);
  });

  it("sorts variants by value within a group", () => {
    const rows = [
      makeRow({ slug: "m", scores: { intelligence: 50 }, blended: 5 }),
      makeRow({ slug: "m-low", name: "M (Low)", effort: "low", scores: { intelligence: 30 }, blended: 1 }),
      makeRow({ slug: "m-high", name: "M (High)", effort: "high", scores: { intelligence: 40 }, blended: 1 }),
    ];
    const groups = groupByBase(rows, general, "blended");
    expect(groups[0].variants.map((v) => v.slug)).toEqual(["m-high", "m-low"]);
  });
});
