// Left sidebar: saved sessions, model status, privacy note.
import { el, icon, confirmSheet } from "/glass.js";
import { action } from "/api.js";
import { store } from "/store.js";
import { $, setText, setUnavailable, onPress, formatDate, sourceLabel } from "/ui.js";
import { PRIVACY_TEXT } from "/recorder.js";
import { clearClips } from "/transcript.js";

const rows = new Map();
let listNode, emptyNode, signature = "";

export function hasDrafts() { return store.dirty.size > 0; }

async function openSession(id) {
  if (store.state?.session?.id === id) return;
  if (hasDrafts() && !(await confirmSheet({
    title: "Open another session?",
    message: "Opening another session discards open transcript, context and speaker editors. Continue?",
    confirmLabel: "Discard and open", destructive: true,
  }))) return;
  clearClips();
  store.dirty.clear();
  action("/api/session/open", { session_id: id });
}

async function deleteSession(session) {
  const ok = await confirmSheet({
    title: "Delete this session?",
    message: `Permanently delete session ${session.id} (${formatDate(session.created_at)}, ${sourceLabel(session.source)}), its app-owned audio, revisions and exports? Backups and external copies remain.`,
    confirmLabel: "Delete session", destructive: true,
  });
  if (ok) action("/api/session/delete", { session_id: session.id, confirm: true });
}

function createRow(session) {
  const title = el("span", { class: "glass-list-title tnum" });
  const sub = el("span", { class: "glass-list-sub" });
  const open = el("button", { type: "button", class: "glass-list-item" }, title, sub);
  const del = el("button", { type: "button", class: "glass-button glass-button--icon session-delete" }, icon("trash"));
  const row = { session, title, sub, open, del, node: el("li", { class: "session-row" }, open, del) };
  onPress(open, () => openSession(row.session.id));
  onPress(del, () => deleteSession(row.session));
  return row;
}

function render(state) {
  if (!listNode) return;
  const sessions = state?.sessions || [];
  const idle = store.isIdle();
  const reason = idle ? "" : "Finish recording and pending work before switching sessions";
  const ids = new Set(sessions.map((s) => s.id));
  for (const [id, row] of rows) if (!ids.has(id)) { row.node.remove(); rows.delete(id); }
  let cursor = listNode.firstChild;
  for (const session of sessions) {
    let row = rows.get(session.id);
    if (!row) { row = createRow(session); rows.set(session.id, row); }
    row.session = session;
    if (row.node !== cursor) listNode.insertBefore(row.node, cursor); else cursor = cursor.nextSibling;
    const current = state?.session?.id === session.id;
    if (row.open.getAttribute("aria-current") !== String(current)) row.open.setAttribute("aria-current", String(current));
    const recordingThis = state?.recording_state !== "idle" && state?.session_id === session.id;
    setText(row.title, formatDate(session.created_at));
    setText(row.sub, `${sourceLabel(session.source)} · ${recordingThis ? "recording" : session.status || "unknown"}`);
    setUnavailable(row.open, reason, current ? "Open session" : "Open this session");
    row.open.setAttribute("aria-label", `${formatDate(session.created_at)}, ${sourceLabel(session.source)}, ${session.status || "unknown"}${current ? ", open" : ""}`);
    setUnavailable(row.del, reason || (recordingThis ? "Cannot delete the session being recorded" : ""), "Delete session");
    row.del.setAttribute("aria-label", `Delete session ${formatDate(session.created_at)}`);
  }
  emptyNode.hidden = sessions.length > 0;
  const model = state ? (state.model_status || "Model status unknown") : store.error ? `Connection error: ${store.error}` : "Connecting…";
  const kind = !state ? "" : state.model_ready ? "ready" : /fail/i.test(model) ? "failed" : "loading";
  setText($("model-status-text"), model);
  const dot = $("model-dot");
  if (dot.dataset.kind !== kind) dot.dataset.kind = kind;
}

export function mountSidebar() {
  listNode = $("session-list"); emptyNode = $("session-empty");
  $("privacy-note").textContent = PRIVACY_TEXT;
  store.subscribe((state, changed) => { if (changed.has("state")) render(state); });
  render(store.state);
}
