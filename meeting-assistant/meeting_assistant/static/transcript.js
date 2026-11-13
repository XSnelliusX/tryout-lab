// The caption stream: keyed per-segment views, patched in place. English leads, Chinese source beneath.
import { el, icon, toast } from "/glass.js";
import { api, action, getToken } from "/api.js";
import { store } from "/store.js";
import { $, setText, setUnavailable, onPress, formatRange, formatMs, speakerText } from "/ui.js";

const views = new Map();
let scroller, list, emptyBox, jump, announcer, noteBox;
let stick = true, sessionKey, seeded = false, emptyKey = "";
let announceQueue = [], announceTimer = 0;

const LIVE_EDGE = new Set(["provisional", "translating"]);

// ---------- Clips ----------
export function clearClips() {
  for (const view of views.values()) dropClip(view);
}
function dropClip(view) {
  view.clip.querySelectorAll("audio").forEach((audio) => audio.pause());
  view.clip.replaceChildren();
  view.clip.hidden = true;
  if (view.url) { URL.revokeObjectURL(view.url); view.url = null; }
}

async function playClip(view) {
  const s = view.segment, state = store.state;
  if (!state?.session?.id || state.recording_state !== "idle") return;
  if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) return;
  const sessionId = state.session.id;
  const end = Math.min(s.end, s.start + 60);
  view.clip.hidden = false;
  view.clip.replaceChildren(el("p", { class: "cap-note-line" }, "Loading authenticated audio clip…"));
  try {
    const query = new URLSearchParams({ session_id: sessionId, start: s.start, end });
    const response = await fetch(`/api/audio?${query}`, { headers: { Authorization: `Bearer ${getToken()}` }, cache: "no-store" });
    if (!response.ok) {
      let message = "Audio unavailable";
      try { message = (await response.json()).error || message; } catch (_) { /* keep default */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const now = store.state;
    if (now?.recording_state !== "idle" || now?.session?.id !== sessionId || store.busy) { dropClip(view); return; }
    if (view.url) URL.revokeObjectURL(view.url);
    view.url = URL.createObjectURL(blob);
    const audio = el("audio", { controls: true, src: view.url, "aria-label": `Audio clip ${formatRange(s)}` });
    view.clip.replaceChildren(audio, end < s.end ? el("p", { class: "cap-note-line" }, "Clip limited to the first 60 seconds.") : null);
    audio.play?.().catch(() => {});
  } catch (error) {
    view.clip.replaceChildren(el("p", { class: "cap-problem" }, error.message));
  }
}

// ---------- History ----------
async function toggleHistory(view) {
  if (!view.history.hidden) { view.history.hidden = true; return; }
  const sessionId = store.state?.session?.id;
  view.history.hidden = false;
  view.history.replaceChildren(el("p", { class: "cap-note-line" }, "Loading history…"));
  try {
    const result = await api(`/api/history?${new URLSearchParams({ segment_id: view.segment.id, session_id: sessionId })}`);
    const entries = result.history || [];
    view.history.replaceChildren(
      el("h4", null, "Original recognition"),
      el("p", { class: "cap-zh-small", lang: "zh-Hant" }, view.segment.raw_text || "(empty)"),
      el("h4", null, "Revision history"),
      entries.length ? el("ol", { class: "cap-revisions" }, entries.map((entry) => el("li", null,
        el("span", { class: "cap-revision-head tnum" }, `Revision ${entry.revision ?? "?"}${entry.created_at ? ` · ${new Date(entry.created_at).toLocaleString("en")}` : ""}`),
        el("span", { lang: "zh-Hant" }, entry.traditional_text || ""),
        entry.english ? el("span", { class: "cap-revision-en" }, entry.english) : null)))
        : el("p", { class: "cap-note-line" }, "No revision history available."),
    );
  } catch (error) {
    view.history.replaceChildren(el("p", { class: "cap-problem" }, error.message));
  }
}

// ---------- Editor ----------
/** The "segment-edit" draft key is set while any inline editor is open (the panels read it). */
function syncEditing() {
  if ([...views.values()].some((v) => v.editing)) store.dirty.add("segment-edit"); else store.dirty.delete("segment-edit");
}
function speakerOptions(state, segments, selected) {
  const names = state?.session?.speaker_names || {};
  const labels = new Set(["unknown", ...Array.from({ length: 8 }, (_, i) => `speaker_${i + 1}`), ...Object.keys(names), ...segments.map((s) => s.speaker || "unknown"), selected || "unknown"]);
  return [...labels].map((label) => el("option", { value: label }, label === "unknown" ? "Unknown" : `${label}${names[label] ? ` — ${names[label]}` : ""}`));
}

function endEdit(view) {
  view.editing = false;
  view.editor.hidden = true;
  view.editor.replaceChildren();
  view.display.hidden = false;
  view.article.classList.remove("is-editing");
  syncEditing();
  view.signature = "";
  render(store.state, new Set(["segment"]));
}

function beginEdit(view) {
  const state = store.state, segment = view.segment;
  if (!state?.session || view.editing) return;
  view.editing = true;
  view.editRevision = segment.revision;
  view.editSession = state.session.id;
  const original = segment.traditional_text || "";
  const initialSpeaker = segment.speaker || "unknown";
  const uid = `cap-edit-${view.id}`;

  const conflict = el("div", { class: "banner banner--warning", role: "alert", hidden: true }, icon("warning"),
    el("span", null, "This caption changed while you were editing. Saving may be rejected; cancel and reopen the editor to see the latest text."));
  const text = el("textarea", { class: "text-area", id: `${uid}-text`, rows: 3, maxLength: 5000, lang: "zh-Hant", value: original });
  const speaker = el("select", { class: "select", id: `${uid}-speaker` }, speakerOptions(state, store.segments(), initialSpeaker));
  speaker.value = initialSpeaker;
  const add = el("input", { type: "checkbox", class: "checkbox", id: `${uid}-add` });
  const term = el("input", { class: "text-input", id: `${uid}-term`, maxLength: 100, lang: "zh-Hant" });
  const rendering = el("input", { class: "text-input", id: `${uid}-render`, maxLength: 200 });
  const vocab = el("div", { class: "cap-vocab", hidden: true },
    el("div", { class: "field" }, el("label", { for: term.id }, "Corrected term"), term, el("span", { class: "field-help" }, "Must appear in the corrected text.")),
    el("div", { class: "field" }, el("label", { for: rendering.id }, "Preferred English rendering (optional)"), rendering));
  add.addEventListener("change", () => { vocab.hidden = !add.checked; if (add.checked) term.focus(); });

  const save = () => {
    const body = { id: segment.id, text: text.value, expected_revision: view.editRevision, session_id: view.editSession };
    if (speaker.value !== initialSpeaker) body.speaker = speaker.value; // an explicit speaker clears diarization ambiguity flags
    if (add.checked) {
      if (!term.value.trim()) { toast("Enter a corrected vocabulary term or uncheck “Add corrected term to vocabulary”.", { kind: "warning" }); term.focus(); return; }
      body.vocabulary_term = term.value.trim();
      body.vocabulary_translation = rendering.value;
    }
    action("/api/segment/edit", body, { success: () => endEdit(view) });
  };
  const cancel = () => endEdit(view);

  view.editor.replaceChildren(
    conflict,
    el("div", { class: "field" }, el("label", { for: text.id }, "Corrected source text"), text),
    el("div", { class: "field" }, el("label", { for: speaker.id }, "Speaker"), speaker),
    el("label", { class: "field field--inline cap-check", for: add.id }, add, "Add corrected term to vocabulary"),
    vocab,
    el("div", { class: "cap-editor-actions" },
      el("button", { type: "button", class: "glass-button glass-button--filled", onclick: cancel }, "Cancel"),
      el("button", { type: "button", class: "glass-button glass-button--filled cap-save", onclick: save }, "Save edit")),
  );
  view.conflict = conflict;
  view.editor.onkeydown = (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
    else if (event.key === "Escape" && text.value === original && !add.checked && speaker.value === initialSpeaker) { event.preventDefault(); event.stopPropagation(); cancel(); }
  };
  view.editing = true;
  syncEditing();
  view.article.classList.add("is-editing");
  view.display.hidden = true;
  view.editor.hidden = false;
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}

// ---------- View construction ----------
function actionButton(label, name, handler) {
  const button = el("button", { type: "button", class: "glass-button glass-button--icon cap-action", "aria-label": label }, icon(name));
  button.dataset.label = label;
  onPress(button, handler);
  return button;
}

function createView(segment) {
  const id = String(segment.id);
  const view = { id, segment, signature: "", editing: false, url: null, status: undefined };
  view.en = el("p", { class: "cap-en", lang: "en" });
  view.zh = el("p", { class: "cap-zh", lang: "zh-Hant" });
  view.error = el("p", { class: "cap-problem", hidden: true });
  view.range = el("span", { class: "tnum" });
  view.speaker = el("span");
  view.state = el("span", { class: "cap-state" });
  view.latency = el("span", { class: "tnum", title: "Time from the end of speech to the English caption" });
  view.edit = actionButton("Edit caption", "pencil", () => beginEdit(view));
  view.historyButton = actionButton("Original and history", "clock", () => toggleHistory(view));
  view.play = actionButton("Play audio clip", "play", () => playClip(view));
  view.retranslate = actionButton("Retranslate", "refresh", () => {
    action("/api/segment/retranslate", { id: view.segment.id, session_id: store.state.session.id });
  });
  const actions = el("div", { class: "cap-actions", role: "group", "aria-label": "Caption actions" }, view.edit, view.historyButton, view.play, view.retranslate);
  view.display = el("div", { class: "cap-display" }, view.en, view.zh, view.error,
    el("div", { class: "cap-metarow" }, el("p", { class: "cap-meta" }, view.range, view.speaker, view.state, view.latency), actions));
  view.history = el("div", { class: "cap-history", hidden: true });
  view.clip = el("div", { class: "cap-clip", hidden: true });
  view.editor = el("div", { class: "cap-editor", hidden: true });
  view.article = el("article", { class: "cap", dataset: { id } }, view.display, view.history, view.clip, view.editor);
  return view;
}

const PLACEHOLDER = { provisional: "…", translating: "…", pending: "Queued for translation", error: "English translation unavailable.", complete: "English translation unavailable." };

function patch(view, segment, ctx) {
  view.segment = segment;
  if (view.editing && view.conflict) view.conflict.hidden = segment.revision === view.editRevision;
  const signature = JSON.stringify([segment, ctx]);
  if (signature === view.signature) return;
  view.signature = signature;

  const status = segment.status || "complete";
  if (view.article.dataset.status !== status) view.article.dataset.status = status;
  setText(view.zh, segment.traditional_text || segment.raw_text || "");
  view.zh.hidden = !view.zh.textContent;
  const english = segment.english || "";
  setText(view.en, english || PLACEHOLDER[status] || "");
  view.en.toggleAttribute("data-empty", !english);
  view.error.hidden = !segment.error;
  setText(view.error, segment.error ? `Inference failed: ${segment.error}` : "");

  setText(view.range, formatRange(segment));
  setText(view.speaker, ctx.speaker);
  view.speaker.hidden = !ctx.speaker;
  const edited = segment.edited || segment.revision > 1;
  const stateText = status === "provisional" ? "Live, may change" : status === "translating" ? "Translating" : status === "pending" ? "Queued" : status === "error" ? "Failed" : edited ? "Edited" : "";
  setText(view.state, stateText);
  view.state.hidden = !stateText;
  view.state.title = edited && segment.revision != null ? `Revision ${segment.revision}` : "";
  view.state.dataset.kind = status === "error" ? "error" : LIVE_EDGE.has(status) ? "live" : "";
  const ms = segment.timing?.speech_end_to_english_ms;
  setText(view.latency, Number.isFinite(ms) ? formatMs(ms) : "");
  view.latency.hidden = !Number.isFinite(ms);

  const hasSession = Boolean(ctx.sessionId), live = status === "provisional";
  const validRange = Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start;
  setUnavailable(view.edit, !hasSession ? "Open a session to edit captions" : live ? "Live captions can be edited once they are final" : segment.revision == null ? "This caption cannot be edited" : "", "Edit caption");
  setUnavailable(view.historyButton, !hasSession ? "Open a session to see history" : live ? "Live captions have no history yet" : "", "Original recognition and revision history");
  setUnavailable(view.play, !hasSession ? "Open a session to play clips" : !ctx.idle ? "Stop recording to play audio clips" : !validRange ? "No audio time range for this caption" : "", "Play audio clip (up to 60 seconds)");
  setUnavailable(view.retranslate, !hasSession ? "Open a session to retranslate" : live ? "Live captions can be retranslated once they are final" : !ctx.modelReady ? "Models are not ready" : ctx.jobActive ? "Wait for the running job to finish" : "", "Retranslate this caption");
  if (!ctx.idle && view.url) dropClip(view);
}

// ---------- Empty states ----------
function emptyContent(state) {
  if (!getToken()) return ["token", "Missing session token", "Open the launch URL from the terminal again so this page can sign in."];
  if (!state) return store.error
    ? ["offline", "Can’t reach the local server", `${store.error} Check that Meeting Assistant is still running, then reload this page.`]
    : ["connecting", "Connecting…", "Waiting for the local Meeting Assistant server."];
  if (!state.model_ready) {
    const failed = /fail/i.test(state.model_status || "");
    return failed
      ? ["failed", "Models couldn’t load", `${state.model_status} Check the local model setup and dependencies, then restart the app.`]
      : ["loading", "Models are loading", `${state.model_status || "Loading models locally…"} They load in the background from local files and are never downloaded by this app. Recording unlocks when they are ready.`];
  }
  if (state.recording_state === "starting") return ["starting", "Starting capture", "Waiting for capture startup and macOS permission. Audio is not confirmed yet."];
  if (state.recording_state === "recording" || state.recording_state === "draining") {
    return state.no_audio
      ? ["silent", "No audio yet", "No audio signal detected for 8 seconds. Check the selected source, permissions and input/output routing."]
      : ["listening", "Listening for speech", "Captions appear here a moment after each phrase. English first, the Chinese source beneath."];
  }
  if (state.session) return ["no-captions", "This session has no captions", "It was saved without any recognised speech."];
  return ["idle", "No session open", "Choose Teams, System or Microphone, then press Record. Or open a saved session from the sidebar."];
}

function renderEmpty(state) {
  const [key, title, body] = views.size ? ["", "", ""] : emptyContent(state);
  emptyBox.hidden = !key;
  if (key === emptyKey) return;
  emptyKey = key;
  if (!key) return;
  emptyBox.dataset.kind = key;
  emptyBox.replaceChildren(el("h2", { class: "cap-empty-title" }, title), el("p", { class: "cap-empty-body" }, body));
}

// ---------- Announcements (finished captions only, never partial updates) ----------
function announce(text) {
  announceQueue.push(text);
  if (announceTimer) return;
  announceTimer = setTimeout(() => {
    announceTimer = 0;
    announcer.textContent = "";
    const joined = announceQueue.join(" ");
    announceQueue = [];
    requestAnimationFrame(() => { announcer.textContent = joined; });
  }, 400);
}

// ---------- Rendering ----------
function render(state, changed) {
  if (!scroller) return;
  const segments = store.segments();
  const key = state?.session?.id ?? state?.session_id ?? null;
  if (key !== sessionKey) {
    for (const view of views.values()) { dropClip(view); view.article.remove(); }
    views.clear();
    syncEditing();
    sessionKey = key;
    seeded = false;
    stick = state?.recording_state && state.recording_state !== "idle";
    scroller.scrollTop = stick ? scroller.scrollHeight : 0;
  }
  const idle = (state?.recording_state || "idle") === "idle";
  const recordingNow = !idle;
  const ctx = (segment) => ({
    sessionId: state?.session?.id || null, idle, modelReady: Boolean(state?.model_ready), jobActive: store.jobActive(),
    speaker: speakerText(state, segment.speaker),
  });

  const ids = new Set(segments.map((s) => String(s.id)));
  for (const [id, view] of views) {
    if (!ids.has(id) && !view.editing) { dropClip(view); view.article.remove(); views.delete(id); }
  }
  let cursor = list.firstChild;
  for (const segment of segments) {
    const id = String(segment.id);
    let view = views.get(id);
    const isNew = !view;
    if (isNew) { view = createView(segment); views.set(id, view); }
    const previous = view.status;
    // Keep DOM order equal to segment order without touching nodes that are already in place.
    if (view.article !== cursor) list.insertBefore(view.article, cursor); else cursor = cursor.nextSibling;
    patch(view, segment, ctx(segment));
    const status = segment.status || "complete";
    view.status = status;
    if (status === "complete" && segment.english && seeded && recordingNow && (isNew || (previous && previous !== "complete"))) announce(segment.english);
  }
  seeded = true;
  noteBox.hidden = views.size === 0;
  renderEmpty(state);
  updateJump();
  if (stick) scrollToEnd();
}

// ---------- Scrolling ----------
function atBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; }
function scrollToEnd() { scroller.scrollTop = scroller.scrollHeight; }
function updateJump() {
  const show = views.size > 0 && !stick && !atBottom();
  jump.hidden = !show;
  const recording = (store.state?.recording_state || "idle") !== "idle";
  setText(jump.querySelector("span"), recording ? "Jump to live" : "Jump to end");
}

export function mountTranscript() {
  scroller = $("captions"); list = $("caption-list"); emptyBox = $("caption-empty");
  jump = $("jump-live"); announcer = $("announcer"); noteBox = $("caption-note");
  scroller.addEventListener("scroll", () => { stick = atBottom(); updateJump(); }, { passive: true });
  jump.addEventListener("click", () => { stick = true; scrollToEnd(); updateJump(); scroller.focus({ preventScroll: true }); });
  new ResizeObserver(() => { if (stick) scrollToEnd(); }).observe(list);
  store.subscribe(render);
  render(store.state, new Set(["state"]));
}
