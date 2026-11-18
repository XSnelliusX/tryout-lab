import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, theme, run, window, keys, exec, home, checking } from "herdr";

export default class CcStatus extends View {
  init(_props, cx) {
    this.budget = null;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(30000, cx => this.refresh(cx));
  }

  refresh(cx) {
    cx.spawn(async cx => {
      try {
        const r = await exec(`${home()}/.local/bin/cc-budget`, [], { timeout: 10000 });
        if (r.code === 0) {
          this.budget = JSON.parse(r.stdout);
          cx.notify();
        }
      } catch {}
    });
  }

  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const live = terminals().filter(x => x.state === "live");
    const subs = live.filter(x => Boolean(x.parent)).length;
    const cmdr = live.find(x => x.labels?.["cc.role"] === "commander");
    const needs = list.filter(a => a.status === "blocked").length;

    const b = this.budget;
    const budgetColor = b?.status === "exceeded" || b?.status === "cap_tier3" ? t.blocked : b?.status === "warn" ? t.working : t.muted;

    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents${subs ? ` · ${subs} sub` : ""}`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(h_flex().id("status-cmdr").gap(6).items_center().cursor_pointer().hover(s => s.text_color(t.foreground))
        .on_click(() => run("layout.toggle", { id: "commander" }))
        .child(div().size(6).rounded(3).bg(cmdr ? (cmdr.status === "error" ? t.blocked : (t[cmdr.status] ?? t.idle)) : t.dim))
        .child(`Cmdr: ${cmdr?.status ?? "offline"}`))
      .when(typeof b?.spent_usd === "number" && typeof b?.cap_usd === "number" && typeof b?.pct_used === "number", el => el.child(h_flex().id("status-budget").gap(5).items_center().cursor_pointer().text_color(budgetColor).hover(s => s.text_color(t.foreground))
        .on_click(() => { run("layout.select", { stack: "panel-body", child: "tasks" }); run("layout.show", { id: "panel" }); })
        .child(`MTD $${b.spent_usd.toFixed(0)}/$${b.cap_usd.toFixed(0)} (${b.pct_used.toFixed(0)}%)`)))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(this.hint()));
  }
}
