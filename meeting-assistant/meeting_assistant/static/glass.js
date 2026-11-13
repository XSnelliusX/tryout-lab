// Liquid Glass behaviours: custom elements (light DOM) and small helpers. No innerHTML, no inline styles.

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** el(tag, props, ...children): DOM builder. Props: class, style (object), dataset (object), on* functions, attributes/properties. */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style") for (const [k, v] of Object.entries(value)) node.style.setProperty(k, v);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else if (key in node && key !== "role" && !key.includes("-")) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

// ---------- Icons: original 16x16 geometry, 1.5px strokes. A leading "*" marks a filled shape. ----------
const circle = (x, y, r) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const ICONS = {
  "record": ["*" + circle(8, 8, 5)],
  "stop": ["*M4.5 4.5h7v7h-7z"],
  "mic": ["M6 3.5a2 2 0 0 1 4 0V8a2 2 0 0 1-4 0z", "M3.5 7.5a4.5 4.5 0 0 0 9 0", "M8 12v2.5", "M5.5 14.5h5"],
  "waveform": ["M3 6.5v3", "M5.5 4v8", "M8 2.5v11", "M10.5 5v6", "M13 6.5v3"],
  "speaker": ["M2.5 6.5H5l3.5-3v9L5 9.5H2.5z", "M11 6a3 3 0 0 1 0 4", "M12.8 4.5a5.5 5.5 0 0 1 0 7"],
  "display": ["M2 3h12v8H2z", "M8 11v2.5", "M5.5 13.5h5"],
  "sidebar": ["M2 3h12v10H2z", "M6 3v10"],
  "inspector": ["M2 3h12v10H2z", "M10 3v10"],
  "plus": ["M8 3v10", "M3 8h10"],
  "trash": ["M3 4.5h10", "M6.5 4.5V3h3v1.5", "M4.5 4.5l.7 8.5h5.6l.7-8.5", "M6.8 7v3.8", "M9.2 7v3.8"],
  "pencil": ["M10.5 2.8l2.7 2.7-7.6 7.6-3.4.7.7-3.4z", "M9 4.3l2.7 2.7"],
  "play": ["*M5 3.2v9.6l8-4.8z"],
  "pause": ["*M4.5 3.5H7v9H4.5z", "*M9 3.5h2.5v9H9z"],
  "clock": [circle(8, 8, 5.5), "M8 4.8V8l2.2 1.4"],
  "chevron-right": ["M6 3.5L10.5 8 6 12.5"],
  "chevron-down": ["M3.5 6L8 10.5 12.5 6"],
  "xmark": ["M4 4l8 8", "M12 4l-8 8"],
  "checkmark": ["M3.5 8.5l3 3 6-7"],
  "copy": ["M5.5 5.5h7.5v8H5.5z", "M3 10.5V3h7.5"],
  "text-size": ["M2 12.5l3.5-9 3.5 9", "M3.3 9.5h4.4", "M10 12.5l2-5 2 5", "M10.7 11h2.6"],
  "gear": [circle(8, 8, 2), circle(8, 8, 4.7), "M8 1.8v1.5", "M8 12.7v1.5", "M1.8 8h1.5", "M12.7 8h1.5", "M3.6 3.6l1 1", "M11.4 11.4l1 1", "M3.6 12.4l1-1", "M11.4 4.6l1-1"],
  "export": ["M8 10V2.5", "M5.5 5L8 2.5 10.5 5", "M4 7.5H3v6h10v-6h-1"],
  "sparkles": ["M6 2.5q.6 3.4 3.5 4-2.9.6-3.5 4-.6-3.4-3.5-4 2.9-.6 3.5-4z", "M12 9.5q.3 1.7 1.8 2-1.5.3-1.8 2-.3-1.7-1.8-2 1.5-.3 1.8-2z"],
  "warning": ["M8 2.5l6 10.5H2z", "M8 6.8v3", "M8 11.5v.2"],
  "info": [circle(8, 8, 5.8), "M8 7.3v4", "M8 5v.2"],
  "arrow-down": ["M8 3v10", "M4 9l4 4 4-4"],
  "person": [circle(8, 5.5, 2.7), "M2.8 13.5c.5-3 2.7-4.3 5.2-4.3s4.7 1.3 5.2 4.3"],
  "book": ["M2.5 3.5c2-.8 4-.5 5.5.8 1.5-1.3 3.5-1.6 5.5-.8v9c-2-.8-4-.5-5.5.8-1.5-1.3-3.5-1.6-5.5-.8z", "M8 4.3v9"],
  "refresh": ["M13 8a5 5 0 1 1-1.6-3.7", "M13 2.5v2.8h-2.8"],
  "swap": ["M3.5 5.5h9", "M10 3l2.5 2.5L10 8", "M12.5 10.5h-9", "M6 8l-2.5 2.5L6 13"],
  "translate": ["M2.5 4h5", "M5 2.5v1.5", "M3.2 4c.4 2.4 1.6 4.4 3.4 5.7", "M6.8 4c-.4 1.8-1.4 3.5-3.2 4.8", "M9 13.5l2.3-6 2.2 6", "M9.6 11.7h3.3"],
};
export const ICON_NAMES = Object.keys(ICONS);

