import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Scrollbar } from "gpui-base";
import { spaces, agents, terminals, theme, run, exec, home, readTextFile, checking } from "herdr";

export default class CcTasks extends View {
  init(_props, cx) {
    this.budget = null;
    this.models = null;
    this.error = null;
    this.loading = false;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(30000, cx => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const [bRes, mRaw] = await Promise.all([
          exec(`${home()}/.local/bin/cc-budget`, [], { timeout: 10000 }),
          readTextFile(`${home()}/.config/command-center/models.json`),
        ]);
        if (bRes.code === 0) this.budget = JSON.parse(bRes.stdout);
        if (mRaw) this.models = JSON.parse(mRaw);
        this.error = null;
      } catch (e) {
        this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  pill(t, text, color, bg) {
    return div().px(6).py(2).rounded(5).bg(bg || t.surface).text_size(10.5).text_color(color || t.muted).child(text);
  }

  render(_cx) {
    const t = theme();
    const allSpaces = spaces();
    const allAgents = agents();
    const agentSet = new Set(allAgents.map(a => a.address));
    const allTerms = terminals().filter(x => x.state === "live");
    const termByAddr = new Map(allTerms.map(x => [x.address, x]));
    const treeKids = (addr, depth = 0, seen = new Set()) => {
      if (seen.has(addr)) return [];
      seen.add(addr);
      const out = [];
      for (const k of allTerms) {
        if (k.parent === addr && !agentSet.has(k.address)) {
          out.push({ term: k, depth });
          out.push(...treeKids(k.address, depth + 1, seen));
        }
      }
      return out;
    };

    const b = this.budget;
    const pct = Math.min(100, b?.pct_used ?? 0);
    const budgetColor = b?.status === "exceeded" || b?.status === "cap_tier3" ? t.blocked : b?.status === "warn" ? t.working : t.done;

    const blocked = allTerms.filter(x => x.status === "blocked" || x.status === "error");
    const roleEntries = Object.entries(this.models?.roles ?? {});

    const btn = (id, label, action) => div().id(id).px(8).py(5).rounded(6).bg(t.surface).text_size(11).text_color(t.foreground)
      .cursor_pointer().hover(s => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);

    return v_flex().id("cc-tasks-root").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12)
      .child(h_flex().flex_none().h(44).px(12).items_center().justify_between().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13.5).child("Mission Control"))
        .child(btn("cc-tasks-refresh", this.loading ? "…" : "Refresh", (_e, cx) => this.refresh(cx))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("cc-tasks-scroll").absolute().inset_0().overflow_y_scroll().p(12).gap(14)
          // Budget card
          .child(v_flex().p(10).gap(7).rounded(8).bg(t.surface).border(1).border_color(t.border)
            .child(h_flex().items_center().justify_between()
              .child(div().text_size(11).font_semibold().text_color(t.muted).child(b ? `BUDGET · ${b.month}` : "BUDGET"))
              .when(Boolean(b), el => el.child(this.pill(t, b.status === "cap_tier3" ? "Tier-3 Auto-Capped" : b.status === "warn" ? "Warn (>=75%)" : b.status === "exceeded" ? "Cap Reached" : "Healthy", budgetColor, budgetColor + "22"))))
            .when(Boolean(b), el => el
              .child(h_flex().items_baseline().justify_between()
                .child(div().text_size(18).font_semibold().child(`$${b.spent_usd.toFixed(2)} / $${b.cap_usd.toFixed(0)}`))
                .child(div().text_size(11).text_color(t.dim).child(`$${b.remaining_usd.toFixed(2)} left`)))
              .child(div().w_full().h(6).rounded(3).bg(t.raised)
                .child(div().h(6).rounded(3).bg(budgetColor).w(`${pct}%`)))
              .child(h_flex().justify_between().text_size(10.5).text_color(t.dim)
                .child(`Today $${b.today_usd.toFixed(2)} · Burn $${b.daily_burn_usd.toFixed(2)}/d`)
                .child(`Proj $${b.projected_usd.toFixed(0)}/mo`)))
            .when(!b, el => el.child(div().text_size(11).text_color(t.dim).child(this.error || "Loading gateway budget…"))))

          // Needs You / Blocked queue
          .when(blocked.length > 0, el => el.child(v_flex().gap(6)
            .child(div().text_size(11).font_semibold().text_color(t.blocked).child(`NEEDS YOU · ${blocked.length}`))
            .children(blocked.map(x => h_flex().id(`blk-${x.address}`).p(8).gap(8).rounded(7).bg(t.blocked + "18").border(1).border_color(t.blocked + "44")
              .items_center().cursor_pointer().hover(s => s.bg(t.blocked + "28"))
              .on_click(() => run(agentSet.has(x.address) ? "pane.focus" : "terminal.peek", { terminal: x.address }))
              .child(div().size(7).rounded(4).bg(t.blocked))
              .child(v_flex().flex_1().min_w(0).gap(2)
                .child(div().truncate().font_medium().child(x.name || x.labels?.["cc.role"] || x.address))
                .child(div().text_size(10.5).text_color(t.muted).truncate().child(x.where || x.cwd || "")))
              .child(this.pill(t, x.address, t.blocked))))))

          // Task Spaces & Worker/Subagent Tree
          .child(v_flex().gap(8)
            .child(div().text_size(11).font_semibold().text_color(t.muted).child(`TASK SPACES · ${allSpaces.length}`))
            .when(allSpaces.length === 0, el => el.child(div().text_size(11).text_color(t.dim).child("Ask Commander to start a ticket task.")))
            .children(allSpaces.map(sp => {
              const spAgents = allAgents.filter(a => a.space === sp.id);
              const spColor = sp.status ? (t[sp.status] ?? t.dim) : t.dim;
              return v_flex().id(`cc-sp-${sp.id}`).p(9).gap(6).rounded(8).bg(t.surface).border(1).border_color(sp.active ? t.accent : t.border)
                .child(h_flex().items_center().gap(7).cursor_pointer().on_click(() => run("space.select", { id: sp.id }))
                  .child(div().size(7).rounded(4).bg(spColor))
                  .child(div().flex_1().truncate().font_semibold().child(sp.name))
                  .when(Boolean(sp.branch), el => el.child(this.pill(t, sp.branch, t.accent)))
                  .child(div().text_size(10.5).text_color(t.dim).child(`${sp.tabs.length}t`)))
                .when(spAgents.length > 0, el => el.child(v_flex().gap(4).pl(6)
                  .children(spAgents.map(a => {
                    const meta = termByAddr.get(a.address);
                    const role = meta?.labels?.["cc.role"];
                    const model = meta?.labels?.["cc.model"];
                    const kids = treeKids(a.address);
                    return v_flex().gap(3)
                      .child(h_flex().id(`cc-ag-${a.address}`).p(5).gap(6).rounded(6).items_center().cursor_pointer().hover(s => s.bg(t.hover))
                        .on_click(() => run("pane.focus", { pane: a.pane }))
                        .child(div().size(6).rounded(3).bg(t[a.status] ?? t.dim))
                        .child(div().flex_1().truncate().child(role && meta?.name && meta.name !== role ? `${role} · ${meta.name}` : (role || meta?.name || a.program.name)))
                        .when(Boolean(model), el2 => el2.child(this.pill(t, model, t.muted, t.raised)))
                        .child(div().text_size(10).text_color(t.dim).child(a.address)))
                      .children(kids.map(({ term: k, depth }) => h_flex().id(`cc-kid-${k.address}`).pl(14 + depth * 12).pr(5).py(4).gap(6).rounded(5).items_center().cursor_pointer().hover(s => s.bg(t.hover))
                        .on_click(() => run("terminal.peek", { terminal: k.address }))
                        .child(div().text_size(10).text_color(t.dim).child("└"))
                        .child(div().size(5).rounded(3).bg(t[k.status] ?? t.dim))
                        .child(div().flex_1().truncate().text_size(11).text_color(t.muted).child(k.name || k.labels?.["cc.role"] || k.address))
                        .child(div().text_size(10).text_color(t.dim).child("peek"))));
                  }))));
            })))

          // Active Model Routing Policy Table
          .when(roleEntries.length > 0, el => el.child(v_flex().gap(6)
            .child(div().text_size(11).font_semibold().text_color(t.muted).child("MODEL ROUTING (models.json)"))
            .child(v_flex().p(8).gap(4).rounded(8).bg(t.surface)
              .children(roleEntries.map(([rname, spec]) => h_flex().gap(6).items_center().text_size(11)
                .child(div().w(95).truncate().font_medium().text_color(t.foreground).child(rname))
                .child(div().flex_1().truncate().text_color(t.dim).child(`${(spec.model || "").split("/").pop()}${spec.variant ? `#${spec.variant}` : ""}`))
                .child(this.pill(t, `T${spec.tier ?? 1}`, t.muted, t.raised))))))))
        .child(Scrollbar.vertical("cc-tasks-scroll").absolute().inset_0()));
  }
}
