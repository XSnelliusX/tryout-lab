// Export & Save actions for Notes tab: export formats, quick transcript save, optional transcript note, and archive path.
import { el, icon, toast } from "/glass.js";
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
  const root = el("div", { class: "pn-stack pn-export" });
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

  // ---- Manual note into transcript ----
  const manualId = uid("manual");
  const manual = el("textarea", { class: "text-area", id: manualId, rows: 3, maxlength: "5000", lang: "zh-Hant", placeholder: "Enter Chinese text to add to this transcript…", "aria-describedby": `${manualId}-help` });
  const manualCount = el("span", { class: "pn-count tnum" });
  const translateBtn = el("button", { type: "button", class: "glass-button glass-button--filled" }, "Add to transcript");
  const manualStatus = el("p", { class: "field-help pn-status", role: "status", "aria-live": "polite" });
  const manualWhy = el("p", { class: "field-help", role: "status" });
  manual.addEventListener("input", () => { manualStatus.textContent = ""; refresh(); });
  translateBtn.addEventListener("click", async () => {
    if (translateBtn.disabled) return;
    busy = true; refresh();
    await action("/api/manual", { text: manual.value }, {
      success: () => { manual.value = ""; manualStatus.textContent = "Added and translated into the transcript."; },
    });
    busy = false; refresh();
  });

  // ---- Archive and privacy ----
  const archive = el("code", { class: "pn-path", tabIndex: 0 });

  root.append(
    el("section", { class: "pn-section", "aria-labelledby": "pe-h-export" },
      el("h3", { class: "pn-title", id: "pe-h-export" }, "Export & Save"),
      el("p", { class: "field-help" },
        "Download a separate snapshot of this session. Later transcript edits won’t overwrite exported files."),
      el("ul", { class: "group-box pn-box pn-formats", "aria-label": "Export formats" }, rows),
      exportNeedsSession, exportResult.box, exportStatus,
      el("div", { class: "pn-actions" }, saveBtn), saveResult.box, saveStatus),
    el("details", { class: "glass-disclosure" },
      el("summary", null, el("span", null, "Add Chinese line to transcript"), icon("chevron-right")),
      el("div", { class: "glass-disclosure-body" },
        el("div", { class: "field" },
          el("label", { for: manualId }, "Chinese text"),
          manual,
          el("p", { class: "field-help", id: `${manualId}-help` }, "Appends text into the session transcript and translates it locally."),
          manualCount),
        el("div", { class: "pn-actions" }, translateBtn),
        manualWhy, manualStatus)),
    el("details", { class: "glass-disclosure" },
      el("summary", null, el("span", null, "Archive folder & privacy"), icon("chevron-right")),
      el("div", { class: "glass-disclosure-body" },
        el("p", { class: "pn-copy" },
          "Live audio, transcription and translation stay on this Mac. Optional post-meeting AI notes send transcript text only when you explicitly confirm."),
        el("p", { class: "pn-copy" }, "Local sessions and exports folder:"),
        archive)));

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
