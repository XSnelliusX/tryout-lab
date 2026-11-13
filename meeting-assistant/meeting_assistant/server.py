"""Loopback-only HTTP UI, the live caption pipeline and single-worker local inference.

Threads:
  capture-reader    helper PCM -> archive, LevelMeter, Segmenter; segmenter events go to
                    _on_segment (pipe_lock + scheduler only, never Application.lock)
  capture-watchdog  flushes an open utterance when no frames arrive for 2 s
  capture-stderr    helper diagnostics -> _capture_status
  model-worker      the only thread that calls the models; takes jobs from the Scheduler
  live-ticker       publishes `live` (<= 10/s) and coalesced `refresh` events
  HTTP handlers     one thread per request; /api/events streams from the EventHub

Locks, in acquisition order: capture segmenter lock -> lock (library/session use
cases; never taken by the reader) -> pipe_lock (utterance keys, speculative decodes)
-> live_lock (preview, device, recording-state transitions, event ordering) ->
scheduler/hub internals (leaves). No lock is held during a model call.
"""

import argparse
import collections
import copy
import hmac
import json
import math
import os
import re
import secrets
import stat
import threading
import time
import webbrowser
import wave
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .audio import (
    RATE,
    STALL_SECONDS,
    Capture,
    clean_device,
    direct_input_volume_supported,
    helper_protocol,
    helper_stale,
    list_devices,
    set_input_volume as helper_set_input_volume,
)
from .events import EventHub
from .inference import supported_languages, validate_language_pair
from .instance import InstanceLock
from .levels import advice
from .pinyin import analyze_pinyin, has_chinese, pinyin_status
from .scheduler import Job, Scheduler
from .storage import Archive, DATA_DIR, append_journal
from .workbench import Workbench

# Meeting data defaults to owner-only permissions, including on exceptional paths.
os.umask(0o077)

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
HELPER = ROOT / ".build" / "capture-audio"
HELPER_SOURCE = ROOT / "native" / "CaptureAudio.swift"

LIVE_INTERVAL = 0.1        # at most 10 live events per second
REFRESH_INTERVAL = 0.25    # refresh bursts are coalesced to one per interval
PARTIAL_INTERVAL = 0.1     # partial translations: at most 10 segment events per second per segment
LAG_NOTICE_SECONDS = 20.0  # recognition backlog that earns a notice
LONG_CONTEXT_CHARS = 600
NO_SIGNAL_AFTER_SECONDS = 30.0  # "no signal" advice only after this much captured audio without speech
STATIC_NAME = re.compile(r"[a-z0-9][a-z0-9._-]*\.(html|js|css|svg)")
CONTENT_TYPES = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                 "css": "text/css; charset=utf-8", "svg": "image/svg+xml; charset=utf-8"}
TIMING_KEYS = ("endpoint_ms", "asr_ms", "translate_ms", "speech_end_to_source_ms", "speech_end_to_english_ms")
SOURCE_STATUS = {"teams": "Capturing remote Teams audio", "system": "Capturing all system output",
                 "microphone": "Capturing the microphone: nearby voices and room sound"}


def launcher_name():
    """Best-effort hint only; macOS determines the actual permission owner."""
    bundle = os.environ.get("__CFBundleIdentifier", "")
    names = {"com.apple.Terminal": "Terminal", "com.cmuxterm.app": "cmux",
             "com.googlecode.iterm2": "iTerm", "com.microsoft.VSCode": "Visual Studio Code"}
    if bundle in names:
        return names[bundle]
    return {"Apple_Terminal": "Terminal", "iTerm.app": "iTerm", "vscode": "Visual Studio Code"}.get(os.environ.get("TERM_PROGRAM"), "your terminal app")


def _ms(start, end):
    if start is None or end is None:
        return None
    return max(0, int(round((end - start) * 1000)))


def _round(value, digits=1):
    return None if value is None or not math.isfinite(value) else round(float(value), digits)


def latency_summary(segments):
    """{count, last, median, p90} over segments carrying timing; None before the first one."""
    timings = [s["timing"] for s in segments if isinstance(s.get("timing"), dict)]
    if not timings:
        return None

    def pick(fraction):
        result = {}
        for key in TIMING_KEYS:
            values = sorted(t[key] for t in timings if isinstance(t.get(key), int))
            result[key] = values[min(len(values) - 1, max(0, math.ceil(fraction * len(values)) - 1))] if values else None
        return result

    return {"count": len(timings), "last": {k: timings[-1].get(k) for k in TIMING_KEYS},
            "median": pick(0.5), "p90": pick(0.9)}


def static_file(name):
    """(bytes, content type) of a servable static file, or None."""
    name = name or "index.html"
    match = STATIC_NAME.fullmatch(name)
    if not match:
        return None
    path = STATIC / name
    try:
        if path.is_symlink() or not path.is_file() or path.resolve().parent != STATIC.resolve():
            return None
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            return None
        return source.read(), CONTENT_TYPES[match.group(1)]


class ServiceUnavailableError(RuntimeError):
    """Raised when a requested local service or model is loading or unavailable (HTTP 503)."""


class TranslationFailureError(RuntimeError):
    """Raised when manual translation inference fails cleanly (HTTP 502)."""


