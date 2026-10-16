// herdr-style: a custom cmux sidebar.
//   Spaces     = workspace groups. Pick one to filter the list to it.
//   Workspaces = collapsible, one line each. Under a workspace sit its terminal
//                tabs (with branch and folder) and the agents running in them.
//   Edit       = double-click a space or workspace, or right-click > Edit…, to
//                open the edit bar: name, color and icon. A workspace's icon is
//                stored in its description as "icon:<symbol>".
// Install: save as ~/.config/cmux/sidebars/herdr-style.js, then
//   cmux sidebar select herdr-style

// ---- Edit bar sizing: change these to taste, then save (the sidebar hot-reloads). ----
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
  claude: { symbol: "sparkle", color: "#D97757" },
  opencode: { symbol: "curlybraces", color: "#8FD16B" },
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
// so it runs alone; selecting the workspace first can leave the terminal unfocused.
// The workspace is only selected when the tab has no usable id.
// Focus a tab (surface). surface.focus with the workspace id also switches workspace,
// so it runs alone. An agent's own surfaceId can differ from its host tab's, so agent
// rows pass the host tab's ids first. The workspace is selected only when no id is usable.
function focusTab(wsId, ...ids) {
  const surfaceId = ids.find((x) => x);
  if (surfaceId) cmux("surface.focus", { surface_id: surfaceId, workspace_id: wsId });
  else cmux("workspace.select", { workspace_id: wsId });
}

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
    const agents = (w.agents ?? []).filter((a) => a.status !== "ended");
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
        out.push({ key: "a:" + w.id + ":" + a.id, kind: "agent", depth: 36, ws: w, tab: t, agent: a });
      }
    }
    for (const a of orphans.sort(byRank)) {
      out.push({ key: "a:" + w.id + ":" + a.id, kind: "agent", depth: 36, ws: w, agent: a });
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
    Image(() => s().icon).font(11)
      .color(() => s().color || "tertiary"),
    Text(() => s().name)
      .font(12).lineLimit(1).truncation("tail")
      .color(() => (space() === s().id ? "primary" : "secondary")),
    Spacer(),
    Text(() => String(s().count)).font(10).monospaced().color("tertiary"),
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
    Text(() => (open() ? "▾ " : "▸ ") + label).font(11).weight("semibold").color("tertiary"),
    Spacer(),
    Text(() => String(countFn())).font(10).monospaced().color("tertiary"),
  ])
    .paddingHorizontal(10).paddingVertical(4)
    .frame({ maxWidth: "infinity" })
    .onTap(toggle);
}

const dirTail = (d) => {
  const parts = String(d ?? "").split("/").filter((p) => p.length > 0);
  return parts.length ? parts[parts.length - 1] : "";
};

// Workspace: one line with fold arrow, color dot, title, unread and tab count.
function wsRow(e) {
  const w = () => e().ws;
  return HStack({ spacing: 6 }, [
    Text(() => (isCollapsed(w().id) ? "▸" : "▾"))
      .font(10).color("tertiary")
      .onTap(() => toggleCollapsed(w().id)),
    Image(() => wsIcon(w()) || "circle.fill")
      .font(() => (wsIcon(w()) ? 11 : 7))
      .color(() => w().color || (wsIcon(w()) ? "secondary" : NO_COLOR)),
    Text(() => w().title || "untitled")
      .font(12).weight("semibold").lineLimit(1).truncation("tail")
      .color(() => (w().selected ? "primary" : "secondary")),
    Spacer(),
    Text(() => (w().unread ? String(w().unread) : ""))
      .font(10).weight("semibold").color("#FF9F0A"),
    Text(() => String(e().tabCount)).font(10).monospaced().color("tertiary"),
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

// Terminal tab: its title, branch with a dirty dot, and folder. Click focuses it.
function tabRow(e) {
  const t = () => e().tab;
  const w = () => e().ws;
  return VStack({ spacing: 1 }, [
    HStack({ spacing: 6 }, [
      Image("terminal").font(10)
        .color(() => (t().focused && w().selected ? "#0A84FF" : "tertiary")),
      Text(() => t().title || dirTail(t().directory) || "terminal")
        .font(11).lineLimit(1).truncation("tail")
        .color(() => (t().focused && w().selected ? "primary" : "secondary")),
      Spacer(),
      Text(() => (t().hasUnread ? "●" : "")).font(10).color("#FF9F0A"),
    ]),
    HStack({ spacing: 6 }, [
      Text(() => (t().branch ? "⎇ " + t().branch + (t().dirty ? " ●" : "") : ""))
        .font(10).monospaced().lineLimit(1).truncation("middle")
        .color(() => (t().dirty ? "#FF9F0A" : "tertiary")),
      Spacer(),
      Text(() => dirTail(t().directory)).font(10).color("tertiary").lineLimit(1),
    ]).paddingLeading(16),
  ])
    .paddingLeading(36).paddingTrailing(10).paddingVertical(3)
    .cornerRadius(7)
    .hoverBackground("#7f7f7f1c")
    .frame({ maxWidth: "infinity" })
    .onTap(() => focusTab(e().ws.id, e().tab.surfaceId, e().tab.id));
}

// Agent: the session name (the tab title) is the headline, with the branch on
// the right. The agent sits below it with its logo, name and status.
function agentRow(e) {
  const a = () => e().agent;
  const t = () => e().tab; // undefined for an agent with no matching tab
  return VStack({ spacing: 1 }, [
    HStack({ spacing: 6 }, [
      Text(() => (t() ? (t().title || dirTail(t().directory)) : (e().ws.title || "")))
        .font(11).weight("medium").lineLimit(1).truncation("tail"),
      Spacer(),
      Text(() => (t() && t().branch ? "⎇ " + t().branch + (t().dirty ? " ●" : "") : ""))
        .font(10).monospaced().lineLimit(1)
        .color(() => (t() && t().dirty ? "#FF9F0A" : "tertiary")),
    ]),
    HStack({ spacing: 6 }, [
      Image(() => agentIcon(a().kind).symbol).font(10)
        .color(() => agentIcon(a().kind).color),
      Text(() => a().name || a().kind || "agent")
        .font(10).lineLimit(1).truncation("tail").color("secondary"),
      Spacer(),
      Text(() => statusOf(a().status).label).font(10).color(() => statusOf(a().status).color),
    ]).paddingLeading(2),
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
