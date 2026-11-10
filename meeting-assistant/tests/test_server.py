"""Inference integration uses fake models; no capture or real model loading."""

import queue
import tempfile
import threading
import time
import unittest
from pathlib import Path

from meeting_assistant.audio import capture_error
from meeting_assistant.server import Application


class FakeModel:
    def __init__(self):
        self.hints = []
        self.before_translation = None

    def transcribe(self, audio, sample_rate=16000, **hints):
        self.hints.append(hints)
        return {"raw_text": "content production", "traditional_text": "content production"}

    def translate(self, text, **hints):
        self.hints.append(hints)
        if self.before_translation:
            action, self.before_translation = self.before_translation, None
            action()
        return "old translation"


class ServerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Application.__new__(Application)
        self.app.lock = threading.RLock()
        self.app.jobs = queue.Queue(maxsize=12)
        self.app.recording_state = "idle"
        self.app.session_id = "fixture"
        self.app.model_ready = True
        self.app.model = FakeModel()
        self.app.segments = []
        self.app.next_id = 1
        self.app.notice = ""
        self.app._init_workbench(Path(self.temp.name).resolve())
        self.app.library.register_session("fixture", "teams")

    def tearDown(self):
        self.temp.cleanup()

    def test_context_and_vocabulary_reach_both_models(self):
        profile = {"context": "Container security engineering", "vocabulary": [{"term": "container protection"}]}
        self.app._infer({"id": 1, "type": "audio", "audio": [], "session_id": "fixture", "profile": profile})
        self.assertEqual(self.app.model.hints, [profile, profile])
        self.assertEqual(self.app.library.get_session("fixture")["segments"][0]["revision"], 1)

    def test_live_translation_cannot_overwrite_intervening_user_edit(self):
        self.app.model.before_translation = lambda: self.app.library.edit_segment("fixture", 1, "container protection", 1)
        self.app._infer({"id": 1, "type": "audio", "audio": [], "session_id": "fixture", "profile": {}})
        segment = self.app.library.get_session("fixture")["segments"][0]
        self.assertEqual(segment["raw_text"], "content production")
        self.assertEqual(segment["traditional_text"], "container protection")
        self.assertEqual(segment["english"], "")
        self.assertEqual(segment["revision"], 2)
        self.assertEqual(self.app.segments[0]["revision"], 2)

    def test_retranslation_cannot_overwrite_newer_revision(self):
        self.app.library.upsert_segment("fixture", {"id": 1, "raw_text": "wrong", "traditional_text": "wrong"})
        self.app.library.edit_segment("fixture", 1, "first fix", 1)
        self.app.model.before_translation = lambda: self.app.library.edit_segment("fixture", 1, "new fix", 2)
        self.app._infer({"id": 1, "type": "retranslate", "session_id": "fixture", "revision": 2, "text": "first fix"})
        segment = self.app.library.get_session("fixture")["segments"][0]
        self.assertEqual(segment["traditional_text"], "new fix")
        self.assertEqual(segment["english"], "")

    def test_permission_error_is_readable_not_raw_json(self):
        error = capture_error(['{"event":"permission","message":"Check settings"}',
            '{"event":"error","domain":"com.apple.ScreenCaptureKit.SCStreamErrorDomain","code":-3801}',
            '{"event":"stopped","exit_code":1}'])
        self.assertIn("Terminal", error)
        self.assertIn("cmux", error)
        self.assertNotIn('"event"', error)

    def test_starting_feed_status_does_not_claim_audio_delivery(self):
        self.app.recording_state = "starting"
        self.app.last_audio_at = self.app.last_signal_at = None
        self.app.started_at = time.monotonic() - 9
        self.app.inflight_at = None
        self.app.model_status = "Models ready"
        self.app.audio_seconds = self.app.level = self.app.dropped = 0
        self.app.capture_status = "Waiting for permission"
        state = self.app.state()
        self.assertIn("not yet confirmed", state["feed_status"])
        self.assertEqual(state["audio_seconds"], 0)
        self.assertTrue(state["no_audio"])

    def test_new_vocabulary_refreshes_capture_hints_for_next_chunk(self):
        self.app.recording_state = "recording"
        self.app.capture_profile = {"context": "Existing session context", "vocabulary": []}
        entry = self.app.vocabulary_add({"term": "container protection"})
        self.assertEqual(self.app.capture_profile["vocabulary"][0]["id"], entry["id"])
        self.assertEqual(self.app.capture_profile["context"], "Existing session context")
        self.app.update_settings({"meeting_context": "Updated context"})
        self.assertEqual(self.app.capture_profile["context"], "Updated context")
        self.app.vocabulary_remove(entry["id"])
        self.assertEqual(self.app.capture_profile["vocabulary"], [])


if __name__ == "__main__":
    unittest.main()