class Application(Workbench):
    def __init__(self, data_dir=None, *, model=None, helper=None, load_models=True, start_threads=True):
        data_dir = Path(data_dir) if data_dir is not None else DATA_DIR
        self.instance_lock = InstanceLock(data_dir)
        self.lock = threading.RLock()
        self.live_lock = threading.Lock()
        self.pipe_lock = threading.Lock()
        self._id_lock = threading.Lock()
        self.jobs = Scheduler()
        self.hub = EventHub()
        self.helper = Path(helper) if helper is not None else HELPER
        self.stall_seconds = STALL_SECONDS  # flush an open utterance when frames stop this long
        self.kill_after = 5.0                # SIGKILL a helper that ignores the stop request
        self.model = None
        self.model_status = "Loading models locally…"
        self.model_ready = False
        self.model_load_state = "loading" if (load_models and model is None) else "unloaded"
        self.capture = None
        self.archive = None
        self.session_id = None
        self.recording_state = "idle"
        self.segments = []
        self.next_id = 1
        self.last_audio_at = None
        self.last_signal_at = None
        self.audio_seconds = 0.0
        self.started_at = None
        self.discarded_bursts = 0  # noise bursts too short for a final, plus no-speech recognitions
        self.last_speech_seconds = None  # stream time of the latest detected speech
        self.notice = ""
        self.capture_status = "Not capturing"
        self.capture_profile = None
        self.capture_audio = None
        self.capture_session = None
        self.live_preview = None
        self.device = None
        self.input_volume_mode = "auto"
        self.last_gain_db = 0.0
        self.pipeline_stats = collections.Counter()
        self._latency_cache = None
        self._keys = {}
        self._open_key = None
        self._spec_key = None
        self._context_warned = False
        self._lag_warned = False
        self._live_dirty = threading.Event()
        self._refresh_wanted = False
        self._stopping = threading.Event()
        self._init_workbench(data_dir)
        # The instance lock is held: nothing can be recording, so any session
        # still marked "recording" was interrupted.
        self.library.recover_interrupted()
        if model is not None:
            self.model, self.model_ready, self.model_status = model, True, "Models ready"
            self.model_load_state = "ready"
        self._load_models = load_models and model is None
        self.worker = self.ticker = None
        if start_threads:
            self.worker = threading.Thread(target=self._worker, name="model-worker", daemon=True)
            self.worker.start()
            self.ticker = threading.Thread(target=self._ticker, name="live-ticker", daemon=True)
            self.ticker.start()

    def close(self):
        """Stop background threads (tests and shutdown); the model call in flight is not interrupted."""
        self._stopping.set()
        self._live_dirty.set()
        self.jobs.close()
        self.hub.close()

    # -- small helpers ----------------------------------------------------------
    def _alloc_id(self):
        with self._id_lock:
            ident = self.next_id
            self.next_id += 1
            return ident

    def _set_recording_state(self, state, expect=None):
        with self.live_lock:
            if expect is not None and self.recording_state not in expect:
                return False
            changed = self.recording_state != state
            self.recording_state = state
        if changed:
            self._request_refresh()
        return True

    def _request_refresh(self):
        self._refresh_wanted = True
        self._live_dirty.set()

    def _set_notice(self, message):
        self.notice = message
        self._live_dirty.set()

    def _model_status(self, message):
        self.model_status = str(message)
        self._request_refresh()

    def _context_notice(self, context):
        if not self._context_warned and isinstance(context, str) and len(context) > LONG_CONTEXT_CHARS:
            self._context_warned = True
            self._set_notice(f"The meeting context is long ({len(context)} characters). It slows every caption "
                             "(about +0.7 s recognition and +0.7 s translation); keep it to a few key terms.")

    # -- model worker -------------------------------------------------------------
    def _worker(self):
        if self._load_models:
            try:
                from .inference import LocalModels
                model = LocalModels(self.data_dir, status_callback=self._model_status)
                model.load()
                self.model = model
                self.model_ready = True
                self.model_load_state = "ready"
                self._model_status("Models ready")
            except Exception as exc:
                self.model_load_state = "error"
                self._model_status(f"Model loading failed: {exc}. Check local model setup and dependencies, then restart the app.")
        while not self._stopping.is_set():
            job = self.jobs.next()
            if job is None:
                continue
            self.run_job(job)

    def run_job(self, job):
        """Run one scheduled job on the calling (worker) thread."""
        from .inference import Cancelled

        handlers = {"final": self._job_final, "speculative": self._job_speculative, "preview": self._job_preview,
                    "translate": self._job_translate, "manual": self._job_manual,
                    "retranslate": self._job_retranslate, "finish": self._finish}
        try:
            handlers[job.type](job)
        except Cancelled:
            self.pipeline_stats[f"{job.type}_cancelled"] += 1
        except Exception:
            self._set_notice("A processing task failed. Original archived audio and saved revisions are retained.")
        finally:
            self.jobs.done(job)

    def _transcribe(self, job):
        result = self.model.transcribe(job.event["audio"], sample_rate=RATE, **(job.profile or {}),
                                       **(job.asr or {}), should_cancel=job.should_cancel)
        self.last_gain_db = float(result.get("gain_db") or 0.0)
        return result

    # -- segmenter handoff (reader / watchdog thread) -----------------------------
    def _on_segment(self, event):
        key = (event["utterance"], event["part"])
        emitted_at = time.monotonic()
        detector = self.capture.detector if self.capture is not None else None
        asr = dict(self.capture_audio or {})
        asr = {"language": asr.get("language", "auto"), "normalize": asr.get("normalize", True),
               "speech_db": getattr(detector, "speech_db", None)}
        common = {"key": key, "event": event, "emitted_at": emitted_at, "asr": asr,
                  "profile": self.capture_profile, "archive": self.archive}
        session_id = self.capture_session
        with self.pipe_lock:
            if event["kind"] == "discard":
                # The utterance closed without a final: drop its preview and speculation.
                if event.get("reason") == "short":
                    self.discarded_bursts += 1
                if key != self._open_key:
                    self._close_key(self._open_key)
                self._close_key(key)
                self._open_key = None
                return
            if key != self._open_key:
                self._close_key(self._open_key)
                self._open_key = key
            entry = self._keys.get(key)
            if entry is None:
                entry = self._keys[key] = {"id": self._alloc_id(), "final": False, "spec": None}
            if entry["final"]:
                return
            kind = event["kind"]
            if kind == "preview":
                self._drop_spec(entry)
                self.jobs.submit(Job("preview", session_id, id=entry["id"], **common))
                self.pipeline_stats["previews_requested"] += 1
            elif kind == "pause":
                self._drop_spec(entry)
                self.jobs.cancel(lambda j: j.type == "preview" and j.get("key") == key)
                entry["spec"] = self.jobs.submit(Job("speculative", session_id, id=entry["id"], final=None, **common))
                self._spec_key = key
                self.pipeline_stats["spec_started"] += 1
            elif kind == "final":
                entry["final"] = True
                self.pipeline_stats["finals"] += 1
                self.jobs.cancel(lambda j: j.type == "preview" and j.get("key") == key)
                spec, entry["spec"] = entry["spec"], None
                self._spec_key = None
                if spec is not None and not spec.cancelled and not spec.get("failed") and self._same_audio(spec, event):
                    self.pipeline_stats["spec_reused"] += 1
                    if spec.get("result") is not None:
                        self.jobs.submit(Job("final", session_id, id=entry["id"], reused=spec, **common))
                    else:
                        spec.final = {"event": event, "emitted_at": emitted_at}
                        self.jobs.promote(spec)
                else:
                    if spec is not None:
                        self._discard_spec(spec)
                    self.jobs.submit(Job("final", session_id, id=entry["id"], **common))

    @staticmethod
    def _same_audio(spec, event):
        import numpy as np

        if event.get("same_as_pause"):
            return True
        a, b = spec.event["audio"], event["audio"]
        return spec.event["start"] == event["start"] and len(a) == len(b) and np.array_equal(a, b)

    def _discard_spec(self, spec):
        # pipe_lock held
        if spec.state == "done" and not spec.cancelled:
            self.pipeline_stats["spec_discarded"] += 1  # finished, but speech went on
        elif not spec.cancelled:
            self.jobs.cancel(lambda j: j is spec)
            self.pipeline_stats["spec_cancelled"] += 1

    def _drop_spec(self, entry):
        # pipe_lock held: speech resumed, so the pause decode is obsolete.
        spec, entry["spec"] = entry["spec"], None
        if spec is not None:
            self._discard_spec(spec)
        if self._spec_key is not None and self._keys.get(self._spec_key) is entry:
            self._spec_key = None

    def _close_key(self, key):
        # pipe_lock held: the segmenter moved on from `key`.
        entry = self._keys.pop(key, None) if key is not None else None
        if self._spec_key == key:
            self._spec_key = None
        if entry is None or entry["final"]:
            return  # A final is on its way; its segment replaces the preview.
        self._drop_spec(entry)
        self.jobs.cancel(lambda j: j.type == "preview" and j.get("key") == key)
        with self.live_lock:
            if self.live_preview and self.live_preview["id"] == entry["id"]:
                self.live_preview = None
                self._live_dirty.set()

    def _on_block(self, capture, now):
        # Reader thread, once per block, after the segmenter ran.
        self.audio_seconds = capture.samples / RATE
        self.last_audio_at = now
        detector, segmenter = capture.detector, capture.segmenter
        if detector.speaking or segmenter.open:
            self.last_signal_at = now
        if detector.speaking:
            self.last_speech_seconds = self.audio_seconds
        if self.recording_state == "starting":
            self._set_recording_state("recording", expect=("starting",))
        spec_key = self._spec_key
        if spec_key is not None and detector.speaking and segmenter.open and segmenter.utterance == spec_key[0]:
            with self.pipe_lock:  # Speech resumed after a pause: stop the speculative decode now.
                entry = self._keys.get(spec_key)
                if entry is not None and not entry["final"] and self._spec_key == spec_key:
                    self._drop_spec(entry)

    def _capture_status(self, event):
        kind = event.get("event")
        with self.live_lock:
            if kind == "started":
                device = clean_device(event.get("device")) if isinstance(event.get("device"), dict) else None
                self.device = device
                status = SOURCE_STATUS.get(event.get("source"), "Capturing audio")
                if device and device.get("name"):
                    status = f"Capturing the microphone “{device['name']}”: nearby voices and room sound"
                self.capture_status = status
            elif kind == "input":
                if self.device is not None:
                    volume = event.get("input_volume")
                    self.device = dict(self.device, input_volume=volume if isinstance(volume, (int, float)) and not isinstance(volume, bool) else None)
            elif kind == "format":
                pass
            else:
                message = event.get("message")
                self.capture_status = message if isinstance(message, str) and message else "Check capture permissions"
        if kind == "started":
            self._set_recording_state("recording", expect=("starting",))
        self._live_dirty.set()

    def _capture_done(self, error):
        # Reader thread, after the final flush: every final is already scheduled.
        self._set_recording_state("draining")
        if error:
            self._set_notice(error)
        session_id = self.capture_session
        with self.pipe_lock:
            self._close_key(self._open_key)
            self._open_key = self._spec_key = None
            self.jobs.cancel(lambda j: j.session_id == session_id and (
                j.type == "preview" or (j.type == "speculative" and j.get("final") is None)))
        self.jobs.submit(Job("finish", session_id, archive=self.archive, error=error))

    # -- jobs -------------------------------------------------------------------
    def _job_preview(self, job):
        with self.pipe_lock:
            entry = self._keys.get(job.key)
            if job.key != self._open_key or entry is None or entry["final"]:
                return
        self.pipeline_stats["previews_run"] += 1
        result = self._transcribe(job)
        self._show_preview(job, result)

    def _show_preview(self, job, result):
        text = (result.get("traditional_text") or "").strip()
        with self.pipe_lock:
            entry = self._keys.get(job.key)
            if job.key != self._open_key or entry is None or entry["final"] or not text:
                return
            event = job.event
            preview = {"id": job.id, "start": round(event["start"], 2), "end": round(event["end"], 2), "kind": "audio",
                       "raw_text": result.get("raw_text", ""), "traditional_text": result.get("traditional_text", ""),
                       "english": "", "revision": 0, "speaker": "unknown", "status": "provisional"}
            with self.live_lock:
                self.live_preview = preview
            self.pipeline_stats["previews_shown"] += 1
        self._live_dirty.set()

    def _job_speculative(self, job):
        from .inference import Cancelled

        try:
            result = self._transcribe(job)
        except Cancelled:
            raise
        except Exception:
            with self.pipe_lock:
                job.failed = True
                final = job.get("final")
            if final is None:
                return  # A later final for this audio decodes it afresh.
            # The final relied on this decode: decode again right here, so the
            # segment keeps its place ahead of later finals.
            try:
                result = self._transcribe(job)
            except Exception as exc:
                result = {"error": str(exc)[:500]}
            self._finalize(job, result, final["event"], speculative_at=job.emitted_at)
            return
        with self.pipe_lock:
            if job.cancelled:
                return
            final = job.get("final")
            if final is None:
                job.result = result
        if final is None:
            self._show_preview(job, result)  # Useful while the turn is not yet confirmed.
            return
        self._finalize(job, result, final["event"], speculative_at=job.emitted_at)

    def _job_final(self, job):
        spec = job.get("reused")
        if spec is not None:
            self._finalize(job, spec.result, job.event, speculative_at=spec.emitted_at)
            return
        try:
            result = self._transcribe(job)
        except Exception as exc:
            result = {"error": str(exc)[:500]}
        self._finalize(job, result, job.event)

    def _finalize(self, job, result, event, speculative_at=None):
        """Turn a final recognition into a saved segment and schedule its translation."""
        session_id, archive = job.session_id, job.archive
        speech_end_at = event.get("speech_end_at")
        timing = {key: None for key in TIMING_KEYS}
        timing["endpoint_ms"] = _ms(speech_end_at, speculative_at if speculative_at is not None else job.emitted_at)
        timing["asr_ms"] = result.get("asr_ms") if isinstance(result.get("asr_ms"), int) else None
        start, end = round(event["start"], 2), round(event["end"], 2)
        text = (result.get("traditional_text") or "").strip()
        if "error" not in result and (result.get("no_speech") or not text):
            self.pipeline_stats["no_speech"] += 1
            with self.pipe_lock:
                self.discarded_bursts += 1
            if archive:
                self._journal(archive, {"type": "no_speech", "id": job.id, "start": start, "end": end})
            with self.live_lock:
                if self.live_preview and self.live_preview["id"] == job.id:
                    self.live_preview = None
            self._live_dirty.set()
            return
        segment = {"id": job.id, "start": start, "end": end, "kind": "audio",
                   "raw_text": result.get("raw_text", ""), "traditional_text": result.get("traditional_text", ""),
                   "english": "", "revision": 1, "speaker": "unknown", "timing": timing,
                   "status": "error" if "error" in result else "translating"}
        if "error" in result:
            segment["error"] = result["error"]
        if archive:
            self._journal(archive, {"type": "source_segment", **segment, "cut": event.get("cut"),
                                    "clean": event.get("clean")})
        stored = self._store_or_report(segment, session_id)
        self._publish_segment(stored, session_id)
        timing["speech_end_to_source_ms"] = _ms(speech_end_at, time.monotonic())
        if "error" in result:
            self._store_or_report(dict(segment, timing=timing), session_id)
            return
        self.jobs.submit(Job("translate", session_id, id=job.id, segment=segment, profile=job.profile,
                             archive=archive, speech_end_at=speech_end_at, queued_at=time.monotonic()))

    def _job_translate(self, job):
        self._translate(job, dict(job.segment), history=True)

    def _job_manual(self, job):
        segment = {"id": job.id, "start": None, "end": None, "kind": "manual", "raw_text": job.text,
                   "traditional_text": job.text, "english": "", "revision": 1, "speaker": "unknown",
                   "status": "translating"}
        if job.archive:
            self._journal(job.archive, {"type": "source_segment", **segment})
        stored = self._store_or_report(segment, job.session_id)
        self._publish_segment(stored, job.session_id)
        self._translate(job, segment, history=False)

    def _translate(self, job, segment, history):
        from .inference import Cancelled

        session_id, ident = job.session_id, segment["id"]
        text = segment["traditional_text"].strip()
        profile = dict(job.profile or {})
        if history and session_id:
            pairs = self._translation_history(session_id, ident)
            if pairs:
                profile["history"] = pairs
        last = 0.0

        def superseded():
            current = self._current_segment(session_id, ident)
            return current is not None and (current.get("revision") != segment["revision"]
                                            or current.get("traditional_text") != segment["traditional_text"])

        def on_text(partial):
            nonlocal last
            now = time.monotonic()
            if now - last < PARTIAL_INTERVAL:
                return
            # Check and publish under the lock a user edit takes, so a partial of
            # the old text can never follow the edit.
            with self.lock:
                if superseded():
                    return
                last = now
                self._publish_segment(dict(segment, english=partial, status="translating"), session_id)

        started = time.monotonic()
        completed = False
        try:
            english = self.model.translate(text, **profile, on_text=on_text, should_cancel=superseded) if text else ""
            segment.update(english=english, status="complete")
            segment.pop("error", None)
            completed = True
        except Cancelled:
            segment.update(status="complete")  # A user edit superseded it; the library keeps the edit.
        except Exception as exc:
            # Errors are displayed but model inputs are never put in server logs.
            segment.update(status="error", error=str(exc)[:500])
        timing = segment.get("timing")
        if isinstance(timing, dict) and completed:
            # Only a finished translation is a latency measurement.
            timing = segment["timing"] = dict(timing)
            timing["translate_ms"] = _ms(started, time.monotonic())
            timing["speech_end_to_english_ms"] = _ms(job.get("speech_end_at"), time.monotonic())
        if job.archive:
            self._journal(job.archive, {"type": "segment", **segment})
        stored = self._store_or_report(segment, session_id)
        self._publish_segment(stored, session_id)

    def _job_retranslate(self, job):
        from .inference import Cancelled

        last = 0.0

        def superseded():
            current = self._current_segment(job.session_id, job.id)
            return current is not None and current.get("revision") != job.revision

        def on_text(partial):
            nonlocal last
            now = time.monotonic()
            if now - last < PARTIAL_INTERVAL:
                return
            with self.lock:
                current = self._current_segment(job.session_id, job.id)
                if current is None or current.get("revision") != job.revision:
                    return
                last = now
                self._publish_segment(dict(current, english=partial, status="translating"), job.session_id)

        error, english = None, ""
        try:
            english = self.model.translate(job.text, **(job.profile or {}), on_text=on_text, should_cancel=superseded)
        except Cancelled:
            return
        except Exception as exc:
            error = str(exc)[:500]
        with self.lock:
            try:
                stored = self.library.update_translation(job.session_id, job.id, job.revision, english, error)
            except ValueError:
                return  # A newer user edit has already superseded this result.
            self._remember(stored, job.session_id)
        self._publish_segment(stored, job.session_id)
        self._journal_session(job.session_id, {"type": "segment", **stored})

    def _finish(self, job):
        status = "error" if job.get("error") else "complete"
        try:
            try:
                if job.archive is not None:
                    self._journal(job.archive, {"type": "pipeline_stats", **{k: int(v) for k, v in self.pipeline_stats.items()}})
                    job.archive.close(status)
            except Exception:
                self._set_notice("Could not finalize the session journal.")
            try:
                if job.session_id:
                    self.library.set_session_status(job.session_id, status)
            except Exception:
                self._set_notice("Could not record the final session status; captions and audio are retained.")
        finally:
            with self.lock:
                self.capture = None
                self.archive = None
                self.capture_session = None
                with self.live_lock:
                    self.live_preview = None
                    self.device = None
                    self.capture_status = "Capture failed; see the error above" if job.get("error") else "Capture stopped; captions finished"
                self._set_recording_state("idle")
            self._request_refresh()

    # -- segment storage and publication --------------------------------------------
    def _journal(self, archive, event):
        try:
            archive.log(event)
        except Exception:
            self._set_notice("Transcript journal write failed. Audio may still be available in the archive.")

    def _store(self, segment, session_id):
        """Save (library rules decide whether a user edit wins) and mirror into memory."""
        with self.lock:
            stored = self.library.upsert_segment(session_id, segment) if session_id else dict(segment)
            self._remember(stored, session_id)
            return stored

    def _store_or_report(self, segment, session_id):
        """_store, but a library failure still shows the caption (as an error) and keeps going.

        The journal already holds the segment, so the next start restores it.
        """
        try:
            return self._store(segment, session_id)
        except Exception:
            failed = dict(segment, status="error",
                          error="Not saved: the transcript library could not be written. "
                                "The session journal keeps this caption; it is restored on the next start.")
            with self.lock:
                self._remember(failed, session_id)
            self._set_notice("Captions could not be saved to the transcript library (disk full or locked?). "
                             "They are kept in the session journal and restored on the next start.")
            return failed

    def _journal_session(self, session_id, event):
        """Journal a change to a session that may no longer be recording."""
        archive = self.archive
        if archive is not None and archive.id == session_id:
            self._journal(archive, event)
            return
        try:
            append_journal(self._session_path(session_id) / "events.jsonl", event)
        except FileNotFoundError:
            pass  # No journal (manual-only session): the library is the only record.
        except Exception:
            self._set_notice("Saved, but the session journal could not be updated.")

    def _remember(self, segment, session_id):
        # lock held; copy-on-write so lock-free readers see a consistent list
        if session_id != self.session_id:
            return
        old = self.segments
        segments = list(old)
        previous_timing = None
        for index, previous in enumerate(segments):
            if previous["id"] == segment["id"]:
                previous_timing = previous.get("timing")
                segments[index] = dict(segment)
                break
        else:
            segments.append(dict(segment))
        cache = self._latency_cache
        if cache is not None and cache[0] is old and previous_timing == segment.get("timing"):
            self._latency_cache = (segments, cache[1])  # timing unchanged: the summary still holds
        self.segments = segments

    def _latency(self):
        """Latency summary of the selected session, recomputed only when the segments changed."""
        segments = self.segments
        cache = self._latency_cache
        if cache is not None and cache[0] is segments:
            return cache[1]
        summary = latency_summary(segments)
        self._latency_cache = (segments, summary)
        return summary

    def _current_segment(self, session_id, ident):
        if session_id != self.session_id:
            return None
        return next((s for s in reversed(self.segments) if s["id"] == ident), None)

    def _publish_segment(self, segment, session_id):
        with self.live_lock:
            if self.live_preview and self.live_preview["id"] == segment["id"]:
                self.live_preview = None
            if session_id == self.session_id:
                self.hub.publish({"type": "segment", "session_id": session_id, "segment": segment})

    def _translation_history(self, session_id, ident):
        """Up to three earlier completed audio pairs; edits (pending) are excluded."""
        from .inference import _history_pairs

        if session_id == self.session_id:
            segments = self.segments
        else:
            segments = self.library.get_session(session_id)["segments"]
        pairs = []
        size = 0
        for segment in reversed(segments):
            if segment["id"] >= ident or segment["kind"] != "audio" or segment["status"] != "complete":
                continue
            source, target = segment["traditional_text"], segment["english"]
            if not source.strip() or not target.strip() or len(source) > 5000 or len(target) > 5000:
                continue
            try:
                _history_pairs([(source, target)])
            except (TypeError, ValueError):
                continue  # A bad prior pair must not poison later translations.
            if size + len(source) + len(target) > 8000:
                break
            pairs.append((source, target))
            size += len(source) + len(target)
            if len(pairs) == 3:
                break
        return list(reversed(pairs))

    # -- use cases ------------------------------------------------------------------
    def start(self, source, consent):
        if source not in ("teams", "system", "microphone"):
            raise ValueError("Invalid audio source.")
        if consent is not True:
            raise ValueError("Confirm recording notice and consent first.")
        with self.lock:
            if self._post_busy():
                raise ValueError("Wait for or cancel the post-meeting job before starting capture.")
            if self.recording_state != "idle":
                raise ValueError("Recording is already active or still draining.")
            if self.jobs.unfinished_tasks:
                raise ValueError("Wait for pending translations to finish before starting a recording.")
            if not self.model_ready:
                raise ValueError("Models are not ready. Check model setup and status.")
            helper = self.helper
            if not helper.is_file() or not os.access(helper, os.X_OK):
                raise ValueError("Capture helper not found at .build/capture-audio. Build it first.")
            settings = self.library.get_settings()
            audio = dict(settings.get("audio") or {})
            notice = ""
            device_uid = audio.get("device_uid") if source == "microphone" else None
            if device_uid and helper_protocol(helper) != 2:
                device_uid = None
                notice = ("The capture helper is outdated, so the selected microphone is ignored and the macOS "
                          "default input is used. Rebuild it with scripts/build_capture.sh.")
            archive = Archive(self.data_dir / "sessions", source)
            # A new recording starts from the saved default context, not from
            # whichever archived session happens to be open.
            context = settings.get("meeting_context", "")
            self.library.register_session(archive.id, source, context)
            self.capture_profile = self.profile(archive.id)
            self.capture_audio = audio
            with self.pipe_lock:
                self._keys, self._open_key, self._spec_key = {}, None, None
            self.pipeline_stats = collections.Counter()
            with self.live_lock:
                self.live_preview = None
                self.device = None
                self.capture_status = "Starting capture; check macOS permission prompts"
            self.last_gain_db = 0.0
            self.archive = archive
            self.session_id = archive.id
            self.capture_session = archive.id
            self.segments = []
            self.next_id = 1
            self.started_at = time.monotonic()
            self.last_audio_at = None
            self.last_signal_at = None
            self.audio_seconds = 0.0
            self.discarded_bursts = 0
            self.last_speech_seconds = None
            self.notice = notice
            self._context_warned = self._lag_warned = False
            self._context_notice(self.capture_profile.get("context", ""))
            self._set_recording_state("starting")
            capture = Capture(helper, source, archive, on_segment=self._on_segment, on_block=self._on_block,
                              on_status=self._capture_status, on_done=self._capture_done, device_uid=device_uid,
                              stall_seconds=self.stall_seconds)
            self.capture = capture
            try:
                capture.start()
            except Exception:
                self.capture = None
                self.archive = None
                self.capture_session = None
                self._set_recording_state("idle")
                archive.close_audio()
                archive.close("capture_start_failed")
                self.library.set_session_status(archive.id, "capture_start_failed")
                raise
        self._request_refresh()

    def stop(self):
        with self.lock:
            if self.recording_state not in ("starting", "recording"):
                raise ValueError("No active recording to stop.")
            self._set_recording_state("draining")
            with self.live_lock:
                self.capture_status = "Stopping capture; preserving the final audio"
            capture = self.capture
        capture.stop()
        kill_after = self.kill_after

        def watchdog():
            try:
                capture.proc.wait(timeout=kill_after)
            except Exception:
                if capture.proc.poll() is None:
                    capture.proc.kill()
        threading.Thread(target=watchdog, daemon=True).start()

    def manual(self, text):
        if not isinstance(text, str) or not text.strip() or len(text) > 5000:
            raise ValueError("Enter Chinese text (up to 5,000 characters).")
        with self.lock:
            if not self.model_ready:
                raise ValueError("Models are not ready.")
            if self._post_busy():
                raise ValueError("Wait for or cancel the post-meeting job first.")
            if self.recording_state == "draining":
                raise ValueError("Wait until the recording has finished draining.")
            self.jobs.submit(Job("manual", self.session_id, id=self._alloc_id(), text=text.strip(),
                                 archive=self.archive, profile=self.profile(self.session_id)))

    def update_settings(self, data):
        with self.lock:
            previous_uid = (self.library.get_settings().get("audio") or {}).get("device_uid")
            settings = super().update_settings(data)
            new_uid = (settings.get("audio") or {}).get("device_uid")
            if new_uid != previous_uid and self.capture is None:
                with self.live_lock:
                    self.input_volume_mode = "auto"
            return settings

    def devices(self):
        listed = list_devices(self.helper)
        devices = [{**d, "direct_volume_supported": direct_input_volume_supported(d, "microphone", self.helper)}
                   for d in listed.get("devices", [])]
        return {"supported": listed.get("supported", False), "devices": devices}

    def set_input_volume(self, volume=None, device_uid=None, mode=None):
        if mode == "auto" and volume is None:
            with self.live_lock:
                self.input_volume_mode = "auto"
            self._request_refresh()
            return {"input_volume_mode": "auto", "input_volume": (self.device or {}).get("input_volume")}
        if isinstance(volume, bool) or not isinstance(volume, (int, float)):
            raise ValueError("Input volume must be a number between 0.0 and 1.0.")
        level = float(volume)
        if not math.isfinite(level) or not 0.0 <= level <= 1.0:
            raise ValueError("Input volume must be between 0.0 and 1.0.")
        if device_uid is not None and not isinstance(device_uid, str):
            raise ValueError("device_uid must be a string.")
        explicit_uid = device_uid.strip() if isinstance(device_uid, str) else ""
        if explicit_uid.startswith("-"):
            raise ValueError("device_uid must be an input device UID.")

        with self.lock:
            capture = self.capture
            capture_source = getattr(capture, "source", "microphone") if capture is not None else None
            if capture_source is not None and capture_source != "microphone":
                raise ValueError("Direct microphone input volume is only available when capturing a microphone.")
            saved_audio = dict((self.library.get_settings().get("audio") or {}))
            target_uid = explicit_uid or saved_audio.get("device_uid") or ""

        listed = list_devices(self.helper)
        if not listed.get("supported"):
            raise ValueError("Direct microphone input volume control is unavailable.")
        candidates = listed.get("devices", [])
        target_dev = next((d for d in candidates if d.get("uid") == target_uid), None) if target_uid else next((d for d in candidates if d.get("is_default")), None)
        if not direct_input_volume_supported(target_dev, "microphone", self.helper):
            raise ValueError("Direct microphone input volume control is unavailable for the selected input.")

        updated = helper_set_input_volume(self.helper, level, device_uid=target_uid or None)
        with self.live_lock:
            self.input_volume_mode = "manual"
            if self.device is not None and (not updated.get("uid") or self.device.get("uid") == updated.get("uid")):
                self.device = dict(self.device, input_volume=updated.get("input_volume"))
        self._request_refresh()
        return {"input_volume": updated.get("input_volume"), "uid": updated.get("uid", ""),
                "input_volume_mode": "manual"}

    def translate_manual(self, text, *, source_lang="zh-hant", target_lang="en", include_pinyin=False):
        if not isinstance(text, str) or not text.strip() or len(text) > 5000:
            raise ValueError("Enter text to translate (up to 5,000 characters).")
        src_norm, tgt_norm = validate_language_pair(source_lang, target_lang)
        with self.lock:
            model = self.model
            ready = self.model_ready
            load_state = self.model_load_state
            status_msg = self.model_status
            error_msg = getattr(self, "model_error", "")
            profile = self.profile(self.session_id)
        if not ready or model is None or load_state in ("loading", "error", "unloaded"):
            if load_state == "loading":
                raise ServiceUnavailableError("Translation model is still loading locally. Try again once models are ready.")
            if load_state == "error":
                raise ServiceUnavailableError(error_msg or status_msg or "Translation model failed to load.")
            raise ServiceUnavailableError("Translation model is not loaded.")
        source_text = text.strip()
        try:
            translated = model.translate(
                source_text,
                context=profile["context"],
                vocabulary=profile["vocabulary"],
                source_lang=src_norm,
                target_lang=tgt_norm,
            )
        except ValueError:
            raise
        except Exception as exc:
            raise TranslationFailureError(f"Translation failed: {exc}") from None
        payload = {
            "translation": translated,
            "source_lang": src_norm or "auto",
            "target_lang": tgt_norm,
        }
        if include_pinyin:
            if has_chinese(source_text):
                payload["source_pinyin"] = analyze_pinyin(source_text)
            if has_chinese(translated):
                payload["target_pinyin"] = analyze_pinyin(translated)
        return payload

    def lookup_pinyin(self, text):
        return analyze_pinyin(text)

    def capabilities(self):
        return {
            "helper_protocol": helper_protocol(self.helper),
            "helper_stale": helper_stale(self.helper, HELPER_SOURCE),
            "event_stream": True,
        }

    # -- state ----------------------------------------------------------------------
    def _feed(self, now):
        state = self.recording_state
        active = state in ("starting", "recording")
        last_audio, last_signal = self.last_audio_at, self.last_signal_at
        no_audio = active and now - (last_signal or self.started_at or now) > 8
        if state == "starting":
            feed = "Waiting for capture startup / macOS permission — audio not yet confirmed"
        elif active and last_audio is None:
            feed = "Capture opened, but no audio frames have arrived"
        elif active and now - last_audio > 3:
            feed = "Audio feed stalled: no new frames for over 3 seconds"
        elif active and (last_signal is None or now - last_signal > 8):
            feed = "Audio frames arriving; no speech detected for a while"
        elif active:
            feed = "Audio frames and speech are arriving"
        else:
            feed = "Capture inactive"
        return no_audio, feed

    def audio_state(self):
        capture = self.capture
        device = self.device
        capture_source = getattr(capture, "source", "microphone") if capture is not None else "microphone"
        direct_supported = direct_input_volume_supported(device, capture_source, self.helper)
        mode = self.input_volume_mode if (capture is None or direct_supported) else "auto"
        if capture is None:
            levels = {"rms_db": None, "peak_db": None, "noise_db": None, "speech_db": None, "snr_db": None,
                      "threshold_db": None, "speaking": False, "gain_db": 0.0, "clipped_recent": 0,
                      "clipped_total": 0}
            return {**levels, "advice": "", "device": device, "direct_volume_supported": direct_supported,
                    "input_volume_mode": mode}
        meter = capture.meter.snapshot()
        detector = capture.detector
        noise, speech = detector.noise_db, detector.speech_db
        snr = speech - noise if speech is not None and noise is not None else None
        levels = {"rms_db": _round(meter["rms_db"]), "peak_db": _round(meter["peak_db"]),
                  "noise_db": _round(noise), "speech_db": _round(speech), "snr_db": _round(snr),
                  "threshold_db": _round(detector.threshold_db), "speaking": bool(detector.speaking),
                  "gain_db": _round(self.last_gain_db if (self.capture_audio or {}).get("normalize", True) else 0.0) or 0.0,
                  "clipped_recent": meter["clipped_recent"], "clipped_total": meter["clipped_total"]}
        hint = ""
        if capture.samples:
            facts = {**levels, "input_volume": (device or {}).get("input_volume")}
            quiet_for = capture.samples / RATE - (self.last_speech_seconds or 0.0)
            if facts["peak_db"] is not None and facts["peak_db"] <= -90.0 and quiet_for < NO_SIGNAL_AFTER_SECONDS:
                # Digital silence is normal on Teams/system audio between speakers:
                # warn about a dead input only after a long stretch without speech.
                facts["peak_db"] = None
            hint = advice(facts)
        return {**levels, "advice": hint, "device": device, "direct_volume_supported": direct_supported,
                "input_volume_mode": mode}

    def live_payload(self, now=None, latency=False):
        now = time.monotonic() if now is None else now
        queue_length, lag, pending = self.jobs.stats(now)
        no_audio, feed = self._feed(now)
        return {"type": "live", "recording_state": self.recording_state, "audio": self.audio_state(),
                "audio_seconds": round(self.audio_seconds, 1), "preview": self.live_preview,
                "queue_length": queue_length, "queue_lag_seconds": round(lag, 1), "pending_work": pending,
                "no_audio": no_audio, "feed_status": feed, "capture_status": self.capture_status,
                "notice": self.notice, "discarded_bursts": self.discarded_bursts,
                "latency": self._latency() if latency is False else latency}

    def state(self):
        # Every event with seq <= this value is reflected below (see events.py).
        seq = self.hub.seq
        live = self.live_payload()
        live.pop("type")
        preview = live.pop("preview")
        return {**self.workbench_state(), **live, "model_status": self.model_status, "model_ready": self.model_ready,
                "model_load_state": self.model_load_state,
                "pinyin": pinyin_status(), "translation_languages": supported_languages(),
                "session_id": self.session_id, "segments": list(self.segments), "live_preview": preview, "seq": seq,
                "capabilities": self.capabilities(), "launcher_name": launcher_name(),
                "archive_dir": str(self.data_dir / "sessions"),
                "session_path": str(self.data_dir / "sessions" / self.session_id) if self.session_id else None}

    def _check_lag(self, lag, capturing=True):
        self.pipeline_stats["max_lag_ms"] = max(self.pipeline_stats["max_lag_ms"], int(lag * 1000))
        if capturing and lag > LAG_NOTICE_SECONDS and not self._lag_warned:
            self._lag_warned = True
            self._set_notice(f"Recognition is running {int(lag)} s behind the audio. Captions will catch up; nothing is skipped.")

    def _refresh_fingerprint(self):
        if not self.lock.acquire(timeout=0.05):
            return None
        try:
            job = json.dumps(self.background_job, sort_keys=True, default=str)
        finally:
            self.lock.release()
        return (self.model_status, self.model_ready, self.recording_state, self.session_id, job)

    def _ticker(self):
        last_live = None
        last_fingerprint = self._refresh_fingerprint()
        last_refresh = last_sent = 0.0
        while not self._stopping.is_set():
            capturing = self.recording_state != "idle"
            timeout = LIVE_INTERVAL if capturing else 0.5
            if self._refresh_wanted:  # a deferred refresh: wake when it is due, not before
                timeout = min(timeout, max(0.0, last_refresh + REFRESH_INTERVAL - time.monotonic()))
            self._live_dirty.wait(timeout)
            self._live_dirty.clear()
            delay = LIVE_INTERVAL - (time.monotonic() - last_sent)
            if delay > 0 and self._stopping.wait(delay):
                return
            if self._stopping.is_set():
                return
            started = time.monotonic()
            try:
                latency = self._latency()  # cached; recomputed outside the lock when segments change
                with self.live_lock:
                    payload = self.live_payload(started, latency=latency)
                    encoded = json.dumps(payload, sort_keys=True, default=str)
                    if encoded != last_live:
                        last_live, last_sent = encoded, started
                        self.hub.publish(payload)
                self._check_lag(payload["queue_lag_seconds"], capturing)
                fingerprint = self._refresh_fingerprint()
                if fingerprint is not None and fingerprint != last_fingerprint:
                    last_fingerprint = fingerprint
                    self._refresh_wanted = True
                if self._refresh_wanted and started - last_refresh >= REFRESH_INTERVAL:
                    self._refresh_wanted = False
                    last_refresh = started
                    self.hub.publish({"type": "refresh"})
            except Exception:
                pass  # The stream is best effort; /api/state remains authoritative.

    def save(self):
        if self.session_id:
            return self.export("markdown")
        with self.lock:
            segments = list(self.segments)
            session_id = self.session_id
        directory = self.data_dir / "sessions"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Exclusive creation avoids overwriting existing exports.
        filename = f"transcript-{session_id or 'manual'}-{secrets.token_hex(4)}.txt"
        path = directory / filename
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            for s in segments:
                interval = f"[{s['start']:.1f}s–{s['end']:.1f}s]" if s.get("start") is not None else "[Manual]"
                out.write(f"{interval}\n{s.get('traditional_text', '')}\n{s.get('english', '')}\n\n")
        return str(path)


