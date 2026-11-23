import { SidePanel } from "./SidePanel";
import { CRITERIA, SENSITIVITY, TIERS, type TierName } from "../lib/engine";
import { NEED_COLORS } from "./decision";

const TIER_ORDER: { tier: TierName; card: string }[] = [
  { tier: "light", card: "Easy" }, { tier: "standard", card: "Medium" }, { tier: "hard", card: "Difficult" }, { tier: "frontier", card: "Hardest" },
];

// One sheet that explains the recommendations: what is scored, and how a pick is made.
export function HowItWorks({ onClose }: { onClose: () => void }) {
  return <SidePanel kicker="METHOD" title="How recommendations work" subtitle="The same engine picks for this page, cc-models and the prompt rewriter." label="How recommendations work" onClose={onClose}>
    <div className="sheet">
      <section>
        <h3>Two questions, in order</h3>
        <ol className="sheet-steps">
          <li><strong>Is it good enough?</strong> A model must reach a share of the best score available for the work.</li>
          <li><strong>Is the extra worth it?</strong> Among those, each doubling of the cost per task must buy enough extra score; otherwise the cheaper model wins. The highest score is not the goal: the score per dollar it takes to get there is.</li>
        </ol>
      </section>
      <section>
        <h3>What is scored</h3>
        <p>The "Any task" row of each tier uses the benchmark you selected. Herdr roles are scored on what each role needs, a weighted mix of:</p>
        <ul className="sheet-criteria">
          {Object.entries(CRITERIA).map(([key, c]) => <li key={key}><span className="dot" style={{ background: NEED_COLORS[key] }} aria-hidden="true" /><strong>{c.label}</strong><span>{c.description}</span></li>)}
        </ul>
        <p className="sheet-note">Each criterion counts 0–100 against the best current model. The mix is a weighted geometric mean, so a strength never hides a weakness: a fast model that cannot use tools is no researcher.</p>
      </section>
      <section>
        <h3>Price of quality</h3>
        <p>One cost sensitivity, set with the Price of quality slider in the criteria: the score points (% of the best) a doubling of cost must buy on standard work. Presets: Max quality {SENSITIVITY.max}, Balanced {SENSITIVITY.balanced}, Lean {SENSITIVITY.lean}; cc-models applies the same presets. Each tier scales it, so harder work may cost more:</p>
        <table className="sheet-table">
          <thead><tr><th scope="col">Tier</th><th scope="col">Must reach</th><th scope="col">Points per cost doubling</th></tr></thead>
          <tbody>{TIER_ORDER.map(({ tier, card }) => {
            const t = TIERS[tier];
            return <tr key={tier}><th scope="row">{t.label}<small>{card}</small></th><td>{pct(t.floor.quality)} (max quality) to {pct(t.floor.cost)} (lean)</td><td>{t.priceScale} × sensitivity</td></tr>;
          })}</tbody>
        </table>
        <p className="sheet-note">The curve shows what one task on every role costs against the roles' average fit for every sensitivity; choose a point to use it. "Speed counts" also rewards a short wait for the first answer token and more tokens per second. Costs are per task at your gateway price for that exact route and effort. Superseded releases are never recommended; a $0 price counts as $0.005. These are benchmark heuristics, not guarantees.</p>
      </section>
    </div>
  </SidePanel>;
}

function pct(v: number) {
  return `${Math.round(v * 100)}%`;
}
