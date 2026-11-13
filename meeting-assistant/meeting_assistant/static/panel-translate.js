// Expandable Manual Translation panel using the already-loaded PLaMo translation model.
import { api } from "/api.js";
import { el, icon, toast } from "/glass.js";
import { createPinyinControl } from "/pinyin-ui.js";
import { store } from "/store.js";
import { $ } from "/ui.js";

const FALLBACK_SOURCE = [
  { code: "auto", label: "Auto-detect" },
  { code: "zh-hant", label: "Traditional Chinese (繁體中文)" },
  { code: "zh-hans", label: "Simplified Chinese (简体中文)" },
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
];

const FALLBACK_TARGET = [
  { code: "en", label: "English" },
  { code: "zh-hant", label: "Traditional Chinese (繁體中文)" },
  { code: "zh-hans", label: "Simplified Chinese (简体中文)" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
];

const MAX_CHARS = 5000;

function fillLanguageOptions(select, options, preferred) {
  const prev = select.value;
  select.replaceChildren(...options.map((opt) => el("option", { value: opt.code }, opt.label)));
  if (options.some((o) => o.code === prev)) select.value = prev;
  else if (options.some((o) => o.code === preferred)) select.value = preferred;
  else if (options.length) select.value = options[0].code;
}

export function mountTranslate(container) {
  const sourceSelect = el("select", { id: "mt-source", class: "select" });
  const targetSelect = el("select", { id: "mt-target", class: "select" });
  const swapBtn = el("button", {
    id: "mt-swap",
    type: "button",
    class: "glass-button glass-button--icon glass-button--filled mt-swap-btn",
    "aria-label": "Swap source and target languages",
    title: "Swap languages",
  }, icon("swap"));

  fillLanguageOptions(sourceSelect, FALLBACK_SOURCE, "zh-hant");
  fillLanguageOptions(targetSelect, FALLBACK_TARGET, "en");

  const input = el("textarea", {
    id: "mt-input",
    class: "text-area mt-textarea",
    placeholder: "Type or paste text to translate…",
    maxlength: String(MAX_CHARS),
    rows: "3",
  });
  const countEl = el("span", { class: "pn-subheadline pn-muted tnum" }, `0 / ${MAX_CHARS}`);

  const srcPinyin = createPinyinControl(() => input.value, { label: "Pinyin", compact: true });
  const dstState = { text: "" };

  const translateBtn = el("button", {
    id: "mt-submit",
    type: "button",
    class: "glass-button glass-button--prominent",
  }, "Translate");
  const clearBtn = el("button", {
    id: "mt-clear",
    type: "button",
    class: "glass-button glass-button--filled",
  }, "Clear");

  const statusBanner = el("div", { class: "banner banner--warning", role: "status", hidden: true },
    icon("info"),
    el("p", { class: "pn-banner-text" }));
  const errorBanner = el("div", { id: "mt-error", class: "banner banner--error", role: "alert", hidden: true },
    icon("warning"),
    el("p", { class: "pn-banner-text" }));

  const resultText = el("p", { id: "mt-result-text", class: "mt-result-text" });
  const dstPinyin = createPinyinControl(() => dstState.text, { label: "Pinyin", compact: true, replaceEl: resultText });
  const copyBtn = el("button", {
    type: "button",
    class: "glass-button glass-button--compact glass-button--filled",
  }, "Copy");
  const resultBox = el("div", { id: "mt-result", class: "mt-result", hidden: true },
    el("div", { class: "mt-result-head" },
      el("span", { id: "mt-result-lang", class: "pn-subtitle" }, "Translation"),
      el("div", { class: "pn-actions" }, dstPinyin.button, copyBtn)),
    el("div", { class: "py-slot" }, resultText, dstPinyin.host));

  let busy = false;
  let lastLangSignature = "";

  function updatePairBadge() {
    const badge = $("manual-translate-pair");
    if (badge) badge.textContent = `${sourceSelect.value || "zh-hant"} → ${targetSelect.value || "en"}`;
  }

  function showError(message) {
    if (!message) {
      errorBanner.hidden = true;
      return;
    }
    errorBanner.querySelector(".pn-banner-text").textContent = message;
    errorBanner.hidden = false;
  }

  function syncLanguages(state) {
    const langs = state?.translation_languages;
    if (!langs) return;
    const src = Array.isArray(langs.source) && langs.source.length ? langs.source : FALLBACK_SOURCE;
    const dst = Array.isArray(langs.target) && langs.target.length ? langs.target : FALLBACK_TARGET;
    const sig = `${src.map((o) => o.code).join(",")}|${dst.map((o) => o.code).join(",")}`;
    if (sig === lastLangSignature) return;
    lastLangSignature = sig;
    fillLanguageOptions(sourceSelect, src, "zh-hant");
    fillLanguageOptions(targetSelect, dst, "en");
    updatePairBadge();
  }

  function syncModelStatus(state) {
    const loadState = state?.model_load_state || (state?.model_ready ? "ready" : "loading");
    const noticeNode = statusBanner.querySelector(".pn-banner-text");
    if (loadState === "loading") {
      noticeNode.textContent = state?.model_status || "Translation model is loading. Manual translation will be ready shortly.";
      statusBanner.hidden = false;
    } else if (loadState === "error") {
      noticeNode.textContent = state?.model_status || "Translation model could not be loaded.";
      statusBanner.hidden = false;
    } else if (loadState === "unloaded") {
      noticeNode.textContent = state?.model_status || "Translation model is not loaded.";
      statusBanner.hidden = false;
    } else {
      statusBanner.hidden = true;
    }
    translateBtn.disabled = busy;
    translateBtn.textContent = busy ? "Translating…" : "Translate";
  }

  function onInputChange() {
    countEl.textContent = `${input.value.length} / ${MAX_CHARS}`;
    srcPinyin.sync();
    if (!input.value.trim()) showError("");
  }

  async function runTranslate() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) {
      showError("Enter some text to translate.");
      input.focus();
      return;
    }
    if (sourceSelect.value === targetSelect.value) {
      showError("Choose different source and target languages.");
      return;
    }

    busy = true;
    showError("");
    syncModelStatus(store.state);

    try {
      const res = await api("/api/translate", {
        text,
        source_lang: sourceSelect.value,
        target_lang: targetSelect.value,
      });
      dstState.text = res?.translation || "";
      resultText.textContent = dstState.text;
      const lbl = targetSelect.selectedOptions?.[0]?.textContent || res?.target_lang || targetSelect.value;
      const head = resultBox.querySelector("#mt-result-lang");
      if (head) head.textContent = lbl;
      resultBox.hidden = !dstState.text;
      dstPinyin.setOpen(false);
      dstPinyin.sync();
    } catch (error) {
      showError(error?.message || "Translation could not be completed.");
    } finally {
      busy = false;
      syncModelStatus(store.state);
    }
  }

  swapBtn.addEventListener("click", () => {
    const prevSource = sourceSelect.value;
    const prevTarget = targetSelect.value;
    const nextSource = prevTarget;
    const nextTarget = prevSource === "auto"
      ? (prevTarget === "en" ? "zh-hant" : "en")
      : prevSource;

    const srcOpts = [...sourceSelect.options].map((o) => o.value);
    const dstOpts = [...targetSelect.options].map((o) => o.value);
    if (!srcOpts.includes(nextSource) || !dstOpts.includes(nextTarget)) {
      showError("This language pair cannot be swapped.");
      return;
    }
    sourceSelect.value = nextSource;
    targetSelect.value = nextTarget;
    if (dstState.text && !resultBox.hidden) {
      input.value = dstState.text;
      onInputChange();
    }
    updatePairBadge();
    showError("");
  });

  sourceSelect.addEventListener("change", () => { updatePairBadge(); showError(""); });
  targetSelect.addEventListener("change", () => { updatePairBadge(); showError(""); });
  input.addEventListener("input", onInputChange);
  input.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runTranslate();
    }
  });
  translateBtn.addEventListener("click", runTranslate);
  clearBtn.addEventListener("click", () => {
    input.value = "";
    dstState.text = "";
    resultBox.hidden = true;
    dstPinyin.sync();
    srcPinyin.sync();
    showError("");
    onInputChange();
    input.focus();
  });
  copyBtn.addEventListener("click", async () => {
    if (!dstState.text) return;
    try {
      await navigator.clipboard.writeText(dstState.text);
      toast("Translation copied.", { kind: "success", timeout: 2200 });
    } catch {
      toast("Clipboard unavailable. Select and copy the translation text.", { kind: "warning" });
    }
  });

  container.replaceChildren(
    el("div", { class: "mt-panel" },
      el("div", { class: "mt-lang-row" },
        el("div", { class: "field" }, el("label", { for: "mt-source" }, "From"), sourceSelect),
        swapBtn,
        el("div", { class: "field" }, el("label", { for: "mt-target" }, "To"), targetSelect)),
      el("div", { class: "field" },
        el("label", { for: "mt-input" }, "Text"),
        input,
        el("div", { class: "mt-meta-row" },
          el("div", { class: "pn-actions" }, srcPinyin.button),
          countEl),
        srcPinyin.host),
      statusBanner,
      errorBanner,
      el("div", { class: "pn-actions" }, translateBtn, clearBtn),
      resultBox));

  updatePairBadge();
  onInputChange();
  syncLanguages(store.state);
  syncModelStatus(store.state);

  store.subscribe((state) => {
    syncLanguages(state);
    syncModelStatus(state);
  });
}