# -- HTTP ---------------------------------------------------------------------------

SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'",
}


class Server(ThreadingHTTPServer):
    daemon_threads = True    # open event streams never block shutdown
    block_on_close = False


def make_handler(app, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass  # Do not log tokens, requests or transcript content.

        def _valid_host(self):
            return self.headers.get("Host", "") == f"127.0.0.1:{self.server.server_port}"

        def _auth(self, mutate=False):
            if not self._valid_host():
                return False
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                return False
            if mutate and self.headers.get("Origin") != f"http://127.0.0.1:{self.server.server_port}":
                return False
            return True

        def _headers(self, status, content_type, cookie=False, length=None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            if length is not None:
                self.send_header("Content-Length", str(length))
            for name, value in SECURITY_HEADERS.items():
                self.send_header(name, value)
            if cookie:
                self.send_header("Set-Cookie", f"meeting_session={token}; HttpOnly; SameSite=Strict; Path=/")
            self.end_headers()

        def _reply(self, status, body, content_type="application/json; charset=utf-8", cookie=False):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self._headers(status, content_type, cookie, len(body))
            self.wfile.write(body)

        def _cookie_ok(self):
            try:
                saved = SimpleCookie(self.headers.get("Cookie", "")).get("meeting_session")
                return bool(saved and hmac.compare_digest(saved.value, token))
            except Exception:
                return False

        def _guard(self, run):
            try:
                run()
            except ServiceUnavailableError as exc:
                self._safe_error(503, str(exc))
            except TranslationFailureError as exc:
                self._safe_error(502, str(exc))
            except (ValueError, TypeError, KeyError, OSError, wave.Error) as exc:
                message = exc.args[0] if isinstance(exc, KeyError) and exc.args else exc
                self._safe_error(400, f"Invalid request: missing or invalid {message}" if isinstance(exc, KeyError) else str(exc))
            except Exception:
                self._safe_error(500, "Internal server error. Captured audio and saved revisions are retained.")

        def _safe_error(self, status, message):
            try:
                self._reply(status, {"error": str(message)[:2000] or "Request failed."})
            except OSError:
                pass

        def do_GET(self):
            self._guard(self._get)

        def do_POST(self):
            self._guard(self._post)

        def _get(self):
            if not self._valid_host():
                return self._reply(403, {"error": "Forbidden"})
            # Route on the raw path: urlsplit would read "//name" as a host.
            path, _, query_string = self.path.partition("?")
            target = urlsplit("http://127.0.0.1" + path)._replace(query=query_string)
            if not path.startswith("/api/"):
                name = path[1:]
                found = static_file(name) if path.startswith("/") and "/" not in name else None
                supplied = parse_qs(target.query).get("token", [""])[0]
                bootstrap = path == "/" and hmac.compare_digest(supplied, token)
                if found is None or (not self._cookie_ok() and not bootstrap):
                    return self._reply(403, {"error": "Forbidden"})
                body, kind = found
                return self._reply(200, body, kind, cookie=bootstrap)
            if not self._auth():
                return self._reply(403, {"error": "Forbidden"})
            query = parse_qs(target.query)
            if path == "/api/state":
                return self._reply(200, app.state())
            if path == "/api/events":
                return self._events()
            if path == "/api/devices":
                return self._reply(200, app.devices())
            if path == "/api/history":
                segment = query.get("segment_id", [""])[0]
                return self._reply(200, {"history": app.history(int(segment), query.get("session_id", [""])[0])})
            if path == "/api/audio":
                clip = app.audio_clip(query.get("session_id", [""])[0], query.get("start", [""])[0], query.get("end", [""])[0])
                return self._reply(200, clip, "audio/wav")
            return self._reply(404, {"error": "Not found"})

        def _events(self):
            client = app.hub.subscribe()
            self.close_connection = True
            try:
                self._headers(200, "application/x-ndjson; charset=utf-8")
                self.wfile.write(app.hub.ping())
            except OSError:
                app.hub.unsubscribe(client)
                return

            def write(data):
                self.wfile.write(data)
                self.wfile.flush()
            app.hub.stream(client, write)

        def _post(self):
            if not self._auth(mutate=True):
                return self._reply(403, {"error": "Forbidden"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise ValueError("Invalid request size.") from None
            if size < 0 or size > 131072:
                raise ValueError("Invalid request size.")
            try:
                data = json.loads(self.rfile.read(size) or b"{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise ValueError("Request body must be JSON.") from None
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object.")
            path = self.path
            if path == "/api/start":
                app.start(data.get("source"), data.get("consent"))
                response = {"ok": True}
            elif path == "/api/stop":
                app.stop()
                response = {"ok": True}
            elif path == "/api/manual":
                app.manual(data.get("text"))
                response = {"ok": True}
            elif path == "/api/translate":
                return self._reply(200, app.translate_manual(
                    data.get("text"),
                    source_lang=data.get("source_lang", "zh-hant"),
                    target_lang=data.get("target_lang", "en"),
                    include_pinyin=bool(data.get("include_pinyin", False)),
                ))
            elif path == "/api/pinyin":
                return self._reply(200, app.lookup_pinyin(data.get("text")))
            elif path == "/api/audio/input-volume":
                response = app.set_input_volume(data.get("volume"), device_uid=data.get("device_uid"), mode=data.get("mode"))
            elif path == "/api/save":
                response = {"path": app.save()}
            elif path == "/api/settings":
                response = {"settings": app.update_settings(data)}
            elif path == "/api/vocabulary":
                response = {"entry": app.vocabulary_add(data)}
            elif path == "/api/vocabulary/delete":
                app.vocabulary_remove(data.get("id"))
                response = {"ok": True}
            elif path == "/api/session/open":
                response = {"session": app.session_open(data.get("session_id"))}
            elif path == "/api/session/context":
                if not isinstance(data.get("session_id"), str):
                    raise ValueError("A session ID is required to change its context.")
                response = {"session": app.session_context(data.get("context"), data["session_id"])}
            elif path == "/api/session/delete":
                app.session_delete(data.get("session_id"), data.get("confirm"))
                response = {"ok": True}
            elif path == "/api/segment/edit":
                if not isinstance(data.get("session_id"), str):
                    raise ValueError("A session ID is required for an edit.")
                response = {"segment": app.segment_edit(data)}
                app.hub.publish({"type": "segment", "session_id": data["session_id"], "segment": response["segment"]})
            elif path == "/api/segment/retranslate":
                app.segment_retranslate(data.get("id"), data.get("session_id", ""))
                response = {"ok": True}
            elif path == "/api/speakers":
                response = app.speaker_names(data.get("names"), data.get("session_id", ""))
            elif path == "/api/attribution":
                response = {"session": app.attribution_flag(data.get("unreliable"), data.get("session_id", ""))}
            elif path == "/api/job/start":
                response = {"job": app.job_start(data)}
            elif path == "/api/job/cancel":
                app.job_stop()
                response = {"ok": True}
            elif path == "/api/artifact/apply":
                response = app.artifact_apply(data)
            elif path == "/api/export":
                response = {"path": app.export(data.get("format"))}
            else:
                return self._reply(404, {"error": "Not found"})
            app._request_refresh()
            self._reply(200, response)

    return Handler


def shutdown(app, timeout=None):
    """Ctrl-C: stop capture (even if it is already draining), then let queued captions finish."""
    capture = app.capture
    if capture:
        try:
            app.stop()
        except Exception:
            capture.stop()  # Already draining: make sure the helper is asked to end.
        if capture.reader:
            capture.reader.join(timeout=15)
    pending = app.jobs.unfinished_tasks
    if pending:
        print(f"Finishing {pending} pending caption task(s); press Ctrl+C again to quit now.", flush=True)
    app.jobs.wait_idle(timeout)
    if app._post_busy():
        try:
            app.job_stop()
        except ValueError:
            pass
        if app.job_thread:
            app.job_thread.join(timeout=5)


def make_server(app, token, port=0):
    return Server(("127.0.0.1", port), make_handler(app, token))


def main():
    parser = argparse.ArgumentParser(description="Local meeting transcription and translation")
    parser.add_argument("--port", type=int, default=8770, help="Loopback HTTP port (default: 8770; 0 chooses an available port)")
    parser.add_argument("--no-browser", action="store_true", help="Print the launch URL without opening a browser")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    try:
        app = Application()
    except ValueError as exc:
        parser.exit(1, str(exc) + "\n")
    token = secrets.token_urlsafe(32)
    try:
        server = make_server(app, token, args.port)
    except OSError as exc:
        app.instance_lock.close()
        parser.exit(1, f"Cannot listen on 127.0.0.1:{args.port}: {exc}. Try --port 0 or another available port.\n")
    url = f"http://127.0.0.1:{server.server_port}/?token={token}"
    print("Meeting Assistant started. Open this session URL if the browser does not open:")
    print(url, flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        shutdown(app)
    finally:
        app.hub.close()
        server.server_close()
        # An in-flight model call may not be cancellable. Retain ownership until
        # process exit rather than allowing another server to mutate its files.
        if not app.job_thread or not app.job_thread.is_alive():
            app.instance_lock.close()
