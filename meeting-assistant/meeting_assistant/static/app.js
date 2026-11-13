// App shell: toolbar, responsive docked/modal drawers, manual translation panel, and inspector tabs.
import { icon, toast } from "/glass.js";
import { getToken } from "/api.js";
import { store } from "/store.js";
import { $, setText, setUnavailable, onPress, formatClock, readPrefs, writePrefs, sessionTitle } from "/ui.js";
import { mountTranscript } from "/transcript.js";
import { mountSidebar } from "/sidebar.js";
import { startRecording, stopRecording, startBlockedReason } from "/recorder.js";
import { mountTranslate } from "/panel-translate.js";
import { mount as mountSetup } from "/panel-setup.js";

for (const slot of document.querySelectorAll("[data-icon]")) slot.replaceWith(icon(slot.dataset.icon));

const body = document.body;
const root = document.documentElement;
const prefs = readPrefs();

// ---------- Responsive layout & modal drawers ----------
const sidebarEl = $("sidebar");
const inspectorEl = $("inspector");
const captionsEl = $("captions");
const toolbarEl = $("toolbar");
const backdropEl = $("drawer-backdrop");
const toggleSidebarBtn = $("toggle-sidebar");
const toggleInspectorBtn = $("toggle-inspector");
const focusToggleBtn = $("focus-toggle");
const closeSidebarBtn = $("close-sidebar");
const closeInspectorBtn = $("close-inspector");

const mqSidebarOverlay = window.matchMedia("(max-width: 1179px)");
const mqInspectorOverlay = window.matchMedia("(max-width: 919px)");

let showSidebar = prefs.sidebar !== false;
let showInspector = prefs.inspector !== false;
let sidebarOverlayOpen = false;
let inspectorOverlayOpen = false;
let focus = false;
let lastDrawerTrigger = null;

function safeShowPopover(node) {
  try {
    if (node.hasAttribute("popover") && !node.matches(":popover-open")) node.showPopover();
  } catch (_) { /* ignore */ }
}

function safeHidePopover(node) {
  try {
    if (node.hasAttribute("popover") && node.matches(":popover-open")) node.hidePopover();
  } catch (_) { /* ignore */ }
}

function configureOverlaySurface(panel, isOverlay) {
  if (isOverlay) {
    if (panel.getAttribute("popover") !== "manual") panel.setAttribute("popover", "manual");
    panel.dataset.overlay = "true";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
  } else {
    safeHidePopover(panel);
    panel.removeAttribute("popover");
    delete panel.dataset.overlay;
    panel.removeAttribute("role");
    panel.removeAttribute("aria-modal");
  }
}

function syncLayout({ restoreFocus = false } = {}) {
  const sideOverlay = mqSidebarOverlay.matches;
  const inspOverlay = mqInspectorOverlay.matches;

  configureOverlaySurface(sidebarEl, sideOverlay);
  configureOverlaySurface(inspectorEl, inspOverlay);

  if (!sideOverlay) sidebarOverlayOpen = false;
  if (!inspOverlay) inspectorOverlayOpen = false;
  if (focus) {
    sidebarOverlayOpen = false;
    inspectorOverlayOpen = false;
  }

  const sideVisible = sideOverlay ? sidebarOverlayOpen : (showSidebar && !focus);
  const inspVisible = inspOverlay ? inspectorOverlayOpen : (showInspector && !focus);

  if (sideOverlay) {
    if (sidebarOverlayOpen) safeShowPopover(sidebarEl);
    else safeHidePopover(sidebarEl);
  }
  if (inspOverlay) {
    if (inspectorOverlayOpen) safeShowPopover(inspectorEl);
    else safeHidePopover(inspectorEl);
  }

  body.dataset.sidebar = sideVisible ? "shown" : "hidden";
  body.dataset.inspector = inspVisible ? "shown" : "hidden";
  body.toggleAttribute("data-focus", focus);

  const anyModalOpen = (sideOverlay && sidebarOverlayOpen) || (inspOverlay && inspectorOverlayOpen);
  backdropEl.hidden = !anyModalOpen;
  toolbarEl.inert = anyModalOpen;
  captionsEl.inert = anyModalOpen;

  sidebarEl.inert = !sideVisible || (inspOverlay && inspectorOverlayOpen);
  inspectorEl.inert = !inspVisible || (sideOverlay && sidebarOverlayOpen);
  sidebarEl.setAttribute("aria-hidden", String(!sideVisible));
  inspectorEl.setAttribute("aria-hidden", String(!inspVisible));

  toggleSidebarBtn.setAttribute("aria-pressed", String(sideVisible));
  toggleInspectorBtn.setAttribute("aria-pressed", String(inspVisible));
  focusToggleBtn.setAttribute("aria-pressed", String(focus));

  if (!anyModalOpen && restoreFocus && lastDrawerTrigger) {
    const trigger = lastDrawerTrigger;
    lastDrawerTrigger = null;
    trigger.focus({ preventScroll: true });
  }
}

