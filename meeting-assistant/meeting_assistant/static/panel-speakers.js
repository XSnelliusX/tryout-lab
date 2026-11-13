// Inspector panel "Speakers": names for the speaker clusters of the open session.
import { el, icon } from "/glass.js";
import { store } from "/store.js";
import { action } from "/api.js";

let seq = 0;
const uid = (name) => `ps-${name}-${++seq}`;
const clusterTitle = (label) => {
  const m = /^speaker_(\d+)$/.exec(label);
  return m ? `Speaker ${m[1]}` : label;
};

export function mount(container) {
  const root = el("div", { class: "pn pn-speakers" });
  container.append(root);

  const intro = el("p", { class: "field-help" },
    "Cluster labels are not verified identities. Name them only if you know who they represent; unknown stays unknown.");

  // Attribution switch (saved immediately).
  const switchId = uid("unreliable");
  const unreliable = el("input", { class: "switch", type: "checkbox", id: switchId, role: "switch", "aria-describedby": `${switchId}-help` });
  const unreliableBox = el("div", { class: "group-box pn-box" },
    el("div", { class: "pn-switch-row" },
      el("label", { for: switchId }, "More than 8 voices, or attribution unreliable"),
      unreliable),
    el("p", { class: "field-help", id: `${switchId}-help` },
      "Turn on if more than 8 distinct voices may be present, or if speaker attribution is unreliable. The session is then treated as anonymous: remote jobs send no speaker names, every speaker is sent as unknown, and local diarization is disabled."));
  let attributionBusy = false;
  unreliable.addEventListener("change", async () => {
    const session = store.state?.session;
    if (!session) { unreliable.checked = false; return; }
    const wanted = unreliable.checked;
    attributionBusy = true;
    refreshControls();
    const ok = await action("/api/attribution", { unreliable: wanted, session_id: session.id }, {
      success: () => { status.textContent = wanted ? "Marked as unreliable: results will use anonymous speakers." : "Speaker attribution is no longer marked unreliable."; },
    });
    attributionBusy = false;
    if (!ok) unreliable.checked = !wanted;
    refreshControls();
  });

  // Names
  const listBox = el("div", { class: "pn-stack pn-names" });
  const empty = el("div", { class: "pn-empty-state" }, icon("person"), el("p", { class: "pn-empty-text" }));
  const saveBtn = el("button", { type: "button", class: "glass-button glass-button--filled" }, "Save speaker names");
  const cancelBtn = el("button", { type: "button", class: "glass-button" }, "Cancel");
  const status = el("p", { class: "field-help pn-status", role: "status", "aria-live": "polite" });
  const actions = el("div", { class: "pn-actions" }, saveBtn, cancelBtn);
  const namesBox = el("div", { class: "group-box pn-box" }, listBox, actions, status);

  let sessionId = null;
  let signature = null;
  const inputs = new Map(); // label -> input
  let savedNames = {};
  let saving = false;

  const isDirty = () => [...inputs].some(([label, input]) => input.value.trim() !== (savedNames[label] || "").trim());
  function refreshControls() {
    const session = store.state?.session;
    const locked = !session || store.jobActive();
    const dirty = isDirty();
    if (dirty) store.dirty.add("speakers"); else store.dirty.delete("speakers");
    saveBtn.disabled = locked || !dirty || saving;
    saveBtn.title = store.jobActive() ? "Locked while a job is running" : "";
    cancelBtn.disabled = !dirty || saving;
    unreliable.disabled = locked || attributionBusy;
  }

  function labelsFor(state) {
    const names = state?.session?.speaker_names || {};
    const counts = new Map();
    for (const s of store.segments()) {
      const speaker = s.speaker || "unknown";
      if (s.status === "provisional") continue;
      counts.set(speaker, (counts.get(speaker) || 0) + 1);
    }
    const labels = [...new Set([...Object.keys(names), ...counts.keys()])].filter((l) => l !== "unknown").sort((a, b) =>
      a.localeCompare(b, "en", { numeric: true }));
    return { labels, names, counts };
  }

  function build(labels, names, counts) {
    listBox.replaceChildren();
    inputs.clear();
    for (const label of labels) {
      const id = uid("name");
      const input = el("input", { class: "text-input", type: "text", id, maxlength: "100", autocomplete: "off", value: names[label] || "", placeholder: "Unknown", "data-speaker": label });
      input.addEventListener("input", () => { status.textContent = ""; refreshControls(); });
      const n = counts.get(label) || 0;
      listBox.append(el("div", { class: "field" },
        el("label", { for: id }, clusterTitle(label)),
        input,
        el("p", { class: "field-help tnum" }, `${label} · ${n} ${n === 1 ? "caption" : "captions"}`)));
      inputs.set(label, input);
    }
  }

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
    el("section", { class: "pn-section", "aria-labelledby": "ps-h-names" },
      el("h3", { class: "pn-title", id: "ps-h-names" }, "Speaker names"), intro, unreliableBox, namesBox, empty));

  function update(state, changed) {
    if (changed && changed.size && !changed.has("state") && !changed.has("segment")) return;
    const session = state?.session ?? null;
    if ((session?.id ?? null) !== sessionId) {
      sessionId = session?.id ?? null;
      signature = null;
      status.textContent = "";
      store.dirty.delete("speakers");
    }
    if (!session) {
      namesBox.hidden = true;
      unreliableBox.hidden = true;
      empty.hidden = false;
      empty.querySelector("p").textContent = "Open a saved session to name its speakers.";
      listBox.replaceChildren();
      inputs.clear();
      signature = null;
      refreshControls();
      return;
    }
    unreliableBox.hidden = false;
    if (!attributionBusy) unreliable.checked = Boolean(session.attribution_unreliable);

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
    empty.querySelector("p").textContent = "No speaker clusters yet. They appear after Diarize locally (Review), or when captions carry a speaker cluster.";
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
