import { Dialog } from "open-glass-ui";
import { CRITERIA, TIERS, type TierName } from "../lib/engine";
import { NEED_COLORS } from "./decision";

const TIER_ORDER: { tier: TierName; card: string }[] = [
  { tier: "light", card: "Easy" }, { tier: "standard", card: "Medium" }, { tier: "hard", card: "Difficult" }, { tier: "frontier", card: "Escalation" },
];

// One sheet that explains both panels: what is scored, and how a pick is made.
export function HowItWorks({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog title="How recommendations work" description="The same engine picks for this page, cc-models and the prompt rewriter." open={open} onOpenChange={onOpenChange}>
    <div className="sheet">
      <section>
        <h3>Two questions, in order</h3>
        <ol className="sheet-steps">
          <li><strong>Is it good enough?</strong> A model must reach a share of the best score available for the work.</li>
          <li><strong>Is the extra worth it?</strong> Among those, each doubling of the cost per task must buy enough extra score; otherwise the cheaper model wins.</li>
        </ol>
      </section>
      <section>
        <h3>What is scored</h3>
        <p>Difficulty cards use the benchmark you selected. Herdr roles are scored on what each role needs, a weighted mix of:</p>
        <ul className="sheet-criteria">
          {Object.entries(CRITERIA).map(([key, c]) => <li key={key}><span className="dot" style={{ background: NEED_COLORS[key] }} aria-hidden="true" /><strong>{c.label}</strong><span>{c.description}</span></li>)}
        </ul>
        <p className="sheet-note">Each criterion counts 0–100 against the best current model. The mix is a weighted geometric mean, so a strength never hides a weakness: a fast model that cannot use tools is no researcher.</p>
      </section>
      <section>
        <h3>Tiers and budgets</h3>
        <table className="sheet-table">
          <thead><tr><th scope="col">Tier</th><th scope="col">Must reach (lean · balanced · max)</th><th scope="col">Points per cost doubling</th></tr></thead>
          <tbody>{TIER_ORDER.map(({ tier, card }) => {
            const t = TIERS[tier];
            return <tr key={tier}><th scope="row">{t.label}<small>{card}</small></th><td>{pct(t.floor.lean)} · {pct(t.floor.balanced)} · {pct(t.floor.max)}</td><td>{t.perDoubling.lean} · {t.perDoubling.balanced} · {t.perDoubling.max}</td></tr>;
          })}</tbody>
        </table>
        <p className="sheet-note">Price focus uses the lean budget, quality focus the balanced one, speed focus also rewards tokens per second. Costs are per task at your gateway price for that exact route and effort. Superseded releases are never recommended; a $0 price counts as $0.005. These are benchmark heuristics, not guarantees.</p>
      </section>
    </div>
  </Dialog>;
}

function pct(v: number) {
  return `${Math.round(v * 100)}%`;
}
