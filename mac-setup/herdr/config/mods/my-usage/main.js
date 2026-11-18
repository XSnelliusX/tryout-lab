import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { theme, exec, props, closeOverlay, home, checking } from "herdr";

// A compact port of the ai-gateway usage dashboard (Overview tab): a spend KPI card with the
// billing split and budget meter, three mini KPI tiles, Top Models as share bars, and tool pills.
//
// Usage comes from the ai-gateway usage log (~/.gateway-cost/usage.jsonl), the single source of truth for
// AI usage. cc-budget counts it like the usage dashboard's "Month" range (every tool and billing mode).
const CC_BUDGET = () => `${home()}/.local/bin/cc-budget`;
const GATEWAY = () => `${home()}/.config/opencode/plugins/ai-gateway/index.ts`;
const BILLING = { gateway: "Gateway", usage: "Direct", other: "Other" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export function number(value) { return isNum(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"; }
export function money(value) {
  if (!isNum(value)) return "—";
  return value >= 1000 ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `$${value.toFixed(2)}`;
}
const short = (v) => (isNum(v) && v >= 100 ? `$${Math.round(v).toLocaleString()}` : money(v));
const pct = (part, total) => (total > 0 ? `${Math.round((part / total) * 100)}%` : "");
const monthName = (ym) => { const [y, m] = String(ym || "").split("-"); return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : ym || ""; };

export default class Usage extends View {
  init(_props, cx) {
    this.loading = false; this.stats = null; this.error = null; this.opening = false;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(60000, cx => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec(CC_BUDGET(), [], { timeout: 15000 });
        if (result.code !== 0) throw new Error(result.stderr || result.stdout);
        const stats = JSON.parse(result.stdout);
        if (typeof stats.spent_usd !== "number") throw new Error(stats.reason || "no usage data");
        this.stats = stats; this.updated = (d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)(new Date()); this.error = null;
      } catch (e) { this.error = `Usage unavailable: ${e}`; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  openDashboard(cx) {
    if (this.opening) return;
    this.opening = true; cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await exec("node", [GATEWAY(), "dashboard"], { timeout: 30000 });
        if (r.code !== 0) this.error = `Could not open the dashboard: ${(r.stdout || r.stderr).trim()}`;
      } catch (e) { this.error = `Could not open the dashboard: ${e}`; }
      finally { this.opening = false; cx.notify(); }
    });
  }

  render() {
    const t = theme(), s = this.stats;
    const series = [t.accent, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1, t.ansi4];
    const billingColor = { gateway: t.accent, usage: t.ansi5, other: t.dim };

    // --- primitives (dashboard: card, label, value, sub, pill, track) ---
    const card = () => v_flex().p(12).gap(8).rounded(12).bg(t.surface).border(1).border_color(t.border).min_w(0);
    const label = (text) => div().text_size(11).font_semibold().text_color(t.muted).child(text);
    const sub = (text) => div().text_size(11).text_color(t.dim).truncate().child(text);
    const pill = (text, color) => div().flex_none().px(8).py(2).rounded(999).bg(color + "22").text_color(color).text_size(10.5).font_semibold().child(text);
    const track = (share, color, h = 6) => div().w_full().h(h).rounded(h / 2).bg(t.raised)
      .child(div().h(h).rounded(h / 2).bg(color).w(`${Math.max(2, Math.min(100, share * 100))}%`));
    const total = (entries) => entries.reduce((a, [, v]) => a + v, 0) || 1;
    const split = (entries, color, key) => h_flex().w_full().h(6).gap(2).children(entries.map(([k, v], i) =>
      div().id(`usage-${key}-split-${i}`).h(6).rounded(3).bg(color(k, i)).w(`${Math.max(2, (v / total(entries)) * 100)}%`)));
    const legend = (entries, color, name, key) => h_flex().flex_wrap().gap_x(12).gap_y(3).children(entries.map(([k, v], i) =>
      h_flex().id(`usage-${key}-${i}`).items_center().gap(5).text_size(11)
        .child(div().size(7).rounded(4).bg(color(k, i)))
        .child(div().text_color(t.muted).child(name(k)))
        .child(div().font_semibold().child(short(v)))));
    const button = (id, title, action, primary) => div().id(id).flex_none().px(10).py(5).rounded(8).text_size(11.5).font_semibold().cursor_pointer()
      .bg(primary ? t.solid : t.surface).text_color(primary ? t.solid_foreground : t.foreground)
      .when(!primary, e => e.border(1).border_color(t.border).hover(st => st.bg(t.hover)))
      .when(Boolean(primary), e => e.hover(st => st.opacity(0.9)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(title);

    // --- header ---
    const header = h_flex().flex_none().h(52).px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0)
        .child(div().font_semibold().text_size(14).child("AI Usage"))
        .child(sub(s ? monthName(s.month) : "Gateway usage log")))
      .child(button("usage-refresh", this.loading ? "…" : "↻", (_e, cx) => this.refresh(cx)))
      .child(button("usage-open", this.opening ? "Opening…" : "Dashboard", (_e, cx) => this.openDashboard(cx), true))
      .when(Boolean(props()?.overlay), e => e.child(button("usage-close", "✕", () => closeOverlay(props().overlay))));

    const body = v_flex().id("usage-scroll").absolute().inset_0().overflow_y_scroll().p(12).gap(10);

    if (this.error) body.child(div().p(8).rounded(8).bg(t.blocked + "18").border(1).border_color(t.blocked + "44").text_size(11).text_color(t.blocked)
      .child(`${this.error}${s ? " · showing last snapshot" : ""}`));
    if (!s) {
      body.child(card().items_center().py(24).child(sub(this.loading ? "Loading usage…" : "No usage data available.")));
      return this.frame(t, header, body);
    }

    // --- 1. spend KPI: value, billing split, budget meter ---
    const hasCap = isNum(s.cap_usd);
    const projOver = hasCap && s.projected_usd > s.cap_usd;
    const status = s.status === "ok" && projOver ? ["Trending over", t.working] : {
      ok: ["On track", t.done], warn: ["Warn", t.working], cap_tier3: ["Tier-3 capped", t.blocked],
      exceeded: ["Cap reached", t.blocked], unknown: ["No cap", t.dim],
    }[s.status] ?? [s.status, t.dim];
    const bills = Object.entries(s.by_billing || {}).filter(([, v]) => v > 0);
    const spend = card()
      .child(h_flex().items_center().justify_between().child(label("Month to date")).child(pill(status[0], status[1])))
      .child(h_flex().items_baseline().gap(6)
        .child(div().text_size(26).font_semibold().child(money(s.spent_usd)))
        .when(hasCap, e => e.child(div().text_size(12).text_color(t.muted).child(`/ ${money(s.cap_usd)}`))));
    if (hasCap) {
      spend.child(track((s.pct_used ?? 0) / 100, status[1], 8))
        .child(sub(`${Math.round(s.pct_used ?? 0)}% used · ${money(s.remaining_usd)} left · ${money(s.daily_allowance_usd)}/day allowance`));
    }
    if (bills.length) {
      spend.child(split(bills, k => billingColor[k] ?? t.dim, "bill"))
        .child(legend(bills, k => billingColor[k] ?? t.dim, k => BILLING[k] ?? k, "bill"));
    }
    body.child(spend);

    // --- 2. mini KPI tiles ---
    const tile = (title, value, note, color) => v_flex().flex_1().min_w(0).px(10).py(8).gap(1).rounded(12).bg(t.surface).border(1).border_color(t.border)
      .child(label(title)).child(div().text_size(15).font_semibold().truncate().text_color(color ?? t.foreground).child(value)).child(sub(note));
    body.child(h_flex().gap(8)
      .child(tile("Today", short(s.today_usd), pct(s.today_usd, s.spent_usd) || "—"))
      .child(tile("Per day", short(s.daily_burn_usd), `day ${s.days_elapsed}/${s.days_in_month}`))
      .child(tile("Projected", short(s.projected_usd), projOver ? "over cap" : "month-end", projOver ? t.blocked : undefined)));

    // --- 3. top models: share bars ---
    const models = (s.top_models || []).slice(0, 5);
    const maxModel = Math.max(...models.map(m => m.cost_usd), 0) || 1;
    body.child(card().gap(10)
      .child(h_flex().items_center().justify_between().child(label("Top models")).child(sub(`${number(s.steps)} steps`)))
      .children(models.length ? models.map((m, i) => {
        const [provider, ...rest] = String(m.model).split("/");
        return v_flex().id(`usage-model-${i}`).gap(4).min_w(0).tooltip(`${m.model} · ${money(m.cost_usd)}`)
          .child(h_flex().gap(6).items_baseline().min_w(0)
            .child(h_flex().flex_1().min_w(0).gap(5).items_baseline()
              .child(div().flex_shrink(1).min_w(0).truncate().font_semibold().child(rest.join("/") || provider))
)
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(pct(m.cost_usd, s.spent_usd)))
            .child(div().flex_none().font_semibold().child(money(m.cost_usd))))
          .child(track(m.cost_usd / maxModel, series[i % series.length]));
      }) : [sub("No model spend yet")]));

    // --- 4. tools: pills ---
    const tools = Object.entries(s.by_tool || {}).filter(([, v]) => v > 0);
    if (tools.length) body.child(card()
      .child(label("Tools"))
      .child(split(tools, (_k, i) => series[i % series.length], "tool"))
      .child(legend(tools, (_k, i) => series[i % series.length], k => k, "tool")));

    body.child(div().text_size(10.5).text_color(t.dim).px(2)
      .child(`Updated ${this.updated} · refreshes every minute`));
    return this.frame(t, header, body);
  }

  frame(t, header, body) {
    return v_flex().id("usage-root").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .child(header)
      .child(div().flex_1().min_h(0).relative()
        .child(body)
        .child(Scrollbar.vertical("usage-scroll").absolute().inset_0()));
  }
}
