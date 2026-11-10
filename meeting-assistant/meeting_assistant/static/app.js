"use strict";
const params = new URLSearchParams(location.search);
const token = params.get("token") || sessionStorage.getItem("meeting-assistant-token");
if (params.get("token")) sessionStorage.setItem("meeting-assistant-token", token);
history.replaceState(null, "", location.pathname);
const $ = id => document.getElementById(id);
let state = null, busy = false, pollInFlight = false;
let sessionId = null, lastRemoteScope = "";
const segmentViews = new Map();
const dirty = new Set();
let vocabSignature = "", speakerSignature = "", artifactSignature = "", sessionSignature = "";

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = String(text);
  if (className) el.className = className;
  return el;
}
function button(text, handler, className) {
  const el = node("button", text, className); el.type = "button"; el.addEventListener("click", handler); return el;
}
function field(label, value, type = "text") {
  const wrapper = node("label", label); const input = node("input"); input.type = type; input.value = value ?? ""; wrapper.append(input); return [wrapper, input];
}
function showMessage(text) { $("message").textContent = text; }
function updateSource() {
  const source = $("source").value;
  $("source-warning").hidden = source !== "system";
  $("source-hint").textContent = {
    teams: "Teams captures remote digital audio, not your microphone or voices in the room. Mac speaker volume can stay at 0; volume-zero capture is not yet verified on this Mac. Keep Teams computer audio connected.",
    system: "Captures all digital system output, not your microphone. Other apps and alerts can be included.",
    microphone: "Captures nearby voices, including your own, through the default macOS input. Speakers can stay silent. Choose the input in System Settings → Sound → Input. This does not directly capture muted Teams playback; only sound reaching the microphone is included."
  }[source];
}
async function api(path, body) {
  const options = {headers: {Authorization: `Bearer ${token}`}, cache: "no-store"};
  if (body !== undefined) { options.method = "POST"; options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(body); }
  const response = await fetch(path, options);
  let data; try { data = await response.json(); } catch (_) { throw new Error(`Request failed (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  return data;
}
async function action(path, body, success) {
  if (busy) return false;
  busy = true; updateControls(); showMessage("");
  try { const result = await api(path, body); if (success) success(result); return true; }
  catch (error) { showMessage(error.message); return false; }
  finally { busy = false; await refresh(); }
}
function jobActive() { return ["running", "cancelling"].includes(state?.job?.status); }
function idle() { return (state?.recording_state || "idle") === "idle" && !jobActive() && !state?.pending_work; }
function currentSegments() { return state?.session?.segments || state?.segments || []; }
function updateControls() {
  document.querySelectorAll("input, textarea, select").forEach(input => { input.disabled = busy; });
  const recording = state?.recording_state || "idle", selected = !!state?.session;
  $("start").disabled = busy || jobActive() || !state?.model_ready || recording !== "idle" || !$("consent").checked;
  $("stop").disabled = busy || !["starting", "recording"].includes(recording);
  $("translate").disabled = busy || jobActive() || !state?.model_ready || recording === "draining";
  $("source").disabled = busy || recording !== "idle"; $("consent").disabled = busy || recording !== "idle";
  $("session-open").disabled = busy || !idle() || !$("session-select").value;
  $("session-delete").disabled = busy || !idle() || !$("session-select").value;
  $("job-cancel").disabled = busy || !jobActive() || state?.job?.status === "cancelling";
  document.querySelectorAll("[data-task]").forEach(el => {
    const task = el.dataset.task, remote = ["review", "summary", "learning"].includes(task);
    el.disabled = busy || !selected || !idle() || (task === "refine" && !state?.model_ready) || (task === "diarize" && (!state?.diarization?.ready || state?.session?.attribution_unreliable)) || (remote && (!$("remote-confirm").checked || dirty.has("gateway") || dirty.has("context") || dirty.has("speakers") || [...segmentViews.values()].some(v => v.editing)));
  });
  document.querySelectorAll("[data-export]").forEach(el => { el.disabled = busy || !selected; });
  $("speakers-save").disabled = busy || !selected || jobActive();
  $("attribution-unreliable").disabled = busy || !selected || jobActive();
  $("context-save").disabled = busy || jobActive();
  $("gateway-save").disabled = busy || jobActive();
  if (dirty.has("context") || dirty.has("vocabulary")) {
    $("start").disabled = true;
    document.querySelectorAll("[data-task]").forEach(el => { el.disabled = true; });
  }
}
function formatTime(s) {
  return Number.isFinite(s.start) && Number.isFinite(s.end) ? `${s.start.toFixed(1)}–${s.end.toFixed(1)} s` : "Manual text / time unknown";
}
function speakerOptions(select, selected) {
  const labels = new Set(["unknown", ...Array.from({length: 8}, (_, i) => `speaker_${i + 1}`), ...Object.keys(state?.session?.speaker_names || {}), ...currentSegments().map(s => s.speaker || "unknown"), selected || "unknown"]);
  select.replaceChildren();
  for (const label of labels) { const opt = node("option", label === "unknown" ? "Unknown" : `${label}${state?.session?.speaker_names?.[label] ? ` — ${state.session.speaker_names[label]}` : ""}`); opt.value = label; select.append(opt); }
  select.value = selected || "unknown";
}
function createSegment(segment) {
  const item = node("article", null, "segment");
  const display = node("div"), editor = node("div", null, "segment-editor"); editor.hidden = true;
  const time = node("time"), badge = node("span", null, "badge"), source = node("p", null, "source-text"), english = node("p", null, "english"), meta = node("p", null, "hint"), error = node("p", null, "warning");
  const controls = node("div", null, "buttons"); const historyBox = node("div", null, "history"); historyBox.hidden = true;
  const audioBox = node("div", null, "audio-box");
  const edit = button("Edit", () => beginEdit(view));
  const historyButton = button("Original & history", () => showHistory(view));
  const play = button("Load audio clip", () => loadAudio(view));
  const retranslate = button("Retranslate", () => action("/api/segment/retranslate", {id: view.segment.id, session_id: state.session.id}));
  controls.append(edit, historyButton, play, retranslate); display.append(time, badge, meta, source, english, error, controls, historyBox, audioBox);
  const textLabel = node("label", "Corrected source text"); const text = node("textarea"); text.rows = 4; text.maxLength = 5000; textLabel.append(text);
  const speakerLabel = node("label", "Speaker cluster"); const speaker = node("select"); speakerLabel.append(speaker);
  const addLabel = node("label", null, "consent"); const add = node("input"); add.type = "checkbox"; addLabel.append(add, document.createTextNode(" Add corrected term to vocabulary"));
  const [termLabel, term] = field("Corrected term (must appear in corrected text)", ""); term.maxLength = 100;
  const [translationLabel, translation] = field("Preferred English rendering (optional)", ""); translation.maxLength = 200;
  const editControls = node("div", null, "buttons");
  const save = button("Save edit", () => {
    const body = {id: view.segment.id, text: text.value, expected_revision: view.editRevision, speaker: speaker.value, session_id: view.editSession};
    if (add.checked) { if (!term.value.trim()) { showMessage("Enter a corrected vocabulary term or uncheck Add corrected term."); return; } body.vocabulary_term = term.value.trim(); body.vocabulary_translation = translation.value; }
    action("/api/segment/edit", body, () => { view.editing = false; editor.hidden = true; display.hidden = false; view.signature = ""; });
  });
  const cancel = button("Cancel", () => { view.editing = false; editor.hidden = true; display.hidden = false; view.signature = ""; renderSegments(currentSegments()); }, "secondary");
  editControls.append(save, cancel); editor.append(textLabel, speakerLabel, addLabel, termLabel, translationLabel, editControls);
  item.append(display, editor);
  const view = {item, display, editor, time, badge, source, english, meta, error, historyBox, audioBox, play, edit, retranslate, text, speaker, add, term, translation, segment, signature: "", editing: false, url: null};
  return view;
}
function beginEdit(view) {
  view.editing = true; view.editRevision = view.segment.revision; view.text.value = view.segment.traditional_text || "";
  view.editSession = state.session.id;
  speakerOptions(view.speaker, view.segment.speaker); view.add.checked = false; view.term.value = ""; view.translation.value = "";
  view.display.hidden = true; view.editor.hidden = false; $("remote-confirm").checked = false; updateControls(); view.text.focus();
}
async function showHistory(view) {
  if (!view.historyBox.hidden) { view.historyBox.hidden = true; return; }
  view.historyBox.hidden = false; view.historyBox.replaceChildren(node("p", "Loading history…", "hint"));
  try {
    const result = await api(`/api/history?${new URLSearchParams({segment_id: view.segment.id, session_id: state.session.id})}`);
    view.historyBox.replaceChildren(node("h4", "Original recognition"), node("p", view.segment.raw_text || "(empty)"), node("h4", "Revision history"));
    if (!result.history?.length) view.historyBox.append(node("p", "No revision history available.", "hint"));
    for (const entry of result.history || []) view.historyBox.append(node("pre", JSON.stringify(entry, null, 2)));
  } catch (e) { view.historyBox.replaceChildren(node("p", e.message, "warning")); }
}
async function loadAudio(view) {
  const s = view.segment;
  if (state?.recording_state !== "idle" || !state?.session?.id || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) return;
  const clipSession = state.session.id;
  const end = Math.min(s.end, s.start + 60);
  view.audioBox.replaceChildren(node("p", "Loading authenticated audio clip…", "hint"));
  try {
    const query = new URLSearchParams({session_id: state.session.id, start: s.start, end});
    const response = await fetch(`/api/audio?${query}`, {headers: {Authorization: `Bearer ${token}`}, cache: "no-store"});
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || "Audio unavailable"); }
    const blob = await response.blob(); if (state?.recording_state !== "idle" || state?.session?.id !== clipSession || busy) { view.audioBox.replaceChildren(); return; } if (view.url) URL.revokeObjectURL(view.url); view.url = URL.createObjectURL(blob);
    const audio = node("audio"); audio.controls = true; audio.src = view.url;
    view.audioBox.replaceChildren(audio);
    if (end < s.end) view.audioBox.append(node("p", "Clip limited to the first 60 seconds.", "hint"));
  } catch (e) { view.audioBox.replaceChildren(node("p", e.message, "warning")); }
}
function renderSegments(segments) {
  const box = $("segments"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 50;
  if (!segmentViews.size && !$("segments-empty")) box.replaceChildren();
  const ids = new Set(segments.map(s => String(s.id)));
  for (const [id, view] of segmentViews) if (!ids.has(id) && !view.editing) { if (view.url) URL.revokeObjectURL(view.url); view.item.remove(); segmentViews.delete(id); }
  const empty = $("segments-empty"); if (empty) empty.remove();
  if (!segments.length && !segmentViews.size) { const p = node("p", "Captions will appear here.", "hint"); p.id = "segments-empty"; box.append(p); }
  for (const segment of segments) {
    const id = String(segment.id); let view = segmentViews.get(id);
    if (!view) { view = createSegment(segment); segmentViews.set(id, view); box.append(view.item); }
    view.segment = segment;
    if (state?.recording_state !== "idle" && view.url) { URL.revokeObjectURL(view.url); view.url = null; view.audioBox.replaceChildren(); }
    const signature = JSON.stringify([segment, state?.session?.speaker_names, state?.recording_state, state?.model_ready, state?.job?.status]);
    if (signature === view.signature || view.editing || view.item.contains(document.activeElement)) continue;
    view.signature = signature;
    view.time.textContent = formatTime(segment);
    view.badge.textContent = `Revision ${segment.revision ?? "unknown"} · ${segment.edited || segment.revision > 1 ? "edited" : "original"}`;
    const speaker = segment.speaker || "unknown", name = state?.session?.speaker_names?.[speaker];
    view.meta.textContent = `Speaker: ${speaker}${name ? ` — ${name}` : ""} · Status: ${segment.status || "unknown"}`;
    view.source.textContent = segment.traditional_text || "(No source text)";
    view.english.textContent = segment.english || (segment.status === "translating" ? "Translating locally…" : "English translation unavailable.");
    view.error.hidden = !segment.error; view.error.textContent = segment.error ? `Inference failed: ${segment.error}` : "";
    view.play.disabled = !state?.session || state.recording_state !== "idle" || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start;
    view.edit.disabled = !state?.session || segment.revision == null;
    view.retranslate.disabled = !state?.session || !state?.model_ready || jobActive();
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function renderSessions() {
  const sessions = state?.sessions || [], signature = JSON.stringify(sessions);
  const select = $("session-select");
  if (signature !== sessionSignature && document.activeElement !== select) {
    const selected = select.value || state?.session?.id || ""; select.replaceChildren();
    if (!sessions.length) { const opt = node("option", "No sessions available"); opt.value = ""; select.append(opt); }
    else for (const session of sessions) { const opt = node("option", `${session.created_at || "Date unknown"} · ${session.source || "unknown"} · ${session.id}`); opt.value = session.id; select.append(opt); }
    if ([...select.options].some(o => o.value === selected)) select.value = selected;
    sessionSignature = signature;
  }
  const s = state?.session;
  $("attribution-unreliable").checked = !!s?.attribution_unreliable;
  $("session-info").textContent = s ? `Open: ${s.id} · ${s.status || "unknown"} · version ${s.version ?? "unknown"}` : "No session open.";
}
function renderSettings() {
  const settings = state?.settings; if (!settings) return;
  if (!dirty.has("context") && document.activeElement !== $("meeting-context")) $("meeting-context").value = state?.session?.context ?? settings.meeting_context ?? "";
  if (!dirty.has("gateway")) { if (document.activeElement !== $("gateway-endpoint")) $("gateway-endpoint").value = settings.gateway?.endpoint || ""; if (document.activeElement !== $("gateway-model")) $("gateway-model").value = settings.gateway?.model || ""; }
  renderVocabulary(settings.vocabulary || []);
}
function renderVocabulary(vocab) {
  const box = $("vocabulary-list"), signature = JSON.stringify(vocab);
  if (signature === vocabSignature || dirty.has("vocabulary") || box.contains(document.activeElement)) return;
  vocabSignature = signature; box.replaceChildren();
  if (!vocab.length) box.append(node("p", "No vocabulary saved.", "hint"));
  for (const entry of vocab) {
    const row = node("div", null, "vocab-row"); row.dataset.vocabId = entry.id;
    const [tl, term] = field("Term", entry.term), [xl, translation] = field("Preferred English", entry.translation), [nl, note] = field("Note", entry.note);
    const enabledLabel = node("label", null, "check"); const enabled = node("input"); enabled.type = "checkbox"; enabled.checked = !!entry.enabled; enabledLabel.append(enabled, document.createTextNode(" Enabled"));
    const knownLabel = node("label", null, "check"); const known = node("input"); known.type = "checkbox"; known.checked = !!entry.known; knownLabel.append(known, document.createTextNode(" Known"));
    for (const input of [term, translation, note, enabled, known]) input.addEventListener("input", () => { dirty.add("vocabulary"); updateControls(); });
    const save = button("Save vocabulary edits", () => {
      const updated = (state?.settings?.vocabulary || []).map(v => {
        const draft = [...box.querySelectorAll(".vocab-row")].find(r => r.dataset.vocabId === v.id);
        if (!draft) return v;
        const inputs = draft.querySelectorAll("input");
        return {...v, term: inputs[0].value, translation: inputs[1].value, note: inputs[2].value, enabled: inputs[3].checked, known: inputs[4].checked};
      });
      action("/api/settings", {vocabulary: updated}, () => { dirty.delete("vocabulary"); vocabSignature = ""; });
    });
    const cancel = button("Cancel vocabulary edits", () => { if (dirty.has("vocabulary") && !confirm("Discard all vocabulary edits?")) return; dirty.delete("vocabulary"); vocabSignature = ""; document.activeElement.blur(); renderVocabulary(state?.settings?.vocabulary || []); }, "secondary");
    const remove = button("Delete", () => { if (dirty.has("vocabulary")) { showMessage("Save or cancel vocabulary edits before deleting a term."); return; } if (confirm(`Delete vocabulary term “${entry.term}”?`)) action("/api/vocabulary/delete", {id: entry.id}, () => { vocabSignature = ""; }); }, "danger");
    row.append(tl, xl, nl, enabledLabel, knownLabel, save, cancel, remove); box.append(row);
  }
}
function renderSpeakers() {
  const box = $("speaker-names"), names = state?.session?.speaker_names || {};
  const labels = [...new Set([...Object.keys(names), ...currentSegments().map(s => s.speaker || "unknown")])].filter(s => s !== "unknown").sort();
  const signature = JSON.stringify([labels, names, state?.session?.id]);
  if (signature === speakerSignature || dirty.has("speakers") || box.contains(document.activeElement)) return;
  speakerSignature = signature; box.replaceChildren();
  if (!labels.length) box.append(node("p", "No speaker clusters available yet.", "hint"));
  for (const label of labels) { const [wrapper, input] = field(label, names[label] || ""); input.dataset.speaker = label; input.addEventListener("input", () => { dirty.add("speakers"); $("remote-confirm").checked = false; updateControls(); }); box.append(wrapper); }
}
function evidence(container, list) {
  for (const ev of list || []) container.append(node("p", `Segment ${ev.segment_id ?? "unknown"}: “${ev.quote || ""}”`, "evidence"));
}
function copyCandidate(text) {
  if (!navigator.clipboard?.writeText) { showMessage("Clipboard unavailable. Select and copy the candidate text manually."); return; }
  navigator.clipboard.writeText(text).then(() => showMessage("Candidate copied. Paste it into the appropriate segment editor and review."), e => showMessage(`Clipboard unavailable: ${e.message}`));
}
function renderArtifacts() {
  const box = $("artifacts"), artifacts = state?.session?.artifacts || [];
  const signature = JSON.stringify([artifacts, state?.session?.version, state?.settings?.vocabulary, state?.recording_state, state?.job?.status, state?.pending_work]);
  if (signature === artifactSignature) return;
  artifactSignature = signature; box.replaceChildren();
  if (!artifacts.length) box.append(node("p", "No results available.", "hint"));
  for (const artifact of artifacts) {
    const wrap = node("article", null, "artifact"), data = artifact.data || {};
    const stale = !!artifact.stale || artifact.source_version !== state.session.version;
    const notReady = artifact.status !== "ready" || (data.status && data.status !== "ready");
    wrap.append(node("h3", `${artifact.kind || "Unknown result"} · ${stale ? "STALE" : (artifact.status || "status unknown")} · source version ${artifact.source_version ?? "unknown"}`));
    if (data.status) wrap.append(node("p", `Result status: ${data.status}`, "hint"));
    if (stale) wrap.append(node("p", "The session changed since this result was generated. Re-run the job before applying.", "warning"));
    if (notReady) wrap.append(node("p", "This result is not ready; applying is disabled.", "warning"));
    for (const limitation of data.limitations || []) wrap.append(node("p", limitation, "hint"));
    if (artifact.kind === "review") for (const [index, proposal] of (data.proposals || []).entries()) {
      const p = node("div", null, "proposal"); p.append(node("strong", `Segment ${proposal.segment_id}`), node("p", `Original: ${proposal.original || ""}`), node("p", `Proposed: ${proposal.replacement || ""}`), node("p", `Evidence: “${proposal.quote || ""}”`), node("p", `Reason: ${proposal.reason || "unknown"} · Uncertainty: ${proposal.uncertainty || "unknown"}`, "hint"));
      const apply = button("Approve this proposal", () => action("/api/artifact/apply", {artifact_id: artifact.id, proposal_index: index, expected_version: artifact.source_version})); apply.disabled = stale || notReady || !idle(); p.append(apply); wrap.append(p);
    }
    if (artifact.kind === "refine") {
      wrap.append(node("p", "Candidates use different audio windows and cannot be applied automatically. Copy a candidate into the appropriate segment editor after review.", "hint"));
      for (const candidate of data.segments || []) { const p = node("div", null, "proposal"); p.append(node("strong", formatTime(candidate)), node("p", candidate.traditional_text || ""), node("p", candidate.english || "", "english"), button("Copy candidate", () => copyCandidate(candidate.traditional_text || ""))); wrap.append(p); }
    }
    if (artifact.kind === "diarize") {
      const timeline = data.timeline || []; wrap.append(node("p", `${timeline.length} speaker intervals. Assignments are approximate, not verified identities.`, "hint"));
      for (const interval of timeline) wrap.append(node("p", `${formatTime(interval)} · ${interval.speaker || "unknown"}`, "evidence"));
      const apply = button("Apply speaker assignments", () => action("/api/artifact/apply", {artifact_id: artifact.id, expected_version: artifact.source_version})); apply.disabled = stale || notReady || !idle(); wrap.append(apply);
    }
    if (artifact.kind === "summary") for (const key of ["overview", "decisions", "actions", "people"]) {
      wrap.append(node("h4", key)); if (!data[key]?.length) wrap.append(node("p", "None available.", "hint"));
      for (const entry of data[key] || []) { const p = node("div", null, "proposal"); p.append(node("p", `${entry.speaker ? `${entry.speaker}: ` : ""}${entry.text || entry.summary || ""}`)); if (key === "actions") p.append(node("p", `Status: ${entry.status || "unknown"} · Owner: ${entry.owner || "unknown"} · Deadline: ${entry.deadline || "unknown"}`, "hint")); evidence(p, entry.evidence); wrap.append(p); }
    }
    if (artifact.kind === "learning") renderLearning(wrap, data.items || []);
    box.append(wrap);
  }
}
function renderLearning(wrap, items) {
  if (!items.length) { wrap.append(node("p", "No learning items available.", "hint")); return; }
  const scroller = node("div", null, "table-scroll"), table = node("table"), head = node("tr");
  for (const title of ["Traditional term", "Pinyin", "Contextual meaning", "Evidence / time", "Vocabulary"]) head.append(node("th", title));
  const thead = node("thead"); thead.append(head); const body = node("tbody");
  for (const item of items) {
    const tr = node("tr"); tr.append(node("td", item.term || "unknown")); const reading = node("td", item.pinyin || "unknown"); reading.append(node("p", `${item.validation_status || "validation unknown"} · ${item.dictionary_provenance || "provenance unknown"}`, "hint")); tr.append(reading, node("td", item.meaning || "unknown"));
    if (item.validation_flags?.length) reading.append(node("p", item.validation_flags.join(" · "), "hint"));
    const segment = currentSegments().find(s => s.id === item.segment_id);
    tr.append(node("td", `Segment ${item.segment_id ?? "unknown"} · ${segment ? formatTime(segment) : "time unknown"}\n“${item.quote || ""}”`));
    const controls = node("td"), existing = (state?.settings?.vocabulary || []).find(v => v.term === item.term);
    if (existing) {
      controls.append(node("span", existing.known ? "Known" : "In vocabulary"));
      const mark = button(existing.known ? "Mark not known" : "Mark known", () => { if (dirty.has("vocabulary")) { showMessage("Save or cancel vocabulary edits first."); return; } const vocab = state.settings.vocabulary.map(v => v.id === existing.id ? {...v, known: !v.known} : v); action("/api/settings", {vocabulary: vocab}); }); controls.append(mark);
    } else controls.append(button("Add to vocabulary", () => action("/api/vocabulary", {term: item.term, translation: item.meaning || "", note: "Added from learning results"})));
    tr.append(controls); body.append(tr);
  }
  table.append(thead, body); scroller.append(table); wrap.append(scroller);
}
async function refresh() {
  if (!token) { $("model").textContent = "Missing session token. Open the launch URL again."; return; }
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const next = await api("/api/state");
    if ((next.session?.id || null) !== sessionId) {
      for (const view of segmentViews.values()) { if (view.url) URL.revokeObjectURL(view.url); view.item.remove(); }
      segmentViews.clear(); sessionId = next.session?.id || null; speakerSignature = ""; artifactSignature = ""; dirty.delete("speakers"); dirty.delete("context");
    }
    state = next;
    const remoteScope = JSON.stringify([state.session?.id, state.session?.version, state.settings?.gateway]);
    if (remoteScope !== lastRemoteScope) { $("remote-confirm").checked = false; lastRemoteScope = remoteScope; }
    $("model").textContent = state.model_status || "Model status unknown";
    $("recording").textContent = {idle: "Idle", starting: "Starting — capture not yet confirmed", recording: "● Capture active", draining: "Finishing capture and queued captions…"}[state.recording_state] || "Recording state unknown";
    $("level").value = state.level || 0; $("capture-status").textContent = state.capture_status || "Capture status unknown";
    $("feed-status").textContent = `Received: ${(state.audio_seconds || 0).toFixed(1)} seconds of audio · ${state.feed_status || "feed status unknown"} · signal RMS: ${(state.level || 0).toFixed(4)}`;
    $("queue").textContent = `Queue: ${state.queue_length ?? "unknown"} · oldest work: ${state.queue_lag_seconds ?? "unknown"}s · skipped: ${state.dropped ?? "unknown"}`;
    $("no-audio").hidden = !state.no_audio; $("notice").hidden = !state.notice; $("notice").textContent = state.notice || "";
    $("launcher-hint").textContent = `This server appears to have been launched through ${state.launcher_name || "an unknown launcher"}. macOS determines the actual permission owner: enable the requesting app shown in System Settings, not Teams or this browser.`;
    if (state.notice && /permission|denied|3801/i.test(state.notice)) $("permissions").open = true;
    $("archive").textContent = state.session_path || state.archive_dir || "Location unknown";
    renderSessions(); renderSettings(); renderSegments(currentSegments()); renderSpeakers(); renderArtifacts();
    const cap = state.diarization; $("diarization-status").textContent = cap ? `Diarization: ${cap.ready ? "ready" : "not ready"}${cap.reason ? ` — ${cap.reason}` : ""}` : "Diarization availability unknown.";
    const job = state.job; $("job-status").textContent = job ? `${job.task || "Unknown task"} · ${job.status || "unknown"} · ${typeof job.progress === "object" ? JSON.stringify(job.progress) : (job.progress || "progress unknown")}${job.error ? ` · Error: ${job.error}` : ""}` : "No job running or reported.";
    const segments = currentSegments().filter(s => s.kind === "audio"); const chars = segments.reduce((n, s) => n + (s.traditional_text || "").length, 0);
    const usedLabels = new Set(segments.map(s => s.speaker || "unknown"));
    const names = state.session?.attribution_unreliable ? {} : Object.fromEntries(Object.entries(state.session?.speaker_names || {}).filter(([key, name]) => key !== "unknown" && usedLabels.has(key) && name));
    $("remote-preview").textContent = state.session ? `Send preview: ${segments.length} audio-derived segments, ${chars} reviewed source characters; session context ${String(state.session.context || "").length} characters (maximum 4,000); ${Object.keys(names).length} reviewed speaker names. Manual pasted translations are excluded. Source text may be sent in overlapping chunks. Gateway: ${state.settings?.gateway?.endpoint || "not configured"} · model: ${state.settings?.gateway?.model || "not configured"}.` : "Open a session to preview the text payload.";
    $("remote-preview-text").textContent = state.session ? JSON.stringify({context: state.session.context || "", speaker_names: names, segments: segments.filter(s => s.traditional_text).map(s => ({id: s.id, text: s.traditional_text, speaker: state.session.attribution_unreliable ? "unknown" : (s.speaker || "unknown")}))}, null, 2) : "No session open.";
    updateControls();
  } catch (error) { $("model").textContent = `Connection error: ${error.message}`; }
  finally { pollInFlight = false; }
}
function hasDrafts() { return dirty.size > 0 || [...segmentViews.values()].some(view => view.editing) || ["manual-text", "vocab-term", "vocab-translation", "vocab-note"].some(id => $(id).value); }
$("source").addEventListener("change", () => { $("consent").checked = false; updateSource(); updateControls(); });
$("consent").addEventListener("change", updateControls);
$("start").addEventListener("click", () => { if (dirty.has("context") || dirty.has("vocabulary")) { showMessage("Save your meeting context and vocabulary before starting capture."); return; } if (hasDrafts() && !confirm("Starting a new session may discard open transcript editors. Continue?")) return; for (const view of segmentViews.values()) { view.audioBox.querySelectorAll("audio").forEach(audio => audio.pause()); view.audioBox.replaceChildren(); if (view.url) { URL.revokeObjectURL(view.url); view.url = null; } } action("/api/start", {source: $("source").value, consent: $("consent").checked}); });
$("stop").addEventListener("click", () => action("/api/stop", {}));
$("translate").addEventListener("click", () => action("/api/manual", {text: $("manual-text").value}, () => { $("manual-text").value = ""; }));
$("save").addEventListener("click", () => action("/api/save", {}, result => showMessage(`Saved to ${result.path}`)));
$("caption-mode").addEventListener("click", () => { const focused = document.body.classList.toggle("caption-mode"); $("caption-mode").setAttribute("aria-pressed", String(focused)); $("caption-mode").textContent = focused ? "Show full controls" : "Focus captions"; });
$("session-select").addEventListener("change", updateControls);
$("session-open").addEventListener("click", () => { if (hasDrafts() && !confirm("Opening another session discards open transcript, context and speaker editors. Continue?")) return; action("/api/session/open", {session_id: $("session-select").value}); });
$("session-delete").addEventListener("click", () => { const id = $("session-select").value; if (id && confirm(`Permanently delete session ${id}, its app-owned audio, revisions and exports? Backups and external copies remain.`)) action("/api/session/delete", {session_id: id, confirm: true}); });
$("meeting-context").addEventListener("input", () => { dirty.add("context"); $("remote-confirm").checked = false; updateControls(); });
$("context-technical").addEventListener("click", () => { if ($("meeting-context").value && !confirm("Replace the context draft with the technical meeting example?")) return; $("meeting-context").value = "Technical meeting discussing software development, architecture, infrastructure, incidents, and project decisions."; dirty.add("context"); $("remote-confirm").checked = false; updateControls(); });
$("context-save").addEventListener("click", () => action("/api/settings", {meeting_context: $("meeting-context").value}, () => { dirty.delete("context"); showMessage("Context saved. Session-derived results may now be stale."); }));
$("vocabulary-form").addEventListener("submit", event => { event.preventDefault(); action("/api/vocabulary", {term: $("vocab-term").value, translation: $("vocab-translation").value, note: $("vocab-note").value}, () => { $("vocabulary-form").reset(); }); });
for (const id of ["gateway-endpoint", "gateway-model"]) $(id).addEventListener("input", () => { dirty.add("gateway"); $("remote-confirm").checked = false; updateControls(); });
$("gateway-save").addEventListener("click", () => action("/api/settings", {gateway: {endpoint: $("gateway-endpoint").value, model: $("gateway-model").value}}, () => { dirty.delete("gateway"); $("remote-confirm").checked = false; showMessage("Gateway settings saved; the API key was not stored."); }));
$("speakers-save").addEventListener("click", () => { const names = {}; $("speaker-names").querySelectorAll("[data-speaker]").forEach(input => { if (input.value.trim()) names[input.dataset.speaker] = input.value.trim(); }); action("/api/speakers", {names, session_id: state.session.id}, () => { dirty.delete("speakers"); speakerSignature = ""; }); });
$("speakers-cancel").addEventListener("click", () => { dirty.delete("speakers"); speakerSignature = ""; renderSpeakers(); updateControls(); });
$("attribution-unreliable").addEventListener("change", () => { $("remote-confirm").checked = false; action("/api/attribution", {unreliable: $("attribution-unreliable").checked, session_id: state.session.id}); });
$("remote-confirm").addEventListener("change", updateControls);
document.querySelectorAll("[data-task]").forEach(el => el.addEventListener("click", () => {
  const task = el.dataset.task, remote = ["review", "summary", "learning"].includes(task), body = {task, session_id: state.session.id, expected_version: state.session.version};
  if (remote) { if (!$("remote-confirm").checked || dirty.has("gateway") || dirty.has("context") || dirty.has("speakers") || [...segmentViews.values()].some(v => v.editing)) return; body.confirm_send = true; body.expected_gateway = state.settings.gateway; if ($("gateway-key").value) body.api_key = $("gateway-key").value; }
  action("/api/job/start", body, () => { if (remote) $("remote-confirm").checked = false; });
}));
$("job-cancel").addEventListener("click", () => action("/api/job/cancel", {}));
document.querySelectorAll("[data-export]").forEach(el => el.addEventListener("click", () => action("/api/export", {format: el.dataset.export}, result => { $("export-status").textContent = `Saved to ${result.path}`; })));
updateSource(); refresh(); setInterval(refresh, 1000);
window.addEventListener("beforeunload", event => { if ((state?.recording_state && state.recording_state !== "idle") || hasDrafts()) { event.preventDefault(); event.returnValue = ""; } });
