// Shared client state: /api/state snapshot + /api/events NDJSON stream (polling fallback).
import { api, getToken } from "/api.js";

const LIVE_KEYS = ["recording_state", "audio", "audio_seconds", "queue_length", "queue_lag_seconds", "pending_work",
  "no_audio", "feed_status", "capture_status", "notice", "discarded_bursts", "latency"];
const BACKOFF = [1000, 2000, 5000];
const POLL_MS = 2000;
const WATCHDOG_MS = 35000; // the server pings every 10 s

const listeners = new Set();
let pendingKinds = new Set(), flushTimer = 0;

function notify(...kinds) {
  for (const kind of kinds) pendingKinds.add(kind);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = 0;
    const changed = pendingKinds;
    pendingKinds = new Set();
    for (const fn of [...listeners]) {
      try { fn(store.state, changed); } catch (error) { console.error(error); }
    }
  }, 16);
}

let inflight = null, again = false, trailing = 0;
let lastSessionId;
// Events received while /api/state is in flight: the snapshot may be older than they are.
let buffered = null;

async function refresh() {
  if (inflight) { again = true; return inflight; }
  inflight = (async () => {
    do {
      again = false;
      buffered = [];
      try {
        const next = await api("/api/state");
        const replay = buffered;
        buffered = null;
        store.state = next;
        store.error = "";
        // Re-apply what the snapshot cannot contain yet (events newer than its seq).
        // A server without seq gets the old behaviour: the snapshot wins.
        if (Number.isFinite(next?.seq)) for (const event of replay) if (Number.isFinite(event.seq) && event.seq > next.seq) apply(event);
        const sessionId = next.session?.id ?? null;
        if (lastSessionId !== undefined && sessionId !== lastSessionId && store.dirty.size) store.dirty.clear();
        lastSessionId = sessionId;
        notify("state", "live", "segment");
      } catch (error) {
        buffered = null;
        store.error = error.message;
        notify("state");
      }
    } while (again);
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Coalesces bursts of server "refresh" events. */
function scheduleRefresh() {
  if (trailing) return;
  trailing = setTimeout(() => { trailing = 0; refresh(); }, 120);
}

function applyLive(event) {
  const s = store.state;
  if (!s) return;
  const before = s.recording_state;
  for (const key of LIVE_KEYS) if (key in event) s[key] = event[key];
  if ("preview" in event) s.live_preview = event.preview ?? null;
  if (event.recording_state && event.recording_state !== before) scheduleRefresh();
  notify("live");
}

function upsert(list, segment) {
  const index = list.findIndex((item) => item.id === segment.id);
  // Revisions only grow: an older revision (e.g. a partial translation of text the
  // user has since edited) never replaces a newer one.
  if (index >= 0) { if (!(list[index].revision > segment.revision)) list[index] = segment; }
  else list.push(segment);
}

function applySegment(event) {
  const s = store.state, segment = event.segment;
  if (!s || !segment) return;
  const open = s.session?.id ?? s.session_id ?? null;
  if (event.session_id && open && event.session_id !== open) { scheduleRefresh(); return; }
  if (s.session) upsert((s.session.segments ??= []), segment);
  if (!s.session || Array.isArray(s.segments)) upsert((s.segments ??= []), segment);
  if (s.live_preview?.id === segment.id) s.live_preview = null;
  notify("segment");
}

function apply(event) {
  const seq = store.state?.seq;
  // Already reflected in the snapshot we hold.
  if (Number.isFinite(event.seq) && Number.isFinite(seq) && event.seq <= seq) return;
  if (event.type === "live") applyLive(event);
  else if (event.type === "segment") applySegment(event);
  else if (event.type === "refresh") scheduleRefresh();
}

function handle(event) {
  if (!event || typeof event !== "object") return;
  if (buffered && (event.type === "live" || event.type === "segment")) buffered.push(event);
  apply(event);
}

let pollTimer = 0;
function startPolling() {
  if (pollTimer) return;
  store.connection = "polling";
  pollTimer = setInterval(refresh, POLL_MS);
  refresh();
  notify("state");
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } }

async function readStream() {
  const controller = new AbortController();
  let lastSeen = Date.now();
  const watchdog = setInterval(() => { if (Date.now() - lastSeen > WATCHDOG_MS) controller.abort(); }, 5000);
  try {
    const response = await fetch("/api/events", { headers: { Authorization: `Bearer ${getToken()}` }, cache: "no-store", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    stopPolling();
    store.connection = "stream";
    refresh();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastSeen = Date.now();
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch (error) { console.error(error); }
      }
    }
  } finally { clearInterval(watchdog); }
}

let started = false;
async function runStream() {
  let attempt = 0;
  for (;;) {
    if (store.state?.capabilities?.event_stream === false) {
      startPolling();
      await new Promise((r) => setTimeout(r, 30000));
      continue;
    }
    let opened = false;
    try {
      await readStream();
      opened = true;
    } catch (_) { /* fall through to polling + backoff (also covers 403/404 from an older server) */ }
    if (store.connection === "stream") { attempt = 0; opened = true; }
    startPolling();
    await new Promise((r) => setTimeout(r, BACKOFF[Math.min(opened ? 0 : attempt++, BACKOFF.length - 1)]));
  }
}

export const store = {
  state: null,
  error: "",
  connection: "connecting",
  busy: 0,
  dirty: new Set(),
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  refresh,
  handle, // applies one stream event (exported for tests)
  segments() {
    const s = this.state;
    const list = s?.session?.segments || s?.segments || [];
    const preview = s?.live_preview;
    return preview && !list.some((item) => item.id === preview.id) ? [...list, preview] : list;
  },
  jobActive() { return ["running", "cancelling"].includes(this.state?.job?.status); },
  isIdle() { return (this.state?.recording_state || "idle") === "idle" && !this.jobActive() && !this.state?.pending_work; },
  setBusy(delta) { this.busy = Math.max(0, this.busy + delta); notify("state"); },
  /** Starts the first load and the event stream. Safe to call once. */
  start() {
    if (started) return;
    started = true;
    refresh();
    runStream();
  },
};
