// Speakers tab: local speaker identification (with honest single-speaker/uncertain handling), naming, and attribution switch.
import { action } from "/api.js";
import { confirmSheet, el, icon } from "/glass.js";
import { store } from "/store.js";

let seq = 0;
const uid = (name) => `ps-${name}-${++seq}`;
const clusterTitle = (label) => {
  const m = /^speaker_(\d+)$/.exec(label);
  return m ? `Speaker ${m[1]}` : (label === "unknown" ? "Uncertain" : label);
};

function formatInterval(row) {
  return Number.isFinite(row?.start) && Number.isFinite(row?.end)
    ? `${row.start.toFixed(1)}–${row.end.toFixed(1)} s`
    : "Time unknown";
}

function summarizeArtifact(artifact) {
  const data = artifact?.data || {};
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  const summary = data.summary || {};
  const uniqueDetected = new Set(timeline.map((r) => r?.speaker).filter((s) => s && s !== "unknown"));
  const speakerList = Array.isArray(summary.speakers) && summary.speakers.length ? summary.speakers : [...uniqueDetected];
  const count = typeof summary.speaker_count === "number" ? summary.speaker_count : speakerList.length;
  const unknownIntervals = timeline.filter((r) => !r?.speaker || r.speaker === "unknown").length;
  const noSpeech = summary.no_speech ?? (timeline.length === 0 || (count === 0 && unknownIntervals === 0));
  const singleSpeaker = summary.single_speaker ?? (count === 1);
  return { timeline, speakerList, count, unknownIntervals, noSpeech, singleSpeaker };
}

