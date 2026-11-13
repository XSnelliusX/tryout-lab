// The caption stream: keyed per-segment views, patched in place. English leads, Chinese source beneath.
import { el, icon, toast } from "/glass.js";
import { api, action, getToken } from "/api.js";
import { createPinyinControl, segmentWords, applyWordHighlight } from "/pinyin-ui.js";
import { store } from "/store.js";
import { $, setText, setUnavailable, onPress, formatRange, speakerText } from "/ui.js";

const views = new Map();
let scroller, list, emptyBox, jump, announcer, noteBox;
let stick = true, sessionKey, seeded = false, emptyKey = "";
let announceQueue = [], announceTimer = 0;

const LIVE_EDGE = new Set(["provisional", "translating"]);
const HAN_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const MAJOR_PAUSE_RE = /[。．.！？!?]/;
const MINOR_PAUSE_RE = /[，,、；;：:]/;

// ---------- Word highlighting & WAV speech timeline ----------
export function buildWordIntervals(text) {
  const segments = segmentWords(text);
  const weighted = [];
  let total = 0;
  for (const seg of segments) {
    let weight = 0;
    if (seg.speakable) {
      const hanCount = (seg.text.match(HAN_CHAR_RE) || []).length;
      const nonHanLen = seg.text.replace(HAN_CHAR_RE, "").trim().length;
      const nonHanSyllables = nonHanLen ? Math.max(1, Math.min(6, Math.ceil(nonHanLen / 3))) : 0;
      weight = hanCount + nonHanSyllables;
    } else if (MAJOR_PAUSE_RE.test(seg.text)) {
      weight = 0.55;
    } else if (MINOR_PAUSE_RE.test(seg.text)) {
      weight = 0.35;
    } else if (/\s/.test(seg.text)) {
      weight = 0.05;
    }
    if (weight <= 0) continue;
    weighted.push({ wordIndex: seg.wordIndex, weight });
    total += weight;
  }
  if (total <= 0) return [];
  const intervals = [];
  let acc = 0;
  for (const item of weighted) {
    const start = acc / total;
    acc += item.weight;
    const end = acc / total;
    if (item.wordIndex >= 0) intervals.push({ wordIndex: item.wordIndex, start, end });
  }
  return intervals;
}

function readAscii(view, offset, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

export function buildSpeechTimelineFromWav(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") return null;

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  let pos = 12;
  while (pos + 8 <= buffer.byteLength) {
    const id = readAscii(view, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= buffer.byteLength) {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = Math.min(size, Math.max(0, buffer.byteLength - body));
      break;
    }
    pos = body + size + (size & 1);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate <= 0 || dataOffset < 0 || dataBytes < 2) {
    return null;
  }

  const bytesPerFrameSample = channels * 2;
  const totalSamples = Math.floor(dataBytes / bytesPerFrameSample);
  if (totalSamples < 1) return null;
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.025));
  const numFrames = Math.max(1, Math.ceil(totalSamples / frameSize));
  const rms = new Float64Array(numFrames);

  let peakRms = 0;
  for (let f = 0; f < numFrames; f += 1) {
    const startSample = f * frameSize;
    const endSample = Math.min(totalSamples, startSample + frameSize);
    const count = endSample - startSample;
    let sumSq = 0;
    for (let s = startSample; s < endSample; s += 1) {
      let mono = 0;
      const base = dataOffset + s * bytesPerFrameSample;
      for (let ch = 0; ch < channels; ch += 1) {
        mono += view.getInt16(base + ch * 2, true) / 32768;
      }
      mono /= channels;
      sumSq += mono * mono;
    }
    const val = Math.sqrt(sumSq / count);
    rms[f] = val;
    if (val > peakRms) peakRms = val;
  }

  if (peakRms < 0.002) return null;
  const sorted = Float64Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.15)] || 0;
  const threshold = floor * 1.15;

  const cdf = new Float64Array(numFrames + 1);
  let totalEnergy = 0;
  for (let f = 0; f < numFrames; f += 1) {
    const voiced = Math.max(0, rms[f] - threshold);
    const weight = voiced > 0 ? Math.pow(voiced, 0.75) : 0;
    totalEnergy += weight;
    cdf[f + 1] = totalEnergy;
  }
  if (totalEnergy <= 0) return null;
  for (let i = 1; i <= numFrames; i += 1) cdf[i] /= totalEnergy;
  return { cdf, numFrames };
}

