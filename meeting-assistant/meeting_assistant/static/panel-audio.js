// Inspector panel "Audio": levels, device, latency, queue, audio settings, permission help.
import { el, icon } from "/glass.js";
import { action } from "/api.js";
import { store } from "/store.js";
import { setText, formatMs, formatDb, formatClock } from "/ui.js";
import { permissionGuide, getDevices, fillDeviceSelect } from "/recorder.js";

const REBUILD = "./scripts/build_capture.sh";
const STAGES = [["endpoint_ms", "Endpointing"], ["asr_ms", "Recognition"], ["translate_ms", "Translation"], ["speech_end_to_source_ms", "To Chinese text"], ["speech_end_to_english_ms", "To English"]];
const LANGS = [["auto", "Automatic"], ["zh", "Chinese"], ["en", "English"]];
let n = 0;

function stat(label, hint) {
  const value = el("dd", { class: "tnum" }, "—");
  return { value, node: el("div", { class: "au-stat" }, el("dt", { title: hint || "" }, label), value) };
}

export function mount(container) {
  const id = (s) => `au-${s}-${++n}`;
  const meter = el("level-meter", { class: "au-meter", readout: true, "aria-label": "Input level" });
  const levelNote = el("p", { class: "field-help" }, "Broadband level of the last 100 ms, with a held peak mark. The red dot lights when samples clip.");
  const advice = el("div", { class: "banner banner--warning", role: "status", hidden: true }, icon("warning"), el("span"));
  const stale = el("div", { class: "banner banner--warning", hidden: true }, icon("warning"),
    el("span", null, "The capture helper is out of date, so device choice and level details are limited. Rebuild it with ", el("code", null, REBUILD), "."));
  const noAudio = el("div", { class: "banner banner--warning", role: "status", hidden: true }, icon("warning"),
    el("span", null, "No audio signal detected for 8 seconds. Check the selected source, permissions, and input/output routing. Silence can also cause this warning."));
  const notice = el("div", { class: "banner banner--info", role: "status", hidden: true }, icon("info"), el("span"));
  const capture = el("p", { class: "field-help", role: "status" });
  const feed = el("p", { class: "field-help", role: "status" });

  const S = {
    device: stat("Device"), rate: stat("Sample rate"), transport: stat("Transport"), volume: stat("macOS input volume"),
    floor: stat("Speech-band noise floor", "Background noise in the 250-4000 Hz speech band"), speech: stat("Speech level", "Typical speech level in the 250-4000 Hz speech band"), snr: stat("Signal-to-noise", "Speech level minus noise floor, both in the speech band; Teams audio can read 70-80 dB"), gain: stat("Applied gain", "Gain applied to audio sent to recognition"),
    clipRecent: stat("Clipping, last 10 s"), clipTotal: stat("Clipping, total"),
    queue: stat("Queue"), lag: stat("Oldest work"), bursts: stat("Noise bursts ignored"),
  };
  const grid = (...items) => el("dl", { class: "au-grid" }, items.map((s) => s.node));

  const latHead = el("tr", null, el("th", { scope: "col" }, "End of speech to"), ["Last", "Median", "90th pct."].map((t) => el("th", { scope: "col" }, t)));
  const latRows = STAGES.map(([key, label]) => ({ key, cells: [0, 1, 2].map(() => el("td", { class: "tnum" }, "—")), tr: null, label }));
  for (const r of latRows) r.tr = el("tr", { class: key(r.key) }, el("th", { scope: "row" }, r.label), r.cells);
  function key(k) { return k === "speech_end_to_english_ms" ? "au-key" : ""; }
  const latBody = el("tbody", null, latRows.map((r) => r.tr));
  const latCount = el("p", { class: "field-help" });
  const latency = el("div", { class: "au-latency" },
    el("table", { class: "au-table" }, el("thead", null, latHead), latBody), latCount);

  // Settings
  const device = el("select", { class: "select", id: id("device") });
  const language = el("select", { class: "select", id: id("lang") }, LANGS.map(([v, l]) => el("option", { value: v }, l)));
  const normalise = el("input", { type: "checkbox", class: "switch", role: "switch", id: id("norm") });
  const deviceHelp = el("span", { class: "field-help" });
  let devicesInfo = { supported: false, devices: [] };
  const save = (patch) => action("/api/settings", { audio: patch }, { success: () => {} });
  device.addEventListener("change", () => save({ device_uid: device.value }));
  language.addEventListener("change", () => save({ language: language.value }));
  normalise.addEventListener("change", () => save({ normalize: normalise.checked }));

  const guide = permissionGuide();
  const section = (title, ...kids) => el("section", { class: "au-section" }, el("h3", { class: "au-title" }, title), ...kids);

  container.append(
    stale, noAudio, notice,
    section("Level", meter, levelNote, advice, capture, feed),
    section("Input", grid(S.device, S.rate, S.transport, S.volume)),
    section("Signal", grid(S.floor, S.speech, S.snr, S.gain, S.clipRecent, S.clipTotal)),
    section("Latency", latency),
    section("Work queue", grid(S.queue, S.lag, S.bursts)),
    section("Settings",
      el("div", { class: "field" }, el("label", { for: device.id }, "Input device"), device, deviceHelp),
      el("div", { class: "field" }, el("label", { for: language.id }, "Recognition language"), language,
        el("span", { class: "field-help" }, "A hint for the recogniser. Automatic works for mixed Chinese and English.")),
      el("div", { class: "field field--inline au-switch" }, normalise, el("label", { for: normalise.id }, "Normalise level"),),
      el("span", { class: "field-help" }, "Evens out the level of audio sent to recognition. The saved audio is not changed."),
    ),
    section("Permissions", guide.node),
  );

  function render(state, changed) {
    const a = state?.audio || null, cap = state?.capabilities || {}, dev = a?.device || null;
    const recording = state && state.recording_state !== "idle";
    if (changed?.has("live") || changed?.has("state")) {
      meter.rms = recording ? a?.rms_db : null;
      meter.peak = recording ? a?.peak_db : null;
      meter.clipped = (a?.clipped_recent || 0) > 0;
      setText(advice.lastChild, a?.advice || "");
      advice.hidden = !a?.advice;
      noAudio.hidden = !state?.no_audio;
      notice.hidden = !state?.notice;
      setText(notice.lastChild, state?.notice || "");
      setText(capture, state?.capture_status || "Capture status unknown");
      setText(feed, state ? `Received ${(state.audio_seconds || 0).toFixed(1)} s of audio · ${state.feed_status || "feed status unknown"}` : "");
      const fmt = (v, f) => (v == null ? "—" : f(v));
      setText(S.device.value, dev?.name || (recording ? "Not reported yet" : "—"));
      setText(S.rate.value, fmt(dev?.sample_rate, (v) => `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} kHz${dev.channels ? ` · ${dev.channels} ch` : ""}`));
      setText(S.transport.value, dev?.transport || "—");
      setText(S.volume.value, dev?.input_volume == null ? (dev ? "No software gain" : "—") : `${Math.round(dev.input_volume * 100)}%${dev.input_volume_settable ? "" : " (fixed)"}`);
      setText(S.floor.value, formatDb(a?.noise_db, 1));
      setText(S.speech.value, formatDb(a?.speech_db, 1));
      setText(S.snr.value, formatDb(a?.snr_db, 1));
      // gain_db is the gain of the last recognition call; "Off" only when normalisation is switched off.
      const normalizeOn = state?.settings?.audio?.normalize !== false;
      setText(S.gain.value, !normalizeOn ? "Off" : !recording || a?.gain_db == null ? "—" : `${a.gain_db > 0 ? "+" : ""}${a.gain_db.toFixed(1)} dB`);
      setText(S.clipRecent.value, a ? String(a.clipped_recent ?? 0) : "—");
      setText(S.clipTotal.value, a ? String(a.clipped_total ?? 0) : "—");
      setText(S.queue.value, state?.queue_length ?? "—");
      setText(S.lag.value, state?.queue_lag_seconds == null ? "—" : `${state.queue_lag_seconds} s`);
      setText(S.bursts.value, state?.discarded_bursts ?? "—");
      const lat = state?.latency;
      for (const r of latRows) [lat?.last, lat?.median, lat?.p90].forEach((src, i) => setText(r.cells[i], formatMs(src?.[r.key])));
      setText(latCount, lat?.count ? `Measured on ${lat.count} captions in this session.` : "No captions measured yet.");
      stale.hidden = !(cap.helper_stale || (cap.helper_protocol != null && cap.helper_protocol < 2));
      guide.update(state);
    }
    if (changed?.has("state") && state) {
      const s = state.settings?.audio || {};
      if (document.activeElement !== device) fillDeviceSelect(device, devicesInfo.devices, s.device_uid || "");
      if (document.activeElement !== language) language.value = s.language || "auto";
      if (document.activeElement !== normalise) normalise.checked = s.normalize !== false;
      const off = recording;
      for (const c of [device, language, normalise]) c.disabled = false;
      device.disabled = !devicesInfo.supported;
      setText(deviceHelp, devicesInfo.supported ? (off ? "Applies to the next recording." : "Used for Microphone recordings.") : "This capture helper cannot list devices; the macOS default input is used.");
    }
  }
  getDevices(true).then((d) => { devicesInfo = d; render(store.state, new Set(["state"])); });
  store.subscribe(render);
  render(store.state, new Set(["state", "live"]));
}