/** icon(name): inline SVG element (aria-hidden, currentColor). Throws on unknown names. */
export function icon(name) {
  const shapes = ICONS[name];
  if (!shapes) throw new Error(`Unknown icon: ${name}`);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  for (const shape of shapes) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", shape.replace("*", ""));
    if (shape[0] === "*") path.setAttribute("fill", "currentColor");
    svg.append(path);
  }
  return svg;
}

// ---------- <glass-segmented> ----------
class GlassSegmented extends HTMLElement {
  static observedAttributes = ["value", "disabled"];
  #thumb = el("span", { class: "glass-segmented-thumb", "aria-hidden": "true" });
  #resize = new ResizeObserver(() => this.#measure());
  #children = new MutationObserver(() => this.#sync());

  constructor() {
    super();
    this.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (button && this.contains(button)) this.#choose(button);
    });
    this.addEventListener("keydown", (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      const enabled = this.#buttons.filter((b) => !b.disabled);
      if (!enabled.length || !(e.key in keys || e.key === "Home" || e.key === "End")) return;
      const at = enabled.indexOf(this.#selected);
      const next = e.key === "Home" ? 0 : e.key === "End" ? enabled.length - 1 : (at + keys[e.key] + enabled.length) % enabled.length;
      e.preventDefault();
      this.#choose(enabled[next]);
      enabled[next].focus();
    });
  }

  get #buttons() { return [...this.querySelectorAll(":scope > button")]; }
  get #selected() { return this.#buttons.find((b) => b.value === this.value) ?? this.#buttons[0]; }
  get value() { return this.getAttribute("value") ?? this.#buttons[0]?.value ?? ""; }
  set value(v) { this.setAttribute("value", v); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { this.toggleAttribute("disabled", Boolean(v)); }

  connectedCallback() {
    this.setAttribute("role", "radiogroup");
    this.#children.observe(this, { childList: true });
    this.#resize.observe(this);
    this.#sync();
    requestAnimationFrame(() => this.setAttribute("data-ready", ""));
  }
  disconnectedCallback() { this.#children.disconnect(); this.#resize.disconnect(); this.removeAttribute("data-ready"); }
  attributeChangedCallback() { if (this.isConnected) this.#sync(); }

  #choose(button) {
    if (button.disabled || button.value === this.value) return;
    this.value = button.value;
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }
  #sync() {
    if (this.#thumb.parentNode !== this) this.prepend(this.#thumb);
    const selected = this.#selected;
    for (const b of this.#buttons) {
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(b === selected));
      b.tabIndex = b === selected ? 0 : -1;
      b.disabled = this.disabled || b.hasAttribute("data-disabled");
    }
    this.#measure();
  }
  #measure() {
    const b = this.#selected;
    if (!b || !b.offsetWidth) return;
    this.#thumb.style.setProperty("width", `${b.offsetWidth}px`);
    this.#thumb.style.setProperty("transform", `translateX(${b.offsetLeft}px)`);
  }
}

// ---------- <glass-sheet> ----------
class GlassSheet extends HTMLElement {
  #dialog; #opener; #resolve; #result;

