"""Deterministic repository tests using only synthetic meeting data."""

import json
import os
import sqlite3
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from meeting_assistant.library import Library


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.root = Path(self.temp.name) / "private"
        self.library = Library(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def register(self):
        return self.library.register_session("session-1", "microphone", "context")

    def segment(self, **kwargs):
        value = {"id": 1, "start": 0.0, "end": 1.0, "kind": "audio", "raw_text": "简体原文", "traditional_text": "繁體原文", "status": "translating"}
        value.update(kwargs)
        return self.library.upsert_segment("session-1", value)

    def test_settings_persist_validate_and_never_store_key(self):
        item = self.library.add_vocabulary("測試", "test", "example")
        self.library.save_settings({"meeting_context": "Team\nmeeting", "gateway": {"endpoint": "https://example.org", "model": "model"}})
        stored = Library(self.root).get_settings()
        self.assertEqual(stored["vocabulary"][0], item)
        self.assertEqual(stored["gateway"]["model"], "model")
        with self.assertRaises(ValueError):
            self.library.save_settings({"gateway": {"api_key": "secret"}})
        with self.assertRaises(ValueError):
            self.library.save_settings({"meeting_context": "x" * 4001})
        for term in ("x" * 101, "<|im_start|>", "a\x00b", "a\x85b"):
            with self.subTest(term=term), self.assertRaises(ValueError):
                self.library.add_vocabulary(term)
        with self.assertRaises(ValueError):
            self.library.save_settings({"vocabulary": [{"term": "test"}] * 129})
        self.library.remove_vocabulary(item["id"])
        self.assertEqual(self.library.get_settings()["vocabulary"], [])
        self.assertEqual(os.stat(self.root).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.library.db_path).st_mode & 0o777, 0o600)

    def test_revision_history_immutable_raw_and_stale_translation(self):
        initial = self.register()
        self.assertEqual(initial["version"], 1)
        segment = self.segment()
        self.assertEqual(segment["revision"], 1)
        snapshot = self.library.get_session("session-1")
        artifact = self.library.add_artifact("session-1", "summary", snapshot["version"], {"summary": "test"})
        self.segment(english="original", status="complete")
        self.assertEqual(self.library.get_session("session-1")["version"], snapshot["version"])
        self.assertFalse(self.library.get_artifact("session-1", artifact["id"])["stale"])
        edited = self.library.edit_segment("session-1", 1, "人工修正", 1, speaker="speaker-1")
        self.assertEqual((edited["raw_text"], edited["traditional_text"], edited["revision"], edited["english"]), ("简体原文", "人工修正", 2, ""))
        self.assertEqual(self.segment(english="late stale")["traditional_text"], "人工修正")
        self.assertEqual(self.library.get_session("session-1")["segments"][0]["english"], "")
        with self.assertRaisesRegex(ValueError, "Revision conflict"):
            self.library.update_translation("session-1", 1, 1, "stale")
        with self.assertRaisesRegex(ValueError, "Revision conflict"):
            self.library.edit_segment("session-1", 1, "lost update", 1)
        self.library.update_translation("session-1", 1, 2, "reviewed")
        self.assertEqual(self.library.get_session("session-1")["segments"][0]["english"], "reviewed")
        self.assertTrue(self.library.get_artifact("session-1", artifact["id"])["stale"])
        history = self.library.segment_history("session-1", 1)
        self.assertEqual([h["traditional_text"] for h in history], ["繁體原文", "人工修正"])
        self.assertEqual([h["raw_text"] for h in history], ["简体原文", "简体原文"])

    def test_edit_rejects_long_text_reserved_tokens_and_controls(self):
        self.register()
        self.segment()
        for text in ("x" * 5001, "<|plamo:tag|>", "prefix <|", "<asr_text>", "a\x00b", "a\x85b"):
            with self.subTest(text=text[:20]), self.assertRaises(ValueError):
                self.library.edit_segment("session-1", 1, text, 1)
        self.assertEqual(self.library.edit_segment("session-1", 1, "line 1\nline 2", 1)["revision"], 2)

    def test_add_vocabulary_reuses_casefolded_term_and_preserves_flags(self):
        item = self.library.add_vocabulary("Server", "old translation", "old note")
        item["enabled"] = False
        item["known"] = True
        self.library.save_settings({"vocabulary": [item]})
        duplicate = self.library.add_vocabulary("  SERVER  ", "new translation")
        self.assertEqual(duplicate["id"], item["id"])
        self.assertEqual(duplicate["term"], "Server")
        self.assertEqual(duplicate["translation"], "new translation")
        self.assertEqual(duplicate["note"], "old note")
        self.assertFalse(duplicate["enabled"])
        self.assertTrue(duplicate["known"])
        self.assertEqual(self.library.add_vocabulary("server", "", "new note")["note"], "new note")
        self.assertEqual(len(self.library.get_settings()["vocabulary"]), 1)

    def test_new_segment_context_and_speakers_invalidate_artifacts(self):
        self.register()
        self.segment()
        before = self.library.get_session("session-1")
        a = self.library.add_artifact("session-1", "summary", before["version"], {})
        self.library.set_session_context("session-1", "context")
        self.assertEqual(self.library.get_session("session-1")["version"], before["version"])
        self.library.set_session_context("session-1", "changed")
        self.assertTrue(self.library.get_artifact("session-1", a["id"])["stale"])
        result = self.library.assign_speakers("session-1", [{"id": 1, "speaker": "speaker-1", "ambiguous": True}])
        self.assertEqual(result["segments"][0]["speaker"], "speaker-1")
        self.assertTrue(result["segments"][0]["ambiguous"])
        self.assertEqual(result["segments"][0]["revision"], 2)
        result = self.library.set_speaker_names("session-1", {"speaker-1": "Reviewed Name"})
        self.assertEqual(result["speaker_names"]["speaker-1"], "Reviewed Name")
        version = result["version"]
        self.segment(id=2, raw_text="other", traditional_text="other")
        self.assertEqual(self.library.get_session("session-1")["version"], version + 1)
        with self.assertRaises(ValueError):
            self.library.assign_speakers("session-1", [{"id": 1, "speaker": "speaker-2"}, {"id": 99, "speaker": "speaker-3"}])
        self.assertEqual(self.library.get_session("session-1")["segments"][0]["speaker"], "speaker-1")

    def test_partial_inference_does_not_clear_fields_or_replace_evidence(self):
        self.register()
        self.segment(english="already translated", status="complete")
        partial = self.library.upsert_segment("session-1", {"id": 1, "raw_text": "changed"})
        self.assertEqual(partial["raw_text"], "简体原文")
        self.assertEqual(partial["traditional_text"], "繁體原文")
        self.assertEqual(partial["english"], "already translated")
        self.assertEqual(partial["status"], "complete")
        edited = self.library.edit_segment("session-1", 1, "reviewed", 1)
        translated = self.library.upsert_segment("session-1", {"id": 1, "revision": edited["revision"], "english": "reviewed translation"})
        self.assertEqual(translated["traditional_text"], "reviewed")
        self.assertEqual(translated["english"], "reviewed translation")

    def test_old_artifact_is_created_stale(self):
        self.register()
        version = self.library.get_session("session-1")["version"]
        self.segment()
        artifact = self.library.add_artifact("session-1", "summary", version, {"items": []})
        self.assertTrue(artifact["stale"])
        self.assertEqual(self.library.get_session("session-1")["artifacts"][0]["data"], {"items": []})
        with self.assertRaises(ValueError):
            self.library.add_artifact("session-1", "summary", 999, {})

    def test_attribution_flag_persists_and_invalidates_on_change_only(self):
        session = self.register()
        self.assertIs(session["attribution_unreliable"], False)
        artifact = self.library.add_artifact("session-1", "summary", session["version"], {})
        session = self.library.set_attribution_unreliable("session-1", True)
        self.assertIs(session["attribution_unreliable"], True)
        self.assertEqual(session["version"], 2)
        self.assertTrue(self.library.get_artifact("session-1", artifact["id"])["stale"])
        self.assertEqual(self.library.set_attribution_unreliable("session-1", True)["version"], 2)
        self.assertIs(Library(self.root).list_sessions()[0]["attribution_unreliable"], True)
        self.assertEqual(self.library.set_attribution_unreliable("session-1", False)["version"], 3)
        with self.assertRaises(ValueError):
            self.library.set_attribution_unreliable("session-1", 1)

    def test_upgrade_old_sessions_schema_and_insert_afterwards(self):
        old_root = Path(self.temp.name) / "old"
        old_root.mkdir()
        from contextlib import closing
        with closing(sqlite3.connect(old_root / "library.sqlite3")) as db:
            db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, context TEXT NOT NULL, speaker_names TEXT NOT NULL)")
            db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)", ("old", "teams", "2026-01-01", "complete", 3, "", "{}"))
            db.commit()
        upgraded = Library(old_root)
        self.assertIs(upgraded.get_session("old")["attribution_unreliable"], False)
        self.assertIs(upgraded.register_session("new", "teams")["attribution_unreliable"], False)
        journal = old_root / "sessions" / "legacy" / "events.jsonl"
        journal.parent.mkdir(parents=True)
        journal.write_text(json.dumps({"type": "session_started", "source": "teams"}) + "\n")
        self.assertEqual(upgraded.import_legacy(), ["legacy"])
        self.assertIs(upgraded.get_session("legacy")["attribution_unreliable"], False)
        self.assertIs(Library(old_root).get_session("old")["attribution_unreliable"], False)

    def test_concurrent_edits_are_atomic_across_instances(self):
        self.register()
        self.segment()
        other = Library(self.root)
        barrier = threading.Barrier(2)
        outcomes = []

        def edit(library, text):
            barrier.wait()
            try:
                outcomes.append(library.edit_segment("session-1", 1, text, 1)["revision"])
            except ValueError:
                outcomes.append("conflict")

        threads = [threading.Thread(target=edit, args=(self.library, "first")), threading.Thread(target=edit, args=(other, "second"))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertCountEqual(outcomes, [2, "conflict"])
        self.assertEqual(len(self.library.segment_history("session-1", 1)), 2)

    def test_legacy_import_is_incremental_and_does_not_overwrite_edits(self):
        directory = self.root / "sessions" / "legacy"
        directory.mkdir(parents=True)
        journal = directory / "events.jsonl"
        source = {"type": "source_segment", "id": 1, "raw_text": "原始", "traditional_text": "來源", "status": "translating"}
        translated = {**source, "type": "segment", "english": "original", "status": "complete"}
        initial = [{"type": "session_started", "source": "teams", "at": "2026-01-01T00:00:00Z"}, source, translated]
        journal.write_text("".join(json.dumps(event, ensure_ascii=False) + "\n" for event in initial), encoding="utf-8")
        self.assertEqual(self.library.import_legacy(), ["legacy"])
        session = self.library.get_session("legacy")
        self.assertEqual((session["source"], session["segments"][0]["english"]), ("teams", "original"))
        self.assertEqual(session["status"], "interrupted")
        self.assertEqual(self.library.import_legacy(), [])
        self.library.edit_segment("legacy", 1, "reviewed", 1)
        with journal.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(translated) + "\n")
            stream.write(json.dumps({"type": "session_finished", "status": "complete"}) + "\n")
        self.library.import_legacy()
        session = self.library.get_session("legacy")
        self.assertEqual(session["status"], "complete")
        self.assertEqual((session["segments"][0]["traditional_text"], session["segments"][0]["english"]), ("reviewed", ""))
        self.assertEqual(len(self.library.segment_history("legacy", 1)), 2)

    def test_import_skips_corrupt_and_truncated_journals_atomically(self):
        sessions = self.root / "sessions"
        for name in ("broken", "truncated", "valid"):
            (sessions / name).mkdir(parents=True)
        good = {"type": "source_segment", "id": 1, "raw_text": "synthetic", "traditional_text": "synthetic"}
        good_line = json.dumps(good) + "\n"
        (sessions / "broken" / "events.jsonl").write_text(good_line + "{bad secret text}\n")
        (sessions / "truncated" / "events.jsonl").write_text(good_line + '{"type":')
        (sessions / "valid" / "events.jsonl").write_text(good_line)
        self.assertEqual(self.library.import_legacy(), ["valid"])
        self.assertEqual(self.library.import_warnings, ["broken", "truncated"])
        with self.assertRaises(ValueError):
            self.library.get_session("broken")
        with self.assertRaises(ValueError):
            self.library.get_session("truncated")
        self.assertEqual(self.library.get_session("valid")["status"], "interrupted")
        (sessions / "broken" / "events.jsonl").write_text(good_line)
        self.assertEqual(self.library.import_legacy(), ["broken"])
        self.assertEqual(self.library.import_warnings, ["truncated"])

    def test_legacy_import_never_interrupts_registered_session(self):
        self.register()
        directory = self.root / "sessions" / "session-1"
        directory.mkdir(parents=True)
        journal = directory / "events.jsonl"
        journal.write_text(json.dumps({"type": "session_started", "source": "microphone"}) + "\n")
        self.library.import_legacy()
        self.library.import_legacy()
        self.assertEqual(self.library.get_session("session-1")["status"], "recording")

    def test_delete_only_validated_session_and_tracked_exports(self):
        self.register()
        session = self.root / "sessions" / "session-1"
        session.mkdir(parents=True)
        (session / "events.jsonl").write_text("synthetic")
        exports = self.root / "exports"
        exports.mkdir()
        tracked, untracked = exports / "tracked.txt", exports / "untracked.txt"
        tracked.write_text("synthetic")
        untracked.write_text("do not delete")
        self.library.register_export("session-1", tracked)
        self.library.delete_session("session-1")
        self.assertFalse(session.exists())
        self.assertFalse(tracked.exists())
        self.assertTrue(untracked.exists())
        with self.assertRaises(ValueError):
            self.library.get_session("session-1")
        with self.assertRaises(ValueError):
            self.library.delete_session("../outside")

    def test_delete_refuses_symlinks_even_within_session(self):
        self.register()
        session = self.root / "sessions" / "session-1"
        session.mkdir(parents=True)
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "keep").write_text("safe")
        (session / "link").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.library.delete_session("session-1")
        self.assertTrue((outside / "keep").exists())
        self.assertEqual(self.library.get_session("session-1")["id"], "session-1")

    def _deletion_fixture(self):
        self.register()
        session = self.root / "sessions" / "session-1"
        session.mkdir(parents=True)
        (session / "audio.wav").write_bytes(b"synthetic audio evidence")
        exports = self.root / "exports"
        exports.mkdir()
        export = exports / "tracked.txt"
        export.write_text("synthetic export")
        self.library.register_export("session-1", export)
        return session, export

    def test_delete_failed_export_move_restores_evidence(self):
        session, export = self._deletion_fixture()
        move = self.library._move_durable

        def fail_export(source, destination):
            if source == export:
                raise OSError("injected export rename failure")
            return move(source, destination)

        with mock.patch.object(self.library, "_move_durable", side_effect=fail_export):
            with self.assertRaisesRegex(OSError, "injected"):
                self.library.delete_session("session-1")
        self.assertEqual((session / "audio.wav").read_bytes(), b"synthetic audio evidence")
        self.assertEqual(export.read_text(), "synthetic export")
        self.assertEqual(self.library.get_session("session-1")["id"], "session-1")
        self.assertEqual(list((self.root / ".trash").iterdir()), [])

    def test_delete_failed_commit_restores_evidence(self):
        session, export = self._deletion_fixture()
        connection = self.library._connection
        injected = False

        @contextmanager
        def fail_commit(*, write=False):
            nonlocal injected
            with connection(write=write) as db:
                yield db
                if write and not injected:
                    injected = True
                    raise OSError("injected commit failure")

        with mock.patch.object(self.library, "_connection", side_effect=fail_commit):
            with self.assertRaisesRegex(OSError, "injected commit"):
                self.library.delete_session("session-1")
        self.assertEqual((session / "audio.wav").read_bytes(), b"synthetic audio evidence")
        self.assertTrue(export.exists())
        self.assertEqual(self.library.get_session("session-1")["id"], "session-1")

    def test_failed_restore_is_retained_and_startup_recovers(self):
        session, export = self._deletion_fixture()
        move = self.library._move_durable

        def fail_export_and_restore(source, destination):
            if source == export or destination == session:
                raise OSError("injected failure")
            return move(source, destination)

        with mock.patch.object(self.library, "_move_durable", side_effect=fail_export_and_restore):
            with self.assertRaisesRegex(OSError, "retain quarantine"):
                self.library.delete_session("session-1")
        quarantines = list((self.root / ".trash").iterdir())
        self.assertEqual(len(quarantines), 1)
        self.assertTrue((quarantines[0] / "manifest.json").exists())
        self.assertTrue((quarantines[0] / "session" / "audio.wav").exists())
        self.assertTrue(export.exists())
        recovered = Library(self.root)
        self.assertEqual((session / "audio.wav").read_bytes(), b"synthetic audio evidence")
        self.assertEqual(recovered.get_session("session-1")["id"], "session-1")
        self.assertEqual(list((self.root / ".trash").iterdir()), [])

    def test_committed_delete_cleanup_recovered_even_if_id_reused(self):
        session, export = self._deletion_fixture()
        with mock.patch.object(self.library, "_purge_quarantine", side_effect=OSError("injected cleanup failure")):
            with self.assertRaisesRegex(OSError, "deletion committed"):
                self.library.delete_session("session-1")
        self.assertFalse(session.exists())
        self.assertFalse(export.exists())
        self.library.register_session("session-1", "new")
        session.mkdir()
        (session / "new.txt").write_text("new")
        recovered = Library(self.root)
        self.assertEqual((session / "new.txt").read_text(), "new")
        self.assertEqual(recovered.get_session("session-1")["source"], "new")
        self.assertEqual(list((self.root / ".trash").iterdir()), [])

    def test_recovery_rejects_malicious_manifest(self):
        session, export = self._deletion_fixture()
        quarantine = self.root / ".trash" / ("a" * 32)
        quarantine.mkdir(parents=True)
        (quarantine / "manifest.json").write_text(json.dumps({"session_id": "session-1", "session_present": False, "exports": [{"name": "../outside", "present": True}]}))
        with self.assertRaisesRegex(OSError, "needs attention"):
            Library(self.root)
        self.assertTrue((session / "audio.wav").exists())
        self.assertTrue(export.exists())
        self.assertTrue(quarantine.exists())


if __name__ == "__main__":
    unittest.main()
