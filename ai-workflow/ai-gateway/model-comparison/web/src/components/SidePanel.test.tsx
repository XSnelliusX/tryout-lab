import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HowItWorks } from "./HowItWorks";

describe("side panels", () => {
  it("renders the method as a docked side panel, not a modal dialog", () => {
    const html = renderToStaticMarkup(<HowItWorks onClose={() => {}} />);
    expect(html).toContain('class="detail-drawer side-panel"');
    expect(html).toContain("How recommendations work");
    expect(html).toContain("Price of quality");
    expect(html).not.toContain('role="dialog"');
  });
});