  connectedCallback() {
    if (this.#dialog) return;
    this.#dialog = this.querySelector(":scope > dialog") ?? el("dialog", null, ...this.childNodes);
    this.#dialog.classList.add("glass", "glass--thick", "glass-sheet-dialog");
    this.#dialog.dataset.shape = "sheet";
    this.#dialog.addEventListener("close", () => {
      this.#opener?.focus?.();
      this.dispatchEvent(new CustomEvent("close", { detail: { value: this.#result } }));
      this.#resolve?.(this.#result);
    });
    this.append(this.#dialog);
  }
  get dialog() { return this.#dialog; }
  /** Opens modally; resolves with the value passed to close(), or undefined when dismissed with Escape. */
  open() {
    this.#opener = document.activeElement;
    this.#result = undefined;
    this.#dialog.showModal();
    return new Promise((resolve) => { this.#resolve = resolve; });
  }
  close(value) {
    this.#result = value;
    this.#dialog?.close();
  }
}

let sheetId = 0;
const KIND_CLASS = { prominent: "glass-button--prominent", destructive: "glass-button--destructive" };

/** sheet({title, body: Node|string, actions: [{label, value, kind: "default"|"prominent"|"destructive"}]}) -> Promise<value|undefined> */
export function sheet({ title, body, actions = [{ label: "OK", value: true, kind: "prominent" }] }) {
  const id = `glass-sheet-${++sheetId}`;
  const host = el("glass-sheet");
  const bodyBox = el("div", { class: "glass-sheet-body", id: `${id}-body` }, body);
  const focusTarget = actions.some((a) => a.kind === "destructive")
    ? actions.find((a) => a.kind !== "destructive" && a.kind !== "prominent")
    : actions.find((a) => a.kind === "prominent") ?? actions.at(-1);
  host.append(
    el("h2", { class: "glass-sheet-title", id: `${id}-title` }, title),
    bodyBox,
    el("div", { class: "glass-sheet-actions" }, actions.map((a) =>
      el("button", {
        type: "button", class: `glass-button glass-button--large ${KIND_CLASS[a.kind] ?? "glass-button--filled"}`,
        autofocus: a === focusTarget, onclick: () => host.close(a.value),
      }, a.label))),
  );
  document.body.append(host);
  host.dialog.setAttribute("aria-labelledby", `${id}-title`);
  host.dialog.setAttribute("aria-describedby", bodyBox.id);
  const result = host.open();
  result.then(() => host.remove());
  return result;
}

/** confirmSheet({title, message, confirmLabel, cancelLabel, destructive}) -> Promise<boolean> */
export async function confirmSheet({ title, message, confirmLabel = "OK", cancelLabel = "Cancel", destructive = false }) {
  const value = await sheet({
    title, body: message,
    actions: [{ label: cancelLabel, value: false }, { label: confirmLabel, value: true, kind: destructive ? "destructive" : "prominent" }],
  });
  return value === true;
}

// ---------- <glass-toasts> ----------
const TOAST_ICONS = { info: "info", success: "checkmark", warning: "warning", error: "xmark" };

class GlassToasts extends HTMLElement {
  connectedCallback() {
    this.setAttribute("aria-live", "polite");
    this.setAttribute("aria-relevant", "additions");
    this.setAttribute("popover", "manual"); // top layer, so toasts stay visible above an open sheet
    this.showPopover?.();
  }

  /** Adds a toast; returns a function that dismisses it. */
  add(message, { kind = "info", timeout, actionLabel, onAction } = {}) {
    let remaining = timeout ?? (kind === "error" ? 8000 : 5000); // 0 keeps the toast until dismissed
    let timer = 0, startedAt = 0, gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      node.setAttribute("data-leaving", "");
      setTimeout(() => node.remove(), reducedMotion() ? 0 : 170);
    };
    const resume = () => { if (remaining > 0 && !timer && !gone) { startedAt = Date.now(); timer = setTimeout(dismiss, remaining); } };
    const pause = () => { if (timer) { clearTimeout(timer); timer = 0; remaining -= Date.now() - startedAt; } };

    const node = el("div", { class: "glass glass-toast", "data-shape": "panel", "data-kind": kind, role: kind === "error" ? "alert" : null },
      icon(TOAST_ICONS[kind] ?? "info"),
      el("span", { class: "glass-toast-message" }, message),
      actionLabel && el("button", { type: "button", class: "glass-button glass-button--filled", onclick: () => { onAction?.(); dismiss(); } }, actionLabel),
      el("button", { type: "button", class: "glass-button glass-button--icon", "aria-label": "Dismiss", title: "Dismiss", onclick: dismiss }, icon("xmark")),
    );
    node.addEventListener("mouseenter", pause);
    node.addEventListener("mouseleave", resume);
    node.addEventListener("focusin", pause);
    node.addEventListener("focusout", (e) => { if (!node.contains(e.relatedTarget)) resume(); });
    this.append(node);
    while (this.children.length > 4) this.firstElementChild.remove();
    resume();
    return dismiss;
  }
}

/** toast(message, {kind: "info"|"success"|"warning"|"error", timeout (ms, 0 = sticky), actionLabel, onAction}) -> dismiss() */
export function toast(message, options) {
  let host = document.querySelector("glass-toasts");
  if (!host) document.body.append((host = el("glass-toasts")));
  return host.add(message, options);
}

// ---------- <level-meter> ----------
const MIN_DB = -60, HOLD_MS = 1200, DECAY_DB_PER_S = 24;
const fraction = (db) => Math.min(1, Math.max(0, (db - MIN_DB) / -MIN_DB));
const NUMERIC = ["rms", "peak", "floor", "threshold"];

class LevelMeter extends HTMLElement {
  static observedAttributes = [...NUMERIC, "clipped", "readout"];
  #v = { rms: MIN_DB, peak: null, floor: null, threshold: null, clipped: false };
  #held = MIN_DB; #holdUntil = 0; #last = 0; #raf = 0; #width = 0;
  #bar = el("div", { class: "lm-bar" });
  #ticks = { peak: el("div", { class: "lm-tick", "data-kind": "peak" }), floor: el("div", { class: "lm-tick", "data-kind": "floor", title: "Noise floor" }), threshold: el("div", { class: "lm-tick", "data-kind": "threshold", title: "Threshold" }) };
  #readout = el("span", { class: "lm-readout", hidden: true });
  #resize = new ResizeObserver(([entry]) => { this.#width = entry.contentRect.width; this.#schedule(); });
  #cache = new WeakMap();

  connectedCallback() {
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "meter");
      this.setAttribute("aria-valuemin", String(MIN_DB));
      this.setAttribute("aria-valuemax", "0");
      if (!this.hasAttribute("aria-label")) this.setAttribute("aria-label", "Input level");
      const track = el("div", { class: "lm-track" }, el("div", { class: "lm-zones" }), this.#bar, ...Object.values(this.#ticks));
      this.append(track, el("span", { class: "lm-clip", title: "Clipping" }), this.#readout);
      this.#resize.observe(track);
    }
    this.#schedule();
  }
  attributeChangedCallback(name, _old, value) {
    if (name === "readout") this.#readout.hidden = value === null;
    else if (name === "clipped") this.clipped = value !== null;
    else this[name] = value;
  }
  get rms() { return this.#v.rms; }
  set rms(db) { this.#num("rms", db); }
  get peak() { return this.#v.peak; }
  set peak(db) { this.#num("peak", db); }
  get floor() { return this.#v.floor; }
  set floor(db) { this.#num("floor", db); }
  get threshold() { return this.#v.threshold; }
  set threshold(db) { this.#num("threshold", db); }
  get clipped() { return this.#v.clipped; }
  set clipped(on) { this.#v.clipped = Boolean(on) && on !== "false"; this.#schedule(); }

  #num(name, db) {
    const n = db == null || db === "" ? NaN : Number(db);
    this.#v[name] = Number.isFinite(n) ? n : name === "rms" ? MIN_DB : null;
    this.#schedule();
  }
  #schedule() { if (!this.#raf && this.isConnected) this.#raf = requestAnimationFrame((t) => { this.#raf = 0; this.#frame(t); }); }

  #frame(t) {
    const { rms, floor, threshold, clipped } = this.#v;
    const peak = this.#v.peak ?? rms;
    const dt = Math.min(100, t - (this.#last || t));
    this.#last = t;
    if (peak >= this.#held) { this.#held = peak; this.#holdUntil = t + HOLD_MS; }
    else if (t > this.#holdUntil) this.#held = reducedMotion() ? peak : Math.max(peak, this.#held - (DECAY_DB_PER_S * dt) / 1000);

    this.#set(this.#bar, "clipPath", `inset(0 ${((1 - fraction(rms)) * 100).toFixed(1)}% 0 0)`);
    for (const [name, db] of [["peak", this.#held], ["floor", floor], ["threshold", threshold]]) {
      const tick = this.#ticks[name];
      this.#set(tick, "hidden", db == null);
      if (db != null) this.#set(tick, "transform", `translateX(${(fraction(db) * this.#width - 1).toFixed(1)}px)`);
    }
    const text = `${Math.round(Math.max(MIN_DB, Math.min(0, rms)))}`;
    this.#set(this, "aria-valuenow", text);
    this.#set(this, "aria-valuetext", `${text} dBFS`);
    this.#set(this.#readout, "textContent", `${text} dBFS`);
    this.toggleAttribute("data-clipped", clipped);
    if (this.#held > peak) this.#schedule(); else this.#last = 0;
  }

  /** Writes only when the value changed, so steady frames cost nothing. */
  #set(node, key, value) {
    const cache = this.#cache.get(node) ?? this.#cache.set(node, {}).get(node);
    if (cache[key] === value) return;
    cache[key] = value;
    if (key === "clipPath" || key === "transform") node.style.setProperty(key === "clipPath" ? "clip-path" : "transform", value);
    else if (key === "hidden" || key === "textContent") node[key] = value;
    else node.setAttribute(key, value);
  }
}
customElements.define("glass-segmented", GlassSegmented);
customElements.define("glass-sheet", GlassSheet);
customElements.define("glass-toasts", GlassToasts);
customElements.define("level-meter", LevelMeter);
