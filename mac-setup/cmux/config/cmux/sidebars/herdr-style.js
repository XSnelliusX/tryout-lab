// herdr-style: a custom cmux sidebar.
//   Spaces     = workspace groups. Pick one to filter the list to it.
//   Workspaces = collapsible, one line each. Under a workspace sit its tabs, two lines each:
//                terminals (repo, branch or path, PR, ports), browser views (site name) and the
//                agents running in them (repo, branch, PR, and how long they have been in
//                their current state). The icon is centered between the two lines.
//   Edit       = double-click a space or workspace, or right-click > Edit…, to
//                open the edit bar: name, color and icon. A workspace's icon is
//                stored in its description as "icon:<symbol>".
// Sizes, indents and colors are the constants at the top: change one, save, and the
// sidebar hot-reloads.
// Install: save as ~/.config/cmux/sidebars/herdr-style.js, then
//   cmux sidebar select herdr-style

// ---- Settings ----
// Edit bar sizing.
const EDIT = {
  perRow: 5,        // swatches / icons per row (15 of each = 3 full rows of 5)
  swatchSize: 15,   // color dot diameter
  iconSize: 14,     // icon font size
  cellPadX: 1,      // horizontal padding inside a cell
  cellPadY: 3,      // vertical padding inside a cell (row height)
  cellGap: 1,       // gap between cells
  barPadX: 8,       // edit bar side padding
  barPadY: 6,       // edit bar top/bottom padding
  barSpacing: 6,    // gap between name, colors, icons and Done
};
// A "working" agent with no activity for this many seconds is shown as idle: hook
// records can keep a stale "working" status after a session stops reporting.
const STALE_WORKING_SECS = 300;
// Row sizing: how far tab and agent rows are indented under their workspace, and icon sizes.
// tabSlot is the fixed width of the tab icon column, so every title starts at the same x.
const TAB_INDENT = 28;
const ICON = { tab: 12, tabSlot: 20, ws: 12, wsDot: 9, space: 14 };
// Text sizes (points). Change these, save, and the sidebar hot-reloads.
const FONT = {
  ws: 13,       // workspace title
  tab: 12,      // tab and agent title
  line2: 11,    // second line: repo, branch, path, PR, ports, time, site
  space: 13,    // space names
  section: 12,  // "Workspaces" header
  count: 11,    // counts, unread, fold arrow, sub badge
};
const COLOR = {
  branch: "#2DD4BF",   // branch in a clean tree
  dirty: "#FF9F0A",    // branch with changes; also unread
  path: "#8E9BB0",     // repo name and path: soft blue-grey, quieter than the branch
  site: "#0A84FF",     // browser site name, ports, focused tab icon
  prOpen: "#34C759",
  prMerged: "#BF5AF2",
};
// Some agents never report that they quit, so their record stays "idle" after exit.
// For those, the agent only counts while its host tab's title still looks like the
// agent's own terminal title (OpenCode sets "OpenCode" / "OC | <session title>");
// once it exits the shell title replaces it and the agent disappears.
const AGENT_TITLE = { opencode: /^(oc\b|opencode)/i };
// -----------------------------------------------------------------------------------

const [space, setSpace] = signal("all"); // "all" | group id | "none" (ungrouped)
const [wsOpen, setWsOpen] = signal(true);
const [query, setQuery] = signal("");
const [collapsed, setCollapsed] = signal([]); // workspace ids folded up
const [editing, setEditing] = signal(null); // { id, kind: "ws" | "group" } shown in the edit bar
const [draftName, setDraftName] = signal(""); // name typed in the edit bar, applied on Done / ✕ / Return

const STATUS = {
  needs_input: { color: "#FF9F0A", label: "needs input", rank: 0 },
  working: { color: "#0A84FF", label: "working", rank: 1 },
  idle: { color: "#34C759", label: "idle", rank: 2 },
  ended: { color: "#7f7f7f66", label: "ended", rank: 3 },
};
const statusOf = (s) => STATUS[s] ?? { color: "#7f7f7f66", label: String(s ?? ""), rank: 9 };
const NO_COLOR = "#7f7f7f55";

