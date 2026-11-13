"""Live capture end to end with a fake capture helper process and fake models (no real capture)."""

import json
import os
import signal
import time
import unittest

from meeting_assistant.audio import clear_probe_cache, helper_protocol, list_devices

from pipeline_fakes import AppCase, write_helper


class CaptureTests(AppCase, unittest.TestCase):
    threads = True

    def start(self, mode, protocol=2, source="teams", settings=None):
        helper = write_helper(self._dir(), protocol, mode)
        self.make_app(helper=helper)
        self.model.text = "早安"
        clear_probe_cache()
        self.log = self.root / "helper.log"
        os.environ["FAKE_HELPER_LOG"] = str(self.log)
        self.addCleanup(os.environ.pop, "FAKE_HELPER_LOG", None)
        self.app.kill_after = 0.5
        self.app.stall_seconds = 0.6
        if settings:
            self.app.update_settings(settings)
        self.app.start(source, True)
        return self.app

    def _dir(self):
        import tempfile
        from pathlib import Path

        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return Path(directory.name)

    def idle(self, timeout=8, stop=False):
        if stop:
            self.app.stop()
        self.wait_for(lambda: self.app.recording_state == "idle", timeout, "capture to finish")

    def two_utterances(self):
        self.wait_for(lambda: len(self.segments()) == 2 and self.segments()[1]["status"] == "complete", 8,
                      "two segments")

    def segments(self):
        return self.app.library.get_session(self.app.session_id)["segments"]

    def helper_runs(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_utterances_become_segments_with_stream_times_and_timing(self):
        app = self.start("utterances")
        self.two_utterances()
        self.idle(stop=True)
        segments = self.segments()
        self.assertEqual(len(segments), 2, segments)
        first, second = segments
        self.assertLess(first["end"], second["start"])  # no overlap any more
        self.assertGreater(first["start"], 0.1)
        self.assertLess(first["end"] - first["start"], 2.2)  # no long trailing silence
        self.assertTrue(all(s["status"] == "complete" and s["timing"]["speech_end_to_english_ms"] is not None
                            for s in segments))
        self.assertEqual(app.notice, "")
        self.assertEqual(app.capture_status, "Capture stopped; captions finished")
        self.assertEqual(app.library.get_session(app.session_id)["status"], "complete")
        self.assertGreaterEqual(app.pipeline_stats["spec_started"], 2)

    def test_stop_by_sigterm_is_a_clean_stop(self):
        app = self.start("forever")
        self.wait_for(lambda: app.recording_state == "recording", 5, "recording")
        self.wait_for(lambda: len(self.segments()) >= 1, 8, "first segment")
        app.stop()
        self.idle()
        self.assertEqual(app.capture_status, "Capture stopped; captions finished")
        self.assertEqual(app.library.get_session(app.session_id)["status"], "complete")
        self.assertNotIn("fail", app.notice.lower())

    def test_helper_ignoring_sigterm_is_killed_and_still_a_clean_stop(self):
        app = self.start("ignore-term", source="microphone")
        self.wait_for(lambda: app.device is not None and app.device.get("input_volume") == 0.8, 8, "input event")
        app.stop()
        self.idle()
        self.assertEqual(app.library.get_session(app.session_id)["status"], "complete")
        self.assertEqual(app.capture_status, "Capture stopped; captions finished")

    def test_last_utterance_at_stop_is_captioned(self):
        app = self.start("speech-at-stop")
        self.wait_for(lambda: app.audio_seconds > 1.5, 5, "speech")
        app.stop()
        self.idle()
        segments = self.segments()
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["status"], "complete")
        self.assertGreater(segments[0]["end"], 1.5)

    def test_stalled_source_is_flushed_by_the_watchdog(self):
        app = self.start("stall")
        self.wait_for(lambda: len(self.segments()) == 1, 6, "watchdog flush")
        self.assertEqual(app.recording_state, "recording")
        self.assertEqual(app.capture.stall_flushes, 1)
        app.stop()
        self.idle()
        self.assertEqual(len(self.segments()), 1)

    def test_ctrl_c_shutdown_tolerates_capture_already_draining(self):
        from meeting_assistant.server import shutdown

        app = self.start("forever")
        self.wait_for(lambda: len(self.segments()) >= 1, 8, "first segment")
        app.stop()  # the user pressed Stop, then Ctrl-C while draining
        shutdown(app, timeout=8)
        self.idle()
        self.assertEqual(app.library.get_session(app.session_id)["status"], "complete")

    def test_capture_failure_is_reported(self):
        app = self.start("fail")
        self.idle()
        self.assertIn("Microphone permission", app.notice)
        self.assertEqual(app.library.get_session(app.session_id)["status"], "error")

    def test_helper_runs_in_its_own_session(self):
        app = self.start("forever")
        self.wait_for(lambda: self.log.exists() and any("--source" in r["args"] for r in self.helper_runs()), 5, "helper")
        run = next(r for r in self.helper_runs() if "--source" in r["args"])
        self.assertNotEqual(run["sid"], os.getsid(0))  # terminal Ctrl-C does not reach it
        app.stop()
        self.idle()

    def test_device_uid_is_passed_to_a_protocol_2_helper(self):
        app = self.start("utterances", source="microphone", settings={"audio": {"device_uid": "USB-1"}})
        self.two_utterances()
        self.idle(stop=True)
        run = next(r for r in self.helper_runs() if "--source" in r["args"])
        self.assertEqual(run["args"], ["--source", "microphone", "--device", "USB-1"])
        self.assertEqual(app.device, None)  # cleared once idle
        self.assertEqual(app.notice, "")

    def test_device_uid_is_ignored_with_notice_for_an_old_helper(self):
        app = self.start("utterances", protocol=1, source="microphone", settings={"audio": {"device_uid": "USB-1"}})
        self.assertIn("outdated", app.notice)
        self.wait_for(lambda: self.log.exists() and any("--source" in r["args"] for r in self.helper_runs()), 5, "helper")
        self.idle(stop=True)
        run = next(r for r in self.helper_runs() if "--source" in r["args"])
        self.assertEqual(run["args"], ["--source", "microphone"])

    def test_audio_diagnostics_during_capture(self):
        app = self.start("forever", source="microphone")
        self.wait_for(lambda: app.audio_state()["speech_db"] is not None, 6, "speech level")
        audio = app.audio_state()
        for key in ("rms_db", "peak_db", "noise_db", "speech_db", "snr_db", "threshold_db", "speaking",
                    "gain_db", "clipped_recent", "clipped_total", "advice", "device"):
            self.assertIn(key, audio)
        self.assertEqual(audio["device"]["uid"], "BuiltIn")
        self.assertEqual(audio["device"]["input_volume"], 0.5)
        self.assertAlmostEqual(audio["snr_db"], audio["speech_db"] - audio["noise_db"], delta=0.2)
        app.stop()
        self.idle()


class HelperProbeTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path

        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        clear_probe_cache()

    def tearDown(self):
        self.temp.cleanup()

    def test_protocol_detection(self):
        self.assertEqual(helper_protocol(write_helper(self.dir, 2)), 2)
        self.assertEqual(helper_protocol(write_helper(self.dir, 1)), 1)
        self.assertIsNone(helper_protocol(self.dir / "missing"))

    def test_device_listing_and_cache(self):
        helper = write_helper(self.dir, 2)
        log = self.dir / "log"
        os.environ["FAKE_HELPER_LOG"] = str(log)
        self.addCleanup(os.environ.pop, "FAKE_HELPER_LOG", None)
        result = list_devices(helper)
        self.assertTrue(result["supported"])
        self.assertEqual([d["uid"] for d in result["devices"]], ["BuiltIn", "USB-1"])
        self.assertTrue(result["devices"][0]["is_default"])
        self.assertNotIn("extra", result["devices"][1])
        self.assertIsNone(result["devices"][1]["input_volume"])
        list_devices(helper)
        runs = [json.loads(line)["args"] for line in log.read_text().splitlines()]
        self.assertEqual(runs.count(["--list-devices"]), 1)  # cached for 5 s
        self.assertLessEqual(runs.count(["--version"]), 1)   # cached per binary

    def test_old_helper_has_no_device_support(self):
        self.assertEqual(list_devices(write_helper(self.dir, 1)), {"supported": False, "devices": []})


if __name__ == "__main__":
    unittest.main()
