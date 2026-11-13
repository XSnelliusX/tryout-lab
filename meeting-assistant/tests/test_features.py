"""Feature contract tests for manual translation, on-demand Pinyin, and direct vs unsupported microphone volume."""

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from meeting_assistant.audio import clear_probe_cache
from meeting_assistant.pinyin import analyze_pinyin, has_chinese
from meeting_assistant.server import make_server

from pipeline_fakes import AppCase, write_helper

TOKEN = "feature-test-token"


class PinyinTests(unittest.TestCase):
    def test_traditional_and_simplified_phrase_context_marks_heteronyms_ambiguous(self):
        self.assertTrue(has_chinese("銀行很重要"))
        self.assertFalse(has_chinese("hello 123"))

        res = analyze_pinyin("銀行很重要，快樂的音樂。")
        self.assertTrue(res["available"])
        self.assertTrue(res["has_chinese"])
        self.assertTrue(res["has_ambiguous"])
        self.assertEqual(res["unavailable_count"], 0)

        by_char = {t["text"]: t for t in res["tokens"] if t["is_chinese"]}
        # Contextual phrase dictionary picks 'háng' for 銀行 (not 'xíng'), AND flags alternatives
        self.assertEqual(by_char["行"]["reading"], "háng")
        self.assertTrue(by_char["行"]["ambiguous"])
        self.assertGreater(len(by_char["行"]["alternatives"]), 1)
        self.assertEqual(by_char["音"]["reading"], "yīn")
        self.assertEqual(by_char["樂"]["reading"], "yuè")
        self.assertTrue(by_char["樂"]["ambiguous"])
        self.assertIn("lè", by_char["樂"]["alternatives"])

    def test_unavailable_engine_or_unmapped_character_degrades_gracefully(self):
        unavail = analyze_pinyin("你好", _engine=False)
        self.assertFalse(unavail["available"])
        self.assertEqual(unavail["tokens"], [])
        self.assertIn("unavailable", unavail["reason"].lower())

        # Private-use / rare unmapped character within CJK Compatibility / PUA doesn't fabricate pinyin
        def fake_engine(text, *, style=None, heteronym=False, errors=None):
            if heteronym:
                return [["?" if ch == "𪚥" else "nǐ"] for ch in text]
            return [["?" if ch == "𪚥" else "nǐ"] for ch in text]

        # Test explicit rare unmapped Han char directly via analyze_pinyin when engine returns same char/empty
        def fake_unmapped(text, **kwargs):
            return [["" if ch == "龍" else "hǎo"] for ch in text]

        partial = analyze_pinyin("龍好", _engine=fake_unmapped)
        self.assertTrue(partial["available"])
        self.assertEqual(partial["unavailable_count"], 1)
        self.assertFalse(partial["tokens"][0]["available"])
        self.assertTrue(partial["tokens"][1]["available"])
        self.assertEqual(partial["tokens"][1]["reading"], "hǎo")


