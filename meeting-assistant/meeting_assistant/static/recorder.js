// Starting and stopping a recording: consent sheet, input devices, permission guide copy.
import { el, icon, sheet, confirmSheet, toast } from "/glass.js";
import { api, action } from "/api.js";
import { store } from "/store.js";
import { sourceLabel } from "/ui.js";
import { clearClips } from "/transcript.js";

export const SOURCE_HINTS = {
  teams: "Teams captures remote digital audio, not your microphone or voices in the room. Mac speaker volume can stay at 0; volume-zero capture is not yet verified on this Mac. Keep Teams computer audio connected.",
  system: "Captures all digital system output, not your microphone. Other apps and alerts can be included.",
  microphone: "Captures nearby voices, including your own, through the selected macOS input. Speakers can stay silent. This does not directly capture muted Teams playback; only sound reaching the microphone is included.",
};
export const SYSTEM_WARNING = "System audio may include unrelated apps, alerts, and private audio. Only choose this if you intend to record all system output.";
export const CONSENT_TEXT = "By starting, you confirm that you have given the required notice and obtained consent to record, locally archive, and transcribe this session.";
export const PRIVACY_TEXT = "Live audio, transcription and translation stay on this Mac. Recording saves audio and transcript events locally until you delete them. Review consent and your organization’s policy before recording.";