// Agent logos: cmux's own template uses sparkle for Claude and curlybraces for OpenCode.
const AGENT_ICON = {
  claude: { symbol: "burst.fill", color: "#D97757" },     
  opencode: { symbol: "chevron.left.forwardslash.chevron.right", color: "#8FD16B" },
  codex: { symbol: "sparkles", color: "#8FDBFF" },
};
const agentIcon = (kind) => AGENT_ICON[kind] ?? { symbol: "cpu", color: "#9a9a9a" };

// Edit bar palette (bright). The grey swatch in the bar clears the color.
const COLOR_ITEMS = [
  { name: "Red", hex: "#FF453A" }, { name: "Orange", hex: "#FF9F0A" }, { name: "Yellow", hex: "#FFD60A" },
  { name: "Lime", hex: "#A6E22E" }, { name: "Green", hex: "#30D158" }, { name: "Teal", hex: "#40E0C8" },
  { name: "Aqua", hex: "#64D2FF" }, { name: "Blue", hex: "#0A84FF" }, { name: "Indigo", hex: "#7D7AFF" },
  { name: "Purple", hex: "#BF5AF2" }, { name: "Pink", hex: "#FF6EB4" }, { name: "Rose", hex: "#FF375F" },
  { name: "Coral", hex: "#FF7A5C" }, { name: "Sand", hex: "#D8B47A" },
];
const SYMBOL_ITEMS = [
  { name: "folder.fill" }, { name: "briefcase.fill" }, { name: "hammer.fill" }, { name: "terminal.fill" },
  { name: "star.fill" }, { name: "book.fill" }, { name: "cube.fill" }, { name: "bolt.fill" },
  { name: "flame.fill" }, { name: "leaf.fill" }, { name: "heart.fill" }, { name: "globe" },
  { name: "wrench.fill" }, { name: "cloud.fill" }, { name: "moon.fill" },
];
const hit = (...xs) => {
  const q = query().trim().toLowerCase();
  return !q || xs.some((x) => String(x ?? "").toLowerCase().includes(q));
};

const inSpace = (w) => {
  const s = space();
  if (s === "all") return true;
  if (s === "none") return !w.group;
  return w.group === s;
};

const isCollapsed = (id) => collapsed().includes(id);
function toggleCollapsed(id) {
  setCollapsed(isCollapsed(id) ? collapsed().filter((x) => x !== id) : [...collapsed(), id]);
}

// Focus a tab (surface). surface.focus with the workspace id also switches workspace,
// so it runs alone. An agent's own surfaceId can differ from its host tab's, so agent
// rows pass the host tab's ids first. The workspace is selected only when no id is usable.
function focusTab(wsId, ...ids) {
  const surfaceId = ids.find((x) => x);
  if (surfaceId) cmux("surface.focus", { surface_id: surfaceId, workspace_id: wsId });
  else cmux("workspace.select", { workspace_id: wsId });
}

// Status to show for an agent: stale "working" becomes idle.
const shownStatus = (a) => {
  if (a.status !== "working" || !a.lastActivityAt) return a.status;
  const now = (data.clock() ?? {}).epoch;
  return now && now - a.lastActivityAt > STALE_WORKING_SECS ? "idle" : a.status;
};

const byRank = (x, y) =>
  (statusOf(x.status).rank - statusOf(y.status).rank)
  || ((y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0));

// Workspace actions use underscore names (set_color, move_up, mark_read, rename):
// the hyphen forms are not recognized by the app.
function wsAction(id, action, extra) {
  cmux("workspace.action", Object.assign({ workspace_id: id, action }, extra ?? {}));
}

const wsIcon = (w) => {
  const d = String((w && w.description) ?? "");
  return d.startsWith("icon:") ? d.slice(5) : "";
};
const currentName = (t) => {
  if (t.kind === "group") { const g = (data.groups() ?? []).find((x) => x.id === t.id); return g ? (g.name || "") : ""; }
  const w = (data.workspaces() ?? []).find((x) => x.id === t.id);
  return w ? (w.title || "") : "";
};
function applyColor(t, hex) {
  if (t.kind === "group") cmux("workspace.group.set_color", { group_id: t.id, color: hex });
  else wsAction(t.id, "set_color", { color: hex });
}
function clearColor(t) {
  if (t.kind === "ws") wsAction(t.id, "clear_color");
}
function applySymbol(t, symbol) {
  if (t.kind === "group") cmux("workspace.group.set_icon", { group_id: t.id, symbol });
  else wsAction(t.id, "set_description", { description: "icon:" + symbol });
}
function clearIcon(t) {
  if (t.kind !== "ws") return;
  wsAction(t.id, "clear_description");
}
function applyName(t, name) {
  if (!name) return;
  if (t.kind === "ws") wsAction(t.id, "rename", { title: name });
  else cmux("workspace.group.rename", { group_id: t.id, name });
}

