"""Cross-module use cases with synthetic text/audio, no inference or network."""

import json
import queue
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from meeting_assistant.workbench import Workbench


class Harness(Workbench):
    def __init__(self, root):
        self.lock = threading.RLock()
        self.jobs = queue.Queue(maxsize=12)
        self.recording_state = "idle"
        self.session_id = None
        self.segments = []
        self.next_id = 1
        self.model_ready = False
        self.notice = ""
        self._init_workbench(root)


class WorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.app = Harness(self.root)
        path = self.root / "sessions" / "synthetic"
        path.mkdir(parents=True)
        (path / "events.jsonl").write_text("", encoding="utf-8")
        with wave.open(str(path / "audio.wav"), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\0\0" * 32000)
        self.app.library.register_session("synthetic", "microphone")
        self.app.library.upsert_segment("synthetic", {"id": 1, "raw_text": "content production",
            "traditional_text": "content production", "english": "content production", "start": 0, "end": 2})
        self.app.session_open("synthetic")

    def tearDown(self):
        self.temp.cleanup()

    def test_edit_retains_raw_and_adds_only_selected_vocabulary(self):
        segment = self.app.segment_edit({"id": 1, "text": "container protection",
            "expected_revision": 1, "vocabulary_term": "container protection", "vocabulary_translation": "容器防護"})
        self.assertEqual(segment["raw_text"], "content production")
        self.assertEqual(segment["traditional_text"], "container protection")
        self.assertEqual(segment["revision"], 2)
        self.assertEqual(self.app.library.get_settings()["vocabulary"][0]["term"], "container protection")
        self.assertEqual(len(self.app.history(1)), 2)

    def test_vocabulary_term_must_be_in_edit(self):
        with self.assertRaises(ValueError):
            self.app.segment_edit({"id": 1, "text": "container protection", "expected_revision": 1,
                                   "vocabulary_term": "invented"})
        self.assertEqual(self.app._selected()["segments"][0]["revision"], 1)

    def test_review_requires_current_version_and_exact_original(self):
        session = self.app._selected()
        artifact = self.app.library.add_artifact("synthetic", "review", session["version"], {
            "proposals": [{"segment_id": 1, "original": "content production", "replacement": "container protection"}]})
        self.app.artifact_apply({"artifact_id": artifact["id"], "proposal_index": 0,
                                "expected_version": session["version"]})
        with self.assertRaises(ValueError):
            self.app.artifact_apply({"artifact_id": artifact["id"], "proposal_index": 0,
                                    "expected_version": self.app._selected()["version"]})
        self.assertTrue(self.app.library.get_artifact("synthetic", artifact["id"])["stale"])

    def test_remote_send_requires_confirmation_before_client_creation(self):
        with self.assertRaisesRegex(ValueError, "Explicitly confirm"):
            self.app.job_start({"task": "learning", "session_id": "synthetic", "expected_version": self.app._selected()["version"]})
        self.assertIsNone(self.app.background_job)

    def test_post_job_prevents_session_switch_and_retranslation(self):
        self.app.background_job = {"status": "running"}
        with self.assertRaises(ValueError):
            self.app.session_open("synthetic")
        self.app.model_ready = True
        with self.assertRaises(ValueError):
            self.app.segment_retranslate(1)

    def test_audio_clip_is_bounded_and_never_played_during_capture(self):
        clip = self.app.audio_clip("synthetic", 0, 1)
        self.assertTrue(clip.startswith(b"RIFF"))
        with self.assertRaises(ValueError):
            self.app.audio_clip("synthetic", 0, 61)
        with self.assertRaises(ValueError):
            self.app.audio_clip("../synthetic", 0, 1)
        self.app.recording_state = "recording"
        with self.assertRaises(ValueError):
            self.app.audio_clip("synthetic", 0, 1)

    def test_context_bumps_version_and_export_matches_edited_source(self):
        self.app.session_context("Engineering release planning")
        self.app.segment_edit({"id": 1, "text": "container protection", "expected_revision": 1})
        output = Path(self.app.export("json"))
        exported = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(exported["segments"][0]["traditional_text"], "container protection")
        self.assertEqual(exported["context"], "Engineering release planning")

    def test_global_context_does_not_rewrite_open_archived_session(self):
        before = self.app.library.get_session("synthetic")
        self.app.update_settings({"meeting_context": "new default"})
        after = self.app.library.get_session("synthetic")
        self.assertEqual((after["context"], after["version"]), (before["context"], before["version"]))
        updated = self.app.session_context("explicit", expected_session="synthetic")
        self.assertEqual(updated["context"], "explicit")
        self.assertEqual(updated["version"], before["version"] + 1)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.app.session_context("x", expected_session="other")

    def test_delete_with_pending_cleanup_clears_selection_and_raises(self):
        with patch.object(self.app.library, "_purge_quarantine", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                self.app.session_delete("synthetic", True)
        self.assertIsNone(self.app.session_id)
        self.assertEqual(self.app.segments, [])
        self.assertIn("cleanup is pending", self.app.notice)

    def test_refinement_is_not_automatically_applied_to_different_windows(self):
        session = self.app._selected()
        artifact = self.app.library.add_artifact("synthetic", "refine", session["version"], {"segments": []})
        with self.assertRaisesRegex(ValueError, "different audio windows"):
            self.app.artifact_apply({"artifact_id": artifact["id"], "expected_version": session["version"]})

    def test_overflow_flag_blocks_automatic_diarization(self):
        before = self.app._selected()["version"]
        self.app.attribution_flag(True)
        self.assertTrue(self.app._selected()["attribution_unreliable"])
        self.assertGreater(self.app._selected()["version"], before)
        with self.assertRaisesRegex(ValueError, "unreliable"):
            self.app.job_start({"task": "diarize", "session_id": "synthetic", "expected_version": self.app._selected()["version"]})

    def test_gateway_snapshot_is_anonymous_and_excludes_manual_text(self):
        from unittest.mock import patch

        self.app.library.upsert_segment("synthetic", {"id": 2, "kind": "manual", "raw_text": "private pasted text",
                                                     "traditional_text": "private pasted text"})
        self.app.attribution_flag(True)
        with patch("meeting_assistant.postprocess.GatewayClient"), patch("meeting_assistant.workbench.threading.Thread") as thread:
            self.app.job_start({"task": "summary", "confirm_send": True, "session_id": "synthetic",
                                "expected_version": self.app._selected()["version"],
                                "expected_gateway": self.app.library.get_settings()["gateway"]})
            snapshot = thread.call_args.kwargs["args"][1]
        self.assertEqual([s["id"] for s in snapshot["segments"]], [1])
        self.assertEqual(snapshot["speaker_names"], {})
        self.assertTrue(all(s["speaker"] == "unknown" for s in snapshot["segments"]))

    def test_remote_confirmation_is_bound_to_session_version_and_gateway(self):
        from unittest.mock import patch

        data = {"task": "summary", "confirm_send": True, "session_id": "synthetic",
                "expected_version": self.app._selected()["version"],
                "expected_gateway": self.app.library.get_settings()["gateway"]}
        self.app.segment_edit({"id": 1, "text": "updated", "expected_revision": 1})
        with patch("meeting_assistant.postprocess.GatewayClient") as client:
            with self.assertRaisesRegex(ValueError, "version changed"):
                self.app.job_start(data)
            client.assert_not_called()
        data["expected_version"] = self.app._selected()["version"]
        self.app.library.save_settings({"gateway": {"endpoint": "https://example.com/v1", "model": "example"}})
        with patch("meeting_assistant.postprocess.GatewayClient") as client:
            with self.assertRaisesRegex(ValueError, "Gateway settings changed"):
                self.app.job_start(data)
            client.assert_not_called()

    def test_new_diarization_clears_old_cluster_names_and_keeps_untimed_manual_speaker(self):
        self.app.library.assign_speakers("synthetic", [{"id": 1, "speaker": "speaker_1"}])
        self.app.library.set_speaker_names("synthetic", {"speaker_1": "Reviewed Person"})
        self.app.library.upsert_segment("synthetic", {"id": 2, "kind": "manual", "raw_text": "manual",
            "traditional_text": "manual", "speaker": "speaker_2"})
        session = self.app._selected()
        artifact = self.app.library.add_artifact("synthetic", "diarize", session["version"],
            {"timeline": [{"start": 0, "end": 2, "speaker": "speaker_2"}]})
        self.app.artifact_apply({"artifact_id": artifact["id"], "expected_version": session["version"]})
        session = self.app._selected()
        self.assertEqual(session["speaker_names"], {})
        self.assertEqual(session["segments"][0]["speaker"], "speaker_2")
        self.assertEqual(session["segments"][1]["speaker"], "speaker_2")

    def test_cancelled_job_does_not_persist_completed_output(self):
        session = self.app._selected()
        self.app.background_job = {"status": "running"}

        class Client:
            def analyze(inner, *args, **kwargs):
                self.app.job_cancel.set()
                return {"status": "ready", "overview": []}

        self.app._run_post_job("summary", session, self.root / "sessions/synthetic", self.app.profile("synthetic"), Client())
        self.assertEqual(self.app.background_job["status"], "cancelled")
        self.assertEqual(self.app._selected()["artifacts"], [])

    def test_stale_browser_cannot_edit_same_numbered_segment_in_another_session(self):
        self.app.library.register_session("another", "microphone")
        self.app.library.upsert_segment("another", {"id": 1, "raw_text": "other meeting", "traditional_text": "other meeting"})
        self.app.session_open("another")
        with self.assertRaisesRegex(ValueError, "selected session changed"):
            self.app.segment_edit({"session_id": "synthetic", "id": 1, "text": "wrong target", "expected_revision": 1})
        self.assertEqual(self.app._selected()["segments"][0]["traditional_text"], "other meeting")


if __name__ == "__main__":
    unittest.main()
