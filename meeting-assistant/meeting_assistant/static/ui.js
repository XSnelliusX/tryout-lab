// Small shared helpers for the app modules.
export const $ = (id) => document.getElementById(id);

export function setText(node, text) {
  const value = text == null ? "" : String(text);
  if (node.textContent !== value) node.textContent = value;
}

/** Marks a button unavailable without removing it from tab order, so its title can explain why. */
export function setUnavailable(button, reason, available = "") {
  const off = Boolean(reason);
  if (off !== (button.getAttribute("aria-disabled") === "true")) {
    if (off) button.setAttribute("aria-disabled", "true"); else button.removeAttribute("aria-disabled");
  }
  const title = off ? reason : available;
  if (title) { if (button.title !== title) button.title = title; } else button.removeAttribute("title");
}
export const isUnavailable = (button) => button.getAttribute("aria-disabled") === "true";

/** Click handler that ignores unavailable buttons. */
export function onPress(button, handler) {
  button.addEventListener("click", (event) => { if (!isUnavailable(button)) handler(event); });
}

export function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatRange(segment) {
  if (Number.isFinite(segment?.start) && Number.isFinite(segment?.end)) return `${formatClock(segment.start)}–${formatClock(segment.end)}`;
  return Number.isFinite(segment?.start) ? `${formatClock(segment.start)}–` : "Manual text";
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

export function formatDb(db, digits = 0) {
  return Number.isFinite(db) ? `${db.toFixed(digits)} dB` : "—";
}

const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "Date unknown") : dateFormat.format(date);
}

export const SOURCE_LABELS = { teams: "Teams", system: "System audio", microphone: "Microphone" };
export const sourceLabel = (source) => SOURCE_LABELS[source] || source || "Unknown source";

export function sessionTitle(session) {
  return session ? `${formatDate(session.created_at)} · ${sourceLabel(session.source)}` : "";
}

/** "speaker_2" -> "Speaker 2"; named speakers use the session's name. "unknown" -> "". */
export function speakerText(state, label) {
  const name = state?.session?.speaker_names?.[label];
  if (name) return name;
  if (!label || label === "unknown") return "";
  const match = /^speaker_(\d+)$/.exec(label);
  return match ? `Speaker ${match[1]}` : label;
}

// View preferences only (never secrets): sessionStorage, wrapped because storage can be unavailable.
const PREF_KEY = "meeting-assistant-view";
export function readPrefs() {
  try { return JSON.parse(sessionStorage.getItem(PREF_KEY)) || {}; } catch (_) { return {}; }
}
export function writePrefs(patch) {
  try { sessionStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), ...patch })); } catch (_) { /* ignore */ }
}
