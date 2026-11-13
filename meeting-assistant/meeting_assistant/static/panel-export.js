// Inspector panel "Export": exports, transcript save, manual translation, archive location and privacy.
import { el, toast } from "/glass.js";
import { store } from "/store.js";
import { action } from "/api.js";

let seq = 0;
const uid = (name) => `pe-${name}-${++seq}`;

const FORMATS = [
  { id: "markdown", label: "Markdown", detail: "Readable transcript with English, Chinese, speakers, revisions and result status." },
  { id: "json", label: "JSON", detail: "Full session record with segments and results. Settings and credentials are excluded." },
  { id: "anki", label: "Anki", detail: "Tab-separated study cards from the current Learning result. Import as text and map the six fields." },
];

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, { kind: "success", timeout: 2500 });
  } catch (error) {
    toast("Clipboard unavailable. Select the path and copy it manually.", { kind: "warning" });
  }
}

/** A saved-path readout with a copy button; the path text is selectable. */
function pathResult() {
  const text = el("code", { class: "pn-path", tabIndex: 0 });
  const copy = el("button", { type: "button", class: "glass-button", "aria-label": "Copy path", title: "Copy path" }, "Copy");
  const label = el("span", { class: "field-help" });
  const box = el("div", { class: "pn-result", hidden: true }, label, el("div", { class: "pn-path-row" }, text, copy));
  copy.addEventListener("click", () => copyText(text.textContent, "Path copied."));
  return {
    box,
    show(kind, path) { label.textContent = kind; text.textContent = path; box.hidden = false; },
  };
}

