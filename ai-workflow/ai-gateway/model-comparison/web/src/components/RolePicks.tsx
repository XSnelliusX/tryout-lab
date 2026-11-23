import { label, formatCost, type Profile, type RecommendationsDocument, type RoleRecommendation } from "../lib/engine";

const PROFILES: Profile[] = ["lean", "balanced", "max"];

// Herdr Command Center roles: the model each role uses now next to the engine's
// lean, balanced and max picks (the table `cc-models recommend` prints).
export function RolePicks({ doc, onSelect }: { doc: RecommendationsDocument | null; onSelect: (slug: string) => void }) {
  const roles = doc?.roles;
  return <section id="roles" aria-label="Herdr role recommendations" className="ranking-section role-picks">
    <header><div><p className="section-kicker">HERDR COMMAND CENTER</p><h2>Models per role</h2>
      <p className="text-sm text-muted">{roles?.available ? <>Each role is scored on its own workload (coding roles on agentic coding, the Commander on tool use), at gateway prices, from {roles.providers.join(", ")}{roles.exclude.length ? ` · excluding ${roles.exclude.join(", ")}` : ""}.</> : null}</p></div></header>
    {!roles?.available
      ? <p className="recommendation-empty">No Herdr config found. Install herdr-commander (<code>ai-workflow/install.sh</code>) to get model picks per role here and in <code>cc-models recommend</code>.</p>
      : <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr><th scope="col" className="px-3 py-2 text-left">Role</th><th scope="col" className="px-3 py-2 text-left">Scored on</th><th scope="col" className="px-3 py-2 text-left">Current</th>{PROFILES.map((p) => <th key={p} scope="col" className="px-3 py-2 text-left">{p}</th>)}</tr></thead>
        <tbody>{roles.roles.map((r) => <Line key={r.role} r={r} onSelect={onSelect} />)}</tbody>
      </table></div>}
    {roles?.available && <p className="text-xs text-muted">“=” means the role already uses that pick. Apply one: <code>cc-models recommend --profile balanced --apply --role implementer</code> (asks first). The scores are the role&apos;s workload score; hover a pick for the reason.</p>}
  </section>;
}

function Line({ r, onSelect }: { r: RoleRecommendation; onSelect: (slug: string) => void }) {
  const c = r.current;
  return <tr>
    <th scope="row" className="px-3 py-2 text-left font-semibold">{r.role}</th>
    <td className="px-3 py-2 text-muted">{r.workload} · {r.tier}</td>
    <td className="px-3 py-2"><code>{c.placeholder ? "not set" : c.id.split("/").pop()}</code>{c.deprecated && <span className="model-status deprecated"> superseded</span>}<br /><small className="text-muted">{c.score ?? "–"} · {formatCost(c.cost_per_task_usd)}/task</small></td>
    {PROFILES.map((p) => {
      const pick = r.picks[p]?.pick;
      if (!pick) return <td key={p} className="px-3 py-2 text-muted">–</td>;
      const same = pick.id === c.id;
      return <td key={p} className="px-3 py-2" title={r.picks[p]!.reason}>
        {same ? <span aria-label="same as current">=</span> : <button type="button" className="text-left underline decoration-dotted" onClick={() => onSelect(pick.slug)}><code>{label(pick)}</code></button>}
        <br /><small className="text-muted">{pick.score} · {formatCost(pick.cost_per_task_usd)}/task</small>
      </td>;
    })}
  </tr>;
}