class FeatureHttpTests(AppCase, unittest.TestCase):
    threads = True

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        clear_probe_cache()
        self.helper = write_helper(Path(temp.name), 2, "forever")
        self.make_app(helper=self.helper)
        self.session_info = self.app.library.register_session("fixture", "teams")
        self.httpd = make_server(self.app, TOKEN, 0)
        self.port = self.httpd.server_port
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def json(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": f"127.0.0.1:{self.port}", "Authorization": f"Bearer {TOKEN}"}
        payload = None
        if method == "POST":
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body if body is not None else {}).encode()
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, json.loads(raw)

    def test_manual_translation_directions_errors_and_non_mutation(self):
        # Default Chinese -> English works and never adds segments to current session
        before_count = len(self.app.state()["segments"])
        status, data = self.json("POST", "/api/translate", {"text": "你好世界"})
        self.assertEqual(status, 200)
        self.assertEqual(data["source_lang"], "zh-hant")
        self.assertEqual(data["target_lang"], "en")
        self.assertTrue(data["translation"])
        self.assertEqual(len(self.app.state()["segments"]), before_count)

        # Reverse EN -> Traditional Chinese
        status, rev = self.json("POST", "/api/translate", {
            "text": "Good morning",
            "source_lang": "en",
            "target_lang": "zh-hant",
        })
        self.assertEqual(status, 200)
        self.assertEqual(rev["source_lang"], "en")
        self.assertEqual(rev["target_lang"], "zh-hant")

        # Unsupported pairs & target auto rejected cleanly
        for bad in (
            {"text": "hi", "source_lang": "en", "target_lang": "zh"},
            {"text": "hi", "source_lang": "en", "target_lang": "pt"},
            {"text": "hi", "source_lang": "en", "target_lang": "auto"},
            {"text": "hi", "source_lang": "en", "target_lang": "en"},
            {"text": "   "},
        ):
            st, err = self.json("POST", "/api/translate", bad)
            self.assertEqual(st, 400, bad)
            self.assertIn("error", err)

        # Loading state returns 503 clearly
        self.app.model_load_state = "loading"
        self.app.model_ready = False
        st, err = self.json("POST", "/api/translate", {"text": "你好"})
        self.assertEqual(st, 503)
        self.assertIn("loading", err["error"].lower())

        # Model load failure returns 503 clearly
        self.app.model_load_state = "error"
        self.app.model_error = "Model files corrupt"
        st, err = self.json("POST", "/api/translate", {"text": "你好"})
        self.assertEqual(st, 503)
        self.assertIn("corrupt", err["error"].lower())

        # Runtime translation error returns 502 clearly
        self.app.model_load_state = "ready"
        self.app.model_ready = True
        def fail_translate():
            raise RuntimeError("MLX context limit")
        self.model.before_translation = fail_translate
        st, err = self.json("POST", "/api/translate", {"text": "你好"})
        self.assertEqual(st, 502)
        self.assertIn("MLX context limit", err["error"])

    def test_pinyin_endpoint_and_state_capability_fields(self):
        status, state = self.json("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertIn("pinyin", state)
        self.assertIn("translation_languages", state)
        self.assertEqual(state["audio"]["input_volume_mode"], "auto")

        status, body = self.json("POST", "/api/pinyin", {"text": "銀行"})
        self.assertEqual(status, 200)
        self.assertTrue(body["available"])
        self.assertTrue(body["has_ambiguous"])

    def test_direct_vs_unsupported_microphone_volume_controls(self):
        status, devs = self.json("GET", "/api/devices")
        self.assertEqual(status, 200)
        by_uid = {d["uid"]: d for d in devs["devices"]}
        self.assertTrue(by_uid["BuiltIn"]["direct_volume_supported"])
        self.assertFalse(by_uid["USB-1"]["direct_volume_supported"])

        # Default mode is auto; setting device_uid does not force manual volume
        st, _ = self.json("POST", "/api/settings", {"audio": {"device_uid": "BuiltIn"}})
        self.assertEqual(st, 200)
        self.assertEqual(self.app.audio_state()["input_volume_mode"], "auto")

        # Adjusting direct volume switches to manual mode without changing software normalize
        st, vol = self.json("POST", "/api/audio/input-volume", {"volume": 0.42, "device_uid": "BuiltIn"})
        self.assertEqual(st, 200)
        self.assertEqual(vol["input_volume_mode"], "manual")
        self.assertEqual(self.app.audio_state()["input_volume_mode"], "manual")
        self.assertAlmostEqual(vol["input_volume"], 0.42, places=2)
        self.assertTrue(self.app.state()["settings"]["audio"]["normalize"])

        # Switching back to automatic works cleanly
        st, auto = self.json("POST", "/api/audio/input-volume", {"mode": "auto"})
        self.assertEqual(st, 200)
        self.assertEqual(auto["input_volume_mode"], "auto")
        self.assertEqual(self.app.audio_state()["input_volume_mode"], "auto")

        # Unsupported fixed/USB mic and virtual device are rejected cleanly
        st, _ = self.json("POST", "/api/audio/input-volume", {"volume": 0.5, "device_uid": "USB-1"})
        self.assertEqual(st, 400)

        # When recording non-microphone source (teams), audio_state reports direct_volume_supported False and rejects volume adjustments
        self.app.start("teams", True)
        try:
            self.wait_for(lambda: self.app.recording_state == "recording", 5, "recording to start")
            st, s = self.json("GET", "/api/state")
            self.assertEqual(st, 200)
            self.assertFalse(s["audio"]["direct_volume_supported"])
            st, err = self.json("POST", "/api/audio/input-volume", {"volume": 0.5})
            self.assertEqual(st, 400)
        finally:
            self.app.stop()
            self.wait_for(lambda: self.app.recording_state == "idle", 5, "recording to stop")


if __name__ == "__main__":
    unittest.main()