// Spaces: All, then each workspace group, then Ungrouped if any.
const spaces = computed(() => {
  const ws = data.workspaces() ?? [];
  const out = [{ id: "all", name: "All Spaces", count: ws.length, icon: "square.grid.2x2", color: null, group: null }];
  for (const g of data.groups() ?? []) {
    out.push({
      id: g.id,
      name: g.name || "Group",
      count: ws.filter((w) => w.group === g.id).length,
      icon: g.icon || "folder.fill",
      color: g.color || null,
      group: g,
    });
  }
  const loose = ws.filter((w) => !w.group).length;
  if (loose > 0) {
    out.push({ id: "none", name: "Ungrouped", count: loose, icon: "tray", color: null, group: null });
  }
  return out;
});

// Flat, keyed roster. Each workspace row is followed by its tabs; each tab by the
// agents it hosts. Agents with no matching tab sit directly under the workspace.
// Collapsed workspaces show only their own row.
const wsRows = computed(() => {
  const out = [];
  let first = true;
  for (const w of data.workspaces() ?? []) {
    if (!inSpace(w)) continue;
    const tabs = w.tabs ?? [];
    // cmux keeps old session records on the terminal that hosted them, so one tab can
    // list several sessions of the same agent. Keep only the most recent per tab and kind.
    const latest = new Map();
    for (const a of w.agents ?? []) {
      if (a.status === "ended") continue;
      const titleRule = AGENT_TITLE[a.kind];
      if (titleRule) {
        const host = tabs.find((t) => (a.panelId && a.panelId === t.id) || (a.surfaceId && a.surfaceId === t.surfaceId));
        if (!host || !titleRule.test(String(host.title ?? ""))) continue;
      }
      const k = a.kind + ":" + (a.panelId || a.surfaceId || a.id);
      const cur = latest.get(k);
      if (!cur || (a.lastActivityAt ?? 0) > (cur.lastActivityAt ?? 0)) latest.set(k, a);
    }
    const agents = [...latest.values()];
    const agentHit = (a) => hit(a.title, a.name, a.kind, w.title);
    const tabHit = (t) => hit(t.title, t.directory, t.branch, w.title);
    // An agent is hosted by the tab whose id is its panelId (or whose surfaceId matches).
    const hostsOf = (t) => agents.filter((a) =>
      (a.panelId && a.panelId === t.id) || (a.surfaceId && a.surfaceId === t.surfaceId));
    const shownTabs = query().trim()
      ? tabs.filter((t) => tabHit(t) || hostsOf(t).some(agentHit))
      : tabs;
    const orphans = agents.filter((a) => agentHit(a) && !tabs.some((t) => hostsOf(t).includes(a)));
    if (query().trim() && shownTabs.length === 0 && orphans.length === 0 && !hit(w.title)) continue;

    if (!first) out.push({ key: "s:" + w.id, kind: "sep" });
    first = false;
    out.push({ key: "w:" + w.id, kind: "ws", ws: w, tabCount: tabs.length });
    if (isCollapsed(w.id)) continue;
    // A tab that hosts agents is shown as its agents only, so it is not listed twice.
    // Each agent row carries the tab's name and git info as its session line.
    for (const t of shownTabs) {
      const hosted = hostsOf(t).sort(byRank);
      if (hosted.length === 0) {
        out.push({ key: "t:" + w.id + ":" + t.id, kind: "tab", ws: w, tab: t });
      }
      for (const a of hosted) {
        out.push({ key: "a:" + w.id + ":" + a.id, kind: "agent", depth: TAB_INDENT, ws: w, tab: t, agent: a });
      }
    }
    for (const a of orphans.sort(byRank)) {
      out.push({ key: "a:" + w.id + ":" + a.id, kind: "agent", depth: TAB_INDENT, ws: w, agent: a });
    }
  }
  return out;
});

