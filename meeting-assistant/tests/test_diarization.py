import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from meeting_assistant import diarization as d


class AssignmentTests(unittest.TestCase):
    def test_coverage_change_overlap_unknown_and_invalid_timing(self):
        timeline = [{"start": 0, "end": 5, "speaker": "speaker_1"},
                    {"start": 4, "end": 8, "speaker": "speaker_2"},
                    {"start": 8, "end": 9, "speaker": "speaker_2"}]
        segments = [{"id": 1, "start": 0, "end": 3},
                    {"id": 2, "start": 3, "end": 6},
                    {"id": 3, "start": 6, "end": 10},
                    {"id": 4, "start": 10, "end": 11},
                    {"id": 5, "start": None, "end": 2}]
        result = d.assign_segments(segments, timeline)
        self.assertEqual(result[0]["speaker"], "speaker_1")
        self.assertEqual(result[1]["speaker"], "unknown")
        self.assertEqual(result[1]["speaker_candidates"], ["speaker_1", "speaker_2"])
        self.assertEqual(result[1]["reason"], "multiple_speakers")
        self.assertEqual(result[2]["speaker"], "unknown")
        self.assertEqual(result[2]["overlap_ratios"]["speaker_2"], 0.75)
        self.assertEqual(result[3]["speaker"], "unknown")
        self.assertEqual(result[4]["reason"], "missing_or_invalid_timing")

    def test_duplicate_intervals_do_not_inflate_coverage_and_changes_are_ambiguous(self):
        rows = [{"start": 0, "end": 3, "speaker": "speaker_1"},
                {"start": 0, "end": 3, "speaker": "speaker_1"}]
        self.assertEqual(d.assign_segments([{"id": 1, "start": 0, "end": 10}], rows)[0]["speaker"], "unknown")
        rows.append({"start": 3, "end": 10, "speaker": "speaker_2"})
        self.assertEqual(d.assign_segments([{"id": 1, "start": 0, "end": 10}], rows)[0]["reason"], "multiple_speakers")

    def test_invalid_timeline_rejected(self):
        for row in ({"start": 0, "end": 1, "speaker": "Alice"},
                    {"start": 0, "end": float("nan"), "speaker": "speaker_1"},
                    {"start": 0, "end": 1, "speaker": "speaker_9"}):
            with self.assertRaises(ValueError):
                d.assign_segments([], [row])


    def test_dominant_speaker_survives_minor_boundary_bleed_while_overlaps_stay_unknown(self):
        timeline = [
            {"start": 0.0, "end": 4.9, "speaker": "speaker_2"},
            {"start": 4.8, "end": 5.0, "speaker": "speaker_1"},
            {"start": 10.0, "end": 12.0, "speaker": "speaker_1"},
            {"start": 11.8, "end": 14.0, "speaker": "speaker_2"},
            {"start": 20.0, "end": 21.4, "speaker": "speaker_3"},
        ]
        segments = [
            {"id": 1, "start": 0.0, "end": 5.0},   # 98% speaker_2, 4% bleed -> retains speaker_2
            {"id": 2, "start": 10.0, "end": 14.0}, # 50/55 overlap -> stays unknown
            {"id": 3, "start": 20.0, "end": 22.0}, # 70% single speaker -> below 80% threshold -> unknown
        ]
        result = d.assign_segments(segments, timeline)
        self.assertEqual(result[0]["speaker"], "speaker_2")
        self.assertEqual(result[0]["reason"], "dominant_speaker_coverage")
        self.assertEqual(result[1]["speaker"], "unknown")
        self.assertEqual(result[1]["reason"], "multiple_speakers")
        self.assertEqual(result[2]["speaker"], "unknown")
        self.assertEqual(result[2]["reason"], "insufficient_coverage")


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.diar = self.root / "diarization"
        self.diar.mkdir(mode=0o700)
        self.session = self.root / "sessions" / "fixture"
        self.session.mkdir(parents=True)
        with wave.open(str(self.session / "audio.wav"), "wb") as audio:
            audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\0\0" * 16000 * 2)
        self.exe = self.diar / "backend"
        self.model = self.diar / "model.gguf"
        self.model.write_bytes(b"model fixture")
        self.exe.write_text("backend fixture")
        self.exe.chmod(0o700)
        self.config = {"executable": str(self.exe), "model": str(self.model), "device": "cpu",
                       "runtime_version": d.RUNTIME_VERSION, "model_revision": d.MODEL_REVISION,
                       "executable_sha256": hashlib.sha256(self.exe.read_bytes()).hexdigest()}
        self.write_config()
        self.model_patches = [patch.object(d, "MODEL_SIZE", self.model.stat().st_size),
                              patch.object(d, "MODEL_SHA256", hashlib.sha256(self.model.read_bytes()).hexdigest())]
        for item in self.model_patches:
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(self.temp.cleanup)

    def write_config(self):
        path = self.diar / "config.json"
        path.write_text(json.dumps(self.config))
        path.chmod(0o600)

    def test_capabilities_checks_config_and_assets_without_execution(self):
        with patch.object(d.subprocess, "Popen", side_effect=AssertionError("not allowed")):
            self.assertTrue(d.capabilities(self.root)["ready"])
            self.model.write_bytes(b"bad")
            self.assertFalse(d.capabilities(self.root)["ready"])
        (self.diar / "config.json").chmod(0o644)
        self.assertIn("private", d.capabilities(self.root)["reason"])

    def test_capability_cache_invalidates_on_asset_change_and_run_forces_recheck(self):
        d._cached_digest.cache_clear()
        with patch.object(d, "_sha256", wraps=d._sha256) as checksum:
            self.assertTrue(d.capabilities(self.root)["ready"])
            self.assertEqual(checksum.call_count, 2)
            self.assertTrue(d.capabilities(self.root)["ready"])
            self.assertEqual(checksum.call_count, 2)
            self.model.write_bytes(b"Model fixture")  # same length, different ctime/mtime
            self.assertFalse(d.capabilities(self.root)["ready"])
            self.assertEqual(checksum.call_count, 3)
            self.model.write_bytes(b"model fixture")
            self.assertTrue(d.capabilities(self.root)["ready"])
            count = checksum.call_count
            with patch.object(d, "_audio_path", side_effect=ValueError("no recording")):
                with self.assertRaises(ValueError):
                    d.diarize_session(self.session, data_dir=self.root)
            self.assertEqual(checksum.call_count, count + 2)

    def test_one_subprocess_with_explicit_local_model_and_sanitized_output(self):
        self.exe.write_text(f"#!{sys.executable}\n" + """import json, sys
args = sys.argv[1:]
assert args[0] == 'diarize' and '--offline' not in args
assert args[args.index('--preset') + 1] == 'v3-offline'
assert args[args.index('--device') + 1] == 'cpu'
assert args[args.index('--model') + 1].endswith('model.gguf')
print('PRIVATE TRANSCRIPT', file=sys.stderr)
with open(args[args.index('--output') + 1], 'w') as f:
    json.dump({'segments':[{'start':0.25,'end':1.5,'speaker':1}]}, f)
""")
        self.config["executable_sha256"] = hashlib.sha256(self.exe.read_bytes()).hexdigest()
        self.write_config()
        events = []
        result = d.diarize_session(self.session, data_dir=self.root, progress=events.append)
        self.assertEqual(result["timeline"], [{"start": 0.25, "end": 1.5, "speaker": "speaker_1"}])
        self.assertEqual(result["summary"], {
            "speaker_count": 1,
            "speakers": ["speaker_1"],
            "single_speaker": True,
            "no_speech": False,
        })
        self.assertEqual([e["status"] for e in events], ["running", "complete"])
        self.assertNotIn("PRIVATE", str(result) + str(events))

    def test_empty_diarization_reports_no_speech_without_inventing_speakers(self):
        self.exe.write_text(f"#!{sys.executable}\n" + """import json, sys
args = sys.argv[1:]
with open(args[args.index('--output') + 1], 'w') as f:
    json.dump({'segments': []}, f)
""")
        self.config["executable_sha256"] = hashlib.sha256(self.exe.read_bytes()).hexdigest()
        self.write_config()
        result = d.diarize_session(self.session, data_dir=self.root)
        self.assertEqual(result["timeline"], [])
        self.assertEqual(result["summary"], {
            "speaker_count": 0,
            "speakers": [],
            "single_speaker": False,
            "no_speech": True,
        })

    def test_rejects_outside_session_and_symlinks(self):
        outside = self.root / "outside"
        outside.mkdir()
        with self.assertRaises(ValueError):
            d.diarize_session(outside, data_dir=self.root)
        audio = self.session / "audio.wav"
        audio.unlink()
        audio.symlink_to(self.model)
        with self.assertRaises(ValueError):
            d.diarize_session(self.session, data_dir=self.root)

    def test_malformed_result_rejected(self):
        path = self.diar / "result.json"
        for value in ({"segments": [{"start": 0, "end": 1, "speaker": 9}]},
                      {"segments": [{"start": 3, "end": 3.05, "speaker": 1}]},
                      {"segments": [{"start": 0, "end": 1, "speaker": True}]}):
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                d._read_result(path, 2)

    def test_cancellation_and_timeout_terminate_subprocess(self):
        self.exe.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(30)\n")
        self.config["executable_sha256"] = hashlib.sha256(self.exe.read_bytes()).hexdigest()
        self.write_config()
        checks = iter([False, False, True])
        with self.assertRaises(d.DiarizationCancelled):
            d.diarize_session(self.session, data_dir=self.root, cancelled=lambda: next(checks))
        with patch.object(d, "TIMEOUT_SECONDS", 0):
            with self.assertRaises(TimeoutError):
                d.diarize_session(self.session, data_dir=self.root)

    def test_setup_requires_explicit_download(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "setup_diarization.py"
        result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--download", result.stderr)


if __name__ == "__main__":
    unittest.main()
