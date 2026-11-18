import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparePanel } from "./ComparePanel";
import { makeRow } from "../lib/testing";
import { TASKS } from "../lib/tasks";

describe("shortlist comparison", () => {
  it("provides a path to pin models when empty", () => {
    const html = renderToStaticMarkup(<ComparePanel pinned={[]} allRows={[]} metrics={[]} costMode="blended" task={TASKS[0]} onUnpin={() => {}} onClear={() => {}} />);
    expect(html).toContain('href="#ranking"');
    expect(html).toContain("Your shortlist starts here");
  });

  it("labels each model's index and preserves missing scores", () => {
    const rows = [makeRow({ slug: "a", name: "Alpha", scores: { intelligence: 50, engineering: 60 }, blended: 1 }), makeRow({ slug: "b", name: "Beta", scores: { intelligence: 40 }, blended: 2 })];
    const html = renderToStaticMarkup(<ComparePanel pinned={rows} allRows={rows} metrics={[]} costMode="blended" task={TASKS[0]} onUnpin={() => {}} onClear={() => {}} />);
    expect(html).toContain("Alpha, Engineering: 60.0");
    expect(html).toContain("Beta, Engineering: not measured");
    expect(html).toContain("Compared with Alpha");
    expect(html).toContain('aria-label="Remove Alpha from comparison"');
  });
});