/** The macOS permission guide as a <details>; call update(state) when the snapshot changes. */
export function permissionGuide() {
  const hint = el("p", { class: "field-help" }, "Allow the app that launched this tool, not Teams or your web browser.");
  const node = el("details", { class: "disclosure" },
    el("summary", null, "Which app needs macOS permission?"),
    el("div", { class: "disclosure-body" },
      hint,
      el("p", { class: "field-help" }, "Double-click launcher → ", el("strong", null, "Terminal"), " (", el("code", null, "/System/Applications/Utilities/Terminal.app"), "). Started from cmux → ", el("strong", null, "cmux"), " (", el("code", null, "/Applications/cmux.app"), "). If macOS lists capture-audio itself, allow that requesting item. After changing access, fully quit and reopen the responsible launcher; save other terminal work first."),
      el("p", { class: "field-help" }, el("strong", null, "Teams / System:"), " Privacy & Security → Screen & System Audio Recording. ",
        el("a", { href: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" }, "Open recording permissions")),
      el("p", { class: "field-help" }, "If the launcher is missing from that list, use its ", el("strong", null, "+"), " button, press ", el("strong", null, "⌘⇧G"), ", and enter the Terminal or cmux application path above. Grant only the permissions for the source you intend to use."),
      el("p", { class: "field-help" }, el("strong", null, "Microphone:"), " Privacy & Security → Microphone. No Screen Recording access is needed. Start once to request access; Microphone settings may not list the launcher until then. ",
        el("a", { href: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" }, "Open microphone permissions"))));
  return {
    node,
    update(state) {
      const text = `This server appears to have been launched through ${state?.launcher_name || "an unknown launcher"}. macOS determines the actual permission owner: enable the requesting app shown in System Settings, not Teams or this browser.`;
      if (hint.textContent !== text) hint.textContent = text;
      if (state?.notice && /permission|denied|3801/i.test(state.notice) && !node.dataset.autoOpened) {
        node.open = true;
        node.dataset.autoOpened = "1";
      }
    },
  };
}

// ---------- Input devices ----------
let deviceCache = { at: 0, value: { supported: false, devices: [] } };
export async function getDevices(force = false) {
  if (!force && Date.now() - deviceCache.at < 5000) return deviceCache.value;
  try {
    const result = await api("/api/devices");
    deviceCache = { at: Date.now(), value: { supported: Boolean(result.supported), devices: Array.isArray(result.devices) ? result.devices : [] } };
  } catch (_) {
    deviceCache = { at: Date.now(), value: { supported: false, devices: [] } };
  }
  return deviceCache.value;
}

/** Fills a <select> with "System default input" + devices; keeps `selected` when present. */
export function fillDeviceSelect(select, devices, selected) {
  // Name the current default: macOS switches it silently (e.g. to a headset jack when one is plugged in).
  const current = devices.find((d) => d.is_default);
  const volume = (d) => (d.input_volume == null ? "" : ` · input volume ${Math.round(d.input_volume * 100)}%`);
  const options = [["", current ? `Follow macOS default (now ${current.name}${volume(current)})` : "Follow macOS default input"]];
  for (const d of devices) options.push([d.uid, `${d.name}${d.is_default ? " (default)" : ""}${d.transport ? ` · ${d.transport}` : ""}${volume(d)}`]);
  const signature = JSON.stringify(options);
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...options.map(([value, label]) => el("option", { value }, label)));
    select.dataset.signature = signature;
  }
  const known = options.some(([value]) => value === (selected || ""));
  select.value = known ? selected || "" : "";
}

// ---------- Start / stop ----------
export function startBlockedReason(state = store.state) {
  if (!state) return "Connecting to the local server…";
  if (!state.model_ready) return /fail/i.test(state.model_status || "") ? `Models failed to load. ${state.model_status}` : "Models are still loading from local files.";
  if (store.jobActive()) return "A post-meeting job is running. Wait for it to finish or cancel it first.";
  if (state.pending_work) return "Queued caption work is still finishing.";
  if (store.dirty.has("context") || store.dirty.has("vocabulary")) return "Save your meeting context and vocabulary before starting capture.";
  if (store.busy) return "Another action is in progress.";
  return "";
}

export async function startRecording(source) {
  const reason = startBlockedReason();
  if (reason) { toast(reason, { kind: "warning" }); return false; }
  if (store.dirty.size && !(await confirmSheet({
    title: "Start a new recording?",
    message: "Starting a new session may discard open transcript, context and speaker editors. Continue?",
    confirmLabel: "Discard and continue", destructive: true,
  }))) return false;

  const state = store.state;
  const devices = source === "microphone" ? await getDevices(true) : { supported: false, devices: [] };
  const current = state.settings?.audio?.device_uid || "";
  const deviceSelect = el("select", { class: "select", id: "consent-device" });
  fillDeviceSelect(deviceSelect, devices.devices, current);

  const body = el("div", { class: "consent" },
    el("p", { class: "consent-lead" }, CONSENT_TEXT),
    el("div", { class: "group-box consent-source" },
      el("h3", { class: "group-box-title" }, sourceLabel(source)),
      el("p", { class: "consent-text" }, SOURCE_HINTS[source] || "")),
    source === "system" ? el("div", { class: "banner banner--warning", role: "note" }, icon("warning"), el("span", null, SYSTEM_WARNING)) : null,
    source === "microphone" ? (devices.supported
      ? el("div", { class: "field" }, el("label", { for: "consent-device" }, "Input device"), deviceSelect,
          el("span", { class: "field-help" }, "Saved as the default input for new recordings."))
      : el("p", { class: "field-help" }, "This capture helper cannot list devices, so the macOS default input is used. Choose it in System Settings → Sound → Input, or rebuild the helper with ./scripts/build_capture.sh.")) : null,
    el("p", { class: "field-help" }, PRIVACY_TEXT),
    el("p", { class: "field-help" }, "macOS may ask for permission the first time you record. ",
      el("a", { href: "x-apple.systempreferences:com.apple.preference.security?Privacy_" + (source === "microphone" ? "Microphone" : "ScreenCapture") }, "Open the matching privacy settings")));

  const choice = await sheet({
    title: "Start recording?",
    body,
    actions: [{ label: "Cancel", value: false }, { label: "Start recording", value: true, kind: "prominent" }],
  });
  if (choice !== true) return false;

  if (source === "microphone" && devices.supported && deviceSelect.value !== current) {
    try { await api("/api/settings", { audio: { device_uid: deviceSelect.value } }); }
    catch (error) { toast(error.message, { kind: "error" }); return false; }
  }
  // The only place consent is sent: the Start button of the sheet above.
  return action("/api/start", { source, consent: true }, { success: clearClips });
}

export function stopRecording() {
  return action("/api/stop", {});
}
