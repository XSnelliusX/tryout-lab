// Inspector panel "Context": default meeting context, per-session context, vocabulary.
import { el, icon, confirmSheet, toast } from "/glass.js";
import { store } from "/store.js";
import { action } from "/api.js";

const TECHNICAL_EXAMPLE = "Technical meeting discussing software development, architecture, infrastructure, incidents, and project decisions.";
const CONTEXT_MAX = 4000;
const VOCAB_MAX = 128;
const CJK = /[㐀-鿿]/;
let seq = 0;
const uid = (name) => `pc-${name}-${++seq}`;
const sameText = (a, b) => (a ?? "") === (b ?? "");
const idleNow = (s) => (s?.recording_state || "idle") === "idle";
const jobBusy = () => store.jobActive();

/** Label + control + optional help text, wired with for/aria-describedby. */
function field(label, control, help, extra) {
  const id = uid("f");
  control.id = id;
  const children = [el("label", { for: id }, label), control];
  if (help) {
    const helpNode = el("p", { class: "field-help", id: `${id}-help` }, help);
    control.setAttribute("aria-describedby", `${id}-help`);
    children.push(helpNode);
  }
  if (extra) children.push(extra);
  return el("div", { class: "field" }, ...children);
}

/**
 * A draft editor for one context string. `saved()` returns the persisted value, `locked()` tells whether saving is
 * disallowed right now. The draft is never overwritten while it differs from the saved value.
 */
function contextEditor({ label, help, dirtyKey, saveLabel, locked, onSave }) {
  const area = el("textarea", { class: "text-area pn-context-area", rows: 5, maxlength: String(CONTEXT_MAX), spellcheck: true });
  const count = el("span", { class: "pn-count tnum" });
  const status = el("p", { class: "field-help pn-status", role: "status", "aria-live": "polite" });
  const saveBtn = el("button", { type: "button", class: "glass-button glass-button--filled" }, saveLabel);
  const revertBtn = el("button", { type: "button", class: "glass-button", hidden: true }, "Revert");
  const exampleBtn = el("button", { type: "button", class: "glass-button" }, "Use technical meeting example");
  const fieldNode = field(label, area, help, count);
  let saved = "";
  let busy = false;

  const isDirty = () => area.value !== saved;
  function refreshChrome() {
    const dirty = isDirty();
    if (dirty) store.dirty.add(dirtyKey); else store.dirty.delete(dirtyKey);
    const isLocked = locked();
    count.textContent = `${area.value.length.toLocaleString("en-US")} / ${CONTEXT_MAX.toLocaleString("en-US")}`;
    saveBtn.disabled = !dirty || isLocked || busy;
    saveBtn.title = isLocked ? "Locked while a job is running" : "";
    revertBtn.hidden = !dirty;
    revertBtn.disabled = busy;
  }
  area.addEventListener("input", () => { status.textContent = ""; refreshChrome(); });
  revertBtn.addEventListener("click", () => { area.value = saved; status.textContent = ""; refreshChrome(); area.focus(); });
  exampleBtn.addEventListener("click", async () => {
    if (area.value.trim() && area.value !== TECHNICAL_EXAMPLE) {
      const ok = await confirmSheet({ title: "Replace the draft?", message: "Replace the context draft with the technical meeting example?", confirmLabel: "Replace" });
      if (!ok) return;
    }
    area.value = TECHNICAL_EXAMPLE;
    status.textContent = "";
    refreshChrome();
    area.focus();
  });
  saveBtn.addEventListener("click", async () => {
    if (saveBtn.disabled) return;
    const value = area.value;
    busy = true;
    refreshChrome();
    const ok = await onSave(value, status);
    busy = false;
    if (ok) saved = value;
    refreshChrome();
  });

  const node = el("div", { class: "pn-stack" }, fieldNode,
    el("div", { class: "pn-actions" }, saveBtn, revertBtn, exampleBtn), status);
  return {
    node,
    status,
    /** Adopt the persisted value; keeps an unsaved draft untouched. */
    sync(value) {
      const wasClean = !isDirty();
      saved = value ?? "";
      if (wasClean && area.value !== saved) area.value = saved;
      refreshChrome();
    },
    /** Drop the draft (session switched). */
    reset(value) { saved = value ?? ""; area.value = saved; status.textContent = ""; refreshChrome(); },
    refresh: refreshChrome,
    dispose() { store.dirty.delete(dirtyKey); },
  };
}

