import { describe, expect, it } from "vitest";
import { computeKpis, indexMaxima, median } from "./kpi";
import { taskById } from "./tasks";
import { makeRow } from "./testing";

const general = taskById("general");

describe("median", () => {
  it("handles empty, odd and even sets", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("computeKpis", () => {
  // Scores 10..40 with prices 1..4, so value = 10, 10, 10, 10 ... adjust below.
  const rows = [
    makeRow({ slug: "weak-cheap", scores: { intelligence: 10 }, blended: 0.2 }),
    makeRow({ slug: "mid", scores: { intelligence: 20 }, blended: 1 }),
    makeRow({ slug: "good-mid-price", scores: { intelligence: 30 }, blended: 3 }),
    makeRow({ slug: "top", scores: { intelligence: 40 }, blended: 10 }),
  ];

  it("picks the highest value ratio as best value", () => {
    // values: 50, 20, 10, 4 -> weak-cheap wins on value
    expect(computeKpis(rows, general, "blended").bestValue?.slug).toBe("weak-cheap");
  });

  it("picks the highest score as top score", () => {
    expect(computeKpis(rows, general, "blended").topScore?.slug).toBe("top");
  });

  it("cheapest-above-median ignores models below the median score", () => {
    // median of 10,20,30,40 is 25; weak-cheap and mid fall below it
    const k = computeKpis(rows, general, "blended");
    expect(k.medianScore).toBe(25);
    expect(k.cheapestAboveMedian?.slug).toBe("good-mid-price");
  });

  it("picks a free model as cheapest when its score reaches the median", () => {
    const withFree = [...rows, makeRow({ slug: "free", scores: { intelligence: 35 }, blended: 0 })];
    expect(computeKpis(withFree, general, "blended").cheapestAboveMedian?.slug).toBe("free");
  });

  it("breaks price ties with the higher score", () => {
    const tied = [
      makeRow({ slug: "a", scores: { intelligence: 30 }, blended: 2 }),
      makeRow({ slug: "b", scores: { intelligence: 35 }, blended: 2 }),
      makeRow({ slug: "c", scores: { intelligence: 5 }, blended: 1 }),
    ];
    expect(computeKpis(tied, general, "blended").cheapestAboveMedian?.slug).toBe("b");
  });

  it("returns nulls when nothing is scored", () => {
    const k = computeKpis([makeRow({ slug: "x", blended: 1 })], general, "blended");
    expect(k.medianScore).toBeNull();
    expect(k.bestValue).toBeNull();
    expect(k.topScore).toBeNull();
    expect(k.cheapestAboveMedian).toBeNull();
  });
});

describe("indexMaxima", () => {
  it("rounds each axis up to a multiple of ten with a floor of ten", () => {
    const max = indexMaxima([
      makeRow({ scores: { intelligence: 57.2, coding: 3 } }),
      makeRow({ scores: { intelligence: 41 } }),
    ]);
    expect(max.intelligence).toBe(60);
    expect(max.scicode).toBe(10);
  });
});
