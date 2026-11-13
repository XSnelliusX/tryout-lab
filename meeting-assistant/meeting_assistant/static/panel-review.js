// Notes & AI review tools: meeting notes/summary, transcript review, study vocabulary, local refinement, and gateway configuration.
import { el, icon, confirmSheet, toast } from "/glass.js";
import { createPinyinControl } from "/pinyin-ui.js";
import { store } from "/store.js";
import { action } from "/api.js";

const REMOTE_TASKS = ["summary", "review", "learning"];
const TASK_LABELS = {
  refine: "Re-check wording locally",
  diarize: "Identify speakers",
  review: "Suggest transcript fixes",
  summary: "Generate meeting notes",
  learning: "Extract study vocabulary",
};
const KIND_TITLES = {
  review: "Suggested transcript fixes",
  refine: "Local re-check candidates",
  diarize: "Speaker timeline",
  summary: "Meeting notes",
  learning: "Study vocabulary",
};
// Unsaved drafts that reset the send confirmation and block remote jobs.
const REMOTE_DRAFTS = { gateway: "gateway settings", context: "default context", "session-context": "session context", speakers: "speaker names", "segment-edit": "an open caption editor" };
// Drafts that block local jobs too (they change the inputs of every job).
const LOCAL_DRAFTS = { context: "default context", "session-context": "session context", vocabulary: "vocabulary" };
const TECHNICAL_ONLY = new Set(["refine", "diarize"]);
const CJK = /[㐀-鿿]/;
const TIMELINE_PREVIEW = 12;

let seq = 0;
const uid = (name) => `pr-${name}-${++seq}`;
const S = () => store.state;
const num = Number.isFinite;
const draftKeys = (map) => Object.keys(map).filter((k) => store.dirty.has(k));
const draftNames = (map) => draftKeys(map).map((k) => map[k]);
const zh = (text) => (CJK.test(text || "") ? "zh-Hant" : null);

function formatTime(s) {
  return num(s?.start) && num(s?.end) ? `${s.start.toFixed(1)}–${s.end.toFixed(1)} s` : "Manual text / time unknown";
}
function isIdle(s) {
  return (s?.recording_state || "idle") === "idle" && !["running", "cancelling"].includes(s?.job?.status) && !s?.pending_work;
}
const isStale = (a, session) => Boolean(a.stale) || a.source_version !== session?.version;
const isNotReady = (a) => a.status !== "ready" || Boolean(a.data?.status && a.data.status !== "ready");

function field(label, control, help) {
  const id = uid("f");
  control.id = id;
  const kids = [el("label", { for: id }, label), control];
  if (help) {
    control.setAttribute("aria-describedby", `${id}-help`);
    kids.push(el("p", { class: "field-help", id: `${id}-help` }, help));
  }
  return el("div", { class: "field" }, ...kids);
}
const p = (text, cls) => el("p", { class: cls || "pn-copy" }, text);

function progressInfo(progress) {
  if (progress == null || progress === "") return { text: "Progress unknown" };
  if (typeof progress === "string") return { text: progress };
  if (typeof progress !== "object") return { text: String(progress) };
  let percent = num(progress.percent) ? progress.percent : null;
  if (percent == null && num(progress.completed_chunks) && num(progress.total_chunks) && progress.total_chunks > 0) percent = (100 * progress.completed_chunks) / progress.total_chunks;
  if (percent == null && num(progress.processed_seconds) && num(progress.total_seconds) && progress.total_seconds > 0) percent = (100 * progress.processed_seconds) / progress.total_seconds;
  const parts = [];
  if (progress.stage) parts.push(String(progress.stage));
  if (num(progress.completed_chunks) && num(progress.total_chunks)) parts.push(`${progress.completed_chunks} of ${progress.total_chunks} chunks`);
  if (num(progress.processed_seconds) && num(progress.total_seconds)) parts.push(`${progress.processed_seconds.toFixed(0)} of ${progress.total_seconds.toFixed(0)} s of audio`);
  else if (num(progress.total_seconds)) parts.push(`${progress.total_seconds.toFixed(0)} s of audio`);
  if (progress.status) parts.push(String(progress.status));
  return { text: parts.join(" · ") || JSON.stringify(progress), percent: percent == null ? null : Math.max(0, Math.min(100, percent)) };
}

