"""Application use cases for reviewed transcripts and explicit post-meeting jobs."""

import copy
import io
import os
import secrets
import threading
import time
import wave
from pathlib import Path

from .library import Library
from .storage import DATA_DIR

REMOTE_TASKS = {"review", "summary", "learning"}
TASKS = REMOTE_TASKS | {"refine", "diarize"}


class Workbench:
    """Mixin sharing the capture application's lock, worker and selected session."""

    def _init_workbench(self, data_dir=DATA_DIR):
        self.data_dir = Path(data_dir)
        self.library = Library(self.data_dir)
        self.library.import_legacy()
        warnings = getattr(self.library, "import_warnings", [])
        if warnings:
            self.notice = f"Some legacy journals could not be imported ({len(warnings)}). Original files were left unchanged."
        self.background_job = None
        self.job_cancel = threading.Event()
        self.job_thread = None

    def _post_busy(self):
        return self.background_job is not None and self.background_job["status"] in ("running", "cancelling")

    def _require_idle(self):
        if self.recording_state != "idle" or self.jobs.unfinished_tasks or self._post_busy():
            raise ValueError("Stop capture and wait for pending work before changing sessions or starting another job.")

    def _selected(self, expected_session=None):
        if not self.session_id:
            raise ValueError("Record or open a saved session first.")
        if expected_session is not None and expected_session != self.session_id:
            raise ValueError("The selected session changed. Reopen the intended session before making changes.")
        return self.library.get_session(self.session_id)

    def profile(self, session_id=None):
        settings = self.library.get_settings()
        context = settings.get("meeting_context", "")
        if session_id:
            context = self.library.get_session(session_id).get("context", context)
        return {"context": context, "vocabulary": settings.get("vocabulary", [])}

    def update_settings(self, data):
        with self.lock:
            if self._post_busy():
                raise ValueError("Wait for or cancel post-meeting work before changing its settings.")
            settings = self.library.save_settings(data)
            if "meeting_context" in data and self.session_id:
                self.library.set_session_context(self.session_id, settings["meeting_context"])
                if getattr(self, "capture_profile", None) is not None:
                    self.capture_profile = dict(self.capture_profile, context=settings["meeting_context"])
            self._refresh_capture_profile(settings)
            return settings

    def vocabulary_add(self, data):
        with self.lock:
            entry = self.library.add_vocabulary(data.get("term"), data.get("translation", ""), data.get("note", ""))
            self._refresh_capture_profile(self.library.get_settings())
            return entry

    def vocabulary_remove(self, ident):
        with self.lock:
            self.library.remove_vocabulary(ident)
            self._refresh_capture_profile(self.library.get_settings())

    def _refresh_capture_profile(self, settings):
        if self.recording_state in ("starting", "recording") and self.session_id:
            existing = getattr(self, "capture_profile", None) or {}
            self.capture_profile = {"context": existing.get("context", settings.get("meeting_context", "")),
                                    "vocabulary": settings.get("vocabulary", [])}

    def session_open(self, session_id):
        with self.lock:
            self._require_idle()
            session = self.library.get_session(session_id)
            self.session_id = session["id"]
            self.segments = session.get("segments", [])
            self.next_id = max((s["id"] for s in self.segments), default=0) + 1
            self.audio_seconds = 0.0
            self.level = 0.0
            self.notice = "Opened an archived session. Original recognition is retained alongside edits."
            return session

    def session_delete(self, session_id, confirm):
        if confirm is not True:
            raise ValueError("Confirm deletion of this session and its app-owned audio, revisions and exports.")
        with self.lock:
            self._require_idle()
            self.library.delete_session(session_id)
            if self.session_id == session_id:
                self.session_id = None
                self.segments = []
                self.next_id = 1
                self.notice = "Session deleted. External copies and backups are not removed."

    def segment_edit(self, data):
        text = data.get("text")
        ident = data.get("id")
        expected = data.get("expected_revision")
        term = data.get("vocabulary_term")
        translation = data.get("vocabulary_translation", "")
        if term is not None and (not isinstance(term, str) or not term.strip() or len(term) > 100 or "<|" in term):
            raise ValueError("Choose a short corrected vocabulary term, not an entire transcript or control token.")
        if term and (not isinstance(text, str) or term.strip() not in text):
            raise ValueError("The vocabulary term must occur exactly in your corrected transcript.")
        if not isinstance(translation, str) or len(translation) > 200 or "<|" in translation:
            raise ValueError("Vocabulary translation must be plain text up to 200 characters.")
        with self.lock:
            session = self._selected(data.get("session_id"))
            segment = self.library.edit_segment(session["id"], ident, text, expected, speaker=data.get("speaker"))
            if term:
                try:
                    self.library.add_vocabulary(term.strip(), translation, "Approved from a manual transcript correction")
                    self._refresh_capture_profile(self.library.get_settings())
                except ValueError:
                    self.notice = "Transcript correction saved, but vocabulary could not be added. Check the vocabulary capacity and fields."
            self._sync_selected()
            if self.model_ready and not self._post_busy():
                self._enqueue_translation(segment, session["id"])
            return segment

    def _enqueue_translation(self, segment, session_id):
        import queue

        try:
            self.jobs.put_nowait({"type": "retranslate", "id": segment["id"],
                                 "revision": segment["revision"], "text": segment["traditional_text"],
                                 "session_id": session_id, "profile": self.profile(session_id),
                                 "queued_at": time.monotonic()})
        except queue.Full:
            self.notice = "Edit saved; translation queue is full. Use Retranslate after it drains."

    def segment_retranslate(self, ident, expected_session=None):
        with self.lock:
            if not self.model_ready:
                raise ValueError("Local models are not ready.")
            if self._post_busy():
                raise ValueError("Wait for or cancel post-meeting work before retranslating.")
            session = self._selected(expected_session)
            segment = next((s for s in session["segments"] if s["id"] == ident), None)
            if segment is None:
                raise ValueError("Segment not found.")
            self._enqueue_translation(segment, session["id"])

    def _sync_selected(self):
        if self.session_id:
            self.segments = self.library.get_session(self.session_id)["segments"]

    def history(self, ident, expected_session=None):
        with self.lock:
            return self.library.segment_history(self._selected(expected_session)["id"], ident)

    def speaker_names(self, names, expected_session=None):
        with self.lock:
            if self._post_busy():
                raise ValueError("Wait for or cancel post-meeting work before changing speaker names.")
            result = self.library.set_speaker_names(self._selected(expected_session)["id"], names)
            self._sync_selected()
            return result

    def attribution_flag(self, value, expected_session=None):
        with self.lock:
            if self._post_busy():
                raise ValueError("Wait for or cancel the job before changing attribution policy.")
            result = self.library.set_attribution_unreliable(self._selected(expected_session)["id"], value)
            self._sync_selected()
            return result

    def workbench_state(self):
        with self.lock:
            from .diarization import capabilities

            session = self.library.get_session(self.session_id) if self.session_id else None
            return {"settings": self.library.get_settings(), "session": session,
                    "sessions": self.library.list_sessions(), "job": copy.deepcopy(self.background_job),
                    "diarization": capabilities(self.data_dir)}

    def _session_path(self, session_id):
        self.library.get_session(session_id)  # Validate a known application-owned ID first.
        root = self.data_dir / "sessions"
        path = root / session_id
        if path.is_symlink() or root.is_symlink() or path.resolve().parent != root.resolve() or not path.is_dir():
            raise ValueError("Unsafe or missing session directory.")
        for audio_name in ("audio.wav", "events.jsonl"):
            if (path / audio_name).is_symlink():
                raise ValueError("Unsafe session evidence path.")
        return path

    def audio_clip(self, session_id, start, end):
        try:
            start, end = float(start), float(end)
        except (TypeError, ValueError):
            raise ValueError("Audio clip times must be numbers.")
        import math

        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or end - start > 60:
            raise ValueError("Choose an audio clip between 0 and 60 seconds long.")
        with self.lock:
            if self.recording_state != "idle":
                raise ValueError("Stop capture before replaying audio to avoid recording playback.")
            path = self._session_path(session_id) / "audio.wav"
            if path.is_symlink():
                raise ValueError("Unsafe audio path.")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as source, wave.open(source, "rb") as audio:
                rate = audio.getframerate()
                if (rate, audio.getnchannels(), audio.getsampwidth()) != (16000, 1, 2):
                    raise ValueError("Unsupported session audio format.")
                first = int(start * rate)
                if first >= audio.getnframes():
                    raise ValueError("Audio clip starts beyond the recording.")
                audio.setpos(first)
                pcm = audio.readframes(min(int((end - start) * rate), audio.getnframes() - first))
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as clip:
                clip.setnchannels(1)
                clip.setsampwidth(2)
                clip.setframerate(rate)
                clip.writeframes(pcm)
            return buffer.getvalue()

    def job_start(self, data):
        task = data.get("task")
        if task not in TASKS:
            raise ValueError("Unknown post-meeting task.")
        with self.lock:
            self._require_idle()
            session = self._selected()
            if data.get("session_id") != session["id"] or data.get("expected_version") != session["version"]:
                raise ValueError("The selected session or transcript version changed. Review the current payload and confirm again.")
            if task in REMOTE_TASKS and data.get("confirm_send") is not True:
                raise ValueError("Explicitly confirm sending this session's transcript text to the configured gateway.")
            if task == "refine" and not self.model_ready:
                raise ValueError("Local models are not ready.")
            settings = self.library.get_settings()
            if task in REMOTE_TASKS and data.get("expected_gateway") != settings.get("gateway"):
                raise ValueError("Gateway settings changed. Review the destination and confirm again.")
            session["segments"] = [s for s in session["segments"] if s.get("kind") == "audio"]
            if task in REMOTE_TASKS and not any(s.get("traditional_text", "").strip() for s in session["segments"]):
                raise ValueError("This session has no audio-derived transcript text to send.")
            if session.get("attribution_unreliable"):
                if task == "diarize":
                    raise ValueError("Speaker attribution is marked unreliable or more than eight voices may be present. Use anonymous notes or manual correction.")
                session["speaker_names"] = {}
                for segment in session["segments"]:
                    segment["speaker"] = "unknown"
            client = None
            if task in REMOTE_TASKS:
                from .postprocess import GatewayClient

                config = settings.get("gateway", {})
                key = data.get("api_key") or os.environ.get("MEETING_ASSISTANT_GATEWAY_KEY", "")
                if not isinstance(key, str) or len(key) > 8192:
                    raise ValueError("Invalid API key.")
                client = GatewayClient(config.get("endpoint", ""), config.get("model", ""), key)
            path = self._session_path(session["id"])
            self.job_cancel = threading.Event()
            self.background_job = {"id": secrets.token_hex(8), "task": task, "session_id": session["id"],
                                   "source_version": session["version"], "status": "running",
                                   "progress": "Starting…", "error": None}
            profile = {"context": session.get("context", ""), "vocabulary": settings.get("vocabulary", [])}
            self.job_thread = threading.Thread(target=self._run_post_job,
                                               args=(task, session, path, profile, client), daemon=True)
            self.job_thread.start()
            return copy.deepcopy(self.background_job)

    def _job_progress(self, progress):
        with self.lock:
            if self.background_job:
                self.background_job["progress"] = progress

    def _run_post_job(self, task, session, path, profile, client):
        try:
            if task == "refine":
                from .refinement import refine_session

                result = refine_session(path, self.model, context=profile["context"],
                                        vocabulary=profile["vocabulary"], progress=self._job_progress,
                                        cancelled=self.job_cancel.is_set)
            elif task == "diarize":
                from .diarization import diarize_session

                result = diarize_session(path, data_dir=self.data_dir, progress=self._job_progress,
                                         cancelled=self.job_cancel.is_set)
            else:
                result = client.analyze(session["segments"], task=task, context=profile["context"],
                                        speaker_names=session.get("speaker_names", {}),
                                        progress=self._job_progress, cancelled=self.job_cancel.is_set)
                if task == "learning":
                    from .learning import select_learning

                    result = select_learning(result, profile["vocabulary"])
            with self.lock:
                if self.job_cancel.is_set():
                    self.background_job.update(status="cancelled", progress="Cancelled; original transcript unchanged")
                    return
                status = result.get("status", "ready")
                artifact = self.library.add_artifact(session["id"], task, session["version"], result, status=status)
                self.background_job.update(status="complete" if status == "ready" else "failed",
                                           progress="Finished — review the results below" if status == "ready" else "Incomplete; partial results saved with limitations. Retry explicitly.",
                                           artifact_id=artifact["id"])
        except Exception as exc:
            with self.lock:
                # Never log transport payloads or credentials. Module errors are safe summaries.
                self.background_job.update(status="cancelled" if self.job_cancel.is_set() else "failed",
                                           error=str(exc)[:1000], progress="Original transcript unchanged")

    def job_stop(self):
        with self.lock:
            if not self._post_busy():
                raise ValueError("No running post-meeting job.")
            self.job_cancel.set()
            self.background_job["status"] = "cancelling"

    def artifact_apply(self, data):
        with self.lock:
            self._require_idle()
            session = self._selected()
            if data.get("expected_version") != session["version"]:
                raise ValueError("Transcript changed. Review the current version before applying a proposal.")
            artifact = self.library.get_artifact(session["id"], data.get("artifact_id"))
            if artifact.get("stale") or artifact["source_version"] != session["version"]:
                raise ValueError("This result is stale. Run the job again against the current transcript.")
            if artifact.get("status") != "ready":
                raise ValueError("Incomplete results cannot be applied. Retry the job or edit the transcript manually.")
            if artifact["kind"] == "diarize":
                if session.get("attribution_unreliable"):
                    raise ValueError("Speaker attribution is marked unreliable; automatic assignment is disabled.")
                from .diarization import assign_segments

                timeline = artifact["data"].get("timeline", [])
                assignments = assign_segments(session["segments"], timeline)
                timed = {s["id"] for s in session["segments"] if s.get("kind") == "audio" and s.get("start") is not None and s.get("end") is not None}
                self.library.assign_speakers(session["id"], [a for a in assignments if a["id"] in timed])
                # New cluster numbers do not prove the identity mapping from an
                # earlier run. Require names to be reviewed again.
                self.library.set_speaker_names(session["id"], {})
                self._sync_selected()
                return {"ok": True}
            if artifact["kind"] != "review":
                raise ValueError("Refinement uses different audio windows. Copy a candidate into the appropriate segment editor; automatic text/timing replacement is unsafe.")
            proposals = artifact["data"].get("proposals", [])
            index = data.get("proposal_index")
            if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(proposals):
                raise ValueError("Invalid proposal index.")
            proposal = proposals[index]
            segment = next((s for s in session["segments"] if s["id"] == proposal["segment_id"]), None)
            if segment is None or segment["traditional_text"] != proposal["original"]:
                raise ValueError("Original text no longer matches the correction proposal.")
            return self.segment_edit({"id": segment["id"], "text": proposal["replacement"],
                                      "expected_revision": segment["revision"]})

    def export(self, format):
        from .exports import export_session

        with self.lock:
            return str(export_session(self._selected(), self.data_dir, format))
