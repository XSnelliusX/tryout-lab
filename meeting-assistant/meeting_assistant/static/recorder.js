// Starting and stopping a recording: input devices and capture actions.
import { el, toast, confirmSheet } from "/glass.js";
import { api, action } from "/api.js";
import { store } from "/store.js";
import { clearClips } from "/transcript.js";

export const PRIVACY_TEXT = "Live audio, transcription and translation stay on this Mac. Recording saves audio and transcript events locally until you delete them.";

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
  if (reason) {
    toast(reason, { kind: "warning" });
    return false;
  }
  if (store.dirty.size && !(await confirmSheet({
    title: "Start a new recording?",
    message: "Starting a new session may discard open caption or speaker edits. Continue?",
    confirmLabel: "Discard and continue", destructive: true,
  }))) return false;

  // Privacy notice is shown in the Sessions footer; starting proceeds immediately without a confirmation dialog.
  return action("/api/start", { source, consent: true }, { success: clearClips });
}

export function stopRecording() {
  return action("/api/stop", {});
}
