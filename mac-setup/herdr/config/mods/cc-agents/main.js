// Agents + sub-agents with Command Center role & model badges.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, setBadge, openOverlay, closeOverlay, props, window, layout, checking } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
  { id: "role", label: "Grouped by role", icon: "terminal" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// `cc.model` is `<model id without provider>#<variant>`, e.g. `gpt-6.2-sol-openai#medium`.
// Shown as `Sol-6.2` + `#m`: no vendor/provider words, effort as one letter.
const VENDOR = new Set(["gpt", "claude", "gemini", "openai", "anthropic", "google"]);
const EFFORT = { minimal: "n", low: "l", medium: "m", high: "h", xhigh: "x", max: "X" };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function shortModel(label) {
  const [raw, variant] = (label ?? "").split("#", 2);
  const id = raw.split("/").pop();
  const parts = id.toLowerCase().split(/[-_]/).filter((p) => p && !/^\d{8}$/.test(p));
  const kept = parts.filter((p) => !VENDOR.has(p));
  const nums = kept.filter((p) => /^\d+(\.\d+)?$/.test(p));
  const words = kept.filter((p) => !nums.includes(p));
  const name = words.length ? words.map(cap).join("-") : parts[0] === "gpt" ? "GPT" : cap(parts[0] ?? "");
  const short = name ? (nums.length ? `${name}-${nums.join(".")}` : name) : id;
  const effort = variant ? EFFORT[variant.toLowerCase()] ?? variant.charAt(0).toLowerCase() : "";
  return { name: short, effort, tip: variant ? `${id} · ${variant} effort` : id };
}

// One theme color per role family (ansi colors follow light and dark themes).
const ROLE_COLOR = {
  commander: "accent",
  implementer: "ansi4", "implementer-pro": "ansi4",
  writer: "ansi5",
  reviewer: "ansi2", "verifier-fast": "ansi2", "verifier-deep": "ansi2",
  architect: "ansi3",
  explore: "ansi6",
  escalation: "ansi1",
};
const ROLE_SHORT = {
  commander: "cmd", implementer: "impl", "implementer-pro": "impl-pro", writer: "write", reviewer: "review",
  "verifier-fast": "verify-fast", "verifier-deep": "verify-deep", architect: "arch", explore: "explore", escalation: "esc",
};
const shortRole = (role) => ROLE_SHORT[role] ?? role;
const ROLE_ORDER = Object.keys(ROLE_COLOR);
const roleRank = (role) => (!role ? Infinity : ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length);
const SPARE = ["ansi4", "ansi5", "ansi2", "ansi3", "ansi6"];

function roleColor(t, role) {
  if (!role) return t.accent;
  const key = ROLE_COLOR[role] ?? SPARE[[...role].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % SPARE.length];
  return t[key] ?? t.accent;
}

const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c + a : c);