export function wordIndexForTime(currentTime, duration, intervals, timeline) {
  if (!Array.isArray(intervals) || !intervals.length) return -1;
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return -1;
  const u = Math.max(0, Math.min(1, currentTime / duration));
  if (u <= 0 || u >= 0.999) return -1;

  let progress = u;
  if (timeline?.cdf && timeline.numFrames > 0) {
    const pos = u * timeline.numFrames;
    const idx = Math.min(timeline.numFrames - 1, Math.floor(pos));
    const frac = pos - idx;
    progress = timeline.cdf[idx] + (timeline.cdf[idx + 1] - timeline.cdf[idx]) * frac;
  }
  if (progress <= 0.0005 || progress >= 0.9995) return -1;
  for (const interval of intervals) {
    if (progress >= interval.start && progress < interval.end) return interval.wordIndex;
  }
  return -1;
}

function renderZhWords(zhNode, text, activeWordIndex = -1) {
  if (!text) {
    zhNode.replaceChildren();
    return;
  }
  const nodes = [];
  for (const seg of segmentWords(text)) {
    if (seg.speakable) {
      nodes.push(el("span", {
        class: "cap-zh-word",
        dataset: { wordIdx: String(seg.wordIndex) },
      }, seg.text));
    } else {
      nodes.push(seg.text);
    }
  }
  zhNode.replaceChildren(...nodes);
  if (activeWordIndex >= 0) applyWordHighlight(zhNode, activeWordIndex);
}

function setActiveWordHighlight(view, wordIndex) {
  const next = Number.isInteger(wordIndex) ? wordIndex : -1;
  if (view.activeWordIndex === next) return;
  view.activeWordIndex = next;
  applyWordHighlight(view.zh, next);
  view.pinyin.setActiveWord(next);
}

// ---------- Clips ----------
export function clearClips() {
  for (const view of views.values()) dropClip(view);
}

function stopClipHighlightLoop(view) {
  if (view.clipRaf) {
    cancelAnimationFrame(view.clipRaf);
    view.clipRaf = 0;
  }
}

function syncPlayButton(view, playing, loading = false) {
  if (!view.play) return;
  const active = Boolean(playing || loading);
  view.article.classList.toggle("is-playing", active);
  view.play.classList.toggle("is-playing", active);
  view.play.toggleAttribute("aria-busy", Boolean(loading));
  const iconName = playing ? "pause" : "play";
  if (view.playIcon !== iconName) {
    view.playIcon = iconName;
    view.play.replaceChildren(icon(iconName));
  }
  const label = playing ? "Pause audio clip" : "Play audio clip";
  if (view.play.getAttribute("aria-label") !== label) view.play.setAttribute("aria-label", label);
  if (view.play.getAttribute("aria-disabled") !== "true") {
    view.play.title = playing ? "Pause audio clip" : "Play audio clip (up to 60 seconds)";
  }
}

function pauseOtherClips(currentView) {
  for (const other of views.values()) {
    if (other === currentView) continue;
    if (other.audio && !other.audio.paused) other.audio.pause();
    else if (other.clipLoading) {
      other.clipRequest = (other.clipRequest || 0) + 1;
      other.clipLoading = false;
      syncPlayButton(other, false, false);
    }
  }
}

function dropClip(view) {
  view.clipRequest = (view.clipRequest || 0) + 1;
  view.clipLoading = false;
  stopClipHighlightLoop(view);
  setActiveWordHighlight(view, -1);
  if (view.audio) {
    view.audio.pause();
    view.audio.removeAttribute("src");
    view.audio = null;
  }
  view.clipRange = null;
  if (view.url) { URL.revokeObjectURL(view.url); view.url = null; }
  syncPlayButton(view, false, false);
}

