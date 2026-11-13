"""Application integration with fake models; no capture or real model loading."""

import time
import unittest

from meeting_assistant.audio import capture_error

from pipeline_fakes import AppCase, event


class ServerIntegrationTests(AppCase, unittest.TestCase):
    def setUp(self):
        self.make_app()
        self.begin()

    def test_context_and_vocabulary_reach_both_models(self):
        profile = {"context": "Container security engineering", "vocabulary": [{"term": "container protection"}]}
        self.app.capture_profile = profile
        self.app._on_segment(event("final", value=0.2))
        self.drain()
        for kind, _, hints in self.model.calls:
            self.assertEqual({k: hints[k] for k in profile}, profile, kind)
        self.assertEqual(len(self.model.calls), 2)
        self.assertEqual(self.saved()[0]["revision"], 1)

    def test_permission_error_is_readable_not_raw_json(self):
        error = capture_error(['{"event":"permission","message":"Check settings"}',
            '{"event":"error","domain":"com.apple.ScreenCaptureKit.SCStreamErrorDomain","code":-3801}',
            '{"event":"stopped","exit_code":1}'])
        self.assertIn("Terminal", error)
        self.assertIn("cmux", error)
        self.assertNotIn('"event"', error)

    def test_starting_feed_status_does_not_claim_audio_delivery(self):
        app = self.app
        app.recording_state = "starting"
        app.last_audio_at = app.last_signal_at = None
        app.started_at = time.monotonic() - 9
        state = app.state()
        self.assertIn("not yet confirmed", state["feed_status"])
        self.assertEqual(state["audio_seconds"], 0)
        self.assertTrue(state["no_audio"])

    def test_new_vocabulary_refreshes_capture_hints_for_next_chunk(self):
        app = self.app
        app.capture_profile = {"context": "Existing session context", "vocabulary": []}
        entry = app.vocabulary_add({"term": "container protection"})
        self.assertEqual(app.capture_profile["vocabulary"][0]["id"], entry["id"])
        self.assertEqual(app.capture_profile["context"], "Existing session context")
        app.update_settings({"meeting_context": "Updated context"})
        self.assertEqual(app.capture_profile["context"], "Updated context")
        app.vocabulary_remove(entry["id"])
        self.assertEqual(app.capture_profile["vocabulary"], [])

    def test_state_has_contract_fields(self):
        state = self.app.state()
        for key in ("settings", "session", "sessions", "job", "diarization", "model_status", "model_ready",
                    "recording_state", "session_id", "segments", "live_preview", "no_audio", "queue_length",
                    "queue_lag_seconds", "pending_work", "dropped", "notice", "capture_status", "audio_seconds",
                    "feed_status", "launcher_name", "archive_dir", "session_path", "audio", "latency",
                    "capabilities"):
            self.assertIn(key, state)
        self.assertEqual(state["settings"]["audio"], {"device_uid": "", "language": "auto", "normalize": True})
        self.assertIsNone(state["latency"])
        self.assertEqual(state["capabilities"], {"helper_protocol": None, "helper_stale": False, "event_stream": True})
        self.assertNotIn("type", state)

    def test_job_start_rejects_non_string_task(self):
        self.app.recording_state = "idle"
        with self.assertRaises(ValueError):
            self.app.job_start({"task": []})


if __name__ == "__main__":
    unittest.main()
