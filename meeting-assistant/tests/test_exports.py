import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from meeting_assistant.exports import export_session


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.session = {
            "id": "session-1", "version": 2, "source": "test", "context": "meeting",
            "speaker_names": {"speaker_1": "Alice", "unknown": "Do not use"},
            "segments": [{"id": 1, "start": 1.2, "end": 4, "speaker": "speaker_1",
                          "raw_text": "原始", "traditional_text": "修正", "english": "revised",
                          "revision": 2, "edited": True},
                         {"id": 2, "start": None, "end": None, "speaker": "unknown",
                          "raw_text": "第二", "traditional_text": "第二", "english": "second", "revision": 1}],
            "artifacts": [
                {"id": "a", "kind": "learning", "source_version": 2, "status": "review-needed",
                 "data": {"items": [{"traditional": "<詞>", "pinyin": "ci2", "contextual_meaning": "=danger",
                                      "quote": "quoted\tline\n<script>", "segment_ids": [1], "start": 1.2,
                                      "end": 4, "validation": "review-needed"}]}},
                {"id": "b", "kind": "summary", "source_version": 1, "status": "ready", "data": {"note": "old note"}},
                {"id": "c", "kind": "learning", "source_version": 1, "status": "ready",
                 "data": {"items": [{"term": "stale word"}]}},
            ],
        }

    def test_markdown_transcript_and_artifact_status(self):
        content = export_session(self.session, self.root, "markdown").read_text()
        for text in ("Segment 1", "1.2s–4s", "Alice", "原始", "修正", "revised", "Speaker: unknown", "STALE — not current", "old note", r"review\-needed"):
            self.assertIn(text, content)
        self.assertNotIn("Do not use", content)

    def test_json_snapshot_is_current_and_secret_free(self):
        self.session["settings"] = {"api_key": "secret value"}
        self.session["artifacts"][0]["data"]["api_key"] = "nested secret"
        self.session["artifacts"][1]["stale"] = False
        result = json.loads(export_session(self.session, self.root, "json").read_text())
        self.assertEqual(result["segments"][0]["raw_text"], "原始")
        self.assertEqual(result["segments"][0]["revision"], 2)
        self.assertTrue(result["artifacts"][1]["stale"])
        self.assertFalse(result["artifacts"][0]["stale"])
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("settings", result)

    def test_anki_is_sanitized_and_stale_excluded(self):
        content = export_session(self.session, self.root, "anki").read_text()
        rows = content.splitlines()
        self.assertEqual(len(rows), 1)
        fields = rows[0].split("\t")
        self.assertEqual(len(fields), 6)
        self.assertEqual(fields[0], "&lt;詞&gt;")
        self.assertTrue(fields[2].startswith("&#x27;="))
        self.assertIn("quoted line &lt;script&gt;", fields[3])
        self.assertIn("1.2s–4s", fields[4])
        self.assertIn("review-needed", fields[5])
        self.assertNotIn("stale word", content)

    def test_no_learning_and_invalid_format_do_not_write(self):
        self.session["artifacts"] = self.session["artifacts"][1:]
        with self.assertRaisesRegex(ValueError, "No non-stale learning"):
            export_session(self.session, self.root, "anki")
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            export_session(self.session, self.root, "other")
        self.assertFalse((self.root / "sessions").exists())

    def test_postprocess_item_meaning_and_segment_times(self):
        self.session["artifacts"][0]["data"]["items"] = [
            {"term": "詞", "pinyin": "ci2", "meaning": "context", "quote": "修正", "segment_id": 1,
             "validation_status": "dictionary_supported", "dictionary_provenance": "pypinyin"}
        ]
        fields = export_session(self.session, self.root, "anki").read_text().strip().split("\t")
        self.assertEqual(fields[2], "context")
        self.assertIn("1.2s–4s", fields[4])
        self.assertIn("dictionary_supported", fields[5])
        self.assertIn("pypinyin", fields[5])

    def test_unique_private_files_and_delete_scope(self):
        first = export_session(self.session, self.root, "json")
        second = export_session(self.session, self.root, "json")
        self.assertNotEqual(first, second)
        self.assertEqual(first.parent, self.root / "sessions" / "session-1" / "exports")
        self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o600)
        for folder in (first.parent, first.parent.parent, first.parent.parent.parent):
            self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)

    def test_bad_ids_and_symlinks_rejected(self):
        for ident in ("../outside", "/outside", ".", "", "a/b", "a\\b"):
            with self.subTest(ident=ident), self.assertRaises(ValueError):
                export_session({**self.session, "id": ident}, self.root, "json")
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "sessions").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            export_session(self.session, self.root, "json")
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