// Right-click menu for a space. "All" and "Ungrouped" are not real groups, so they get no menu.
function spaceMenu(s) {
  const g = s.group;
  if (!g) return [];
  return [
    Button("New Workspace in Space", () => cmux("workspace.group.new_workspace", { group_id: g.id })),
    Button("Edit…", () => (setDraftName(""), setEditing({ id: g.id, kind: "group" }))),
    Button(g.collapsed ? "Expand" : "Collapse", () =>
      cmux(g.collapsed ? "workspace.group.expand" : "workspace.group.collapse", { group_id: g.id })),
    Button(g.pinned ? "Unpin" : "Pin", () =>
      cmux(g.pinned ? "workspace.group.unpin" : "workspace.group.pin", { group_id: g.id })),
    Divider(),
    Button("Ungroup (keep workspaces)", () =>
      cmux("workspace.group.ungroup", { group_id: g.id })),
  ];
}

// Right-click menu for a workspace row.
function wsMenu(w) {
  return [
    Button(() => (w().pinned ? "Unpin" : "Pin"), () =>
      wsAction(w().id, w().pinned ? "unpin" : "pin")),
    Button("Edit…", () => (setDraftName(""), setEditing({ id: w().id, kind: "ws" }))),
    Menu("Move", [
      Button("Up", () => wsAction(w().id, "move_up")),
      Button("Down", () => wsAction(w().id, "move_down")),
      Button("To Top", () => wsAction(w().id, "move_top")),
    ]),
    Button("Mark as Read", () => wsAction(w().id, "mark_read")),
    Divider(),
    Button("Close Workspace", () => cmux("workspace.close", { workspace_id: w().id, force: true })).destructive(),
  ];
}

function spaceRow(e) {
  const s = () => e();
  return HStack({ spacing: 8 }, [
    Image(() => s().icon).font(ICON.space)
      .color(() => s().color || "tertiary"),
    Text(() => s().name)
      .font(FONT.space).lineLimit(1).truncation("tail")
      .color(() => (space() === s().id ? "primary" : "secondary")),
    Spacer(),
    Text(() => String(s().count)).font(FONT.count).monospaced().color("tertiary"),
  ])
    .paddingHorizontal(10).paddingVertical(4)
    .cornerRadius(7)
    .background(() => (space() === s().id ? "#7f7f7f2a" : null))
    .hoverBackground("#7f7f7f1c")
    .frame({ maxWidth: "infinity" })
    .contextMenu(spaceMenu(s()))
    .onDoubleTap(() => { if (s().group) (setDraftName(""), setEditing({ id: s().id, kind: "group" })); })
    .onTap(() => setSpace(s().id));
}

function sepRow() {
  return Rectangle().fill("#7f7f7f26").frame({ height: 1 })
    .paddingHorizontal(10).paddingVertical(5);
}

function sectionHeader(label, open, toggle, countFn) {
  return HStack({ spacing: 6 }, [
    Text(() => (open() ? "▾ " : "▸ ") + label).font(FONT.section).weight("semibold").color("tertiary"),
    Spacer(),
    Text(() => String(countFn())).font(FONT.count).monospaced().color("tertiary"),
  ])
    .paddingHorizontal(10).paddingVertical(4)
    .frame({ maxWidth: "infinity" })
    .onTap(toggle);
}

const dirTail = (d) => {
  const parts = String(d ?? "").split("/").filter((p) => p.length > 0);
  return parts.length ? parts[parts.length - 1] : "";
};
const branchText = (x) => (x && x.branch ? "⎇ " + x.branch : "");
const portsText = (t) => ((t && t.ports) || []).length ? ":" + t.ports.join(" :") : "";
const runningSubs = (a) => (a.children ?? []).filter((c) => c.running).length;

// The sidebar's tab data has no type field. Terminals always report a directory;
// browser views (and other non-terminal panels) do not, so "no directory" means browser.
const isBrowser = (t) => !!t && !t.directory;

