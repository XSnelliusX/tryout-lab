// On-demand Pinyin helper: word-grouped ruby readings, separate Chinese/Pinyin copy, animated replacement, and playback highlighting.
import { api } from "/api.js";
import { el, icon } from "/glass.js";

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const OPEN_PUNCT_RE = /^[(\[{\u300c\u300e\u201c\u2018\uff08\u3010\u300a\u3008]/;
const CACHE_LIMIT = 250;
const cache = new Map();
let showContextualGuess = false;
const guessSubscribers = new Set();
const copyTimers = new WeakMap();
let lastCopyAnnouncement = "";

const wordSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh-Hant", { granularity: "word" })
  : null;

const reducedMotion = () => typeof matchMedia === "function"
  && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function getShowContextualGuess() {
  return showContextualGuess;
}

export function setShowContextualGuess(next) {
  const val = Boolean(next);
  if (val === showContextualGuess) return;
  showContextualGuess = val;
  for (const listener of [...guessSubscribers]) listener(showContextualGuess);
}

export function hasChinese(text) {
  return typeof text === "string" && HAN_RE.test(text);
}

/** Split text into word/punctuation segments with speakable word indices for highlighting and grouping. */
export function segmentWords(text) {
  if (typeof text !== "string" || !text) return [];
  const raw = [];
  if (wordSegmenter) {
    for (const part of wordSegmenter.segment(text)) {
      const seg = part.segment;
      const start = part.index;
      const end = start + seg.length;
      const speakable = HAN_RE.test(seg) || (Boolean(part.isWordLike) && WORD_CHAR_RE.test(seg));
      raw.push({ text: seg, start, end, speakable });
    }
  } else {
    const fallbackRe = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[A-Za-z0-9]+|[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]+)/g;
    let match;
    while ((match = fallbackRe.exec(text)) !== null) {
      const seg = match[0];
      raw.push({
        text: seg,
        start: match.index,
        end: match.index + seg.length,
        speakable: HAN_RE.test(seg) || WORD_CHAR_RE.test(seg),
      });
    }
  }
  let wordIndex = 0;
  return raw.map((item) => ({
    ...item,
    wordIndex: item.speakable ? wordIndex++ : -1,
  }));
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export async function lookupPinyin(text) {
  const clean = typeof text === "string" ? text.trim() : "";
  if (!clean || !hasChinese(clean)) {
    return { available: true, has_chinese: false, tokens: [], has_ambiguous: false, unavailable_count: 0 };
  }
  if (cache.has(clean)) return cache.get(clean);
  try {
    const res = await api("/api/pinyin", { text: clean });
    cacheSet(clean, res);
    return res;
  } catch (error) {
    return { ok: false, error: error?.message || "Pronunciation lookup failed." };
  }
}

export function formatPinyinText(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return "";
  let out = "";
  let prevWasSyllableOrWord = false;
  for (const token of tokens) {
    if (token.is_chinese) {
      const syllable = token.available ? (token.reading || "") : "—";
      if (!syllable) continue;
      if (out && prevWasSyllableOrWord && !/\s$/.test(out)) out += " ";
      out += syllable;
      prevWasSyllableOrWord = true;
    } else {
      const plain = token.text || "";
      if (!plain) continue;
      const trimmed = plain.trim();
      const startsWord = WORD_CHAR_RE.test(plain[0] || "");
      if (out && prevWasSyllableOrWord && startsWord && !/\s$/.test(out)) out += " ";
      out += plain;
      prevWasSyllableOrWord = Boolean(trimmed) && WORD_CHAR_RE.test(trimmed[trimmed.length - 1] || "") && !OPEN_PUNCT_RE.test(trimmed);
    }
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function renderRubyToken(token, revealContextualGuess = false) {
  if (!token.is_chinese) {
    return el("span", { class: "py-token py-token--plain" }, token.text);
  }
  if (!token.available) {
    return el("span", { class: "py-token is-unavailable", title: "Pronunciation unavailable" },
      el("ruby", null, token.text, el("rt", null, "—")));
  }
  const reading = token.reading || "";
  if (token.ambiguous) {
    const alts = Array.isArray(token.alternatives) && token.alternatives.length ? token.alternatives.join(" / ") : reading;
    if (revealContextualGuess) {
      return el("span", {
        class: "py-token is-ambiguous",
        title: `Multiple possible readings: ${alts}`,
      }, el("ruby", null, token.text, el("rt", null, `${reading}?`)));
    }
    return el("span", {
      class: "py-token",
      title: `Multiple possible readings: ${alts}`,
    }, el("ruby", null, token.text, el("rt", null, reading)));
  }
  return el("span", { class: "py-token" },
    el("ruby", null, token.text, el("rt", null, reading)));
}

function buildGroupedFlowNodes(tokens, revealContextualGuess) {
  const fullText = tokens.map((t) => t.text || "").join("");
  const words = segmentWords(fullText);
  if (!words.length) return tokens.map((t) => renderRubyToken(t, revealContextualGuess));

  // Index tokens with UTF-16 spans so we can group multi-character words cleanly without breaking token alignment.
  const tokenSpans = [];
  let cursor = 0;
  for (const token of tokens) {
    const text = token.text || "";
    tokenSpans.push({ token, start: cursor, end: cursor + text.length });
    cursor += text.length;
  }

  const out = [];
  let tIdx = 0;
  for (const word of words) {
    const children = [];
    while (tIdx < tokenSpans.length && tokenSpans[tIdx].end <= word.start) {
      tIdx += 1;
    }
    while (tIdx < tokenSpans.length && tokenSpans[tIdx].start < word.end) {
      const span = tokenSpans[tIdx];
      if (span.token.is_chinese) {
        children.push(renderRubyToken(span.token, revealContextualGuess));
      } else {
        const sliceStart = Math.max(0, word.start - span.start);
        const sliceEnd = Math.min(span.token.text.length, word.end - span.start);
        const slice = span.token.text.slice(sliceStart, sliceEnd);
        if (slice) children.push(renderRubyToken({ ...span.token, text: slice }, revealContextualGuess));
      }
      if (span.end <= word.end) {
        tIdx += 1;
      } else {
        break;
      }
    }
    if (!children.length) continue;
    if (word.speakable) {
      const compactWord = word.text.length <= 6 && !/\s/.test(word.text);
      out.push(el("span", {
        class: `py-word${compactWord ? " py-word--nowrap" : ""}`,
        dataset: { wordIdx: String(word.wordIndex) },
      }, children));
    } else {
      out.push(...children);
    }
  }
  return out;
}

/** Extract only base Chinese/plain text from a selection inside `root`, omitting `<rt>` and `.py-no-copy`. */
export function extractSelectedBaseText(root, selection) {
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const parts = [];
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    const scope = root.contains(range.commonAncestorContainer) ? range.commonAncestorContainer : root;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!root.contains(node)) continue;
      if (node.parentElement?.closest("rt, .py-no-copy")) continue;
      if (!range.intersectsNode(node)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.data.length;
      if (end > start) parts.push(node.data.slice(start, end));
    }
  }
  return parts.join("");
}

function showCopyStatus(button, statusNode, ok) {
  clearTimeout(copyTimers.get(button));
  button.removeAttribute("data-copied");
  button.removeAttribute("data-failed");
  const iconSlot = button.querySelector(".py-copy-icon");
  if (iconSlot) iconSlot.replaceChildren(icon(ok ? "checkmark" : "copy"));
  let message = ok ? "Copied" : "Copy failed";
  if (message === lastCopyAnnouncement) message += "\u00A0";
  lastCopyAnnouncement = message;
  statusNode.textContent = "";
  button.setAttribute(ok ? "data-copied" : "data-failed", "");
  requestAnimationFrame(() => { statusNode.textContent = message; });
  copyTimers.set(button, setTimeout(() => {
    button.removeAttribute("data-copied");
    button.removeAttribute("data-failed");
    const slot = button.querySelector(".py-copy-icon");
    if (slot) slot.replaceChildren(icon("copy"));
    statusNode.textContent = "";
  }, 2000));
}

async function copyString(button, statusNode, text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showCopyStatus(button, statusNode, true);
  } catch {
    showCopyStatus(button, statusNode, false);
  }
}

function makeCopyButton(label, ariaLabel, statusNode, getText) {
  const iconWrap = el("span", { class: "py-copy-icon", "aria-hidden": "true" }, icon("copy"));
  const btn = el("button", {
    type: "button",
    class: "glass-button glass-button--compact py-copy-btn",
    "aria-label": ariaLabel,
  }, iconWrap, el("span", null, label));
  btn.addEventListener("click", () => copyString(btn, statusNode, getText()));
  return btn;
}

export function applyWordHighlight(root, activeWordIndex) {
  if (!root) return;
  const active = Number.isInteger(activeWordIndex) ? activeWordIndex : -1;
  for (const node of root.querySelectorAll("[data-word-idx]")) {
    const idx = Number(node.dataset.wordIdx);
    const isCurrent = active >= 0 && idx === active;
    const isPast = active >= 0 && idx < active;
    node.classList.toggle("is-speaking", isCurrent);
    node.classList.toggle("is-spoken", isPast);
  }
}

export function renderPinyinResult(data, {
  showContextualGuess: revealGuess = showContextualGuess,
  onToggleContextualGuess = null,
  activeWordIndex = -1,
} = {}) {
  if (data.ok === false) {
    return el("div", { class: "py-panel", role: "status" },
      el("p", { class: "py-note" }, data.error || "Pronunciation lookup unavailable right now."));
  }
  if (!data.available) {
    return el("div", { class: "py-panel", role: "status" },
      el("p", { class: "py-note" }, data.reason || "Pronunciation lookup is currently unavailable."));
  }
  if (!data.has_chinese || !Array.isArray(data.tokens) || !data.tokens.length) {
    return el("div", { class: "py-panel" },
      el("p", { class: "py-note" }, "No Chinese characters detected."));
  }

  const chineseText = data.tokens.map((t) => t.text || "").join("");
  const pinyinText = formatPinyinText(data.tokens);

  const flow = el("div", { class: "py-ruby-flow", lang: "zh-Hant" },
    buildGroupedFlowNodes(data.tokens, revealGuess));

  flow.addEventListener("copy", (event) => {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const clean = extractSelectedBaseText(flow, selection);
    if (!clean) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", clean);
  });

  if (activeWordIndex >= 0) applyWordHighlight(flow, activeWordIndex);

  const statusNode = el("span", { class: "py-copy-status", role: "status" });
  const copyChineseBtn = makeCopyButton("Copy Chinese", "Copy Chinese text", statusNode, () => chineseText);
  const copyPinyinBtn = makeCopyButton("Copy Pinyin", "Copy Pinyin", statusNode, () => pinyinText);
  const copyGroup = el("div", { class: "py-copy-group" }, copyChineseBtn, copyPinyinBtn, statusNode);

  const footerItems = [copyGroup];
  const ambiguousTokens = data.tokens.filter((t) => t.is_chinese && t.available && t.ambiguous);
  if (ambiguousTokens.length) {
    const toggleBtn = el("button", {
      type: "button",
      class: "glass-button glass-button--compact py-guess-toggle",
      "aria-pressed": String(Boolean(revealGuess)),
    }, "Contextual guess");
    toggleBtn.addEventListener("click", () => {
      if (onToggleContextualGuess) onToggleContextualGuess(!revealGuess);
      else setShowContextualGuess(!revealGuess);
    });
    footerItems.push(el("div", { class: "py-ambig-controls" },
      el("span", { class: "py-note" }, "Multiple readings possible"),
      toggleBtn));
  }

  const children = [flow, el("div", { class: "py-footer" }, footerItems)];

  if (ambiguousTokens.length && revealGuess) {
    const seen = new Set();
    const parts = [];
    for (const t of ambiguousTokens) {
      const key = `${t.text}:${(t.alternatives || []).join("/")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(`${t.text} (${(t.alternatives || [t.reading]).join(" / ")})`);
    }
    children.push(el("p", { class: "py-alts" },
      `Contextual guess (?): ${parts.join(", ")}.`));
  }

  if (data.unavailable_count > 0) {
    children.push(el("p", { class: "py-note" },
      `Pronunciation unavailable for ${data.unavailable_count} uncommon character${data.unavailable_count === 1 ? "" : "s"} (—).`));
  }
  return el("div", { class: "py-panel" }, children);
}

export function createPinyinControl(getText, { label = "Pinyin", compact = true, replaceEl = null } = {}) {
  let open = false;
  let renderedText = "";
  let loadingText = "";
  let lastResult = null;
  let requestId = 0;
  let activeWordIndex = -1;
  const activeAnimations = new Set();

  const button = el("button", {
    type: "button",
    class: `glass-button ${compact ? "glass-button--compact cap-action" : ""}`.trim(),
    "aria-pressed": "false",
    hidden: true,
  }, label);

  const host = el("div", { class: "py-host", hidden: true });

  function cancelAnimations() {
    for (const anim of activeAnimations) {
      try { anim.cancel(); } catch (_) { /* ignore */ }
    }
    activeAnimations.clear();
    const slot = host.parentElement;
    if (slot?.classList.contains("py-slot")) {
      slot.style.removeProperty("overflow");
    }
    host.style.removeProperty("overflow");
  }

  function trackAnim(anim, onDone) {
    if (!anim) return;
    activeAnimations.add(anim);
    anim.finished.catch(() => {}).finally(() => {
      activeAnimations.delete(anim);
      onDone?.();
    });
  }

  function syncReplacedVisibility() {
    if (!replaceEl) return;
    const text = (getText() || "").trim();
    replaceEl.hidden = open || !text;
  }

  function renderPanel({ restoreToggleFocus = false } = {}) {
    if (!lastResult || !open) return null;
    const panel = renderPinyinResult(lastResult, {
      showContextualGuess,
      activeWordIndex,
      onToggleContextualGuess: (next) => setShowContextualGuess(next),
    });
    host.replaceChildren(panel);
    if (restoreToggleFocus) panel.querySelector(".py-guess-toggle")?.focus({ preventScroll: true });
    return panel;
  }

  function onGuessPrefChange() {
    if (!host.isConnected && !open) {
      guessSubscribers.delete(onGuessPrefChange);
      return;
    }
    if (open && lastResult) {
      const keepFocus = Boolean(
        document.activeElement
        && host.contains(document.activeElement)
        && document.activeElement.classList.contains("py-guess-toggle"),
      );
      renderPanel({ restoreToggleFocus: keepFocus });
    }
  }
  guessSubscribers.add(onGuessPrefChange);

  function animateOpen(panelEl, startHeight, endHeight, container) {
    if (reducedMotion() || typeof host.animate !== "function") return;
    if (container && startHeight > 0 && endHeight > 0 && Math.abs(endHeight - startHeight) >= 1) {
      container.style.setProperty("overflow", "hidden");
      trackAnim(container.animate(
        [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
        { duration: 240, easing: "cubic-bezier(.22, 1, .36, 1)" },
      ), () => container.style.removeProperty("overflow"));
    }
    if (panelEl) {
      trackAnim(panelEl.animate(
        [
          { opacity: replaceEl ? 0.45 : 0, transform: "translateY(-3px) scale(0.99)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 210, easing: "cubic-bezier(.22, 1, .36, 1)" },
      ));
      for (const rt of panelEl.querySelectorAll("rt")) {
        trackAnim(rt.animate(
          [
            { opacity: 0, transform: "translateY(5px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 240, easing: "cubic-bezier(.22, 1, .36, 1)" },
        ));
      }
    }
  }

  function animateCloseToReplace(startHeight) {
    if (!replaceEl) return;
    const text = (getText() || "").trim();
    const slot = host.parentElement?.classList.contains("py-slot") ? host.parentElement : null;
    host.hidden = true;
    replaceEl.hidden = !text;
    if (reducedMotion() || typeof replaceEl.animate !== "function") return;
    const endHeight = slot ? slot.getBoundingClientRect().height : 0;
    if (slot && startHeight > 0 && endHeight > 0 && Math.abs(endHeight - startHeight) >= 1) {
      slot.style.setProperty("overflow", "hidden");
      trackAnim(slot.animate(
        [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
        { duration: 200, easing: "cubic-bezier(.22, 1, .36, 1)" },
      ), () => slot.style.removeProperty("overflow"));
    }
    if (!replaceEl.hidden) {
      trackAnim(replaceEl.animate(
        [
          { opacity: 0.4, transform: "translateY(3px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 190, easing: "cubic-bezier(.22, 1, .36, 1)" },
      ));
    }
  }

  async function load(text, { animate = false } = {}) {
    const token = ++requestId;
    loadingText = text;
    const slot = host.parentElement?.classList.contains("py-slot") ? host.parentElement : null;
    if (replaceEl) {
      button.setAttribute("aria-busy", "true");
    } else {
      host.hidden = false;
      host.replaceChildren(el("div", { class: "py-panel" },
        el("p", { class: "py-note", role: "status" }, "Loading pronunciation…")));
    }
    const result = await lookupPinyin(text);
    if (token === requestId) loadingText = "";
    if (replaceEl) button.removeAttribute("aria-busy");
    if (token !== requestId || !open) return;

    cancelAnimations();
    const startHeight = animate ? (slot ? slot.getBoundingClientRect().height : 0) : 0;
    renderedText = text;
    lastResult = result;
    if (replaceEl) replaceEl.hidden = true;
    host.hidden = false;
    const panel = renderPanel();
    if (animate) {
      const container = slot || host;
      const endHeight = container.getBoundingClientRect().height;
      animateOpen(panel, startHeight, endHeight, container);
    }
  }

  function sync() {
    const text = (getText() || "").trim();
    const visible = hasChinese(text);
    button.hidden = !visible;
    if (!visible) {
      cancelAnimations();
      open = false;
      loadingText = "";
      button.setAttribute("aria-pressed", "false");
      button.removeAttribute("aria-busy");
      host.hidden = true;
      host.replaceChildren();
      renderedText = "";
      lastResult = null;
      syncReplacedVisibility();
      return;
    }
    if (open) {
      if (text !== renderedText && text !== loadingText) {
        if (replaceEl) replaceEl.hidden = true;
        load(text, { animate: false });
      } else if (text === renderedText && replaceEl) {
        replaceEl.hidden = true;
      }
    } else if (replaceEl) {
      replaceEl.hidden = false;
    }
  }

  function setOpen(next) {
    const text = (getText() || "").trim();
    if (!hasChinese(text)) return;
    const want = Boolean(next);
    if (want === open) return;
    cancelAnimations();
    open = want;
    button.setAttribute("aria-pressed", String(open));
    const slot = host.parentElement?.classList.contains("py-slot") ? host.parentElement : null;

    if (!open) {
      requestId += 1;
      loadingText = "";
      button.removeAttribute("aria-busy");
      if (replaceEl) {
        const startHeight = slot ? slot.getBoundingClientRect().height : 0;
        animateCloseToReplace(startHeight);
      } else if (!reducedMotion() && typeof host.animate === "function") {
        const startHeight = host.getBoundingClientRect().height;
        host.style.setProperty("overflow", "hidden");
        trackAnim(host.animate(
          [
            { height: `${startHeight}px`, opacity: 1 },
            { height: "0px", opacity: 0 },
          ],
          { duration: 180, easing: "cubic-bezier(.22, 1, .36, 1)" },
        ), () => {
          host.style.removeProperty("overflow");
          if (!open) host.hidden = true;
        });
      } else {
        host.hidden = true;
      }
      return;
    }

    if (text === renderedText && lastResult) {
      const startHeight = slot ? slot.getBoundingClientRect().height : 0;
      if (replaceEl) replaceEl.hidden = true;
      host.hidden = false;
      const panel = renderPanel();
      const container = slot || host;
      const endHeight = container.getBoundingClientRect().height;
      animateOpen(panel, startHeight, endHeight, container);
      return;
    }
    load(text, { animate: true });
  }

  function setActiveWord(wordIndex) {
    const next = Number.isInteger(wordIndex) ? wordIndex : -1;
    if (next === activeWordIndex) return;
    activeWordIndex = next;
    applyWordHighlight(host, activeWordIndex);
  }

  button.addEventListener("click", () => setOpen(!open));

  return {
    button,
    host,
    sync,
    setOpen,
    isOpen: () => open,
    setActiveWord,
  };
}