export function mount(container) {
  const root = el("div", { class: "pn pn-context" });
  container.append(root);

  // ---- Default context for new recordings ----
  const defaultEditor = contextEditor({
    label: "Default for new recordings",
    help: "Describe the topic, the people and the jargon. While a recording is running, a change also applies to that recording; sessions that are already saved keep their own context.",
    dirtyKey: "context",
    saveLabel: "Save context",
    locked: jobBusy,
    onSave: (value, status) => action("/api/settings", { meeting_context: value }, {
      success: () => { status.textContent = "Saved as the default for new recordings."; },
    }),
  });

  // ---- Context of the open archived session ----
  const sessionEditor = contextEditor({
    label: "Context for this session",
    help: "Used when this session is refined, reviewed or summarised. It does not change the default above.",
    dirtyKey: "session-context",
    saveLabel: "Save session context",
    locked: jobBusy,
    onSave: (value, status) => {
      const s = store.state?.session;
      if (!s) return Promise.resolve(false);
      const fresh = (s.artifacts || []).filter((a) => !a.stale && a.source_version === s.version).length;
      return action("/api/session/context", { session_id: s.id, context: value }, {
        success: () => {
          status.textContent = fresh
            ? `Saved. ${fresh} existing ${fresh === 1 ? "result is" : "results are"} now stale; run ${fresh === 1 ? "it" : "them"} again from Review.`
            : "Saved. This session’s version changed.";
        },
      });
    },
  });
  const staleNote = el("p", { class: "pn-banner-text" });
  const sessionBanner = el("div", { class: "banner banner--warning", role: "note" }, icon("warning"),
    el("div", null,
      el("strong", null, "Saving makes results stale. "),
      "Changing this context creates a new version of the session. Review proposals, summaries and other results generated earlier no longer match it and must be run again.",
      staleNote));
  const sessionTitle = el("h4", { class: "pn-subtitle" }, "This session");
  const sessionBox = el("div", { class: "group-box pn-box" }, sessionTitle, sessionBanner, sessionEditor.node);
  const sessionLiveNote = el("p", { class: "field-help", hidden: true },
    "A recording is in progress. It uses the default context above; the session context becomes editable when you open it after recording.");
  const sessionSlot = el("div", { class: "pn-stack" }, sessionBox, sessionLiveNote);

  // ---- Vocabulary ----
  const vocabIntro = el("p", { class: "field-help" },
    "Context and enabled terms are hints, not mandatory substitutions. Changes are saved locally. Use Chinese → preferred English pairs for translation, or leave the English rendering empty for recognition-only hints. English product names can use the same English spelling as their rendering.");
  const vocabCount = el("span", { class: "badge tnum" });
  const vocabList = el("ul", { class: "pn-vocab-list", "aria-label": "Vocabulary" });
  const vocabBox = el("div", { class: "group-box pn-box pn-vocab-box" }, vocabList);
  const vocabLockNote = el("p", { class: "field-help", role: "status", "aria-live": "polite" });

  let editingId = null;
  let editorHandle = null;
  let renderedSig = null;

  const vocabulary = () => store.state?.settings?.vocabulary || [];

  async function saveEntries(entries, afterSuccess) {
    return action("/api/settings", { vocabulary: entries }, { success: afterSuccess });
  }

  function badge(text, kind) { return el("span", { class: `badge${kind ? ` badge--${kind}` : ""}` }, text); }
  function termNode(text) {
    return el("span", { class: "pn-term", lang: CJK.test(text) ? "zh-Hant" : null }, text);
  }

  function displayRow(entry) {
    const editBtn = el("button", {
      type: "button", class: "glass-button glass-button--icon", "aria-label": `Edit “${entry.term}”`, title: "Edit",
      disabled: editingId !== null || jobBusy(),
      onclick: () => { editingId = entry.id; renderVocabulary(true); },
    }, icon("pencil"));
    const delBtn = el("button", {
      type: "button", class: "glass-button glass-button--icon pn-danger", "aria-label": `Delete “${entry.term}”`, title: "Delete",
      disabled: editingId !== null,
      onclick: async () => {
        if (store.dirty.has("vocabulary")) { toast("Save or cancel vocabulary edits before deleting a term.", { kind: "warning" }); return; }
        const ok = await confirmSheet({
          title: "Delete this term?", message: `Delete vocabulary term “${entry.term}”? This cannot be undone.`,
          confirmLabel: "Delete", destructive: true,
        });
        if (!ok) return;
        action("/api/vocabulary/delete", { id: entry.id }, {});
      },
    }, icon("trash"));
    const badges = el("span", { class: "pn-badges" });
    if (entry.known) badges.append(badge("Known", "green"));
    if (!entry.enabled) badges.append(badge("Disabled", "orange"));
    return el("li", { class: "pn-row", "data-id": entry.id, "data-disabled": entry.enabled ? null : "" },
      el("div", { class: "pn-row-main" },
        el("div", { class: "pn-row-head" }, termNode(entry.term || ""), badges),
        entry.translation
          ? el("div", { class: "pn-row-sub" }, "→ ", el("span", null, entry.translation))
          : el("div", { class: "pn-row-sub pn-muted" }, "Recognition hint only"),
        entry.note ? el("div", { class: "pn-row-note" }, entry.note) : null),
      el("div", { class: "pn-row-actions" }, editBtn, delBtn));
  }

  function editorRow(entry) {
    const term = el("input", { class: "text-input", type: "text", maxlength: "100", value: entry.term ?? "", autocomplete: "off", required: true });
    const english = el("input", { class: "text-input", type: "text", maxlength: "200", value: entry.translation ?? "", autocomplete: "off" });
    const note = el("input", { class: "text-input", type: "text", maxlength: "1000", value: entry.note ?? "", autocomplete: "off" });
    const enabled = el("input", { class: "checkbox", type: "checkbox", checked: !!entry.enabled });
    const known = el("input", { class: "checkbox", type: "checkbox", checked: !!entry.known });
    const error = el("p", { class: "field-help pn-error", role: "alert", hidden: true }, "Enter a term.");
    const save = el("button", { type: "button", class: "glass-button glass-button--filled" }, "Save");
    const cancel = el("button", { type: "button", class: "glass-button" }, "Cancel");
    const changed = () => term.value !== (entry.term ?? "") || english.value !== (entry.translation ?? "") || note.value !== (entry.note ?? "")
      || enabled.checked !== !!entry.enabled || known.checked !== !!entry.known;
    const sync = () => {
      if (changed()) store.dirty.add("vocabulary"); else store.dirty.delete("vocabulary");
      save.disabled = jobBusy();
      const invalid = !term.value.trim();
      term.setAttribute("aria-invalid", String(invalid && term.value !== (entry.term ?? "")));
      error.hidden = !(invalid && term.value !== (entry.term ?? ""));
    };
    for (const input of [term, english, note, enabled, known]) input.addEventListener("input", sync);
    const close = () => { editingId = null; store.dirty.delete("vocabulary"); renderVocabulary(true); };
    cancel.addEventListener("click", async () => {
      if (changed()) {
        const ok = await confirmSheet({ title: "Discard changes?", message: `Discard your edits to “${entry.term}”?`, confirmLabel: "Discard", cancelLabel: "Keep editing", destructive: true });
        if (!ok) return;
      }
      close();
    });
    save.addEventListener("click", async () => {
      if (!term.value.trim()) { error.hidden = false; term.setAttribute("aria-invalid", "true"); term.focus(); return; }
      const updated = vocabulary().map((v) => (v.id === entry.id
        ? { ...v, term: term.value.trim(), translation: english.value, note: note.value, enabled: enabled.checked, known: known.checked }
        : v));
      save.disabled = true;
      const ok = await saveEntries(updated, () => {});
      if (ok) close(); else save.disabled = jobBusy();
    });
    const form = el("li", { class: "pn-row pn-row--edit", "data-id": entry.id },
      el("form", { class: "pn-stack", onsubmit: (e) => { e.preventDefault(); save.click(); } },
        field("Term", term, null, error),
        field("Preferred English", english, "Leave empty for a recognition-only hint."),
        field("Note", note),
        el("div", { class: "pn-checks" },
          el("label", { class: "pn-check" }, enabled, "Enabled"),
          el("label", { class: "pn-check" }, known, "Known")),
        el("div", { class: "pn-actions" }, save, cancel)));
    editorHandle = { focus: () => term.focus() };
    return form;
  }

  function renderVocabulary(force = false) {
    const entries = vocabulary();
    if (editingId && !entries.some((v) => v.id === editingId)) { editingId = null; store.dirty.delete("vocabulary"); force = true; }
    const sig = JSON.stringify([entries, editingId, jobBusy()]);
    if (!force && sig === renderedSig) return;
    // Never rebuild while the user is typing in an edit row.
    if (!force && editingId && vocabList.contains(document.activeElement)) return;
    renderedSig = sig;
    const hadFocus = vocabList.contains(document.activeElement);
    vocabList.replaceChildren();
    editorHandle = null;
    if (!entries.length) vocabList.append(el("li", { class: "pn-empty" }, "No vocabulary saved."));
    for (const entry of entries) vocabList.append(entry.id === editingId ? editorRow(entry) : displayRow(entry));
    vocabCount.textContent = `${entries.length} / ${VOCAB_MAX}`;
    vocabLockNote.textContent = editingId ? "Other terms are locked until you save or cancel this edit." : "";
    if (editingId && editorHandle) editorHandle.focus();
    else if (hadFocus && force) vocabList.querySelector("button:not(:disabled)")?.focus();
  }

  // ---- Add-term form ----
  const addTerm = el("input", { class: "text-input", type: "text", maxlength: "100", autocomplete: "off", required: true });
  const addEnglish = el("input", { class: "text-input", type: "text", maxlength: "200", autocomplete: "off" });
  const addNote = el("input", { class: "text-input", type: "text", maxlength: "1000", autocomplete: "off" });
  const addBtn = el("button", { type: "submit", class: "glass-button glass-button--filled" }, "Add term");
  const addStatus = el("p", { class: "field-help", role: "status", "aria-live": "polite" });
  let adding = false;
  const addForm = el("form", { class: "group-box pn-box pn-stack pn-add", "aria-label": "Add a term" },
    el("h4", { class: "pn-subtitle" }, "Add a term"),
    field("Term", addTerm),
    field("Preferred English", addEnglish, "Leave empty for a recognition-only hint. Adding a term that already exists updates its English and note."),
    field("Note", addNote),
    el("div", { class: "pn-actions" }, addBtn),
    addStatus);
  function refreshAdd() {
    const any = Boolean(addTerm.value || addEnglish.value || addNote.value);
    if (any) store.dirty.add("vocabulary-add"); else store.dirty.delete("vocabulary-add");
    addBtn.disabled = adding || !addTerm.value.trim() || vocabulary().length >= VOCAB_MAX;
  }
  for (const input of [addTerm, addEnglish, addNote]) input.addEventListener("input", () => { addStatus.textContent = ""; refreshAdd(); });
  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (addBtn.disabled) return;
    const term = addTerm.value.trim();
    adding = true;
    refreshAdd();
    const ok = await action("/api/vocabulary", { term, translation: addEnglish.value, note: addNote.value }, {
      success: () => { addForm.reset(); addStatus.textContent = `Added “${term}”.`; },
    });
    adding = false;
    refreshAdd();
    if (ok) addTerm.focus();
  });

  root.append(
    el("section", { class: "pn-section", "aria-labelledby": "pc-h-default" },
      el("h3", { class: "pn-title", id: "pc-h-default" }, "Meeting context"),
      el("div", { class: "group-box pn-box" }, defaultEditor.node),
      sessionSlot),
    el("section", { class: "pn-section", "aria-labelledby": "pc-h-vocab" },
      el("div", { class: "pn-title-row" }, el("h3", { class: "pn-title", id: "pc-h-vocab" }, "Vocabulary"), vocabCount),
      vocabIntro, vocabBox, vocabLockNote, addForm));

  let lastSessionId;
  function update(state, changed) {
    if (changed && !changed.has("state")) return;
    const settings = state?.settings;
    if (!settings) return;
    defaultEditor.sync(settings.meeting_context ?? "");

    const session = state.session;
    const showSession = Boolean(session) && idleNow(state);
    sessionBox.hidden = !showSession;
    sessionLiveNote.hidden = !(Boolean(session) && !idleNow(state));
    if ((session?.id ?? null) !== lastSessionId) {
      lastSessionId = session?.id ?? null;
      sessionEditor.reset(session?.context ?? "");
    } else {
      sessionEditor.sync(session?.context ?? "");
    }
    const fresh = (session?.artifacts || []).filter((a) => !a.stale && a.source_version === session.version).length;
    staleNote.textContent = fresh ? ` ${fresh} current ${fresh === 1 ? "result" : "results"} would become stale.` : "";
    defaultEditor.refresh();
    sessionEditor.refresh();
    renderVocabulary();
    refreshAdd();
  }
  const unsubscribe = store.subscribe(update);
  update(store.state);

  return function unmount() {
    unsubscribe();
    for (const key of ["context", "session-context", "vocabulary", "vocabulary-add"]) store.dirty.delete(key);
    root.remove();
  };
}