function modelChip(t, id, label, role) {
  const m = shortModel(label);
  const c = roleColor(t, role);
  return h_flex().id(id).flex_none().px(5).h(16).rounded(4).items_center().bg(alpha(c, "1f")).text_size(10).font_medium().tooltip(m.tip)
    .child(div().text_color(c).child(m.effort ? `${m.name}#${m.effort}` : m.name));
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class CcAgents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    this.lastBadge = null;
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    if (!checking()) cx.timer.every(30000, (cx) => cx.notify());
  }

  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  since(a) { return this.changed[a.address]?.at ?? 0; }
  rank(a) { return RANK[a.status] ?? 0; }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex().id(`sort-${s.id}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => { setShared("agents.sort", s.id); closeOverlay(props().overlay); })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) { run("terminal.peek", { terminal: addr }); }

  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [{ t: k, lines: [...lead, last ? "└" : "├"] }, ...this.tree(all, k.address, [...lead, last ? "" : "│"])];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    const role = k.labels?.["cc.role"];
    const model = k.labels?.["cc.model"];
    return h_flex().id(`sub-${k.address}`).pl(39).pr(8).rounded(8).h(26).flex_none().gap(4).items_center().text_size(12)
      .when(on, (el) => el.bg(t.raised)).hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(2).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(4).child(pic)))
      .child(h_flex().flex_1().min_w(0).gap(4).items_center()
        .child(div().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(k.name || shortRole(role) || k.template || k.program?.name || k.address))
        .when(Boolean(role && k.name && k.name !== role), el => el.child(div().flex_1().min_w(0).truncate().text_color(alpha(roleColor(t, role), "cc")).child(shortRole(role)))))
      .when(Boolean(model), el => el.child(modelChip(t, `sub-model-${k.address}`, model, role)))
      .child(this.status(t, { status: st }, compact));
  }

  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render() {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const termMap = new Map(all.map((x) => [x.address, x]));
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);

    const blockedCount = all.filter(x => x.state === "live" && (x.status === "blocked" || x.status === "error")).length;
    const nextBadge = blockedCount > 0 ? String(blockedCount) : null;
    if (!checking() && nextBadge !== this.lastBadge) {
      this.lastBadge = nextBadge;
      setBadge(nextBadge);
    }

    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const byRole = sort.id === "role";
    const flat = byPriority || byRole;
    const roleOf = (a) => termMap.get(a.address)?.labels?.["cc.role"] ?? null;
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    const urgent = (x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq;
    if (byPriority) list = [...list].sort(urgent);
    if (byRole) list = [...list].sort((x, y) => roleRank(roleOf(x)) - roleRank(roleOf(y)) || (roleOf(x) ?? "").localeCompare(roleOf(y) ?? "") || urgent(x, y));
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));

    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div().id(`fold-${a.address}`).h(18).px(3).gap(3).flex().items_center().rounded(4).text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim)).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); open ? this.folded.add(a.address) : this.folded.delete(a.address); cx.notify(); })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      const meta = termMap.get(a.address);
      const ccRole = meta?.labels?.["cc.role"];
      const ccModel = meta?.labels?.["cc.model"];
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex().id(`ag-${a.address}`).h(26).px(8).flex_none().items_center().gap(4).hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div().id(`pin-${a.address}`).flex_none().p(2).rounded(4).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.pin", { terminal: a.address, pinned: !isPinned }); this.hovered = null; cx.notify(); })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      const full = flat || isPinned;
      const baseName = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      const ownName = meta?.name && meta.name !== ccRole ? meta.name : null;
      const name = ccRole && !full ? ownName ?? shortRole(ccRole) : baseName;
      const tag = byRole && !isPinned ? (ccRole ? ownName : more) : full ? (ccRole ? shortRole(ccRole) : more) : ccRole && ownName ? shortRole(ccRole) : null;
      const rc = roleColor(t, ccRole);
      const nameColor = ccRole && !full && !ownName ? rc : idle ? t.muted : t.foreground;
      const tagColor = ccRole ? alpha(rc, idle ? "99" : "dd") : t.dim;
      return h_flex().id(`ag-${a.address}`).px(8).h(30).flex_none().rounded(8).items_center().gap(7)
        .when(a.focused, (el) => el.bg(t.selected)).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => { if (on) this.hovered = a.address; else if (this.hovered === a.address) this.hovered = null; cx.notify(); })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => { cx.stop_propagation(); this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address); cx.notify(); })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(tag ? 110 : 180).truncate().text_color(nameColor).child(name))
          .when(Boolean(tag), el => el.child(div().flex_1().min_w(0).truncate().text_color(tagColor).child(`\u00b7 ${tag}`))))
        .when(Boolean(ccModel), el => el.child(modelChip(t, `model-${a.address}`, ccModel, ccRole)))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, flat && !isPinned));
    };

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, flat))];
    };

    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const role = roleOf(a);
      const id = byPriority ? `sec-${r}` : byRole ? `role-${role ?? ""}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else if (byRole) groups.push({ id, label: role ?? "Other", color: role ? roleColor(t, role) : null, status: null, members: [a] });
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex().id(g.id).px(8).pt(8).h(30).flex_none().gap(6).items_center().text_size(11).font_medium().cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { open ? this.folded.add(g.id) : this.folded.delete(g.id); cx.notify(); })
        .child(div().truncate().text_color(g.color ?? t[g.status] ?? t.dim).child(g.label))
        .when(flat || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed ? list.flatMap(withKids) : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .when(!collapsed, (el) => el.child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents & Subagents"))
        .child(div().id("ag-sort").text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click(() => openOverlay({ mod: "cc-agents", kind: "popup", width: 200, height: 172, props: { sortMenu: true } }))
          .tooltip(`Sort agents: ${sort.label}`).child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)))))
      .when(list.length === 0 && !collapsed, (el) => el.child(div().px(12).text_size(12).text_color(t.dim).child("No worker agents yet. Ask Commander to dispatch a ticket task.")))
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) => el.child(h_flex().h(28).items_center().justify_center()
        .child(div().id("collapse").text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click(toggleSidebar).child("»"))));
  }
}
