"""Loopback-only HTTP UI and single-worker local inference orchestration."""

import argparse
import hmac
import json
import os
import queue
import secrets
import threading
import time
import webbrowser
import wave
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .audio import Capture
from .storage import Archive, DATA_DIR
from .workbench import Workbench
from .instance import InstanceLock

# Meeting data defaults to owner-only permissions, including on exceptional paths.
os.umask(0o077)

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
MAX_QUEUE = 12


def launcher_name():
    """Best-effort hint only; macOS determines the actual permission owner."""
    bundle = os.environ.get("__CFBundleIdentifier", "")
    names = {"com.apple.Terminal": "Terminal", "com.cmuxterm.app": "cmux",
             "com.googlecode.iterm2": "iTerm", "com.microsoft.VSCode": "Visual Studio Code"}
    if bundle in names:
        return names[bundle]
    return {"Apple_Terminal": "Terminal", "iTerm.app": "iTerm", "vscode": "Visual Studio Code"}.get(os.environ.get("TERM_PROGRAM"), "your terminal app")


class Application(Workbench):
    def __init__(self):
        self.instance_lock = InstanceLock(DATA_DIR)
        self.lock = threading.RLock()
        self.jobs = queue.Queue(maxsize=MAX_QUEUE)
        self.model = None
        self.model_status = "Loading models locally…"
        self.model_ready = False
        self.capture = None
        self.archive = None
        self.session_id = None
        self.recording_state = "idle"
        self.segments = []
        self.next_id = 1
        self.level = 0.0
        self.last_audio_at = None
        self.last_signal_at = None
        self.audio_seconds = 0.0
        self.started_at = None
        self.dropped = 0
        self.notice = ""
        self.capture_status = "Not capturing"
        self.inflight_at = None
        self._init_workbench()
        self.capture_profile = None
        threading.Thread(target=self._worker, daemon=True).start()

    def _model_status(self, message):
        with self.lock:
            self.model_status = str(message)

    def _worker(self):
        try:
            from .inference import LocalModels
            model = LocalModels(DATA_DIR, status_callback=self._model_status)
            model.load()
            with self.lock:
                self.model = model
                self.model_ready = True
                self.model_status = "Models ready"
        except Exception as exc:
            with self.lock:
                self.model_status = f"Model loading failed: {exc}. Check local model setup and dependencies, then restart the app."
        while True:
            job = self.jobs.get()
            try:
                if job["type"] == "finish":
                    self._finish(job)
                    continue
                with self.lock:
                    self.inflight_at = job["queued_at"]
                self._infer(job)
            except Exception:
                with self.lock:
                    self.notice = "A processing task failed. Original archived audio and saved revisions are retained."
            finally:
                with self.lock:
                    self.inflight_at = None
                self.jobs.task_done()

    def _infer(self, job):
        if job["type"] == "retranslate":
            error = None
            english = ""
            try:
                english = self.model.translate(job["text"], **job.get("profile", {}))
            except Exception as exc:
                error = str(exc)
            try:
                self.library.update_translation(job["session_id"], job["id"], job["revision"], english, error)
            except ValueError:
                return  # A newer user edit has already superseded this result.
            with self.lock:
                if self.session_id == job["session_id"]:
                    self._sync_selected()
            return
        archive = job.get("archive")
        session_id = job.get("session_id")
        profile = job.get("profile", {})
        result = {"id": job["id"], "start": job.get("start"), "end": job.get("end"), "kind": job["type"]}
        try:
            if job["type"] == "audio":
                asr = self.model.transcribe(job["audio"], sample_rate=16000, **profile)
                result["raw_text"] = asr.get("raw_text", "")
                result["traditional_text"] = asr.get("traditional_text", "")
            else:
                result["raw_text"] = job["text"]
                result["traditional_text"] = job["text"]
            text = result["traditional_text"].strip()
            result["revision"] = 1
            result["speaker"] = "unknown"
            result["status"] = "translating" if text else "complete"
            if archive:
                archive.log({"type": "source_segment", **result})
            self._publish(result, session_id)
            result["english"] = self.model.translate(text, **profile) if text else ""
            result["status"] = "complete"
        except Exception as exc:
            result["status"] = "error"
            # Errors are displayed but model inputs are never put in server logs.
            result["error"] = str(exc)
        if archive:
            try:
                archive.log({"type": "segment", **result})
            except Exception:
                with self.lock:
                    self.notice = "Transcript journal write failed. Audio may still be available in the archive."
        self._publish(result, session_id)

    def _publish(self, result, session_id=None):
        if session_id:
            result = self.library.upsert_segment(session_id, result)
        with self.lock:
            if session_id and session_id != self.session_id:
                return
            for index, previous in enumerate(self.segments):
                if previous["id"] == result["id"]:
                    self.segments[index] = dict(result)
                    break
            else:
                self.segments.append(dict(result))

    def _finish(self, job):
        try:
            job["archive"].close("error" if job.get("error") else "complete")
        except Exception:
            with self.lock:
                self.notice = "Could not finalize the session journal."
        with self.lock:
            if job.get("session_id"):
                self.library.set_session_status(job["session_id"], "error" if job.get("error") else "complete")
            self.capture = None
            self.archive = None
            self.recording_state = "idle"
            self.level = 0.0
            self.capture_status = "Capture failed; see the error above" if job.get("error") else "Capture stopped; captions finished"

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
            helper = ROOT / ".build" / "capture-audio"
            if not helper.is_file() or not os.access(helper, os.X_OK):
                raise ValueError("Capture helper not found at .build/capture-audio. Build it first.")
            archive = Archive(DATA_DIR / "sessions", source)
            self.library.register_session(archive.id, source, self.profile(self.session_id)["context"])
            self.capture_profile = self.profile(archive.id)
            self.archive = archive
            self.session_id = archive.id
            self.segments = []
            self.next_id = 1
            self.level = 0.0
            self.started_at = time.monotonic()
            self.last_audio_at = None
            self.last_signal_at = None
            self.audio_seconds = 0.0
            self.dropped = 0
            self.notice = ""
            self.capture_status = "Starting capture; check macOS permission prompts"
            self.recording_state = "starting"
            capture = Capture(helper, source, archive, self._chunk, self._level, self._capture_done, self._capture_status)
            self.capture = capture
            try:
                capture.start()
            except Exception:
                self.capture = None
                self.archive = None
                self.recording_state = "idle"
                archive.close_audio()
                archive.close("capture_start_failed")
                self.library.set_session_status(archive.id, "capture_start_failed")
                raise

    def stop(self):
        with self.lock:
            if self.recording_state not in ("starting", "recording"):
                raise ValueError("No active recording to stop.")
            self.recording_state = "draining"
            self.capture_status = "Stopping capture; preserving the final audio chunk"
            capture = self.capture
            capture.stop()
        def watchdog():
            try:
                capture.proc.wait(timeout=5)
            except Exception:
                if capture.proc.poll() is None:
                    capture.proc.kill()
        threading.Thread(target=watchdog, daemon=True).start()

    def _level(self, level, offset):
        with self.lock:
            self.level = level
            self.audio_seconds = offset
            self.last_audio_at = time.monotonic()
            if self.recording_state == "starting":
                self.recording_state = "recording"
            if level >= 0.008:
                self.last_signal_at = self.last_audio_at

    def _capture_status(self, event):
        with self.lock:
            if event["event"] == "started":
                if self.recording_state == "starting":
                    self.recording_state = "recording"
                self.capture_status = {"teams": "Capturing remote Teams audio",
                                       "system": "Capturing all system output",
                                       "microphone": "Capturing the default microphone: nearby voices and room sound"}.get(event.get("source"), "Capturing audio")
            else:
                self.capture_status = event.get("message", "Check capture permissions")

    def _chunk(self, audio, start, end):
        with self.lock:
            ident = self.next_id
            self.next_id += 1
            archive = self.archive
            job = {"type": "audio", "id": ident, "audio": audio, "start": start, "end": end,
                   "archive": archive, "session_id": self.session_id,
                   "profile": self.capture_profile, "queued_at": time.monotonic()}
            try:
                self.jobs.put_nowait(job)
            except queue.Full:
                self.dropped += 1
                self.notice = "Inference queue full: some captions were skipped; captured audio is retained."
                archive.log({"type": "inference_skipped", "id": ident, "start": start, "end": end, "reason": "queue_full"})

    def _capture_done(self, error):
        with self.lock:
            self.recording_state = "draining"
            if error:
                self.notice = error
            archive = self.archive
        # This may wait for queue space, but only after the reader has reached EOF.
        self.jobs.put({"type": "finish", "archive": archive, "session_id": archive.id, "error": error})

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
            job = {"type": "manual", "id": self.next_id, "text": text.strip(),
                   "archive": self.archive, "session_id": self.session_id,
                   "profile": self.profile(self.session_id), "queued_at": time.monotonic()}
            try:
                self.jobs.put_nowait(job)
            except queue.Full:
                raise ValueError("Inference queue is full; try again later.")
            self.next_id += 1

    def state(self):
        with self.lock:
            now = time.monotonic()
            with self.jobs.mutex:
                queued_times = [j["queued_at"] for j in self.jobs.queue if "queued_at" in j]
            oldest = min(queued_times + ([self.inflight_at] if self.inflight_at else []), default=now)
            active = self.recording_state in ("starting", "recording")
            no_audio = active and now - (self.last_signal_at or self.started_at) > 8
            if self.recording_state == "starting":
                feed_status = "Waiting for capture startup / macOS permission — audio not yet confirmed"
            elif active and self.last_audio_at is None:
                feed_status = "Capture opened, but no audio frames have arrived"
            elif active and now - self.last_audio_at > 3:
                feed_status = "Audio feed stalled: no new frames for over 3 seconds"
            elif active and (self.last_signal_at is None or now - self.last_signal_at > 8):
                feed_status = "Audio frames arriving; signal is silent or below the speech threshold"
            elif active:
                feed_status = "Audio frames and a signal are arriving"
            else:
                feed_status = "Capture inactive"
            return {**self.workbench_state(), "model_status": self.model_status, "model_ready": self.model_ready,
                    "recording_state": self.recording_state, "session_id": self.session_id,
                    "segments": list(self.segments), "level": self.level, "no_audio": no_audio,
                    "queue_length": len(queued_times), "queue_lag_seconds": round(now - oldest, 1),
                    "pending_work": self.jobs.unfinished_tasks,
                    "dropped": self.dropped, "notice": self.notice,
                    "capture_status": self.capture_status,
                    "audio_seconds": round(self.audio_seconds, 1), "feed_status": feed_status,
                    "launcher_name": launcher_name(),
                    "archive_dir": str(DATA_DIR / "sessions"),
                    "session_path": str(DATA_DIR / "sessions" / self.session_id) if self.session_id else None}

    def save(self):
        if self.session_id:
            return self.export("markdown")
        with self.lock:
            segments = list(self.segments)
            session_id = self.session_id
        directory = DATA_DIR / "sessions"
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

        def _reply(self, status, body, content_type="application/json; charset=utf-8", cookie=False):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'")
            if cookie:
                self.send_header("Set-Cookie", f"meeting_session={token}; HttpOnly; SameSite=Strict; Path=/")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._valid_host():
                return self._reply(403, {"error": "Forbidden"})
            target = urlsplit(self.path)
            files = {"/": ("index.html", "text/html; charset=utf-8"),
                     "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                     "/style.css": ("style.css", "text/css; charset=utf-8")}
            if target.path in files:
                try:
                    cookies = SimpleCookie(self.headers.get("Cookie", ""))
                    saved = cookies.get("meeting_session")
                    cookie_ok = bool(saved and hmac.compare_digest(saved.value, token))
                except Exception:
                    cookie_ok = False
                supplied = parse_qs(target.query).get("token", [""])[0]
                bootstrap = target.path == "/" and hmac.compare_digest(supplied, token)
                if not cookie_ok and not bootstrap:
                    return self._reply(403, {"error": "Forbidden"})
                name, kind = files[target.path]
                return self._reply(200, (STATIC / name).read_bytes(), kind, cookie=bootstrap)
            if target.path == "/api/state" and self._auth():
                return self._reply(200, app.state())
            if target.path in ("/api/history", "/api/audio") and self._auth():
                try:
                    query = parse_qs(target.query)
                    if target.path == "/api/history":
                        return self._reply(200, {"history": app.history(int(query.get("segment_id", [""])[0]), query.get("session_id", [""])[0])})
                    clip = app.audio_clip(query.get("session_id", [""])[0], query.get("start", [""])[0], query.get("end", [""])[0])
                    return self._reply(200, clip, "audio/wav")
                except (ValueError, OSError, wave.Error) as exc:
                    return self._reply(400, {"error": str(exc)})
            self._reply(403, {"error": "Forbidden"})

        def do_POST(self):
            if not self._auth(mutate=True):
                return self._reply(403, {"error": "Forbidden"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 0 or size > 131072:
                    raise ValueError("Invalid request size.")
                data = json.loads(self.rfile.read(size) or b"{}")
                if not isinstance(data, dict):
                    raise ValueError("Expected a JSON object.")
                if self.path == "/api/start":
                    app.start(data.get("source"), data.get("consent"))
                    response = {"ok": True}
                elif self.path == "/api/stop":
                    app.stop()
                    response = {"ok": True}
                elif self.path == "/api/manual":
                    app.manual(data.get("text"))
                    response = {"ok": True}
                elif self.path == "/api/save":
                    response = {"path": app.save()}
                elif self.path == "/api/settings":
                    response = {"settings": app.update_settings(data)}
                elif self.path == "/api/vocabulary":
                    response = {"entry": app.vocabulary_add(data)}
                elif self.path == "/api/vocabulary/delete":
                    app.vocabulary_remove(data.get("id"))
                    response = {"ok": True}
                elif self.path == "/api/session/open":
                    response = {"session": app.session_open(data.get("session_id"))}
                elif self.path == "/api/session/delete":
                    app.session_delete(data.get("session_id"), data.get("confirm"))
                    response = {"ok": True}
                elif self.path == "/api/segment/edit":
                    if not isinstance(data.get("session_id"), str):
                        raise ValueError("A session ID is required for an edit.")
                    response = {"segment": app.segment_edit(data)}
                elif self.path == "/api/segment/retranslate":
                    app.segment_retranslate(data.get("id"), data.get("session_id", ""))
                    response = {"ok": True}
                elif self.path == "/api/speakers":
                    response = app.speaker_names(data.get("names"), data.get("session_id", ""))
                elif self.path == "/api/attribution":
                    response = {"session": app.attribution_flag(data.get("unreliable"), data.get("session_id", ""))}
                elif self.path == "/api/job/start":
                    response = {"job": app.job_start(data)}
                elif self.path == "/api/job/cancel":
                    app.job_stop()
                    response = {"ok": True}
                elif self.path == "/api/artifact/apply":
                    response = app.artifact_apply(data)
                elif self.path == "/api/export":
                    response = {"path": app.export(data.get("format"))}
                else:
                    return self._reply(404, {"error": "Not found"})
                self._reply(200, response)
            except (ValueError, OSError, json.JSONDecodeError) as exc:
                self._reply(400, {"error": str(exc)})

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
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
        capture = app.capture
        if capture:
            if app.recording_state in ("starting", "recording"):
                app.stop()
            else:
                capture.stop()
            capture.reader.join()
        app.jobs.join()
        if app._post_busy():
            app.job_stop()
            if app.job_thread:
                app.job_thread.join(timeout=5)
    finally:
        server.server_close()
        # An in-flight model call may not be cancellable. Retain ownership until
        # process exit rather than allowing another server to mutate its files.
        if not app.job_thread or not app.job_thread.is_alive():
            app.instance_lock.close()