async function playClip(view) {
  // If a clip fetch is currently in flight, clicking again cancels it.
  if (view.clipLoading) {
    view.clipRequest = (view.clipRequest || 0) + 1;
    view.clipLoading = false;
    syncPlayButton(view, false, false);
    return;
  }
  // Toggle play/pause directly on the already-loaded audio element.
  if (view.audio) {
    if (!view.audio.paused && !view.audio.ended) {
      view.audio.pause();
      return;
    }
    pauseOtherClips(view);
    if (view.audio.ended) view.audio.currentTime = 0;
    try {
      await view.audio.play();
    } catch (_) { /* ignore autoplay/playback interruption */ }
    return;
  }

  const s = view.segment, state = store.state;
  if (!state?.session?.id || state.recording_state !== "idle") return;
  if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) return;
  const sessionId = state.session.id;
  const end = Math.min(s.end, s.start + 60);
  const token = (view.clipRequest = (view.clipRequest || 0) + 1);

  pauseOtherClips(view);
  view.clipLoading = true;
  syncPlayButton(view, false, true);

  try {
    const query = new URLSearchParams({ session_id: sessionId, start: s.start, end });
    const response = await fetch(`/api/audio?${query}`, { headers: { Authorization: `Bearer ${getToken()}` }, cache: "no-store" });
    if (!response.ok) {
      let message = "Audio unavailable";
      try { message = (await response.json()).error || message; } catch (_) { /* keep default */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const timeline = buildSpeechTimelineFromWav(await blob.arrayBuffer());
    const now = store.state;
    if (token !== view.clipRequest || now?.recording_state !== "idle" || now?.session?.id !== sessionId || store.busy) {
      if (token === view.clipRequest) dropClip(view);
      return;
    }
    if (view.url) URL.revokeObjectURL(view.url);
    view.url = URL.createObjectURL(blob);
    view.clipRange = [s.start, s.end];
    const fallbackDuration = Math.max(0.05, end - s.start);
    const audio = new Audio(view.url);
    view.audio = audio;
    view.clipLoading = false;

    const updateHighlight = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration;
      const idx = audio.ended ? -1 : wordIndexForTime(audio.currentTime, duration, view.wordIntervals, timeline);
      setActiveWordHighlight(view, idx);
    };
    const tick = () => {
      view.clipRaf = 0;
      if (audio.paused || audio.ended || view.audio !== audio) return;
      updateHighlight();
      view.clipRaf = requestAnimationFrame(tick);
    };
    const startLoop = () => {
      syncPlayButton(view, true, false);
      updateHighlight();
      if (!view.clipRaf && !audio.paused && !audio.ended) {
        view.clipRaf = requestAnimationFrame(tick);
      }
    };

    audio.addEventListener("play", startLoop);
    audio.addEventListener("playing", startLoop);
    audio.addEventListener("timeupdate", updateHighlight);
    audio.addEventListener("seeked", updateHighlight);
    audio.addEventListener("pause", () => {
      stopClipHighlightLoop(view);
      syncPlayButton(view, false, false);
      if (audio.currentTime <= 0 || audio.ended) setActiveWordHighlight(view, -1);
      else updateHighlight();
    });
    audio.addEventListener("ended", () => {
      stopClipHighlightLoop(view);
      syncPlayButton(view, false, false);
      setActiveWordHighlight(view, -1);
    });
    audio.addEventListener("error", () => {
      dropClip(view);
      toast("Could not play this audio clip.", { kind: "error" });
    });

    if (end < s.end) {
      toast("Playing the first 60 seconds of this clip.", { kind: "info", timeout: 3000 });
    }
    await audio.play();
  } catch (error) {
    if (token !== view.clipRequest) return;
    dropClip(view);
    toast(error?.message || "Audio unavailable", { kind: "error" });
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
    const rawText = view.segment.raw_text || "";
    const origZh = el("p", { class: "cap-zh-small", lang: "zh-Hant" }, rawText || "(empty)");
    const origPinyin = createPinyinControl(() => rawText, { label: "Pinyin", compact: true, replaceEl: rawText ? origZh : null });
    origPinyin.sync();
    view.history.replaceChildren(
      el("div", { class: "pn-title-row" }, el("h4", null, "Original recognition"), origPinyin.button),
      el("div", { class: "py-slot" }, origZh, origPinyin.host),
      el("h4", null, "Revision history"),
      entries.length ? el("ol", { class: "cap-revisions" }, entries.map((entry) => {
        const revZh = el("span", { lang: "zh-Hant" }, entry.traditional_text || "");
        const revPinyin = createPinyinControl(() => entry.traditional_text || "", { label: "Pinyin", compact: true, replaceEl: revZh });
        revPinyin.sync();
        return el("li", null,
          el("div", { class: "pn-title-row" },
            el("span", { class: "cap-revision-head tnum" }, `Revision ${entry.revision ?? "?"}${entry.created_at ? ` · ${new Date(entry.created_at).toLocaleString("en")}` : ""}`),
            revPinyin.button),
          el("div", { class: "py-slot" }, revZh, revPinyin.host),
          entry.english ? el("span", { class: "cap-revision-en" }, entry.english) : null);
      }))
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
  const view = {
    id,
    segment,
    signature: "",
    editing: false,
    url: null,
    audio: null,
    clipRange: null,
    clipLoading: false,
    playIcon: "play",
    status: undefined,
    zhText: "",
    wordIntervals: [],
    activeWordIndex: -1,
    clipRaf: 0,
    clipRequest: 0,
  };
  view.en = el("p", { class: "cap-en", lang: "en" });
  view.zh = el("p", { class: "cap-zh", lang: "zh-Hant" });
  view.pinyin = createPinyinControl(() => view.segment.traditional_text || view.segment.raw_text || "", {
    label: "Pinyin",
    compact: true,
    replaceEl: view.zh,
  });
  view.zhSlot = el("div", { class: "py-slot" }, view.zh, view.pinyin.host);
  view.error = el("p", { class: "cap-problem", hidden: true });
  view.range = el("span", { class: "tnum" });
  view.speaker = el("span");
  view.state = el("span", { class: "cap-state" });
  view.edit = actionButton("Edit caption", "pencil", () => beginEdit(view));
  view.historyButton = actionButton("Original and history", "clock", () => toggleHistory(view));
  view.play = actionButton("Play audio clip", "play", () => playClip(view));
  view.retranslate = actionButton("Retranslate", "refresh", () => {
    action("/api/segment/retranslate", { id: view.segment.id, session_id: store.state.session.id });
  });
  const actions = el("div", { class: "cap-actions", role: "group", "aria-label": "Caption actions" }, view.pinyin.button, view.edit, view.historyButton, view.play, view.retranslate);
  view.display = el("div", { class: "cap-display" }, view.en, view.zhSlot, view.error,
    el("div", { class: "cap-metarow" }, el("p", { class: "cap-meta" }, view.range, view.speaker, view.state), actions));
  view.history = el("div", { class: "cap-history", hidden: true });
  view.editor = el("div", { class: "cap-editor", hidden: true });
  view.article = el("article", { class: "cap", dataset: { id } }, view.display, view.history, view.editor);
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
  const zhText = segment.traditional_text || segment.raw_text || "";
  if (zhText !== view.zhText) {
    view.zhText = zhText;
    view.wordIntervals = buildWordIntervals(zhText);
    renderZhWords(view.zh, zhText, view.activeWordIndex);
  }
  view.zh.hidden = view.pinyin.isOpen() || !zhText;
  view.pinyin.sync();
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

  const hasSession = Boolean(ctx.sessionId), live = status === "provisional";
  const validRange = Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start;
  if (view.clipRange && (view.clipRange[0] !== segment.start || view.clipRange[1] !== segment.end)) dropClip(view);
  const isPlaying = Boolean(view.audio && !view.audio.paused && !view.audio.ended);
  setUnavailable(view.edit, !hasSession ? "Open a session to edit captions" : live ? "Live captions can be edited once they are final" : segment.revision == null ? "This caption cannot be edited" : "", "Edit caption");
  setUnavailable(view.historyButton, !hasSession ? "Open a session to see history" : live ? "Live captions have no history yet" : "", "Original and revision history");
  setUnavailable(view.play, !hasSession ? "Open a session to play clips" : !ctx.idle ? "Stop recording to play audio clips" : !validRange ? "No audio time range for this caption" : "", isPlaying ? "Pause audio clip" : "Play audio clip (up to 60 seconds)");
  setUnavailable(view.retranslate, !hasSession ? "Open a session to retranslate" : live ? "Live captions can be retranslated once they are final" : !ctx.modelReady ? "Models are not ready" : ctx.jobActive ? "Wait for the running job to finish" : "", "Retranslate this caption");
  if (!ctx.idle && (view.audio || view.clipLoading)) dropClip(view);
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
  return ["idle", "Ready for live captions", "Choose Teams, System audio, or Microphone above, then press Record — or expand Translate text in the Tools sidebar anytime."];
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