export function mount(container) {
  const root = el("div", { class: "pn-stack pn-review" });
  container.append(root);
  let busy = false;

  /** Run a request with the panel locked; resolves like action(). */
  async function run(path, body, options) {
    if (busy) return false;
    busy = true; updateControls();
    try { return await action(path, body, options); } finally { busy = false; updateControls(); }
  }

  // ================= Job status =================
  const jobBadge = el("span", { class: "badge" });
  const jobTitle = el("strong", { class: "pn-job-title" });
  const jobBar = el("progress", { class: "pn-progress", max: 100, "aria-label": "Job progress", hidden: true });
  const jobText = el("p", { class: "pn-copy" });
  const jobError = el("p", { class: "pn-copy pn-error-text", hidden: true });
  const cancelBtn = el("button", { type: "button", class: "glass-button glass-button--filled" }, "Cancel job");
  cancelBtn.addEventListener("click", () => run("/api/job/cancel", {}));
  const jobBox = el("div", { class: "group-box pn-box pn-stack pn-job", role: "status", "aria-live": "polite" },
    el("div", { class: "pn-job-head" }, jobTitle, jobBadge), jobBar, jobText, jobError, cancelBtn);

  // ================= Local jobs =================
  const localJobs = {};
  function jobItem(task, description) {
    const descId = uid("desc"), whyId = uid("why");
    const button = el("button", { type: "button", class: "glass-button glass-button--filled pn-wide", "aria-describedby": `${descId} ${whyId}` }, TASK_LABELS[task]);
    const why = el("p", { class: "field-help pn-why", id: whyId });
    const node = el("div", { class: "pn-job-item" }, button, el("p", { class: "field-help", id: descId }, description), why);
    localJobs[task] = { button, why };
    button.addEventListener("click", () => startJob(task));
    return node;
  }
  const localBox = el("div", { class: "group-box pn-box pn-stack" },
    jobItem("refine", "Re-checks saved audio locally with the speech model and suggests wording alternatives without editing automatically."));

  // ================= Remote jobs =================
  const endpoint = el("input", { class: "text-input", type: "url", autocomplete: "off", spellcheck: false, placeholder: "https://", maxlength: "2048", autocapitalize: "off" });
  const model = el("input", { class: "text-input", type: "text", autocomplete: "off", spellcheck: false, maxlength: "200", autocapitalize: "off" });
  const endpointHint = el("p", { class: "field-help pn-error-text", hidden: true }, "The gateway must use an https:// address.");
  const gwSave = el("button", { type: "button", class: "glass-button glass-button--filled" }, "Save gateway settings");
  const gwRevert = el("button", { type: "button", class: "glass-button", hidden: true }, "Revert");
  const gwStatus = el("p", { class: "field-help pn-status", role: "status", "aria-live": "polite" });
  const apiKey = el("input", { class: "text-input", type: "password", autocomplete: "off", spellcheck: false, maxlength: "8192", autocapitalize: "off" });
  const keyClear = el("button", { type: "button", class: "glass-button", hidden: true }, "Clear key");
  const endpointField = field("Gateway HTTPS endpoint", endpoint);
  endpointField.append(endpointHint);

  const gatewayBox = el("div", { class: "group-box pn-box pn-stack" },
    endpointField,
    field("Model", model),
    el("div", { class: "pn-actions" }, gwSave, gwRevert), gwStatus,
    el("hr", { class: "divider pn-divider" }),
    field("API key (optional, memory only)", apiKey,
      "The key is not saved in settings or browser storage. Clear it or close this page to discard it. If empty, the app uses the MEETING_ASSISTANT_GATEWAY_KEY environment variable when it is set."),
    el("div", { class: "pn-actions" }, keyClear));

  const gw = () => S()?.settings?.gateway || {};
  // Last values copied from the server into the fields; the draft is dirty when the fields differ from them.
  let gwSynced = { endpoint: "", model: "" };
  function gatewayDirty() { return endpoint.value !== gwSynced.endpoint || model.value !== gwSynced.model; }
  function onGatewayInput() {
    gwStatus.textContent = "";
    endpointHint.hidden = !endpoint.value || /^https:\/\//i.test(endpoint.value.trim());
    endpoint.setAttribute("aria-invalid", String(!endpointHint.hidden));
    updateControls();
  }
  endpoint.addEventListener("input", onGatewayInput);
  model.addEventListener("input", onGatewayInput);
  apiKey.addEventListener("input", () => { keyClear.hidden = !apiKey.value; });
  keyClear.addEventListener("click", () => { apiKey.value = ""; keyClear.hidden = true; apiKey.focus(); });
  gwRevert.addEventListener("click", () => { endpoint.value = gwSynced.endpoint; model.value = gwSynced.model; onGatewayInput(); endpoint.focus(); });
  gwSave.addEventListener("click", () => run("/api/settings", { gateway: { endpoint: endpoint.value, model: model.value } }, {
    success: () => { confirm.checked = false; gwStatus.textContent = "Gateway settings saved; the API key was not stored."; },
  }));

  // Payload preview
  const facts = el("dl", { class: "pn-facts" });
  const previewPre = el("pre", { class: "pn-pre", tabIndex: 0, "aria-label": "Full payload preview" });
  const previewSummary = el("summary", null, "Preview source text, context and speaker labels");
  const previewDetails = el("details", { class: "pn-preview" }, previewSummary,
    p("This is the source data before chunking and overlap. English translations and raw audio are not sent.", "field-help"), previewPre);
  const payloadEmpty = p("Open a session to preview the text payload.", "field-help");
  let previewJson = "";
  let sendable = 0;
  const payloadBox = el("div", { class: "group-box pn-box pn-stack" },
    el("h4", { class: "pn-subtitle" }, "What would be sent"), facts, payloadEmpty, previewDetails,
    p("Manual pasted translations are excluded. Source text may be sent in overlapping chunks.", "field-help"));
  previewDetails.addEventListener("toggle", () => { if (previewDetails.open) previewPre.textContent = previewJson; });

  const warning = el("div", { class: "banner banner--warning", role: "note" }, icon("warning"),
    el("p", { class: "pn-banner-text" }, "Remote review, summary and learning send transcript text, meeting context and speaker names to the configured gateway. Raw audio is not uploaded. Check the endpoint and your organization’s policy before sending."));

  const confirmId = uid("confirm");
  const confirm = el("input", { class: "switch", type: "checkbox", id: confirmId, role: "switch" });
  const confirmBox = el("div", { class: "group-box pn-box" },
    el("div", { class: "pn-switch-row" },
      el("label", { for: confirmId }, "I explicitly confirm sending this session’s text to the configured gateway."), confirm));
  const remoteButtons = {};
  const remoteWhy = el("p", { class: "field-help pn-why", id: uid("rwhy"), role: "status", "aria-live": "polite" });
  const remoteGrid = el("div", { class: "pn-btn-grid" }, REMOTE_TASKS.map((task) => {
    const button = el("button", { type: "button", class: "glass-button glass-button--filled", "aria-describedby": remoteWhy.id }, TASK_LABELS[task]);
    button.addEventListener("click", () => startJob(task));
    remoteButtons[task] = button;
    return button;
  }));
  confirm.addEventListener("change", updateControls);

  // ================= Results =================
  const results = el("div", { class: "pn-stack pn-results" });
  const resultsEmpty = p("No results yet. Run a job above; results for this session appear here.", "field-help");

  const jobSection = el("section", { class: "pn-section", "aria-labelledby": "pr-h-job", hidden: true },
    el("h3", { class: "pn-title", id: "pr-h-job" }, "Active task"), jobBox);

  const advancedAiDetails = el("details", { class: "glass-disclosure" },
    el("summary", null, el("span", null, "Transcript cleanup & AI gateway settings"), icon("chevron-right")),
    el("div", { class: "glass-disclosure-body" },
      el("h4", { class: "pn-subtitle" }, "On this Mac"),
      localBox,
      el("h4", { class: "pn-subtitle" }, "External gateway configuration"),
      warning, gatewayBox, payloadBox));

  root.append(
    jobSection,
    el("section", { class: "pn-section", "aria-labelledby": "pr-h-remote" },
      el("h3", { class: "pn-title", id: "pr-h-remote" }, "AI notes & review"),
      remoteGrid, confirmBox, remoteWhy),
    el("section", { class: "pn-section", "aria-labelledby": "pr-h-results" },
      el("h3", { class: "pn-title", id: "pr-h-results" }, "Saved AI results"),
      resultsEmpty, results),
    advancedAiDetails);

  // ================= Blockers =================
  function localBlockers(task) {
    const s = S(), out = [];
    if (!s?.session) { out.push("Open a session first."); return out; }
    if (!isIdle(s)) out.push("Stop capture and wait for pending work and jobs to finish.");
    if (task === "refine" && !s.model_ready) out.push("The local models are not ready yet.");
    if (task === "diarize") {
      if (!s.diarization?.ready) out.push("Diarization is not available on this Mac.");
      if (s.session.attribution_unreliable) out.push("Unavailable: attribution is marked unreliable in Speakers.");
    }
    const drafts = draftNames(LOCAL_DRAFTS);
    if (drafts.length) out.push(`Save or cancel your unsaved ${drafts.join(" and ")} first.`);
    return out;
  }
  function remoteBlockers() {
    const s = S(), out = [];
    if (!s?.session) { out.push("Open a session first."); return out; }
    if (!isIdle(s)) out.push("Stop capture and wait for pending work and jobs to finish.");
    const drafts = [...draftNames(REMOTE_DRAFTS), ...(store.dirty.has("vocabulary") ? ["vocabulary"] : [])];
    if (drafts.length) out.push(`Save or cancel your unsaved ${drafts.join(", ")} first.`);
    if (!gw().endpoint || !gw().model) out.push("Set and save the gateway endpoint and model first.");
    if (!sendable) out.push("This session has no audio-derived transcript text to send.");
    if (!out.length && !confirm.checked) out.push("Confirm sending above to enable the remote jobs.");
    return out;
  }

  // ================= Controls =================
  let lastScope = null;
  function enforceConfirm() {
    const s = S();
    const scope = JSON.stringify([s?.session?.id, s?.session?.version, s?.settings?.gateway]);
    if (scope !== lastScope) { confirm.checked = false; lastScope = scope; }
    if (draftKeys(REMOTE_DRAFTS).length) confirm.checked = false;
  }
  function updateControls() {
    const s = S();
    const dirty = gatewayDirty();
    if (dirty) store.dirty.add("gateway"); else store.dirty.delete("gateway");
    enforceConfirm();
    const active = store.jobActive();
    gwSave.disabled = busy || !dirty || active;
    gwSave.title = active ? "Locked while a job is running" : "";
    gwRevert.hidden = !dirty;
    for (const [task, { button, why }] of Object.entries(localJobs)) {
      const reasons = localBlockers(task);
      button.disabled = busy || reasons.length > 0;
      why.textContent = reasons[0] || "";
      why.hidden = !reasons.length;
    }
    confirm.disabled = busy || !s?.session || draftKeys(REMOTE_DRAFTS).length > 0;
    const reasons = remoteBlockers();
    for (const button of Object.values(remoteButtons)) button.disabled = busy || reasons.length > 0;
    remoteWhy.textContent = reasons[0] || "";
    remoteWhy.hidden = !reasons.length;
    cancelBtn.disabled = busy || !active || s?.job?.status === "cancelling";
  }

  async function startJob(task) {
    const s = S();
    if (!s?.session) return;
    const remote = REMOTE_TASKS.includes(task);
    const blockers = remote ? remoteBlockers() : localBlockers(task);
    if (blockers.length || (remote && !confirm.checked)) { updateControls(); return; }
    const body = { task, session_id: s.session.id, expected_version: s.session.version };
    if (remote) {
      body.confirm_send = true;
      body.expected_gateway = s.settings.gateway;
      if (apiKey.value) body.api_key = apiKey.value;
    }
    await run("/api/job/start", body, { success: () => { if (remote) confirm.checked = false; } });
    updateControls();
  }

  // ================= Renderers =================
  function updateJob(s) {
    const job = s?.job;
    const badgeKind = { running: "accent", cancelling: "orange", complete: "green", failed: "red", cancelled: "orange" }[job?.status] || "";
    if (!job || job.task === "diarize") {
      jobSection.hidden = true;
      jobTitle.textContent = "No active task";
      jobBadge.hidden = true; jobBar.hidden = true; jobError.hidden = true;
      jobText.textContent = "";
      return;
    }
    jobSection.hidden = false;
    jobTitle.textContent = TASK_LABELS[job.task] || job.task || "Unknown task";
    jobBadge.hidden = false;
    jobBadge.className = `badge${badgeKind ? ` badge--${badgeKind}` : ""}`;
    jobBadge.textContent = job.status ? job.status[0].toUpperCase() + job.status.slice(1) : "Unknown";
    const info = progressInfo(job.progress);
    jobText.textContent = info.text;
    const active = ["running", "cancelling"].includes(job.status);
    jobBar.hidden = !(active && info.percent != null);
    if (!jobBar.hidden) jobBar.value = info.percent;
    jobError.hidden = !job.error;
    jobError.textContent = job.error ? `Error: ${job.error}` : "";
  }

  function updateLocal() {
    /* Speaker identification status now renders directly in the Speakers tab. */
  }

  function updateGateway(s) {
    const saved = { endpoint: gw().endpoint || "", model: gw().model || "" };
    if (!gatewayDirty()) {
      endpoint.value = saved.endpoint; model.value = saved.model;
    }
    gwSynced = saved;
    void s;
  }

  function updatePayload(s) {
    const session = s?.session;
    facts.replaceChildren();
    if (!session) {
      payloadEmpty.hidden = false; facts.hidden = true; previewDetails.hidden = true;
      previewJson = ""; sendable = 0;
      return;
    }
    payloadEmpty.hidden = true; facts.hidden = false; previewDetails.hidden = false;
    const segments = store.segments().filter((seg) => seg.kind === "audio" && seg.status !== "provisional");
    const chars = segments.reduce((n, seg) => n + (seg.traditional_text || "").length, 0);
    const used = new Set(segments.map((seg) => seg.speaker || "unknown"));
    const names = session.attribution_unreliable ? {} : Object.fromEntries(Object.entries(session.speaker_names || {}).filter(([k, name]) => k !== "unknown" && used.has(k) && name));
    const withText = segments.filter((seg) => seg.traditional_text);
    sendable = withText.length;
    const ctxLen = String(session.context || "").length;
    const rows = [
      ["Segments", `${segments.length} audio-derived`],
      ["Source text", `${chars.toLocaleString("en-US")} reviewed characters`],
      ["Context", `${ctxLen.toLocaleString("en-US")} of 4,000 characters`],
      ["Speaker names", `${Object.keys(names).length} reviewed${session.attribution_unreliable ? " (anonymous: attribution unreliable)" : ""}`],
      ["Gateway", gw().endpoint || "not configured"],
      ["Model", gw().model || "not configured"],
    ];
    for (const [k, v] of rows) facts.append(el("dt", null, k), el("dd", null, v));
    previewJson = JSON.stringify({
      context: session.context || "", speaker_names: names,
      segments: withText.map((seg) => ({ id: seg.id, text: seg.traditional_text, speaker: session.attribution_unreliable ? "unknown" : (seg.speaker || "unknown") })),
    }, null, 2);
    if (previewDetails.open && previewPre.textContent !== previewJson) previewPre.textContent = previewJson;
  }

  // ---- artifacts ----
  const artifactViews = new Map(); // id -> {node, sig, open}

  function evidenceList(list) {
    if (!list?.length) return null;
    return el("ul", { class: "pn-evidence" }, list.map((ev) =>
      el("li", null, el("span", { class: "pn-muted" }, `Segment ${ev.segment_id ?? "unknown"}: `), el("q", { lang: zh(ev.quote) }, ev.quote || ""))));
  }

  function guarded(button, fn) {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      try { await fn(); } finally { if (button.isConnected) updateResultsControlsLater(); }
    });
    return button;
  }
  function updateResultsControlsLater() { renderResults(true); }

  function reviewBody(artifact, ctx) {
    const nodes = [];
    (artifact.data?.proposals || []).forEach((proposal, index) => {
      const approve = el("button", { type: "button", class: "glass-button glass-button--filled", "data-fk": `approve-${index}` }, "Approve this proposal");
      approve.disabled = ctx.stale || ctx.notReady || !ctx.idle || busy;
      guarded(approve, () => run("/api/artifact/apply", { artifact_id: artifact.id, proposal_index: index, expected_version: artifact.source_version }));
      const pinyinCtl = createPinyinControl(() => proposal.replacement || proposal.original || "", { label: "Pinyin", compact: true });
      pinyinCtl.sync();
      nodes.push(el("div", { class: "pn-item" },
        el("div", { class: "pn-item-head" }, el("strong", null, `Segment ${proposal.segment_id ?? "?"}`),
          el("span", { class: "badge" }, `Uncertainty: ${proposal.uncertainty || "unknown"}`)),
        el("dl", { class: "pn-diff" },
          el("dt", null, "Original"), el("dd", { lang: zh(proposal.original) }, proposal.original || ""),
          el("dt", null, "Proposed"), el("dd", { class: "pn-proposed", lang: zh(proposal.replacement) }, proposal.replacement || ""),
          el("dt", null, "Evidence"), el("dd", { lang: zh(proposal.quote) }, el("q", null, proposal.quote || "")),
          el("dt", null, "Reason"), el("dd", null, proposal.reason || "unknown")),
        pinyinCtl.host,
        el("div", { class: "pn-actions" }, approve, pinyinCtl.button)));
    });
    if (!nodes.length) nodes.push(p("No proposals in this result.", "field-help"));
    return nodes;
  }

  function refineBody(artifact) {
    const nodes = [p("Candidates use different audio windows and cannot be applied automatically. Copy a candidate into the appropriate segment editor after review.", "field-help")];
    (artifact.data?.segments || []).forEach((candidate, index) => {
      const copy = el("button", { type: "button", class: "glass-button glass-button--filled", "data-fk": `copy-${index}` }, "Copy candidate");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(candidate.traditional_text || "");
          toast("Candidate copied. Paste it into the appropriate segment editor and review.", { kind: "success" });
        } catch (error) {
          toast("Clipboard unavailable. Select and copy the candidate text manually.", { kind: "warning" });
        }
      });
      const candZh = el("p", { class: "pn-zh", lang: "zh-Hant" }, candidate.traditional_text || "");
      const py = createPinyinControl(() => candidate.traditional_text || "", { label: "Pinyin", compact: true, replaceEl: candZh });
      py.sync();
      nodes.push(el("div", { class: "pn-item" },
        el("div", { class: "pn-item-head" }, el("strong", { class: "tnum" }, formatTime(candidate)), py.button),
        el("div", { class: "py-slot" }, candZh, py.host),
        candidate.english ? el("p", { class: "pn-en" }, candidate.english) : null,
        copy));
    });
    if (nodes.length === 1) nodes.push(p("No candidates in this result.", "field-help"));
    return nodes;
  }

  function diarizeBody(artifact, ctx, view) {
    const timeline = artifact.data?.timeline || [];
    const nodes = [p(`${timeline.length} speaker ${timeline.length === 1 ? "interval" : "intervals"}. Assignments are approximate, not verified identities.`, "field-help")];
    const shown = view.expanded ? timeline : timeline.slice(0, TIMELINE_PREVIEW);
    if (timeline.length) {
      nodes.push(el("ul", { class: "pn-timeline", "aria-label": "Speaker intervals" }, shown.map((row) =>
        el("li", null, el("span", { class: "tnum pn-muted" }, formatTime(row)), el("span", { class: "badge" }, row.speaker || "unknown")))));
    }
    if (timeline.length > TIMELINE_PREVIEW) {
      const more = el("button", { type: "button", class: "glass-button", "data-fk": "expand", "aria-expanded": String(Boolean(view.expanded)) }, view.expanded ? "Show fewer" : `Show all ${timeline.length}`);
      more.addEventListener("click", () => { view.expanded = !view.expanded; view.sig = ""; renderResults(true); });
      nodes.push(more);
    }
    nodes.push(p("Applying replaces the speaker labels on this session’s captions and clears saved speaker names, because new cluster numbers do not prove who is who. Name the clusters again afterwards.", "field-help"));
    const apply = el("button", { type: "button", class: "glass-button glass-button--filled", "data-fk": "apply" }, "Apply speaker assignments");
    apply.disabled = ctx.stale || ctx.notReady || !ctx.idle || busy || Boolean(S()?.session?.attribution_unreliable);
    guarded(apply, async () => {
      const names = S()?.session?.speaker_names || {};
      if (Object.values(names).some(Boolean)) {
        const ok = await confirmSheet({
          title: "Apply speaker assignments?",
          message: "This replaces the speaker labels on the captions and clears the speaker names you saved. You can name the clusters again afterwards.",
          confirmLabel: "Apply",
        });
        if (!ok) return;
      }
      await run("/api/artifact/apply", { artifact_id: artifact.id, expected_version: artifact.source_version });
    });
    nodes.push(apply);
    return nodes;
  }

  function summaryBody(artifact) {
    const data = artifact.data || {};
    const nodes = [];
    const SECTIONS = { overview: "Overview", decisions: "Decisions", actions: "Actions", people: "People" };
    for (const [key, title] of Object.entries(SECTIONS)) {
      nodes.push(el("h5", { class: "pn-section-label" }, title));
      const entries = data[key] || [];
      if (!entries.length) nodes.push(p("None available.", "field-help"));
      for (const entry of entries) {
        const meta = key === "actions"
          ? p(`Status: ${entry.status || "unknown"} · Owner: ${entry.owner || "unknown"} · Deadline: ${entry.deadline || "unknown"}`, "field-help") : null;
        nodes.push(el("div", { class: "pn-item" },
          el("p", { class: "pn-copy" }, `${entry.speaker ? `${entry.speaker}: ` : ""}${entry.text || entry.summary || ""}`), meta, evidenceList(entry.evidence)));
      }
    }
    return nodes;
  }

  function learningBody(artifact) {
    const items = artifact.data?.items || [];
    if (!items.length) return [p("No learning items available.", "field-help")];
    const vocab = S()?.settings?.vocabulary || [];
    const segs = store.segments();
    return items.map((item, index) => {
      const existing = vocab.find((v) => v.term === item.term);
      const segment = segs.find((seg) => seg.id === item.segment_id);
      let control;
      if (existing) {
        const mark = el("button", { type: "button", class: "glass-button", "data-fk": `learn-${index}` }, existing.known ? "Mark not known" : "Mark known");
        guarded(mark, async () => {
          if (store.dirty.has("vocabulary")) { toast("Save or cancel vocabulary edits first.", { kind: "warning" }); return; }
          const next = (S()?.settings?.vocabulary || []).map((v) => (v.id === existing.id ? { ...v, known: !v.known } : v));
          await run("/api/settings", { vocabulary: next });
        });
        control = el("div", { class: "pn-learn-actions" }, el("span", { class: `badge${existing.known ? " badge--green" : ""}` }, existing.known ? "Known" : "In vocabulary"), mark);
      } else {
        const add = el("button", { type: "button", class: "glass-button", "data-fk": `learn-${index}` }, "Add to vocabulary");
        guarded(add, () => run("/api/vocabulary", { term: item.term, translation: item.meaning || "", note: "Added from learning results" }));
        control = el("div", { class: "pn-learn-actions" }, add);
      }
      const quoteEl = item.quote ? el("p", { class: "pn-quote", lang: zh(item.quote) }, el("q", null, item.quote)) : null;
      const py = createPinyinControl(() => item.quote || item.term || "", { label: "Pinyin", compact: true, replaceEl: quoteEl });
      py.sync();
      return el("div", { class: "pn-item" },
        el("div", { class: "pn-learn-head" }, el("span", { class: "pn-learn-term", lang: zh(item.term) || "zh-Hant" }, item.term || "unknown"), el("span", { class: "pn-muted" }, item.pinyin || "unknown"), py.button),
        el("p", { class: "pn-copy" }, item.meaning || "unknown"),
        el("p", { class: "field-help" }, `Segment ${item.segment_id ?? "unknown"} · ${segment ? formatTime(segment) : "time unknown"}`),
        quoteEl ? el("div", { class: "py-slot" }, quoteEl, py.host) : py.host,
        el("p", { class: "field-help" }, `${item.validation_status || "validation unknown"} · ${item.dictionary_provenance || "provenance unknown"}`),
        item.validation_flags?.length ? el("p", { class: "field-help" }, item.validation_flags.join(" · ")) : null,
        control);
    });
  }

  function buildArtifact(artifact, view) {
    const s = S();
    const session = s.session;
    const data = artifact.data || {};
    const stale = isStale(artifact, session), notReady = isNotReady(artifact);
    const ctx = { stale, notReady, idle: isIdle(s) };
    const title = KIND_TITLES[artifact.kind] || String(artifact.kind || "Unknown result");
    const badges = el("span", { class: "pn-badges" });
    badges.append(stale ? el("span", { class: "badge badge--orange" }, "Stale")
      : el("span", { class: `badge${notReady ? " badge--red" : " badge--green"}` }, notReady ? (artifact.status || "Not ready") : "Current"));
    const summary = el("summary", { "data-fk": "summary" },
      icon("chevron-right"), el("span", { class: "pn-art-title" }, title), badges);
    const body = el("div", { class: "pn-art-body" });
    body.append(p(`Based on session version ${artifact.source_version ?? "unknown"}${data.status && data.status !== artifact.status ? ` · result status: ${data.status}` : ""}`, "field-help tnum"));
    if (stale) body.append(el("div", { class: "banner banner--warning", role: "note" }, icon("warning"), p("The session changed since this result was generated. Re-run the job before applying.", "pn-banner-text")));
    if (notReady) body.append(el("div", { class: "banner banner--warning", role: "note" }, icon("warning"), p("This result is not ready; applying is disabled.", "pn-banner-text")));
    for (const limitation of data.limitations || []) body.append(p(limitation, "field-help"));
    const content = {
      review: () => reviewBody(artifact, ctx), refine: () => refineBody(artifact), diarize: () => diarizeBody(artifact, ctx, view),
      summary: () => summaryBody(artifact), learning: () => learningBody(artifact),
    }[artifact.kind];
    if (content) body.append(...content());
    const details = el("details", { class: "pn-artifact", open: view.open }, summary, body);
    details.dataset.stale = stale ? "1" : "0";
    details.addEventListener("toggle", () => { view.open = details.open; });
    return details;
  }

  function artifactSig(artifact, s) {
    const session = s.session;
    const extra = artifact.kind === "learning" ? [s.settings?.vocabulary, store.segments().length]
      : artifact.kind === "diarize" ? [session.attribution_unreliable, Object.keys(session.speaker_names || {}).length] : null;
    return JSON.stringify([artifact, session.version, isIdle(s), extra]);
  }

  function renderResults(force = false) {
    const s = S();
    const session = s?.session;
    const list = session?.artifacts || [];
    resultsEmpty.hidden = list.length > 0;
    resultsEmpty.textContent = session ? "No results yet. Run a job above; results for this session appear here." : "Open a session to see its results.";
    const ids = new Set(list.map((a) => a.id));
    for (const [id, view] of artifactViews) if (!ids.has(id)) { view.node.remove(); artifactViews.delete(id); }
    const ordered = [...list].reverse().sort((a, b) => isStale(a, session) - isStale(b, session)); // current first, newest first
    const focusKey = results.contains(document.activeElement) ? document.activeElement.dataset?.fk : null;
    const focusOwner = focusKey ? document.activeElement.closest("details")?.dataset?.id : null;
    ordered.forEach((artifact, position) => {
      let view = artifactViews.get(artifact.id);
      if (!view) {
        view = { node: null, sig: "", open: !isStale(artifact, session), expanded: false };
        artifactViews.set(artifact.id, view);
      }
      const sig = artifactSig(artifact, s);
      if (view.node && sig === view.sig && !force) return;
      view.sig = sig;
      const fresh = buildArtifact(artifact, view);
      fresh.dataset.id = artifact.id;
      if (view.node) view.node.replaceWith(fresh); else results.append(fresh);
      view.node = fresh;
    });
    // Order (newest first) without recreating nodes.
    ordered.forEach((artifact, position) => {
      const node = artifactViews.get(artifact.id)?.node;
      if (node && results.children[position] !== node) results.insertBefore(node, results.children[position] || null);
    });
    if (focusKey && focusOwner && !results.contains(document.activeElement)) {
      const node = artifactViews.get(focusOwner)?.node;
      (node?.querySelector(`[data-fk="${focusKey}"]:not(:disabled)`) || node?.querySelector("summary"))?.focus();
    }
  }

  // ================= Update loop =================
  let lastSession;
  function update(state, changed) {
    if (changed && changed.size && !changed.has("state") && !changed.has("segment")) return;
    const s = state;
    if ((s?.session?.id ?? null) !== lastSession) {
      lastSession = s?.session?.id ?? null;
      artifactViews.clear();
      results.replaceChildren();
      gwStatus.textContent = "";
    }
    updateGateway(s);
    updateJob(s);
    updateLocal(s);
    updatePayload(s);
    updateControls();
    renderResults();
  }
  const unsubscribe = store.subscribe(update);
  update(store.state);

  // store.dirty is a plain Set, so watch the keys this panel depends on.
  const watchedKeys = [...Object.keys(REMOTE_DRAFTS), ...Object.keys(LOCAL_DRAFTS)];
  let lastDraftSig = "";
  const timer = setInterval(() => {
    const sig = watchedKeys.filter((k) => store.dirty.has(k)).join(",");
    if (sig !== lastDraftSig) { lastDraftSig = sig; updateControls(); }
  }, 250);

  return function unmount() {
    clearInterval(timer);
    unsubscribe();
    store.dirty.delete("gateway");
    root.remove();
  };
}
