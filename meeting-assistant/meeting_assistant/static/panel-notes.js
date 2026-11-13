// Notes tab: exports & transcript saving at top, followed by AI notes/review results and collapsed advanced tools.
import { el } from "/glass.js";
import { mount as mountExport } from "/panel-export.js";
import { mount as mountReview } from "/panel-review.js";

export function mount(container) {
  const wrap = el("div", { class: "pn" });
  const exportHost = el("div", { class: "pn-stack" });
  const reviewHost = el("div", { class: "pn-stack" });

  wrap.append(exportHost, el("hr", { class: "divider pn-divider" }), reviewHost);
  container.replaceChildren(wrap);

  const unmountExport = mountExport(exportHost);
  const unmountReview = mountReview(reviewHost);
  return () => {
    unmountReview?.();
    unmountExport?.();
  };
}
