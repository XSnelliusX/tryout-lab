"""Static browser contracts without starting the app or accessing a meeting."""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "meeting_assistant/static"
NODE = shutil.which("node")
# Modules written by the app shell and panels; the gallery/glass files are the component library.
APP_MODULES = ["app", "api", "store", "ui", "transcript", "recorder", "sidebar",
               "pinyin-ui", "panel-translate", "panel-setup", "panel-notes",
               "panel-audio", "panel-context", "panel-speakers", "panel-review", "panel-export"]


class Elements(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.scripts = []
        self.events = []
        self.styles = []
        self.links = []
        self.metas = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "script":
            self.scripts.append(attrs)
        if tag == "link":
            self.links.append(attrs)
        if tag == "meta":
            self.metas.append(attrs)
        if "style" in attrs:
            self.styles.append(tag)
        self.events.extend(k for k in attrs if k.startswith("on"))


def source(name):
    return (STATIC / f"{name}.js").read_text()


class UIContractTests(unittest.TestCase):
    def test_static_ids_are_present_and_unique(self):
        parser = Elements()
        parser.feed((STATIC / "index.html").read_text())
        self.assertEqual(len(parser.ids), len(set(parser.ids)))
        required = set()
        for name in ("app", "transcript", "sidebar", "panel-translate", "panel-audio"):
            required |= set(re.findall(r'\$\("([^"\n]+)"\)', source(name)))
        self.assertFalse(required - set(parser.ids), required - set(parser.ids))
        for tab in ("setup", "speakers", "notes"):
            self.assertIn(f"pane-{tab}", parser.ids)
            self.assertIn(f"tab-{tab}", parser.ids)
        self.assertIn("manual-translate-details", parser.ids)
        self.assertIn("pane-translate", parser.ids)

    def test_responsive_and_text_scale_metadata(self):
        parser = Elements()
        parser.feed((STATIC / "index.html").read_text())
        self.assertIn({"name": "text-scale", "content": "scale"}, parser.metas)
        app_css = (STATIC / "app.css").read_text()
        self.assertNotIn("min-width: 1100px", app_css)
        glass_css = (STATIC / "glass.css").read_text()
        self.assertIn("--text-body: 400 1rem", glass_css)

    def test_page_is_csp_clean(self):
        parser = Elements()
        parser.feed((STATIC / "index.html").read_text())
        self.assertFalse(parser.events, "CSP requires external scripts, not inline event handlers")
        self.assertFalse(parser.styles, "CSP forbids inline style attributes")
        self.assertEqual([s.get("src") for s in parser.scripts], ["/app.js"])
        self.assertTrue(all(s.get("type") == "module" for s in parser.scripts))
        self.assertTrue(all(l["href"].startswith("/") and "//" not in l["href"] for l in parser.links))
        self.assertIn("/panels.css", [l["href"] for l in parser.links])

    def test_module_imports_resolve_to_same_origin_files(self):
        for name in APP_MODULES:
            text = source(name)
            for target in re.findall(r'from "(/[^"]+)"', text):
                self.assertTrue((STATIC / target.lstrip("/")).is_file(), f"{name}: {target}")
            self.assertNotRegex(text, r'(?:from\s|import\(|fetch\()\s*["\'`]https?://', name)
            self.assertNotRegex(text, r'\beval\s*\(|new Function', name)
            self.assertNotRegex(text, r'setAttribute\(\s*["\']style["\']', name)

    def test_no_sensitive_or_unsafe_dom_rendering(self):
        for name in APP_MODULES:
            text = source(name)
            for forbidden in ("innerHTML", "outerHTML", "insertAdjacentHTML", "localStorage"):
                self.assertNotIn(forbidden, text, f"{name}: {forbidden}")
            self.assertNotRegex(text, r'sessionStorage\.setItem\([^\n]*(?:api_key|gateway-key|apiKey)', name)

    def test_authorization_header_and_consent(self):
        api = source("api")
        self.assertIn("Authorization:", api)
        self.assertIn("Bearer", api)
        self.assertIn("sessionStorage", api)
        for name in APP_MODULES:
            if name != "recorder":
                self.assertNotRegex(source(name), r'consent\s*:\s*true', name)
            self.assertNotIn("Which app needs macOS permission", source(name), name)
        rec = source("recorder")
        self.assertRegex(rec, r'consent:\s*true')
        self.assertNotIn("Start recording?", rec)

    def test_floating_captions_and_gradient_preserved(self):
        app_css = (STATIC / "app.css").read_text()
        self.assertIn(".ambient", app_css)
        self.assertIn("background: transparent", app_css)
        self.assertIn(".record-icon", app_css)
        glass_css = (STATIC / "glass.css").read_text()
        en_m = re.search(r"--text-caption-en:[^;]*?([\d.]+)rem", glass_css)
        zh_m = re.search(r"--text-caption-zh:[^;]*?([\d.]+)rem", glass_css)
        self.assertIsNotNone(en_m)
        self.assertIsNotNone(zh_m)
        self.assertGreater(float(en_m.group(1)), float(zh_m.group(1)))
        pinyin_ui = source("pinyin-ui")
        self.assertIn("Contextual guess", pinyin_ui)
        self.assertIn("py-guess-toggle", pinyin_ui)

    def test_old_stylesheet_is_gone(self):
        self.assertFalse((STATIC / "style.css").exists())

    def test_pinyin_copy_replacement_and_audio_clip_contracts(self):
        panels_css = (STATIC / "panels.css").read_text()
        self.assertIn("user-select: none", panels_css)
        self.assertIn("-webkit-user-select: none", panels_css)
        self.assertNotIn("flex-direction: column-reverse", panels_css)

        pinyin_ui = source("pinyin-ui")
        self.assertIn("Copy Chinese", pinyin_ui)
        self.assertIn("Copy Pinyin", pinyin_ui)
        self.assertIn("replaceEl", pinyin_ui)
        self.assertIn("extractSelectedBaseText", pinyin_ui)

        transcript = source("transcript")
        self.assertIn("Pause audio clip", transcript)
        self.assertIn('iconName = playing ? "pause" : "play"', transcript)
        self.assertNotIn("cap-clip-close", transcript)

    @unittest.skipUnless(NODE, "node is not installed")
    def test_pinyin_formatting_word_segmentation_and_wav_timeline_in_node(self):
        script = r"""
import { segmentWords, formatPinyinText } from "./pinyin-ui.js";
import { buildWordIntervals, buildSpeechTimelineFromWav, wordIndexForTime } from "./transcript.js";

const segs = segmentWords("銀行很重要，快樂的音樂。");
const speakable = segs.filter((s) => s.speakable).map((s) => s.text);
const pinyin = formatPinyinText([
  { text: "銀", is_chinese: true, available: true, reading: "yín" },
  { text: "行", is_chinese: true, available: true, reading: "háng" },
  { text: "很", is_chinese: true, available: true, reading: "hěn" },
  { text: "重", is_chinese: true, available: true, reading: "zhòng" },
  { text: "要", is_chinese: true, available: true, reading: "yào" },
  { text: "，API。", is_chinese: false },
]);

// Build a 1-second 16kHz mono 16-bit PCM WAV: 0.25s silence, 0.5s tone, 0.25s silence.
const sampleRate = 16000;
const totalSamples = 16000;
const dataBytes = totalSamples * 2;
const buf = new ArrayBuffer(44 + dataBytes);
const view = new DataView(buf);
const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
writeStr(0, "RIFF");
view.setUint32(4, 36 + dataBytes, true);
writeStr(8, "WAVE");
writeStr(12, "fmt ");
view.setUint32(16, 16, true);
view.setUint16(20, 1, true);
view.setUint16(22, 1, true);
view.setUint32(24, sampleRate, true);
view.setUint32(28, sampleRate * 2, true);
view.setUint16(32, 2, true);
view.setUint16(34, 16, true);
writeStr(36, "data");
view.setUint32(40, dataBytes, true);
for (let i = 4000; i < 12000; i++) {
  view.setInt16(44 + i * 2, Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), true);
}

const timeline = buildSpeechTimelineFromWav(buf);
const intervals = buildWordIntervals("銀行很重要");
const earlySilenceIdx = wordIndexForTime(0.10, 1.0, intervals, timeline);
const midSpeechIdx = wordIndexForTime(0.50, 1.0, intervals, timeline);
const lateSilenceIdx = wordIndexForTime(0.90, 1.0, intervals, timeline);

console.log(JSON.stringify({ speakable, pinyin, hasTimeline: Boolean(timeline), earlySilenceIdx, midSpeechIdx, lateSilenceIdx }));
"""
        with tempfile.TemporaryDirectory() as temp:
            temp_dir = Path(temp)
            for mod in ("pinyin-ui.js", "transcript.js"):
                txt = (STATIC / mod).read_text(encoding="utf-8")
                txt = (
                    txt.replace('from "/api.js"', 'from "./stub.js"')
                       .replace('from "/glass.js"', 'from "./stub.js"')
                       .replace('from "/store.js"', 'from "./stub.js"')
                       .replace('from "/ui.js"', 'from "./stub.js"')
                       .replace('from "/pinyin-ui.js"', 'from "./pinyin-ui.js"')
                )
                (temp_dir / mod).write_text(txt, encoding="utf-8")
            (temp_dir / "stub.js").write_text(
                "export const api = async () => ({});\n"
                "export const action = async () => ({});\n"
                "export const getToken = () => '';\n"
                "export const el = () => ({});\n"
                "export const icon = () => ({});\n"
                "export const toast = () => {};\n"
                "export const store = { state: null, segments: () => [] };\n"
                "export const $ = () => null;\n"
                "export const setText = () => {};\n"
                "export const setUnavailable = () => {};\n"
                "export const onPress = () => {};\n"
                "export const formatRange = () => '';\n"
                "export const speakerText = () => '';\n",
                encoding="utf-8",
            )
            (temp_dir / "package.json").write_text('{"type": "module"}', encoding="utf-8")
            (temp_dir / "test.mjs").write_text(script, encoding="utf-8")
            done = subprocess.run([NODE, str(temp_dir / "test.mjs")], capture_output=True, text=True, timeout=30, cwd=temp_dir)
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout.strip().splitlines()[-1])
        self.assertGreaterEqual(len(result["speakable"]), 3)
        self.assertEqual(result["pinyin"], "yín háng hěn zhòng yào，API。")
        self.assertTrue(result["hasTimeline"])
        self.assertEqual(result["earlySilenceIdx"], -1)
        self.assertGreaterEqual(result["midSpeechIdx"], 0)
        self.assertEqual(result["lateSilenceIdx"], -1)


if __name__ == "__main__":
    unittest.main()