function closeDrawers(restoreFocus = false) {
  sidebarOverlayOpen = false;
  inspectorOverlayOpen = false;
  syncLayout({ restoreFocus });
}

toggleSidebarBtn.addEventListener("click", () => {
  if (focus) focus = false;
  if (mqSidebarOverlay.matches) {
    const next = !sidebarOverlayOpen;
    inspectorOverlayOpen = false;
    sidebarOverlayOpen = next;
    lastDrawerTrigger = next ? toggleSidebarBtn : null;
    syncLayout();
    if (next) closeSidebarBtn.focus({ preventScroll: true });
  } else {
    showSidebar = !showSidebar;
    writePrefs({ sidebar: showSidebar });
    syncLayout();
  }
});

toggleInspectorBtn.addEventListener("click", () => {
  if (focus) focus = false;
  if (mqInspectorOverlay.matches) {
    const next = !inspectorOverlayOpen;
    sidebarOverlayOpen = false;
    inspectorOverlayOpen = next;
    lastDrawerTrigger = next ? toggleInspectorBtn : null;
    syncLayout();
    if (next) closeInspectorBtn.focus({ preventScroll: true });
  } else {
    showInspector = !showInspector;
    writePrefs({ inspector: showInspector });
    syncLayout();
  }
});

focusToggleBtn.addEventListener("click", () => {
  focus = !focus;
  syncLayout();
});

closeSidebarBtn.addEventListener("click", () => closeDrawers(true));
closeInspectorBtn.addEventListener("click", () => closeDrawers(true));
backdropEl.addEventListener("click", () => closeDrawers(true));

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (sidebarOverlayOpen || inspectorOverlayOpen)) {
    event.preventDefault();
    closeDrawers(true);
  }
});

window.addEventListener("meeting:session-opened", () => {
  if (sidebarOverlayOpen) closeDrawers(false);
});

mqSidebarOverlay.addEventListener("change", () => syncLayout());
mqInspectorOverlay.addEventListener("change", () => syncLayout());
syncLayout();

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
onPress(record, () => {
  const rs = store.state?.recording_state || "idle";
  if (rs === "idle") startRecording(source.value);
  else stopRecording();
});

const STATUS = { idle: "Ready", starting: "Starting", recording: "Recording", draining: "Finishing" };
let lastRecIcon = "";

function renderToolbar(state) {
  const rs = state?.recording_state || "idle";
  const active = rs !== "idle";
  const label = rs === "idle" ? "Record" : "Stop";
  const iconName = rs === "idle" ? "record" : "stop";
  if (lastRecIcon !== iconName) { $("record-icon").replaceChildren(icon(iconName)); lastRecIcon = iconName; }
  setText($("record-label"), label);
  record.dataset.recording = active ? "true" : "false";
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
  const meter = $("toolbar-meter");
  const a = state?.audio;
  meter.rms = active ? a?.rms_db : null;
  meter.peak = active ? a?.peak_db : null;
  meter.clipped = (a?.clipped_recent || 0) > 0;
  meter.hidden = !active;

  const title = state?.session ? sessionTitle(state.session) : active ? "New recording" : "Meeting Assistant";
  setText($("session-title"), title);
  document.title = active ? `● ${title}` : title;
}
store.subscribe((state, changed) => { if (changed.has("state") || changed.has("live")) renderToolbar(state); });

// ---------- Expandable manual translation + 3-tab inspector ----------
mountTranslate($("pane-translate"));

const TABS = ["setup", "speakers", "notes"];
const TAB_MIGRATION = { audio: "setup", context: "setup", speakers: "speakers", review: "notes", export: "notes" };
const loaded = new Set(["setup"]);
const tabs = $("tabs");

async function showTab(name) {
  for (const t of TABS) $(`pane-${t}`).hidden = t !== name;
  if (name === "setup" || loaded.has(name)) return;
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
mountSetup($("pane-setup"));

const initialTab = TAB_MIGRATION[prefs.tab] || (TABS.includes(prefs.tab) ? prefs.tab : "setup");
if (initialTab !== "setup") {
  tabs.value = initialTab;
  showTab(initialTab);
}

mountTranscript();
mountSidebar();

// ---------- Leaving the page ----------
window.addEventListener("beforeunload", (event) => {
  if ((store.state?.recording_state && store.state.recording_state !== "idle") || store.dirty.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});

if (!getToken()) toast("Missing session token. Open the launch URL from the terminal again.", { kind: "error", timeout: 0 });
store.start();
