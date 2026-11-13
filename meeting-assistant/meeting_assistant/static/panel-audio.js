// Audio controls for the Setup pane: source-aware mic selection, direct CoreAudio mic volume when supported, language, and collapsed diagnostics.
import { api, action } from "/api.js";
import { el, icon } from "/glass.js";
import { fillDeviceSelect, getDevices } from "/recorder.js";
import { store } from "/store.js";
import { $, formatDb, formatMs, setText } from "/ui.js";

const REBUILD = "./scripts/build_capture.sh";
const STAGES = [
  ["endpoint_ms", "Endpointing"],
  ["asr_ms", "Recognition"],
  ["translate_ms", "Translation"],
  ["speech_end_to_source_ms", "To Chinese text"],
  ["speech_end_to_english_ms", "To English"],
];
const LANGS = [["auto", "Automatic"], ["zh", "Chinese"], ["en", "English"]];
let n = 0;

function stat(label, hint) {
  const value = el("dd", { class: "tnum" }, "—");
  return { value, node: el("div", { class: "au-stat" }, el("dt", { title: hint || "" }, label), value) };
}

function selectedDeviceRecord(devicesInfo, selectedUid, liveDevice) {
  const list = Array.isArray(devicesInfo?.devices) ? devicesInfo.devices : [];
  if (selectedUid) {
    const match = list.find((d) => d.uid === selectedUid);
    if (match) return match;
    if (liveDevice && liveDevice.uid === selectedUid) return liveDevice;
    return null;
  }
  return list.find((d) => d.is_default) || liveDevice || list[0] || null;
}