// "<1m", "7m", "1h 5m"
const ago = (s) => {
  if (s < 60) return "<1m";
  if (s < 3600) return Math.floor(s / 60) + "m";
  const m = Math.floor((s % 3600) / 60);
  return Math.floor(s / 3600) + "h" + (m ? " " + m + "m" : "");
};
// How long the agent has been in the state shown for it. A stale "working" shown as idle
// counts from its last activity, since sinceEpoch still points at when it started working.
const stateTime = (a) => {
  const now = (data.clock() ?? {}).epoch;
  const since = shownStatus(a) === a.status ? (a.sinceEpoch ?? a.lastActivityAt) : a.lastActivityAt;
  return now && since ? ago(now - since) : "";
};

// The workspace's pull request for this tab's branch, if any.
const prFor = (w, t) =>
  t && t.branch ? (w.prs ?? (w.pr ? [w.pr] : [])).find((x) => x.branch && x.branch === t.branch) : undefined;
const prTextFor = (w, t) => { const p = prFor(w, t); return p ? "#" + p.number : ""; };
const prColorFor = (w, t) => { const p = prFor(w, t); return p && p.status === "merged" ? COLOR.prMerged : COLOR.prOpen; };

// ---- Path helpers ----
// Home becomes ~. Desktop and Documents are OneDrive-synced and symlinked into the home folder,
// so their real OneDrive location is shown as the home path you actually use.
const homePath = (d) => String(d ?? "")
  .replace(/^\/Users\/[^/]+\/Library\/CloudStorage\/OneDrive-[^/]+\/(Desktop|Documents)(?=\/|$)/, "~/$1")
  .replace(/^\/Users\/[^/]+/, "~");
// "~/Documents/lab" -> "~/Documents/" + "lab"; "~" -> "" + "~".
// A deep parent keeps its first and last folder: "~/a/b/c/d" -> "~/…/c/" + "d".
const pathParent = (d) => {
  const p = homePath(d), i = p.lastIndexOf("/");
  if (i <= 0) return "";
  const dir = p.slice(0, i).split("/");
  return (dir.length > 2 ? [dir[0], "…", dir[dir.length - 1]] : dir).join("/") + "/";
};
const pathLeaf = (d) => { const p = homePath(d), i = p.lastIndexOf("/"); return i > 0 ? p.slice(i + 1) : p; };

// Browser views expose only a title. Page titles usually end in the site ("Inbox - Gmail",
// "Fix auth · Pull Request #482 · org/repo"), so the last segment becomes the second line.
const TITLE_SEPS = [" – ", " — ", " | ", " · ", " - "];
const browserParts = (title) => {
  const s = String(title ?? "");
  let at = -1, len = 0;
  for (const sep of TITLE_SEPS) {
    const i = s.lastIndexOf(sep);
    if (i > at) { at = i; len = sep.length; }
  }
  const main = at > 0 ? s.slice(0, at).trim() : s;
  const site = at > 0 ? s.slice(at + len).trim() : "";
  return main && site && site.length <= 32 ? { main, site } : { main: s, site: "" };
};

