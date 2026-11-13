import { el, icon, ICON_NAMES, confirmSheet, sheet, toast } from "/glass.js";

const root = document.documentElement;

// Icon placeholders in the markup become inline SVG.
for (const slot of document.querySelectorAll("[data-icon]")) slot.replaceWith(icon(slot.dataset.icon));

// Appearance and transparency overrides (data-theme, data-transparency on <html>).
document.querySelector("#theme").addEventListener("change", (e) => {
  if (e.target.value === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = e.target.value;
});
document.querySelector("#reduce").addEventListener("change", (e) => {
  if (e.target.checked) root.dataset.transparency = "reduced";
  else root.removeAttribute("data-transparency");
});

const seg = document.querySelector("#seg");
seg.addEventListener("change", () => { document.querySelector("#seg-out").textContent = `value: ${seg.value}`; });

// Sheets
document.querySelector("#open-confirm").addEventListener("click", async (e) => {
  const ok = await confirmSheet({ title: "Stop recording?", message: "The session will be saved and the summary will be prepared.", confirmLabel: "Stop and save" });
  toast(ok ? "Session saved" : "Recording continues", { kind: ok ? "success" : "info" });
});
document.querySelector("#open-destructive").addEventListener("click", async () => {
  const ok = await confirmSheet({ title: "Delete this session?", message: "The transcript, notes and audio for “Weekly sync” will be removed. This cannot be undone.", confirmLabel: "Delete", destructive: true });
  if (ok) toast("Session deleted", { kind: "warning" });
});
document.querySelector("#open-custom").addEventListener("click", async () => {
  const input = el("input", { class: "text-input", id: "rename", value: "Weekly sync" });
  const body = el("div", { class: "field" }, el("label", { for: "rename" }, "Name"), input);
  const value = await sheet({ title: "Rename session", body, actions: [{ label: "Cancel", value: null }, { label: "Rename", value: "ok", kind: "prominent" }] });
  if (value === "ok") toast(`Renamed to “${input.value}”`, { kind: "success" });
});

// Toasts
const SAMPLES = {
  info: ["Model warmed up", {}],
  success: ["Exported to Markdown", { kind: "success" }],
  warning: ["Input level is low", { kind: "warning" }],
  error: ["Could not reach the speech model", { kind: "error" }],
  action: ["Transcript removed", { actionLabel: "Undo", onAction: () => toast("Restored", { kind: "success" }) }],
};
for (const button of document.querySelectorAll("[data-toast]")) {
  button.addEventListener("click", () => { const [text, opts] = SAMPLES[button.dataset.toast]; toast(text, { kind: button.dataset.toast, ...opts }); });
}

// Live meter: ~10 updates per second.
const live = document.querySelector("#live-meter");
let phase = 0;
setInterval(() => {
  phase += 0.35;
  const level = -26 + 16 * Math.sin(phase) + 6 * Math.sin(phase * 2.7);
  live.rms = level;
  live.peak = level + 6;
  live.clipped = level + 6 > -1;
}, 100);

// Scroll-edge sample content
const edge = document.querySelector(".edge-content");
for (let i = 1; i <= 14; i++) {
  edge.append(el("div", { class: "edge-card" },
    el("div", { class: "edge-en" }, `Line ${i}: we need the confirmation before Friday.`),
    el("div", { class: "edge-zh", lang: "zh-Hant" }, "我們需要在星期五之前收到確認。")));
}

// Icon grid
const grid = document.querySelector("#icons");
for (const name of ICON_NAMES) grid.append(el("figure", { class: "icon-cell" }, icon(name), el("figcaption", null, name)));
