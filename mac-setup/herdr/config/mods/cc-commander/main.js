import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { terminals, theme, run, exec, home, props, layout, readTextFile, checking } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function ensureCommanderTerm(node, content) {
  if (!node) return node;
  if (node.id === "commander") {
    const children = (node.children ?? []).map(c => ensureCommanderTerm(c, content));
    if (!children.some(c => c.id === "commander-term")) {
      children.push({ id: "commander-term", type: "block", content });
    }
    return { ...node, children };
  }
  if (node.id === "commander-term") return { ...node, content };
  if (!node.children) return node;
  return { ...node, children: node.children.map(c => ensureCommanderTerm(c, content)) };
}

export default class CcCommander extends View {
  init(_props, cx) {
    this.spawning = false;
    this.error = null;
    this.modelLabel = "terra#low";
    this.lastSyncAt = 0;
    this.lastTargetKey = null;
    if (checking()) return;
    this.loadModelLabel(cx);
    cx.timer.every(15000, cx => this.loadModelLabel(cx));
  }

  getError() {
    try { return this.error || localStorage.getItem("cc.cmdr.error") || null; } catch { return this.error; }
  }

  setError(msg) {
    this.error = msg;
    try {
      if (msg) localStorage.setItem("cc.cmdr.error", msg);
      else localStorage.removeItem("cc.cmdr.error");
    } catch {}
  }

  isSpawning() {
    try { return this.spawning || localStorage.getItem("cc.cmdr.spawning") === "1"; } catch { return this.spawning; }
  }

  setSpawning(val) {
    this.spawning = val;
    try {
      if (val) localStorage.setItem("cc.cmdr.spawning", "1");
      else localStorage.removeItem("cc.cmdr.spawning");
    } catch {}
  }

  loadModelLabel(cx) {
    cx.spawn(async cx => {
      try {
        const raw = await readTextFile(`${home()}/.config/command-center/models.json`);
        if (raw) {
          const r = JSON.parse(raw)?.roles?.commander;
          if (r?.model) {
            const name = r.model.split("/").pop().replace("-openai", "").replace("-anthropic", "");
            this.modelLabel = r.variant ? `${name}#${r.variant}` : name;
            cx.notify();
          }
        }
      } catch {}
    });
  }

  syncTerminalBlock(cmdr) {
    if (checking() || props()?.body) return;
    const now = Date.now();
    const targetKey = cmdr ? cmdr.address : "__offline__";
    if (this.lastTargetKey === targetKey && now - this.lastSyncAt < 800) return;
    const root = layout();
    const cmdrCol = find(root, "commander");
    if (!cmdrCol) return;
    const termNode = find(cmdrCol, "commander-term");
    const bound = termNode?.content?.terminal ?? null;
    if (cmdr && (!termNode || bound !== cmdr.address)) {
      this.lastSyncAt = now;
      this.lastTargetKey = targetKey;
      this.setError(null);
      run("layout.set", { layout: ensureCommanderTerm(root, { terminal: cmdr.address }) });
    } else if (!cmdr && (!termNode || bound)) {
      this.lastSyncAt = now;
      this.lastTargetKey = targetKey;
      run("layout.set", { layout: ensureCommanderTerm(root, { mod: "cc-commander", props: { body: true } }) });
    }
  }

  launch(cx) {
    if (this.isSpawning()) return;
    this.setSpawning(true);
    this.setError(null);
    cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await exec(`${home()}/.local/bin/cc-commander`, [], { timeout: 20000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Failed to start Commander").trim());
      } catch (e) {
        this.setError(String(e));
      } finally {
        this.setSpawning(false);
        cx.notify();
      }
    });
  }

  restart(_cmdr, cx) {
    if (this.isSpawning()) return;
    this.setSpawning(true);
    this.setError(null);
    cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await exec(`${home()}/.local/bin/cc-commander`, ["--restart"], { timeout: 25000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Failed to restart Commander").trim());
      } catch (e) {
        this.setError(String(e));
      } finally {
        this.setSpawning(false);
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const cmdr = terminals().find(x => x.state === "live" && x.labels?.["cc.role"] === "commander");
    const spawning = this.isSpawning();
    const error = this.getError();

    if (props()?.body) {
      return v_flex().size_full().items_center().justify_center().p(24).gap(12).bg(t.background).text_color(t.foreground)
        .child(div().text_size(14).font_semibold().text_center().child("Commander Offline"))
        .child(div().text_size(12).text_color(t.muted).text_center().child(`Central Chief-of-Staff (${this.modelLabel}). Launches isolated ticket spaces & workers.`))
        .when(Boolean(error), el => el.child(div().text_size(11).text_color(t.blocked).text_center().child(error)))
        .child(h_flex().id("cc-launch-btn").px(14).py(8).rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_semibold().cursor_pointer()
          .on_click((_e, cx) => this.launch(cx))
          .child(spawning ? "Starting Commander…" : "Launch Commander"));
    }

    this.syncTerminalBlock(cmdr);

    const status = cmdr?.status ?? "offline";
    const modelTag = cmdr?.labels?.["cc.model"] || this.modelLabel;
    const dot = status === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)
      : div().size(7).rounded(4).bg(status === "blocked" || status === "error" ? t.blocked : status === "done" ? t.done : status === "idle" ? t.idle : t.dim);

    const iconBtn = (id, tip, labelEl, action) => div().id(id).px(6).py(3).rounded(5).text_size(11).text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(labelEl);

    return h_flex().size_full().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
      .child(dot)
      .child(div().font_semibold().text_color(t.foreground).child("Commander"))
      .child(div().px(6).py(2).rounded(5).bg(t.surface).text_size(10.5).text_color(t.accent).child(modelTag))
      .when(Boolean(cmdr), el => el.child(div().text_size(10.5).text_color(t.dim).child(cmdr.address)))
      .when(Boolean(error), el => el.child(div().px(5).py(1).rounded(4).bg(t.blocked + "22").text_size(10).text_color(t.blocked).tooltip(error).child("Error")))
      .child(div().flex_1())
      .when(Boolean(cmdr), el => el
        .child(iconBtn("cmdr-focus", "Focus Commander input", "Focus", () => run("pane.focus", { terminal: cmdr.address })))
        .child(iconBtn("cmdr-restart", "Restart Commander session", spawning ? "…" : "Restart", (_e, cx) => this.restart(cmdr, cx))))
      .when(!cmdr, el => el.child(iconBtn("cmdr-start", "Launch Commander", spawning ? "Starting…" : "Start", (_e, cx) => this.launch(cx))))
      .child(iconBtn("cmdr-hide", "Hide Commander panel", svg("mods/pane/close.svg").size(12), () => run("layout.hide", { id: "commander" })));
  }
}