// ---- Tab line 2: repo, branch (or path outside git), PR on the left; state or ports on the right. ----
// Repo name for a tab in git. The sidebar data has no repo field, so use the repo from this
// branch's PR url (".../org/repo/pull/1") when there is one, else the tab's folder name
// (which is the subfolder's name when the tab sits inside a repo).
const repoName = (w, t, pathFn) => {
  if (!t || !t.branch) return "";
  const p = prFor(w, t);
  const segs = p && p.url ? String(p.url).replace(/^https?:\/\/[^/]+\//, "").split("/") : [];
  return segs.length > 2 && segs[1] ? segs[1] : pathLeaf(pathFn());
};
// The trailing/leading spaces stand in for gaps, so an empty piece takes no room.
const repoView = (pathFn, w, t) =>
  Text(() => { const n = repoName(w(), t(), pathFn); return n ? n + " " : ""; })
    .font(FONT.line2).monospaced().weight("medium").color(COLOR.path).lineLimit(1).truncation("middle");
const ctxView = (pathFn, t) =>
  Text(() => (t() && t().branch ? branchText(t()) : pathParent(pathFn()) + pathLeaf(pathFn())))
    .font(FONT.line2).monospaced().lineLimit(1).truncation("middle")
    .color(() => (t() && t().branch ? (t().dirty ? COLOR.dirty : COLOR.branch) : COLOR.path));
const prView = (w, t) =>
  Text(() => { const n = prTextFor(w(), t()); return n ? " " + n : ""; })
    .font(FONT.line2).monospaced().lineLimit(1).layoutPriority(2)
    .color(() => prColorFor(w(), t()));
const tabLine2 = (pathFn, w, t, right) =>
  HStack({ spacing: 0 }, [repoView(pathFn, w, t), ctxView(pathFn, t), prView(w, t), Spacer(), ...right]);

// Workspace: one line with fold arrow, color dot, title, unread and tab count.
function wsRow(e) {
  const w = () => e().ws;
  return HStack({ spacing: 6 }, [
    Text(() => (isCollapsed(w().id) ? "▸" : "▾"))
      .font(FONT.count).color("tertiary")
      .onTap(() => toggleCollapsed(w().id)),
    Image(() => wsIcon(w()) || "circle.fill")
      .font(() => (wsIcon(w()) ? ICON.ws : ICON.wsDot))
      .color(() => w().color || (wsIcon(w()) ? "secondary" : NO_COLOR)),
    Text(() => w().title || "untitled")
      .font(FONT.ws).weight("semibold").lineLimit(1).truncation("tail")
      .color(() => (w().selected ? "primary" : "secondary")),
    Spacer(),
    Text(() => (w().unread ? String(w().unread) : ""))
      .font(FONT.count).weight("semibold").color(COLOR.dirty),
    Text(() => String(e().tabCount)).font(FONT.count).monospaced().color("tertiary"),
  ])
    .paddingHorizontal(10).paddingVertical(4)
    .cornerRadius(8)
    .background(() => (w().selected ? "#7f7f7f2a" : null))
    .hoverBackground("#7f7f7f24")
    .frame({ maxWidth: "infinity" })
    .contextMenu(wsMenu(w))
    .onDoubleTap(() => (setDraftName(""), setEditing({ id: w().id, kind: "ws" })))
    .onTap(() => cmux("workspace.select", { workspace_id: w().id }));
}

// Terminal or browser tab. The icon sits beside both lines, centered vertically between them.
// Line 1: title and an unread dot. Terminal line 2: repo, branch (or path), PR, open ports.
// Browser line 2: the site name from the end of the page title, when it has one. Click focuses the tab.
function tabRow(e) {
  const t = () => e().tab;
  const w = () => e().ws;
  return HStack({ spacing: 6 }, [
    Image(() => (isBrowser(t()) ? "globe" : "terminal")).font(ICON.tab).frame({ width: ICON.tabSlot })
      .color(() => (t().focused && w().selected ? COLOR.site : "tertiary")),
    VStack({ spacing: 1 }, [
      HStack({ spacing: 6 }, [
        Text(() => (isBrowser(t()) ? browserParts(t().title).main : (t().title || dirTail(t().directory) || "terminal")))
          .font(FONT.tab).lineLimit(1).truncation("tail")
          .color(() => (t().focused && w().selected ? "primary" : "secondary")),
        Spacer(),
        Text(() => (t().hasUnread ? "●" : "")).font(FONT.count).color(COLOR.dirty),
      ]),
      ForEach({ items: () => (isBrowser(t()) ? [] : [1]), key: () => "l2" }, () =>
        tabLine2(() => t().directory || w().directory, w, t, [
          Text(() => portsText(t())).font(FONT.line2).monospaced().color(COLOR.site).lineLimit(1).layoutPriority(2),
        ])),
      ForEach({ items: () => (isBrowser(t()) && browserParts(t().title).site ? [1] : []), key: () => "site" }, () =>
        Text(() => browserParts(t().title).site).font(FONT.line2).color(COLOR.site).lineLimit(1).truncation("tail")),
    ]).frame({ maxWidth: "infinity" }),
  ])
    .paddingLeading(TAB_INDENT).paddingTrailing(10).paddingVertical(3)
    .cornerRadius(7)
    .hoverBackground("#7f7f7f1c")
    .frame({ maxWidth: "infinity" })
    .onTap(() => focusTab(e().ws.id, e().tab.surfaceId, e().tab.id));
}

// Agent: like a terminal tab, but the agent's logo is the icon.
// Line 1: session name (the tab title) and the number of running subagents.
// Line 2: repo, branch (or path), PR; on the right, how long the agent has been in its current
// state, colored like its status dot (green idle, blue working, orange needs input).
function agentRow(e) {
  const a = () => e().agent;
  const t = () => e().tab; // undefined for an agent with no matching tab
  const status = () => shownStatus(a());
  return HStack({ spacing: 6 }, [
    Image(() => agentIcon(a().kind).symbol).font(ICON.tab).frame({ width: ICON.tabSlot })
      .color(() => agentIcon(a().kind).color),
    VStack({ spacing: 1 }, [
      HStack({ spacing: 6 }, [
        Text(() => (t() ? (t().title || dirTail(t().directory)) : (e().ws.title || "")))
          .font(FONT.tab).weight("medium").lineLimit(1).truncation("tail"),
        Spacer(),
        Text(() => (runningSubs(a()) ? runningSubs(a()) + " sub" : "")).font(FONT.count).color("tertiary"),
      ]),
      tabLine2(() => a().directory || (t() && t().directory) || e().ws.directory, () => e().ws, t, [
        Text(() => (stateTime(a()) ? stateTime(a()) + " " : ""))
          .font(FONT.line2).monospaced().lineLimit(1).layoutPriority(2)
          .color(() => statusOf(status()).color),
        Circle({ size: 7 }).fill(() => statusOf(status()).color),
      ]),
    ]).frame({ maxWidth: "infinity" }),
  ])
    .paddingLeading(e().depth).paddingTrailing(10).paddingVertical(3)
    .cornerRadius(7)
    .hoverBackground("#7f7f7f1c")
    .frame({ maxWidth: "infinity" })
    .onTap(() => focusTab(e().ws.id, e().tab && e().tab.surfaceId, e().tab && e().tab.id, e().agent.surfaceId));
}

// Edit bar pieces. Swatches and icon choices are plain static views, so each tap
// closes over its own value and reads only the bar's current target.
const GREY = "#8E8E93";
const colorOf = (t) => {
  if (t.kind === "group") { const g = (data.groups() ?? []).find((x) => x.id === t.id); return g && g.color ? String(g.color).toLowerCase() : ""; }
  const w = (data.workspaces() ?? []).find((x) => x.id === t.id);
  return w && w.color ? String(w.color).toLowerCase() : "";
};
const symbolOf = (t) => {
  if (t.kind === "group") { const g = (data.groups() ?? []).find((x) => x.id === t.id); return g ? (g.icon || "folder.fill") : ""; }
  return wsIcon((data.workspaces() ?? []).find((x) => x.id === t.id));
};
const isOn = (get, want) => { const t = editing(); return !!t && get(t) === want; };

// A tappable choice; `selected` is a live check that draws a highlight behind it.
const tappable = (label, run, selected) =>
  HStack([Spacer(), label, Spacer()])
    .frame({ maxWidth: "infinity" })
    .paddingHorizontal(EDIT.cellPadX).paddingVertical(EDIT.cellPadY).cornerRadius(6)
    .background(() => (selected() ? "#7f7f7f4d" : null))
    .hoverBackground("#7f7f7f33")
    .cursor("pointer")
    .onTap(() => { const t = editing(); if (t) run(t); });
// The first swatch is the default grey, which clears the color.
const swatch = (hex, clear) =>
  tappable(Circle({ size: EDIT.swatchSize }).fill(hex),
    (t) => (clear ? clearColor(t) : applyColor(t, hex)),
    () => (clear ? isOn(colorOf, "") : isOn(colorOf, hex.toLowerCase())));
// Icon choices; the workspace grid starts with a "no icon" choice.
const iconChoice = (name) =>
  tappable(Image(name).font(EDIT.iconSize).color("secondary"), (t) => applySymbol(t, name),
    () => isOn(symbolOf, name));
const noIconChoice = () =>
  tappable(Image("circle.slash").font(EDIT.iconSize).color("tertiary"), (t) => clearIcon(t),
    () => isOn(symbolOf, ""));

function commitName(name) {
  const t = editing(), n = name.trim();
  if (t && n && n !== currentName(t)) applyName(t, n);
}
// ✕ and Done do the same thing: apply a typed name, then close.
function closeBar() { commitName(draftName()); setDraftName(""); setEditing(null); }

// Cells split into rows of EDIT.perRow. Each cell stretches, so a full row fills the width.
const gridRows = (cells) => {
  const rows = [];
  for (let i = 0; i < cells.length; i += EDIT.perRow) {
    rows.push(HStack({ spacing: EDIT.cellGap }, cells.slice(i, i + EDIT.perRow)).frame({ maxWidth: "infinity" }));
  }
  return rows;
};

function editBar(kind) {
  const isWs = kind === "ws";
  return VStack({ spacing: EDIT.barSpacing }, [
    HStack({ spacing: 6 }, [
      Text(isWs ? "Edit workspace" : "Edit space").font(11).weight("semibold").color("secondary"),
      Spacer(),
      Text("✕").font(12).color("tertiary").cursor("pointer").onTap(() => closeBar()),
    ]),
    // Blur can report as submit or cancel, so neither may close the bar: only Done
    // and ✕ do. Color and icon taps apply right away; the name applies on Return or Done.
    TextField(() => { const t = editing(); return t ? currentName(t) : ""; }, {
      placeholder: "Name",
      onEdit: (t) => setDraftName(String(t ?? "")),
      onSubmit: (t) => commitName(String(t ?? "")),
      onCancel: () => {},
    }),
    ...gridRows([swatch(GREY, true), ...COLOR_ITEMS.map((c) => swatch(c.hex))]),
    ...gridRows(isWs
      ? [noIconChoice(), ...SYMBOL_ITEMS.slice(0, 14).map((x) => iconChoice(x.name))]
      : SYMBOL_ITEMS.map((x) => iconChoice(x.name))),
    HStack([
      Spacer(),
      Text("Done").font(11).weight("semibold").color("#0A84FF").cursor("pointer")
        .paddingHorizontal(10).paddingVertical(3).cornerRadius(6)
        .background("#0A84FF26").hoverBackground("#0A84FF40")
        .onTap(() => closeBar()),
    ]),
  ]).paddingHorizontal(EDIT.barPadX).paddingVertical(EDIT.barPadY).cornerRadius(10).background("#7f7f7f1c");
}

sidebar(() =>
  VStack({ spacing: 6 }, [
    HStack({ spacing: 6 }, [
      Text("Spaces").font(13).weight("semibold"),
      Spacer(),
      Button("+", () => cmux("workspace.group.create", { name: "New Space" })),
    ]).paddingHorizontal(10),

    ForEach({ items: spaces, key: (s) => s.id }, (e) => spaceRow(e)),

    ForEach({ items: () => (editing() && editing().kind === "group" ? [editing()] : []), key: (r) => "g" + r.id },
      () => editBar("group")),
    ForEach({ items: () => (editing() && editing().kind === "ws" ? [editing()] : []), key: (r) => "w" + r.id },
      () => editBar("ws")),

    TextField("", {
      placeholder: "Search",
      autofocus: false,
      onEdit: (t) => setQuery(t ?? ""),
      onSubmit: (t) => setQuery(t ?? ""),
    }).paddingHorizontal(10),

    sectionHeader("Workspaces", wsOpen, () => setWsOpen(!wsOpen()), () => wsRows().filter((r) => r.kind === "ws").length),
    ForEach(
      { items: () => (wsOpen() ? wsRows() : []), key: (r) => r.key },
      (e) => {
        const k = e().kind; // kind is stable per key
        if (k === "sep") return sepRow();
        if (k === "ws") return wsRow(e);
        if (k === "tab") return tabRow(e);
        return agentRow(e);
      }
    ),

    Text(() => (wsRows().length === 0
      ? (query().trim() ? "No matches." : "Nothing in this space yet.")
      : ""))
      .font(11).color("tertiary").paddingHorizontal(10),
    Spacer(),
  ]).paddingHorizontal(6),
  { surface: "glass" }
)
