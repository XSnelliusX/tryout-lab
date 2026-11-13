// App shell: toolbar, layout toggles, inspector tabs. Captions, sessions and recording live in their own modules.
import { el, icon, toast } from "/glass.js";
import { action, getToken } from "/api.js";
import { store } from "/store.js";
import { $, setText, setUnavailable, onPress, formatClock, readPrefs, writePrefs, sessionTitle } from "/ui.js";
import { mountTranscript } from "/transcript.js";
import { mountSidebar } from "/sidebar.js";
import { startRecording, stopRecording, startBlockedReason } from "/recorder.js";
import { mount as mountAudio } from "/panel-audio.js";

for (const slot of document.querySelectorAll("[data-icon]")) slot.replaceWith(icon(slot.dataset.icon));
const body = document.body, root = document.documentElement;
const prefs = readPrefs();

// ---------- Layout toggles ----------
let showSidebar = prefs.sidebar !== false, showInspector = prefs.inspector !== false, focus = false;
function layout() {
  body.dataset.sidebar = showSidebar && !focus ? "shown" : "hidden";
  body.dataset.inspector = showInspector && !focus ? "shown" : "hidden";
  body.toggleAttribute("data-focus", focus);
  for (const [id, on] of [["toggle-sidebar", showSidebar], ["toggle-inspector", showInspector], ["focus-toggle", focus]]) $(id).setAttribute("aria-pressed", String(on));
  $("sidebar").inert = body.dataset.sidebar === "hidden";
  $("inspector").inert = body.dataset.inspector === "hidden";
  $("sidebar").setAttribute("aria-hidden", String(body.dataset.sidebar === "hidden"));
  $("inspector").setAttribute("aria-hidden", String(body.dataset.inspector === "hidden"));
}
$("toggle-sidebar").addEventListener("click", () => { if (focus) focus = false; else showSidebar = !showSidebar; writePrefs({ sidebar: showSidebar }); layout(); });
$("toggle-inspector").addEventListener("click", () => { if (focus) focus = false; else showInspector = !showInspector; writePrefs({ inspector: showInspector }); layout(); });
$("focus-toggle").addEventListener("click", () => { focus = !focus; layout(); });
layout();

// ---------- Caption size ----------
const STEPS = [0.85, 1, 1.15, 1.3, 1.45, 1.6];
let scaleIndex = STEPS.indexOf(prefs.scale) >= 0 ? STEPS.indexOf(prefs.scale) : 1;
function applyScale() {
  root.style.setProperty("--caption-scale", String(STEPS[scaleIndex]));
  setUnavailable($("text-smaller"), scaleIndex === 0 ? "Smallest size" : "", "Smaller captions");
  setUnavailable($("text-larger"), scaleIndex === STEPS.length - 1 ? "Largest size" : "", "Larger captions");
  writePrefs({ scale: STEPS[scaleIndex] });
}
onPress($("text-smaller"), () => { scaleIndex = Math.max(0, scaleIndex - 1); applyScale(); });
onPress($("text-larger"), () => { scaleIndex = Math.min(STEPS.length - 1, scaleIndex + 1); applyScale(); });
applyScale();

// ---------- Source and record ----------
const SOURCES = ["teams", "system", "microphone"];
const source = $("source");
if (SOURCES.includes(prefs.source)) source.value = prefs.source;
source.addEventListener("change", () => writePrefs({ source: source.value }));
const record = $("record");
record.append();
onPress(record, () => {
  const rs = store.state?.recording_state || "idle";
  if (rs === "idle") startRecording(source.value);
  else stopRecording();
});

const STATUS = { idle: "Idle", starting: "Starting", recording: "Recording", draining: "Finishing" };
let lastRecIcon = "";

function renderToolbar(state) {
  const rs = state?.recording_state || "idle";
  const active = rs !== "idle";
  const label = rs === "idle" ? "Record" : "Stop";
  const iconName = rs === "idle" ? "record" : "stop";
  if (lastRecIcon !== iconName) { $("record-icon").replaceChildren(icon(iconName)); lastRecIcon = iconName; }
  setText($("record-label"), label);
  record.classList.toggle("glass-button--prominent", !active);
  record.classList.toggle("glass-button--destructive", active);
  let reason = "";
  if (rs === "idle") reason = startBlockedReason(state);
  else if (rs === "draining") reason = "Finishing capture and queued captions…";
  setUnavailable(record, reason, rs === "idle" ? `Record from ${source.value}` : "Stop recording and save the session");
  source.disabled = active;
  source.title = active ? "Stop recording to change the source" : "";

  if ($("rec-dot").dataset.state !== rs) $("rec-dot").dataset.state = rs;
  setText($("rec-text"), STATUS[rs] || "Unknown");
  setText($("elapsed"), formatClock(state?.audio_seconds || 0));
  const meter = $("toolbar-meter"), a = state?.audio;
  meter.rms = active ? a?.rms_db : null;
  meter.peak = active ? a?.peak_db : null;
  meter.clipped = (a?.clipped_recent || 0) > 0;
  meter.hidden = !active;

  const title = state?.session ? sessionTitle(state.session) : active ? "New recording" : "Meeting Assistant";
  setText($("session-title"), title);
  document.title = active ? `● ${title}` : title;
}
store.subscribe((state, changed) => { if (changed.has("state") || changed.has("live")) renderToolbar(state); });

// ---------- Inspector tabs ----------
const TABS = ["audio", "context", "speakers", "review", "export"];
const loaded = new Set(["audio"]);
const tabs = $("tabs");
async function showTab(name) {
  for (const t of TABS) $(`pane-${t}`).hidden = t !== name;
  if (name === "audio" || loaded.has(name)) return;
  loaded.add(name);
  const pane = $(`pane-${name}`);
  try {
    const module = await import(`/panel-${name}.js`);
    module.mount(pane);
  } catch (error) {
    console.error(error);
    pane.replaceChildren(el("p", { class: "field-help pane-unavailable", role: "status" }, "This panel is unavailable."));
  }
}
tabs.addEventListener("change", () => { writePrefs({ tab: tabs.value }); showTab(tabs.value); });
mountAudio($("pane-audio"));
if (TABS.includes(prefs.tab) && prefs.tab !== "audio") { tabs.value = prefs.tab; showTab(prefs.tab); }

mountTranscript();
mountSidebar();

// ---------- Leaving the page ----------
window.addEventListener("beforeunload", (event) => {
  if ((store.state?.recording_state && store.state.recording_state !== "idle") || store.dirty.size) { event.preventDefault(); event.returnValue = ""; }
});

if (!getToken()) toast("Missing session token. Open the launch URL from the terminal again.", { kind: "error", timeout: 0 });
store.start();