export function mount(container) {
  const id = (s) => `au-${s}-${++n}`;

  const meter = el("level-meter", { class: "au-meter", readout: true, "aria-label": "Input level" });
  const advice = el("div", { class: "banner banner--warning", role: "status", hidden: true }, icon("warning"), el("span"));
  const stale = el("div", { class: "banner banner--warning", hidden: true }, icon("warning"),
    el("span", null, "The capture helper is out of date. Rebuild it with ", el("code", null, REBUILD), "."));
  const noAudio = el("div", { class: "banner banner--warning", role: "status", hidden: true }, icon("warning"),
    el("span", null, "No audio detected for 8 seconds. Check the selected source, permissions, and app output."));
  const notice = el("div", { class: "banner banner--info", role: "status", hidden: true }, icon("info"), el("span"));
  const captureLine = el("p", { class: "field-help", role: "status" });

  // Input & Language
  const device = el("select", { class: "select", id: id("device") });
  const refreshDevices = el("button", {
    type: "button",
    class: "glass-button glass-button--icon glass-button--filled",
    "aria-label": "Refresh microphones",
    title: "Refresh input devices",
  }, icon("refresh"));
  const deviceHelp = el("span", { class: "field-help" });
  const language = el("select", { class: "select", id: id("lang") }, LANGS.map(([v, l]) => el("option", { value: v }, l)));

  // Conditional Direct Microphone Input Volume (ONLY shown when source === "microphone" AND direct CoreAudio control is supported)
  const volAuto = el("input", { type: "checkbox", class: "switch", role: "switch", id: id("vol-auto"), checked: true });
  const volSlider = el("input", {
    type: "range",
    class: "glass-slider",
    id: id("vol-slider"),
    min: "0",
    max: "100",
    step: "1",
    value: "50",
    "aria-label": "Direct microphone input volume",
  });
  const volReadout = el("span", { class: "vol-readout tnum" }, "50%");
  const volError = el("p", { class: "pn-copy pn-error-text", role: "alert", hidden: true });
  const volSection = el("div", { class: "group-box pn-box", id: id("vol-box"), hidden: true },
    el("div", { class: "pn-switch-row" },
      el("label", { for: volAuto.id }, "Automatic input volume"),
      volAuto),
    el("div", { class: "vol-slider-block" },
      el("label", { for: volSlider.id, class: "field-label" }, "Microphone input volume"),
      el("div", { class: "vol-slider-row" }, volSlider, volReadout)),
    volError);

  // Collapsed Diagnostics & Software Leveling
  const normalise = el("input", { type: "checkbox", class: "switch", role: "switch", id: id("norm") });
  const S = {
    device: stat("Device"),
    rate: stat("Sample rate"),
    transport: stat("Transport"),
    volume: stat("macOS input volume"),
    floor: stat("Noise floor", "Background noise in the 250-4000 Hz speech band"),
    speech: stat("Speech level", "Typical speech level in the 250-4000 Hz speech band"),
    snr: stat("Signal-to-noise", "Speech level minus noise floor"),
    gain: stat("Software gain", "Digital leveling applied before speech recognition"),
    clipRecent: stat("Clipping (10 s)"),
    clipTotal: stat("Clipping (total)"),
    queue: stat("Queue"),
    lag: stat("Oldest work"),
    bursts: stat("Noise bursts ignored"),
  };
  const grid = (...items) => el("dl", { class: "au-grid" }, items.map((s) => s.node));
  const latHead = el("tr", null, el("th", { scope: "col" }, "End of speech to"), ["Last", "Median", "90th pct."].map((t) => el("th", { scope: "col" }, t)));
  const latRows = STAGES.map(([key, label]) => ({ key, cells: [0, 1, 2].map(() => el("td", { class: "tnum" }, "—")), tr: null }));
  for (const r of latRows) r.tr = el("tr", { class: r.key === "speech_end_to_english_ms" ? "au-key" : "" }, el("th", { scope: "row" }, STAGES.find(([k]) => k === r.key)[1]), r.cells);
  const latCount = el("p", { class: "field-help" });
  const latency = el("div", { class: "au-latency" },
    el("table", { class: "au-table" }, el("thead", null, latHead), el("tbody", null, latRows.map((r) => r.tr))),
    latCount);

  const diagDetails = el("details", { class: "glass-disclosure" },
    el("summary", null, el("span", null, "Advanced audio & diagnostics"), icon("chevron-right")),
    el("div", { class: "glass-disclosure-body" },
      el("div", { class: "pn-switch-row" },
        el("label", { for: normalise.id }, "Software speech leveling"),
        normalise),
      el("p", { class: "field-help" }, "Digitally balances quieter speech before recognition. Separate from hardware microphone volume; saved audio stays unchanged."),
      el("h4", { class: "au-title" }, "Signal & input"),
      grid(S.device, S.rate, S.transport, S.volume, S.floor, S.speech, S.snr, S.gain, S.clipRecent, S.clipTotal),
      el("h4", { class: "au-title" }, "Processing latency & queue"),
      grid(S.queue, S.lag, S.bursts),
      latency));

  let devicesInfo = { supported: false, devices: [] };
  let volBusy = false;
  let volTimer = 0;

  const save = (patch) => action("/api/settings", { audio: patch }, { success: () => {} });

  function setSliderUi(pct) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    volSlider.value = String(clamped);
    volSlider.style.setProperty("--control-value", `${clamped}%`);
    setText(volReadout, `${clamped}%`);
  }

  async function commitVolume(volumeFloat) {
    volBusy = true;
    volError.hidden = true;
    try {
      const uid = device.value || store.state?.settings?.audio?.device_uid || "";
      const body = { volume: volumeFloat };
      if (uid) body.device_uid = uid;
      const res = await api("/api/audio/input-volume", body);
      volAuto.checked = res?.input_volume_mode === "auto";
      if (res?.input_volume != null) setSliderUi(res.input_volume * 100);
      devicesInfo = await getDevices(true);
    } catch (error) {
      volError.textContent = error?.message || "Could not update microphone volume.";
      volError.hidden = false;
    } finally {
      volBusy = false;
    }
  }

  volSlider.addEventListener("input", () => {
    const pct = Number(volSlider.value);
    setSliderUi(pct);
    volAuto.checked = false;
    clearTimeout(volTimer);
    volTimer = window.setTimeout(() => commitVolume(pct / 100), 160);
  });

  volSlider.addEventListener("change", () => {
    clearTimeout(volTimer);
    const pct = Number(volSlider.value);
    setSliderUi(pct);
    volAuto.checked = false;
    commitVolume(pct / 100);
  });

  volAuto.addEventListener("change", async () => {
    volError.hidden = true;
    if (volAuto.checked) {
      volBusy = true;
      try {
        const res = await api("/api/audio/input-volume", { mode: "auto" });
        if (res?.input_volume != null) setSliderUi(res.input_volume * 100);
      } catch (error) {
        volAuto.checked = false;
        volError.textContent = error?.message || "Could not switch to automatic volume.";
        volError.hidden = false;
      } finally {
        volBusy = false;
      }
    } else {
      commitVolume(Number(volSlider.value) / 100);
    }
  });

  device.addEventListener("change", () => {
    save({ device_uid: device.value });
    render(store.state, new Set(["state", "source"]));
  });
  language.addEventListener("change", () => save({ language: language.value }));
  normalise.addEventListener("change", () => save({ normalize: normalise.checked }));
  refreshDevices.addEventListener("click", async () => {
    devicesInfo = await getDevices(true);
    render(store.state, new Set(["state", "live"]));
  });

  container.append(
    stale,
    noAudio,
    notice,
    el("section", { class: "pn-section" },
      el("h3", { class: "pn-title" }, "Recording & Sound"),
      el("div", { class: "group-box pn-box" },
        el("div", { class: "field" },
          el("span", { class: "field-label" }, "Input signal"),
          meter,
          advice,
          captureLine),
        el("div", { class: "field" },
          el("label", { for: device.id }, "Microphone"),
          el("div", { class: "pn-actions" },
            el("div", { class: "pn-row-main" }, device),
            refreshDevices),
          deviceHelp),
        el("div", { class: "field" },
          el("label", { for: language.id }, "Spoken language"),
          language,
          el("span", { class: "field-help" }, "Automatic works well for mixed Mandarin and English."))),
      volSection),
    diagDetails,
  );

  function render(state, changed) {
    const a = state?.audio || null;
    const cap = state?.capabilities || {};
    const dev = a?.device || null;
    const recording = Boolean(state && state.recording_state !== "idle");

    if (changed?.has("live") || changed?.has("state")) {
      meter.rms = recording ? a?.rms_db : null;
      meter.peak = recording ? a?.peak_db : null;
      meter.clipped = (a?.clipped_recent || 0) > 0;
      setText(advice.lastChild, a?.advice || "");
      advice.hidden = !a?.advice;
      noAudio.hidden = !state?.no_audio;
      notice.hidden = !state?.notice;
      setText(notice.lastChild, state?.notice || "");
      setText(captureLine, state
        ? `${state.capture_status || "Ready"}${recording ? ` · ${(state.audio_seconds || 0).toFixed(1)} s received` : ""}`
        : "");

      const fmt = (v, f) => (v == null ? "—" : f(v));
      setText(S.device.value, dev?.name || (recording ? "Not reported yet" : "—"));
      setText(S.rate.value, fmt(dev?.sample_rate, (v) => `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} kHz${dev.channels ? ` · ${dev.channels} ch` : ""}`));
      setText(S.transport.value, dev?.transport || "—");
      setText(S.volume.value, dev?.input_volume == null ? (dev ? "No direct gain" : "—") : `${Math.round(dev.input_volume * 100)}%${dev.input_volume_settable ? "" : " (fixed)"}`);
      setText(S.floor.value, formatDb(a?.noise_db, 1));
      setText(S.speech.value, formatDb(a?.speech_db, 1));
      setText(S.snr.value, formatDb(a?.snr_db, 1));
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
    }

    if (!changed || changed.has("state") || changed.has("source") || changed.has("live")) {
      const s = state?.settings?.audio || {};
      if (changed?.has("state") || !changed) {
        if (document.activeElement !== device) fillDeviceSelect(device, devicesInfo.devices, s.device_uid || "");
        if (document.activeElement !== language) language.value = s.language || "auto";
        if (document.activeElement !== normalise) normalise.checked = s.normalize !== false;
        device.disabled = !devicesInfo.supported;
        setText(deviceHelp, devicesInfo.supported
          ? (recording ? "Device selection applies to the next Microphone recording." : "Used when source is set to Microphone.")
          : "macOS default input will be used.");
      }

      const selectedSource = recording
        ? (state?.audio?.source || state?.session?.source || $("source")?.value || "teams")
        : ($("source")?.value || "teams");
      const chosenUid = document.activeElement === device ? device.value : (device.value || s.device_uid || "");
      const activeDev = selectedDeviceRecord(devicesInfo, chosenUid, dev);
      const micMode = selectedSource === "microphone";
      const directSupported = micMode && (recording
        ? Boolean(a?.direct_volume_supported ?? activeDev?.direct_volume_supported)
        : Boolean(activeDev?.direct_volume_supported));

      // Rule: If direct control is supported, show separate slider + automatic switch; otherwise automatic mode only and NO notice.
      volSection.hidden = !directSupported;
      if (directSupported && !volBusy) {
        const mode = a?.input_volume_mode === "manual" ? "manual" : "auto";
        if (document.activeElement !== volAuto) volAuto.checked = mode === "auto";
        const hwVol = recording && dev?.input_volume != null ? dev.input_volume : activeDev?.input_volume;
        if (hwVol != null && document.activeElement !== volSlider) {
          setSliderUi(hwVol * 100);
        }
      }
    }
  }

  const sourceControl = $("source");
  if (sourceControl) {
    sourceControl.addEventListener("change", () => render(store.state, new Set(["source"])));
  }

  getDevices(true).then((d) => {
    devicesInfo = d;
    render(store.state, new Set(["state", "source"]));
  });
  store.subscribe(render);
  render(store.state, new Set(["state", "live"]));
}