export function mount(container) {
  const root = el("div", { class: "pn pn-speakers" });
  container.replaceChildren(root);

  // ================= Identify speakers card =================
  const identifyBtn = el("button", { type: "button", class: "glass-button glass-button--prominent pn-wide" }, "Identify speakers");
  const identifyWhy = el("p", { class: "field-help pn-why", role: "status" });
  const jobStatus = el("p", { class: "field-help", role: "status", hidden: true });
  const jobBar = el("progress", { class: "pn-progress", max: 100, "aria-label": "Speaker check progress", hidden: true });
  const jobCancel = el("button", { type: "button", class: "glass-button glass-button--compact glass-button--filled", hidden: true }, "Cancel");

  const summaryTitle = el("h4", { class: "spk-summary-title" });
  const summaryBadge = el("span", { class: "badge" });
  const summaryBody = el("p", { class: "pn-copy pn-muted" });
  const applyBtn = el("button", { type: "button", class: "glass-button glass-button--filled" }, "Apply speaker labels");
  const previewList = el("ul", { class: "pn-timeline", "aria-label": "Detected speaker intervals" });
  const previewDetails = el("details", { class: "glass-disclosure", hidden: true },
    el("summary", null, el("span", null, "Detected speaker intervals"), icon("chevron-right")),
    el("div", { class: "glass-disclosure-body" }, previewList));
  const summaryCard = el("div", { class: "spk-summary", hidden: true },
    el("div", { class: "spk-summary-head" }, summaryTitle, summaryBadge),
    summaryBody,
    el("div", { class: "pn-actions" }, applyBtn),
    previewDetails);

  const identifyCard = el("div", { class: "group-box pn-box" },
    el("p", { class: "pn-copy pn-muted" },
      "Groups voices in the saved recording. Genuinely single-speaker or overlapping audio stays conservative instead of guessing extra speakers."),
    identifyBtn,
    identifyWhy,
    jobBar,
    el("div", { class: "pn-actions" }, jobStatus, jobCancel),
    summaryCard);

  // ================= Attribution reliability switch =================
  const switchId = uid("unreliable");
  const unreliable = el("input", { class: "switch", type: "checkbox", id: switchId, role: "switch", "aria-describedby": `${switchId}-help` });
  const unreliableDetails = el("details", { class: "glass-disclosure" },
    el("summary", null, el("span", null, "Attribution settings"), icon("chevron-right")),
    el("div", { class: "glass-disclosure-body" },
      el("div", { class: "pn-switch-row" },
        el("label", { for: switchId }, "More than 8 voices, or labels unreliable"),
        unreliable),
      el("p", { class: "field-help", id: `${switchId}-help` },
        "Turn on if many voices overlap or attribution seems wrong. Remote notes treat all speakers as anonymous and local speaker detection is paused.")));

  // ================= Names =================
  const listBox = el("div", { class: "pn-stack pn-names" });
  const empty = el("div", { class: "pn-empty-state" }, icon("person"), el("p", { class: "pn-empty-text" }));
  const saveBtn = el("button", { type: "button", class: "glass-button glass-button--filled" }, "Save speaker names");
  const cancelBtn = el("button", { type: "button", class: "glass-button" }, "Cancel");
  const status = el("p", { class: "field-help pn-status", role: "status", "aria-live": "polite" });
  const namesBox = el("div", { class: "group-box pn-box" }, listBox, el("div", { class: "pn-actions" }, saveBtn, cancelBtn), status);

  let sessionId = null;
  let signature = null;
  const inputs = new Map();
  let savedNames = {};
  let saving = false;
  let busy = false;
  let attributionBusy = false;

  const isDirty = () => [...inputs].some(([label, input]) => input.value.trim() !== (savedNames[label] || "").trim());

  function isIdle(s) {
    return (s?.recording_state || "idle") === "idle" && !["running", "cancelling"].includes(s?.job?.status) && !s?.pending_work;
  }

  function latestDiarizeArtifact(session) {
    const list = session?.artifacts || [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.kind === "diarize") return list[i];
    }
    return null;
  }

  function diarizeBlocker(s) {
    if (!s?.session) return "Open a saved session first.";
    if (!isIdle(s)) return "Stop recording and finish active tasks before identifying speakers.";
    if (!s.diarization?.ready) return s.diarization?.reason || "Speaker identification is not available on this Mac.";
    if (s.session.attribution_unreliable) return "Unavailable while labels are marked unreliable below.";
    for (const key of ["context", "session-context", "vocabulary"]) {
      if (store.dirty.has(key)) return "Save or cancel unsaved Setup drafts first.";
    }
    return "";
  }

  function refreshControls() {
    const s = store.state;
    const session = s?.session;
    const locked = !session || store.jobActive() || busy;
    const dirty = isDirty();
    if (dirty) store.dirty.add("speakers"); else store.dirty.delete("speakers");
    saveBtn.disabled = locked || !dirty || saving;
    cancelBtn.disabled = !dirty || saving;
    unreliable.disabled = locked || attributionBusy;

    const blocker = diarizeBlocker(s);
    identifyBtn.disabled = busy || Boolean(blocker);
    identifyWhy.textContent = blocker;

    const art = latestDiarizeArtifact(session);
    const stale = art ? Boolean(art.stale) || art.source_version !== session?.version : true;
    applyBtn.disabled = busy || !art || stale || !isIdle(s) || Boolean(session?.attribution_unreliable);
  }

  function labelsFor(state) {
    const names = state?.session?.speaker_names || {};
    const counts = new Map();
    for (const s of store.segments()) {
      const speaker = s.speaker || "unknown";
      if (s.status === "provisional") continue;
      counts.set(speaker, (counts.get(speaker) || 0) + 1);
    }
    const labels = [...new Set([...Object.keys(names), ...counts.keys()])]
      .filter((l) => l !== "unknown")
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    return { labels, names, counts };
  }

  function build(labels, names, counts) {
    listBox.replaceChildren();
    inputs.clear();
    for (const label of labels) {
      const id = uid("name");
      const input = el("input", {
        class: "text-input",
        type: "text",
        id,
        maxlength: "100",
        autocomplete: "off",
        value: names[label] || "",
        placeholder: "Enter participant name",
        "data-speaker": label,
      });
      input.addEventListener("input", () => { status.textContent = ""; refreshControls(); });
      const n = counts.get(label) || 0;
      listBox.append(el("div", { class: "field" },
        el("label", { for: id }, clusterTitle(label)),
        input,
        el("p", { class: "field-help tnum" }, `${n} ${n === 1 ? "caption" : "captions"}`)));
      inputs.set(label, input);
    }
  }

  identifyBtn.addEventListener("click", async () => {
    const s = store.state;
    if (!s?.session || diarizeBlocker(s) || busy) return;
    busy = true;
    refreshControls();
    try {
      await action("/api/job/start", { task: "diarize", session_id: s.session.id, expected_version: s.session.version });
    } finally {
      busy = false;
      refreshControls();
    }
  });

  jobCancel.addEventListener("click", async () => {
    busy = true;
    refreshControls();
    try { await action("/api/job/cancel", {}); } finally { busy = false; refreshControls(); }
  });

  applyBtn.addEventListener("click", async () => {
    const s = store.state;
    const art = latestDiarizeArtifact(s?.session);
    if (!art || applyBtn.disabled) return;
    const names = s?.session?.speaker_names || {};
    if (Object.values(names).some(Boolean)) {
      const ok = await confirmSheet({
        title: "Apply speaker assignments?",
        message: "This updates speaker labels across captions and clears saved speaker names.",
        confirmLabel: "Apply",
      });
      if (!ok) return;
    }
    busy = true;
    refreshControls();
    try {
      await action("/api/artifact/apply", { artifact_id: art.id, expected_version: art.source_version });
    } finally {
      busy = false;
      refreshControls();
    }
  });

  unreliable.addEventListener("change", async () => {
    const session = store.state?.session;
    if (!session) { unreliable.checked = false; return; }
    const wanted = unreliable.checked;
    attributionBusy = true;
    refreshControls();
    const ok = await action("/api/attribution", { unreliable: wanted, session_id: session.id }, {
      success: () => { status.textContent = wanted ? "Marked as unreliable." : "Speaker attribution restored."; },
    });
    attributionBusy = false;
    if (!ok) unreliable.checked = !wanted;
    refreshControls();
  });

  saveBtn.addEventListener("click", async () => {
    const session = store.state?.session;
    if (!session || saveBtn.disabled) return;
    const names = {};
    for (const [label, input] of inputs) if (input.value.trim()) names[label] = input.value.trim();
    saving = true;
    refreshControls();
    const ok = await action("/api/speakers", { names, session_id: session.id }, {
      success: () => { savedNames = names; signature = null; status.textContent = "Speaker names saved."; },
    });
    saving = false;
    if (ok) { for (const [label, input] of inputs) input.value = savedNames[label] || ""; }
    refreshControls();
  });

  cancelBtn.addEventListener("click", () => {
    for (const [label, input] of inputs) input.value = savedNames[label] || "";
    status.textContent = "";
    refreshControls();
  });

  root.append(
    el("section", { class: "pn-section", "aria-labelledby": "ps-h-id" },
      el("h3", { class: "pn-title", id: "ps-h-id" }, "Identify speakers"),
      identifyCard),
    el("section", { class: "pn-section", "aria-labelledby": "ps-h-names" },
      el("h3", { class: "pn-title", id: "ps-h-names" }, "Speaker names"),
      namesBox,
      empty),
    unreliableDetails,
  );

  function renderDiarizeArtifact(session) {
    const art = latestDiarizeArtifact(session);
    if (!art || art.status !== "ready") {
      summaryCard.hidden = true;
      return;
    }
    const stale = Boolean(art.stale) || art.source_version !== session?.version;
    const info = summarizeArtifact(art);
    summaryCard.hidden = false;
    summaryBadge.textContent = stale ? "Outdated" : info.noSpeech ? "No speech" : info.singleSpeaker ? "1 speaker" : `${info.count} speakers`;
    summaryBadge.className = `badge ${stale ? "badge--orange" : info.count > 1 ? "badge--green" : ""}`.trim();

    if (info.noSpeech) {
      summaryTitle.textContent = "No clear speech found";
      summaryBody.textContent = "No spoken intervals were clear enough to separate into speakers.";
    } else if (info.singleSpeaker) {
      summaryTitle.textContent = "1 speaker detected";
      summaryBody.textContent = info.unknownIntervals > 0
        ? `One primary voice detected across this recording (${info.unknownIntervals} ambiguous ${info.unknownIntervals === 1 ? "interval" : "intervals"} kept uncertain).`
        : "Only one speaker was heard across this recording; extra speakers were not invented.";
    } else {
      summaryTitle.textContent = `${info.count} speakers detected`;
      const parts = [info.speakerList.map(clusterTitle).join(", ")];
      if (info.unknownIntervals > 0) parts.push(`${info.unknownIntervals} overlapping or unclear ${info.unknownIntervals === 1 ? "interval" : "intervals"} kept uncertain`);
      summaryBody.textContent = parts.join(" · ");
    }

    const shown = info.timeline.slice(0, 24);
    previewList.replaceChildren(...shown.map((row) => el("li", null,
      el("span", { class: "tnum pn-muted" }, formatInterval(row)),
      el("span", { class: "badge" }, clusterTitle(row?.speaker || "unknown")))));
    previewDetails.hidden = shown.length === 0;
  }

  function update(state, changed) {
    if (changed && changed.size && !changed.has("state") && !changed.has("segment")) return;
    const session = state?.session ?? null;
    if ((session?.id ?? null) !== sessionId) {
      sessionId = session?.id ?? null;
      signature = null;
      status.textContent = "";
      store.dirty.delete("speakers");
    }

    const job = state?.job;
    const diarJob = job && job.task === "diarize" && job.session_id === session?.id;
    const active = diarJob && ["running", "cancelling"].includes(job.status);
    jobBar.hidden = !active;
    jobCancel.hidden = !active;
    if (diarJob) {
      const pct = typeof job.progress?.percent === "number" ? job.progress.percent : null;
      if (pct != null) jobBar.value = Math.max(0, Math.min(100, pct));
      else jobBar.removeAttribute("value");
      jobStatus.hidden = false;
      jobStatus.textContent = job.status === "failed"
        ? (job.error || "Speaker identification failed.")
        : job.progress?.stage || `Status: ${job.status}`;
    } else {
      jobStatus.hidden = true;
    }

    if (!session) {
      identifyCard.hidden = false;
      summaryCard.hidden = true;
      namesBox.hidden = true;
      unreliableDetails.hidden = true;
      empty.hidden = false;
      empty.querySelector("p").textContent = "Open a saved session to detect and name speakers.";
      listBox.replaceChildren();
      inputs.clear();
      signature = null;
      refreshControls();
      return;
    }

    unreliableDetails.hidden = false;
    if (!attributionBusy) unreliable.checked = Boolean(session.attribution_unreliable);
    renderDiarizeArtifact(session);

    const { labels, names, counts } = labelsFor(state);
    const sig = JSON.stringify([sessionId, labels, names, [...counts]]);
    const editing = namesBox.contains(document.activeElement) && isDirty();
    if (sig !== signature && !isDirty() && !editing) {
      signature = sig;
      savedNames = { ...names };
      build(labels, names, counts);
    } else if (!isDirty()) {
      savedNames = { ...names };
    }

    const hasLabels = labels.length > 0;
    namesBox.hidden = !hasLabels;
    empty.hidden = hasLabels;
    empty.querySelector("p").textContent = "No named speaker clusters yet. Run Identify speakers above when your recording finishes.";
    refreshControls();
  }

  const unsubscribe = store.subscribe(update);
  update(store.state);
  return function unmount() {
    unsubscribe();
    store.dirty.delete("speakers");
    root.remove();
  };
}