export function mount(container) {
  const root = el("div", { class: "pn pn-export" });
  container.append(root);
  let busy = false;

  // ---- Exports ----
  const exportStatus = el("p", { class: "field-help pn-status", role: "status", "aria-live": "polite" });
  const exportResult = pathResult();
  const exportButtons = new Map();
  const rows = FORMATS.map((f) => {
    const button = el("button", { type: "button", class: "glass-button glass-button--filled", "aria-label": `Export ${f.label}` }, "Export");
    exportButtons.set(f.id, button);
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      busy = true; refresh();
      exportStatus.textContent = "";
      const ok = await action("/api/export", { format: f.id }, {
        success: (result) => { exportResult.show(`${f.label} saved`, result?.path ?? "(path unknown)"); exportStatus.textContent = `${f.label} export saved.`; },
      });
      busy = false; refresh();
    });
    return el("li", { class: "pn-format" },
      el("div", { class: "pn-format-text" }, el("strong", null, f.label), el("span", { class: "pn-muted" }, f.detail)),
      button);
  });
  const exportNeedsSession = el("p", { class: "field-help", hidden: true }, "Open a saved session to export it.");

  // ---- Save transcript ----
  const saveBtn = el("button", { type: "button", class: "glass-button glass-button--filled" }, "Save transcript");
  const saveResult = pathResult();
  const saveStatus = el("p", { class: "field-help pn-status", role: "status", "aria-live": "polite" });
  saveBtn.addEventListener("click", async () => {
    busy = true; refresh();
    saveStatus.textContent = "";
    await action("/api/save", {}, {
      success: (result) => { saveResult.show("Transcript saved", result?.path ?? "(path unknown)"); saveStatus.textContent = "Transcript saved."; },
    });
    busy = false; refresh();
  });

  // ---- Manual translation ----
  const manualId = uid("manual");
  const manual = el("textarea", { class: "text-area", id: manualId, rows: 4, maxlength: "5000", lang: "zh-Hant", placeholder: "輸入中文…", "aria-describedby": `${manualId}-help` });
  const manualCount = el("span", { class: "pn-count tnum" });
  const translateBtn = el("button", { type: "button", class: "glass-button glass-button--filled" }, "Translate");
  const manualStatus = el("p", { class: "field-help pn-status", role: "status", "aria-live": "polite" });
  const manualWhy = el("p", { class: "field-help", role: "status" });
  manual.addEventListener("input", () => { manualStatus.textContent = ""; refresh(); });
  translateBtn.addEventListener("click", async () => {
    if (translateBtn.disabled) return;
    busy = true; refresh();
    await action("/api/manual", { text: manual.value }, {
      success: () => { manual.value = ""; manualStatus.textContent = "Added to the transcript. Manual text is excluded from remote processing."; },
    });
    busy = false; refresh();
  });

  // ---- Archive and privacy ----
  const archive = el("code", { class: "pn-path", tabIndex: 0 });

  root.append(
    el("section", { class: "pn-section", "aria-labelledby": "pe-h-export" },
      el("h3", { class: "pn-title", id: "pe-h-export" }, "Export session"),
      el("p", { class: "field-help" },
        "Each export is a separate copy, not a live view: later edits do not update files you already exported. Exports can contain sensitive meeting content, so avoid shared or cloud-synced folders unless that is authorised."),
      el("ul", { class: "group-box pn-box pn-formats", "aria-label": "Export formats" }, rows),
      exportNeedsSession, exportResult.box, exportStatus),
    el("section", { class: "pn-section", "aria-labelledby": "pe-h-save" },
      el("h3", { class: "pn-title", id: "pe-h-save" }, "Transcript file"),
      el("p", { class: "field-help" },
        "Save writes the captions that are available now. Stop and finish the recording first, and wait until finishing is done, to get the full available transcript."),
      el("div", { class: "pn-actions" }, saveBtn), saveResult.box, saveStatus),
    el("section", { class: "pn-section", "aria-labelledby": "pe-h-manual" },
      el("h3", { class: "pn-title", id: "pe-h-manual" }, "Translate pasted text"),
      el("div", { class: "group-box pn-box pn-stack" },
        el("div", { class: "field" },
          el("label", { for: manualId }, "Chinese text"),
          manual,
          el("p", { class: "field-help", id: `${manualId}-help` }, "Paste Chinese text as a fallback. It uses the same local model worker as captions."),
          manualCount),
        el("div", { class: "pn-actions" }, translateBtn),
        manualWhy, manualStatus)),
    el("section", { class: "pn-section", "aria-labelledby": "pe-h-privacy" },
      el("h3", { class: "pn-title", id: "pe-h-privacy" }, "Archive and privacy"),
      el("div", { class: "group-box pn-box pn-stack" },
        el("p", { class: "pn-copy" },
          "Live audio, transcription and translation stay on this Mac. Optional post-meeting text processing sends text to your chosen gateway only after confirmation. Recording saves audio and transcript events locally until you delete them. Exports are separate copies. Review consent and your organization’s policy before recording."),
        el("p", { class: "pn-copy" }, "Sessions and exports are stored here:"),
        archive,
        el("p", { class: "pn-copy" },
          "Delete session folders and exports there when no longer needed; backups or other copies must be removed separately."))));

  function refresh() {
    const s = store.state;
    const hasSession = Boolean(s?.session);
    for (const button of exportButtons.values()) button.disabled = busy || !hasSession;
    exportNeedsSession.hidden = hasSession;
    saveBtn.disabled = busy;
    manualCount.textContent = `${manual.value.length.toLocaleString("en-US")} / 5,000`;
    const reason = !s ? "" : !s.model_ready ? "The local models are not ready yet."
      : store.jobActive() ? "Wait for the running job to finish."
      : s.recording_state === "draining" ? "Wait until capture has finished draining."
      : "";
    manualWhy.textContent = reason;
    translateBtn.disabled = busy || Boolean(reason) || !s || !manual.value.trim();
    if (manual.value) store.dirty.add("manual-text"); else store.dirty.delete("manual-text");
    archive.textContent = s?.session_path || s?.archive_dir || "~/Library/Application Support/Meeting Assistant/sessions";
  }

  let lastSession;
  function update(state, changed) {
    if (changed && changed.size && !changed.has("state")) return;
    if ((state?.session?.id ?? null) !== lastSession) {
      lastSession = state?.session?.id ?? null;
      exportResult.box.hidden = true;
      exportStatus.textContent = "";
    }
    refresh();
  }
  const unsubscribe = store.subscribe(update);
  update(store.state);
  return function unmount() {
    unsubscribe();
    store.dirty.delete("manual-text");
    root.remove();
  };
}
