"""Private, versioned local meeting repository.

Every operation uses its own SQLite connection. Write transactions begin
immediately so revision checks and their mutations are serialized, including
across separate Library instances.

SQLite secure_delete reduces recoverable database remnants, but neither it nor
unlinking files guarantees secure erasure from SSDs, snapshots, or backups.
"""

import json
import os
import re
import shutil
import sqlite3
import stat
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def _now():
    return datetime.now(timezone.utc).isoformat()


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _text(value, name, limit, *, required=False, multiline=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError(f"{name} must be {'nonempty and ' if required else ''}at most {limit} characters")
    if ("<|" in value or re.search(r"</?(?:asr_text|tts_[a-z0-9_]+|blank\d+|tool_call)>", value, re.IGNORECASE)) or any(
        unicodedata.category(ch) == "Cc" and not (multiline and ch in "\n\r\t")
        for ch in value
    ):
        raise ValueError(f"{name} contains a reserved token or control character")
    return value


def _id(value):
    if not isinstance(value, str) or not value or value in (".", "..") or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", value):
        raise ValueError("Invalid session id; use a single safe directory name")
    return value


def _segment_id(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("Segment id must be a non-negative integer")
    return value


def _no_symlinks(path):
    """Refuse symlink components even when the final path does not yet exist."""
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError("Symlinks are not allowed in app-owned paths")


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _safe_tree(path):
    _no_symlinks(path)
    if not path.is_dir():
        raise ValueError("Expected an app-owned directory")
    def fail(error):
        raise error
    for root, dirs, files in os.walk(path, followlinks=False, onerror=fail):
        for name in dirs + files:
            if (Path(root) / name).is_symlink():
                raise ValueError("Symlinks are not allowed in app-owned directories")


class Library:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(os.path.abspath(data_dir))
        self.import_warnings = []
        _no_symlinks(self.data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.data_dir, 0o700)
        self.db_path = self.data_dir / "library.sqlite3"
        _no_symlinks(self.db_path)
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(self.db_path, flags, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("Library database must be a regular file")
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        with self._connection(write=True) as db:
            # Do not use executescript: it implicitly commits the transaction.
            for statement in (
                "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, context TEXT NOT NULL, speaker_names TEXT NOT NULL, attribution_unreliable INTEGER NOT NULL DEFAULT 0)",
                "CREATE TABLE IF NOT EXISTS segments (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id INTEGER NOT NULL, start REAL, end REAL, kind TEXT NOT NULL, raw_text TEXT NOT NULL, traditional_text TEXT NOT NULL, english TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, speaker TEXT NOT NULL, error TEXT, edited INTEGER NOT NULL DEFAULT 0, ambiguity TEXT, PRIMARY KEY(session_id, id))",
                "CREATE TABLE IF NOT EXISTS segment_history (session_id TEXT NOT NULL, segment_id INTEGER NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, segment_id, revision), FOREIGN KEY(session_id, segment_id) REFERENCES segments(session_id, id) ON DELETE CASCADE)",
                "CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, source_version INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)",
                "CREATE TABLE IF NOT EXISTS exports (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, filename TEXT NOT NULL UNIQUE, PRIMARY KEY(session_id, filename))",
                "CREATE TABLE IF NOT EXISTS imports (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, lines INTEGER NOT NULL, legacy_owned INTEGER NOT NULL DEFAULT 1)",
                "CREATE TABLE IF NOT EXISTS deletion_commits (id TEXT PRIMARY KEY)",
            ):
                db.execute(statement)
            if "legacy_owned" not in {row["name"] for row in db.execute("PRAGMA table_info(imports)")}:
                db.execute("ALTER TABLE imports ADD COLUMN legacy_owned INTEGER NOT NULL DEFAULT 1")
            if "attribution_unreliable" not in {row["name"] for row in db.execute("PRAGMA table_info(sessions)")}:
                db.execute("ALTER TABLE sessions ADD COLUMN attribution_unreliable INTEGER NOT NULL DEFAULT 0")
        self._recover_deletions()

    @contextmanager
    def _connection(self, *, write=False):
        _no_symlinks(self.db_path)
        db = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA secure_delete=ON")
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _session(self, db, session_id):
        row = db.execute("SELECT * FROM sessions WHERE id=?", (_id(session_id),)).fetchone()
        if row is None:
            raise ValueError("Session not found")
        return row

    def _segment(self, db, session_id, segment_id):
        self._session(db, session_id)
        row = db.execute("SELECT * FROM segments WHERE session_id=? AND id=?", (session_id, _segment_id(segment_id))).fetchone()
        if row is None:
            raise ValueError("Segment not found")
        return row

    @staticmethod
    def _segment_dict(row):
        result = dict(row)
        result.pop("session_id")
        result.pop("edited")
        ambiguity = result.pop("ambiguity")
        if ambiguity is not None:
            result.update(json.loads(ambiguity))
        if result["error"] is None:
            result.pop("error")
        return result

    def _history(self, db, row):
        db.execute("INSERT INTO segment_history VALUES (?, ?, ?, ?, ?)",
                   (row["session_id"], row["id"], row["revision"], _json(self._segment_dict(row)), _now()))

    @staticmethod
    def _bump(db, session_id):
        db.execute("UPDATE sessions SET version=version+1 WHERE id=?", (session_id,))

    @staticmethod
    def _artifact_dict(row, version):
        result = dict(row)
        result["data"] = json.loads(result["data"])
        result["stale"] = result["source_version"] != version
        return result

    def _session_dict(self, db, row, full=True):
        result = dict(row)
        result["speaker_names"] = json.loads(result["speaker_names"])
        result["attribution_unreliable"] = bool(result["attribution_unreliable"])
        if full:
            result["segments"] = [self._segment_dict(r) for r in db.execute("SELECT * FROM segments WHERE session_id=? ORDER BY id", (row["id"],))]
            result["artifacts"] = [self._artifact_dict(r, row["version"]) for r in db.execute("SELECT * FROM artifacts WHERE session_id=? ORDER BY created_at, id", (row["id"],))]
        return result

    def get_settings(self):
        with self._connection() as db:
            return self._settings(db)

    @staticmethod
    def _settings(db):
        result = {"meeting_context": "", "vocabulary": [], "gateway": {"endpoint": "", "model": ""}}
        for row in db.execute("SELECT * FROM settings"):
            result[row["key"]] = json.loads(row["value"])
        return result

    @staticmethod
    def _vocabulary(value):
        if not isinstance(value, list) or len(value) > 128:
            raise ValueError("Vocabulary must be a list of at most 128 entries")
        result, ids = [], set()
        for item in value:
            if not isinstance(item, dict):
                raise ValueError("Each vocabulary entry must be an object")
            ident = item.get("id") or str(uuid.uuid4())
            try:
                ident = str(uuid.UUID(ident))
            except (ValueError, TypeError, AttributeError):
                raise ValueError("Vocabulary id must be a UUID") from None
            if ident in ids:
                raise ValueError("Duplicate vocabulary id")
            ids.add(ident)
            enabled, known = item.get("enabled", True), item.get("known", False)
            if not isinstance(enabled, bool) or not isinstance(known, bool):
                raise ValueError("Vocabulary enabled and known must be booleans")
            result.append({"id": ident, "term": _text(item.get("term", ""), "term", 100, required=True),
                           "translation": _text(item.get("translation", ""), "translation", 200),
                           "note": _text(item.get("note", ""), "note", 1000),
                           "enabled": enabled, "known": known})
        return result

    def save_settings(self, updates):
        if not isinstance(updates, dict) or set(updates) - {"meeting_context", "vocabulary", "gateway"}:
            raise ValueError("Invalid settings fields")
        with self._connection(write=True) as db:
            settings = self._settings(db)
            if "meeting_context" in updates:
                settings["meeting_context"] = _text(updates["meeting_context"], "meeting context", 4000, multiline=True)
            if "vocabulary" in updates:
                settings["vocabulary"] = self._vocabulary(updates["vocabulary"])
            if "gateway" in updates:
                gateway = updates["gateway"]
                if not isinstance(gateway, dict) or set(gateway) - {"endpoint", "model"}:
                    raise ValueError("Gateway settings may contain only endpoint and model; never store API keys")
                settings["gateway"] = {k: _text(gateway.get(k, settings["gateway"][k]), k, 2048 if k == "endpoint" else 200) for k in ("endpoint", "model")}
            for key, value in settings.items():
                db.execute("INSERT OR REPLACE INTO settings VALUES (?, ?)", (key, _json(value)))
            return settings

    def add_vocabulary(self, term, translation="", note=""):
        with self._connection(write=True) as db:
            settings = self._settings(db)
            candidate = self._vocabulary([{"term": term, "translation": translation, "note": note}])[0]
            vocabulary = settings["vocabulary"]
            existing = next((item for item in vocabulary if item["term"].strip().casefold() == term.strip().casefold()), None)
            if existing is not None:
                if translation.strip():
                    existing["translation"] = candidate["translation"]
                if note.strip():
                    existing["note"] = candidate["note"]
                result = existing
            else:
                vocabulary = self._vocabulary(vocabulary + [candidate])
                result = vocabulary[-1]
            db.execute("INSERT OR REPLACE INTO settings VALUES ('vocabulary', ?)", (_json(vocabulary),))
            return result

    def remove_vocabulary(self, vocabulary_id):
        with self._connection(write=True) as db:
            vocabulary = self._settings(db)["vocabulary"]
            if not any(item["id"] == vocabulary_id for item in vocabulary):
                raise ValueError("Vocabulary entry not found")
            db.execute("INSERT OR REPLACE INTO settings VALUES ('vocabulary', ?)", (_json([item for item in vocabulary if item["id"] != vocabulary_id]),))

    def list_sessions(self):
        with self._connection() as db:
            return [self._session_dict(db, row, full=False) for row in db.execute("SELECT * FROM sessions ORDER BY created_at DESC, id DESC")]

    def register_session(self, session_id, source, context=""):
        _id(session_id)
        _text(source, "source", 200, required=True)
        _text(context, "context", 4000, multiline=True)
        with self._connection(write=True) as db:
            db.execute("INSERT OR IGNORE INTO sessions (id, source, created_at, status, version, context, speaker_names) VALUES (?, ?, ?, ?, ?, ?, ?)", (session_id, source, _now(), "recording", 1, context, "{}"))
            return self._session_dict(db, self._session(db, session_id))

    def set_session_status(self, session_id, status):
        _text(status, "status", 200, required=True)
        with self._connection(write=True) as db:
            self._session(db, session_id)
            db.execute("UPDATE sessions SET status=? WHERE id=?", (status, session_id))

    def set_session_context(self, session_id, context):
        _text(context, "context", 4000, multiline=True)
        with self._connection(write=True) as db:
            row = self._session(db, session_id)
            if row["context"] != context:
                db.execute("UPDATE sessions SET context=?, version=version+1 WHERE id=?", (context, session_id))
            return self._session_dict(db, self._session(db, session_id))

    def set_attribution_unreliable(self, session_id, value):
        if not isinstance(value, bool):
            raise ValueError("Attribution unreliable must be a boolean")
        with self._connection(write=True) as db:
            row = self._session(db, session_id)
            if bool(row["attribution_unreliable"]) != value:
                db.execute("UPDATE sessions SET attribution_unreliable=?, version=version+1 WHERE id=?", (int(value), session_id))
            return self._session_dict(db, self._session(db, session_id))

    def get_session(self, session_id):
        with self._connection() as db:
            return self._session_dict(db, self._session(db, session_id))

    def _upsert(self, db, session_id, segment):
        self._session(db, session_id)
        if not isinstance(segment, dict):
            raise ValueError("Segment must be an object")
        ident = _segment_id(segment.get("id"))
        row = db.execute("SELECT * FROM segments WHERE session_id=? AND id=?", (session_id, ident)).fetchone()
        if row is None:
            raw = segment.get("raw_text", "")
            text = segment.get("traditional_text", raw)
            if not isinstance(raw, str) or not isinstance(text, str):
                raise ValueError("Segment source must be text")
            db.execute("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (session_id, ident, segment.get("start"), segment.get("end"), segment.get("kind", "audio"), raw, text,
                        segment.get("english", ""), 1, segment.get("status", "complete"), segment.get("speaker") or "unknown", segment.get("error"), 0, None))
            self._bump(db, session_id)
            row = self._segment(db, session_id, ident)
            self._history(db, row)
            return self._segment_dict(row)

        # Inference does not own edited text or translations for user revisions.
        incoming_revision = segment.get("revision", 1)
        incoming_text = segment.get("traditional_text", row["traditional_text"])
        if (row["edited"] and "revision" not in segment) or incoming_revision != row["revision"] or incoming_text != row["traditional_text"]:
            return self._segment_dict(row)
        english = segment.get("english", row["english"])
        status = segment.get("status", row["status"])
        error = segment.get("error", row["error"])
        db.execute("UPDATE segments SET english=?, status=?, error=? WHERE session_id=? AND id=?", (english, status, error, session_id, ident))
        return self._segment_dict(self._segment(db, session_id, ident))

    def upsert_segment(self, session_id, segment):
        with self._connection(write=True) as db:
            return self._upsert(db, session_id, segment)

    def edit_segment(self, session_id, segment_id, text, expected_revision, speaker=None):
        _text(text, "Segment text", 5000, multiline=True)
        if speaker is not None:
            _text(speaker, "speaker", 200, required=True)
        with self._connection(write=True) as db:
            row = self._segment(db, session_id, segment_id)
            if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or expected_revision != row["revision"]:
                raise ValueError(f"Revision conflict: expected {expected_revision}, current {row['revision']}; reload the segment")
            new_speaker = row["speaker"] if speaker is None else speaker
            if text != row["traditional_text"] or new_speaker != row["speaker"]:
                db.execute("UPDATE segments SET traditional_text=?, speaker=?, english='', error=NULL, status='pending', revision=revision+1, edited=1 WHERE session_id=? AND id=?", (text, new_speaker, session_id, segment_id))
                self._bump(db, session_id)
                row = self._segment(db, session_id, segment_id)
                self._history(db, row)
            return self._segment_dict(row)

    def segment_history(self, session_id, segment_id):
        with self._connection() as db:
            self._segment(db, session_id, segment_id)
            return [dict(json.loads(r["data"]), created_at=r["created_at"]) for r in db.execute("SELECT * FROM segment_history WHERE session_id=? AND segment_id=? ORDER BY revision", (session_id, segment_id))]

    def update_translation(self, session_id, segment_id, revision, english, error=None):
        if not isinstance(english, str) or (error is not None and not isinstance(error, str)):
            raise ValueError("Translation and error must be strings")
        with self._connection(write=True) as db:
            row = self._segment(db, session_id, segment_id)
            if isinstance(revision, bool) or not isinstance(revision, int) or revision != row["revision"]:
                raise ValueError(f"Revision conflict: translation targets {revision}, current {row['revision']}; retranslate current text")
            db.execute("UPDATE segments SET english=?, error=?, status=? WHERE session_id=? AND id=?", (english, error, "error" if error else "complete", session_id, segment_id))
            return self._segment_dict(self._segment(db, session_id, segment_id))

    def set_speaker_names(self, session_id, names):
        if not isinstance(names, dict):
            raise ValueError("Speaker names must be an object")
        for key, value in names.items():
            _text(key, "speaker label", 200, required=True)
            _text(value, "speaker name", 200)
        with self._connection(write=True) as db:
            row = self._session(db, session_id)
            if json.loads(row["speaker_names"]) != names:
                db.execute("UPDATE sessions SET speaker_names=?, version=version+1 WHERE id=?", (_json(names), session_id))
            return self._session_dict(db, self._session(db, session_id))

    def assign_speakers(self, session_id, assignments):
        if not isinstance(assignments, list):
            raise ValueError("Speaker assignments must be a list")
        with self._connection(write=True) as db:
            self._session(db, session_id)
            seen, changed = set(), False
            for item in assignments:
                if not isinstance(item, dict):
                    raise ValueError("Speaker assignment must be an object")
                ident = _segment_id(item.get("id"))
                if ident in seen:
                    raise ValueError("Duplicate speaker assignment")
                seen.add(ident)
                speaker = _text(item.get("speaker"), "speaker", 200, required=True)
                row = self._segment(db, session_id, ident)
                # Store optional metadata without allowing it to overwrite record fields.
                metadata = {k: v for k, v in item.items() if k not in {"id", "speaker"}}
                if set(metadata) & {"start", "end", "kind", "raw_text", "traditional_text", "english", "revision", "status", "error", "session_id", "edited"}:
                    raise ValueError("Invalid speaker assignment metadata")
                encoded = _json(metadata) if metadata else None
                if speaker != row["speaker"] or encoded != row["ambiguity"]:
                    db.execute("UPDATE segments SET speaker=?, ambiguity=?, revision=revision+1, edited=1 WHERE session_id=? AND id=?", (speaker, encoded, session_id, ident))
                    self._history(db, self._segment(db, session_id, ident))
                    changed = True
            if changed:
                self._bump(db, session_id)
            return self._session_dict(db, self._session(db, session_id))

    def add_artifact(self, session_id, kind, source_version, data, status="ready"):
        _text(kind, "artifact kind", 200, required=True)
        _text(status, "artifact status", 200, required=True)
        if isinstance(source_version, bool) or not isinstance(source_version, int) or source_version < 1:
            raise ValueError("Artifact source version must be a positive integer")
        with self._connection(write=True) as db:
            session = self._session(db, session_id)
            if source_version > session["version"]:
                raise ValueError("Artifact source version is newer than the session")
            ident = str(uuid.uuid4())
            db.execute("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)", (ident, session_id, kind, source_version, status, _json(data), _now()))
            return self._artifact_dict(db.execute("SELECT * FROM artifacts WHERE id=?", (ident,)).fetchone(), session["version"])

    def get_artifact(self, session_id, artifact_id):
        with self._connection() as db:
            session = self._session(db, session_id)
            row = db.execute("SELECT * FROM artifacts WHERE session_id=? AND id=?", (session_id, artifact_id)).fetchone()
            if row is None:
                raise ValueError("Artifact not found")
            return self._artifact_dict(row, session["version"])

    def register_export(self, session_id, path):
        """Track an app-created direct child of data_dir/exports for deletion."""
        path = Path(os.path.abspath(path))
        directory = self.data_dir / "exports"
        if path.parent != directory or path.name in ("", ".", ".."):
            raise ValueError("Export must be a direct child of the app exports directory")
        _no_symlinks(path)
        if not path.is_file():
            raise ValueError("Export must be an existing regular file")
        with self._connection(write=True) as db:
            self._session(db, session_id)
            existing = db.execute("SELECT session_id FROM exports WHERE filename=?", (path.name,)).fetchone()
            if existing is not None and existing["session_id"] != session_id:
                raise ValueError("Export is already tracked by another session")
            db.execute("INSERT OR IGNORE INTO exports VALUES (?, ?)", (session_id, path.name))

    def _trash_root(self):
        root = self.data_dir / ".trash"
        _no_symlinks(root)
        root.mkdir(mode=0o700, exist_ok=True)
        if not root.is_dir():
            raise ValueError("Deletion quarantine is not a directory")
        os.chmod(root, 0o700)
        _fsync_dir(self.data_dir)
        return root

    @staticmethod
    def _export_name(name):
        if (not isinstance(name, str) or not name or name in (".", "..") or
                "/" in name or "\x00" in name or len(os.fsencode(name)) > 255):
            raise ValueError("Invalid tracked export filename")
        return name

    def _manifest(self, quarantine):
        path = quarantine / "manifest.json"
        _no_symlinks(path)
        if not path.is_file():
            raise ValueError("Deletion manifest must be a regular file")
        with path.open(encoding="utf-8") as source:
            manifest = json.load(source)
        if not isinstance(manifest, dict) or set(manifest) != {"session_id", "session_present", "exports"}:
            raise ValueError("Invalid deletion manifest")
        _id(manifest["session_id"])
        if not isinstance(manifest["session_present"], bool) or not isinstance(manifest["exports"], list):
            raise ValueError("Invalid deletion manifest")
        seen = set()
        for entry in manifest["exports"]:
            if not isinstance(entry, dict) or set(entry) != {"name", "present"} or not isinstance(entry["present"], bool):
                raise ValueError("Invalid deletion manifest")
            name = self._export_name(entry["name"])
            if name in seen:
                raise ValueError("Duplicate tracked export")
            seen.add(name)
        return manifest

    def _move_durable(self, source, destination):
        _no_symlinks(source)
        _no_symlinks(destination)
        if os.path.lexists(destination):
            raise ValueError("Deletion recovery destination already exists")
        os.rename(source, destination)
        _fsync_dir(source.parent)
        if source.parent != destination.parent:
            _fsync_dir(destination.parent)

    def _restore_quarantine(self, quarantine, manifest):
        """Restore only the paths in a validated manifest; never overwrite."""
        session = self.data_dir / "sessions" / _id(manifest["session_id"])
        exports = self.data_dir / "exports"
        staged_exports = quarantine / "exports"
        items = [(quarantine / "session", session, manifest["session_present"], True)]
        items += [(staged_exports / str(index), exports / self._export_name(entry["name"]), entry["present"], False)
                  for index, entry in enumerate(manifest["exports"])]
        for staged, original, was_present, is_session in items:
            _no_symlinks(staged)
            _no_symlinks(original)
            if os.path.lexists(staged):
                if not was_present or os.path.lexists(original):
                    raise ValueError("Deletion recovery found conflicting paths")
            elif was_present and not os.path.lexists(original):
                raise ValueError("Deletion recovery cannot locate a staged file")
            if was_present:
                found = staged if os.path.lexists(staged) else original
                if is_session:
                    _safe_tree(found)
                elif not found.is_file():
                    raise ValueError("Tracked export is not a regular file")
        for staged, original, _, _ in items:
            if os.path.lexists(staged):
                self._move_durable(staged, original)

    def _purge_quarantine(self, quarantine):
        _safe_tree(quarantine)
        shutil.rmtree(quarantine)
        _fsync_dir(quarantine.parent)

    def _recover_deletions(self):
        root = self.data_dir / ".trash"
        _no_symlinks(root)
        if not root.exists():
            return
        if not root.is_dir():
            raise ValueError("Deletion quarantine is not a directory")
        # Serialize against deletions even when Library instances share a DB.
        with self._connection(write=True) as db:
            for quarantine in sorted(root.iterdir()):
                if not re.fullmatch(r"[0-9a-f]{32}", quarantine.name) or quarantine.is_symlink() or not quarantine.is_dir():
                    raise ValueError("Unsafe deletion quarantine entry; inspect .trash without removing it")
                _no_symlinks(quarantine)
                committed = db.execute("SELECT 1 FROM deletion_commits WHERE id=?", (quarantine.name,)).fetchone() is not None
                try:
                    if committed:
                        self._purge_quarantine(quarantine)
                        db.execute("DELETE FROM deletion_commits WHERE id=?", (quarantine.name,))
                    elif (quarantine / "manifest.json").exists():
                        _safe_tree(quarantine)
                        self._restore_quarantine(quarantine, self._manifest(quarantine))
                        self._purge_quarantine(quarantine)
                    else:
                        # A crash while preparing the manifest occurs before any
                        # evidence is moved. Refuse unexplained staged content.
                        if any(p.name not in {"manifest.tmp", "exports"} for p in quarantine.iterdir()):
                            raise ValueError("Missing deletion manifest")
                        staged = quarantine / "exports"
                        if staged.exists() and (not staged.is_dir() or any(staged.iterdir())):
                            raise ValueError("Missing deletion manifest with staged files")
                        self._purge_quarantine(quarantine)
                except (OSError, ValueError, UnicodeError) as exc:
                    raise OSError(f"Deletion recovery needs attention in quarantine {quarantine.name}; data has been retained") from exc

    def delete_session(self, session_id):
        _id(session_id)
        directory = self.data_dir / "sessions" / session_id
        _no_symlinks(directory)
        if directory.parent != self.data_dir / "sessions" or directory.resolve().parent != (self.data_dir / "sessions").resolve():
            raise ValueError("Invalid session path")
        quarantine = None
        manifest = None
        token = uuid.uuid4().hex
        try:
            with self._connection(write=True) as db:
                # Do not compound an incomplete deletion of this same ID.
                trash = self.data_dir / ".trash"
                _no_symlinks(trash)
                if trash.exists():
                    for pending in trash.iterdir():
                        if not re.fullmatch(r"[0-9a-f]{32}", pending.name) or pending.is_symlink() or not pending.is_dir():
                            raise ValueError("Unsafe deletion quarantine entry; inspect .trash")
                        if not (pending / "manifest.json").is_file():
                            raise ValueError("Incomplete deletion quarantine; restart to recover")
                        if self._manifest(pending)["session_id"] == session_id:
                            raise ValueError("Session has a pending deletion; restart to recover it")
                self._session(db, session_id)
                names = [self._export_name(row["filename"]) for row in db.execute("SELECT filename FROM exports WHERE session_id=? ORDER BY filename", (session_id,))]
                exports = [self.data_dir / "exports" / name for name in names]
                _no_symlinks(directory)
                if directory.exists():
                    _safe_tree(directory)
                for path in exports:
                    _no_symlinks(path)
                    if path.exists() and not path.is_file():
                        raise ValueError("Tracked export is not a regular file")
                manifest = {"session_id": session_id, "session_present": directory.exists(),
                            "exports": [{"name": name, "present": path.exists()} for name, path in zip(names, exports)]}
                root = self._trash_root()
                quarantine = root / token
                quarantine.mkdir(mode=0o700)
                _fsync_dir(root)
                staged_exports = quarantine / "exports"
                staged_exports.mkdir(mode=0o700)
                _fsync_dir(staged_exports)
                manifest_tmp = quarantine / "manifest.tmp"
                fd = os.open(manifest_tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as output:
                    output.write(_json(manifest))
                    output.flush()
                    os.fsync(output.fileno())
                os.rename(manifest_tmp, quarantine / "manifest.json")
                _fsync_dir(quarantine)
                if manifest["session_present"]:
                    self._move_durable(directory, quarantine / "session")
                for index, (path, entry) in enumerate(zip(exports, manifest["exports"])):
                    if entry["present"]:
                        self._move_durable(path, staged_exports / str(index))
                db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
                db.execute("INSERT INTO deletion_commits (id) VALUES (?)", (token,))
        except BaseException:
            if quarantine is not None:
                try:
                    # If commit raised after actually succeeding, purge only on
                    # the next recovery pass; never restore committed data.
                    with self._connection(write=True) as db:
                        committed = db.execute("SELECT 1 FROM deletion_commits WHERE id=?", (token,)).fetchone() is not None
                        if not committed:
                            if quarantine.exists():
                                if (quarantine / "manifest.json").exists():
                                    self._restore_quarantine(quarantine, self._manifest(quarantine))
                                self._purge_quarantine(quarantine)
                            elif manifest and (manifest["session_present"] and not directory.exists() or any(entry["present"] and not path.exists() for entry, path in zip(manifest["exports"], exports))):
                                raise ValueError("Missing quarantine and original evidence")
                except BaseException as recovery_error:
                    raise OSError(f"Deletion could not be restored; retain quarantine {token} and restart or recover it manually") from recovery_error
            raise
        try:
            with self._connection(write=True) as db:
                if quarantine.exists():
                    self._purge_quarantine(quarantine)
                db.execute("DELETE FROM deletion_commits WHERE id=?", (token,))
        except (OSError, ValueError, sqlite3.Error) as exc:
            raise OSError(f"Session deletion committed; quarantine {token} cleanup remains pending") from exc

    def import_legacy(self):
        """Import each complete legacy journal atomically, without inference.

        ``import_warnings`` contains only safe session IDs for journals skipped on
        the most recent call. No journal content or exception text is exposed.
        """
        self.import_warnings = []
        directory = self.data_dir / "sessions"
        _no_symlinks(directory)
        if not directory.is_dir():
            return []
        imported = []
        for session_path in sorted(directory.iterdir()):
            if session_path.is_symlink() or not session_path.is_dir():
                continue
            try:
                session_id = _id(session_path.name)
            except ValueError:
                continue
            journal = session_path / "events.jsonl"
            try:
                _no_symlinks(journal)
                if not journal.is_file():
                    continue
                if self._import_legacy_journal(session_id, journal):
                    imported.append(session_id)
            except (OSError, UnicodeError, ValueError, TypeError, OverflowError,
                    sqlite3.IntegrityError, sqlite3.DataError, sqlite3.InterfaceError,
                    sqlite3.ProgrammingError):
                self.import_warnings.append(session_id)
        return imported

    def _import_legacy_journal(self, session_id, journal):
        with journal.open(encoding="utf-8") as stream:
            lines = stream.readlines()
        if lines and not lines[-1].endswith("\n"):
            raise ValueError("Incomplete legacy journal")
        with self._connection(write=True) as db:
            record = db.execute("SELECT lines, legacy_owned FROM imports WHERE session_id=?", (session_id,)).fetchone()
            offset = record["lines"] if record else 0
            if offset > len(lines):
                raise ValueError("Legacy journal was truncated")
            events = []
            for line in lines[offset:]:
                event = json.loads(line)
                if not isinstance(event, dict):
                    raise ValueError("Invalid legacy journal event")
                events.append(event)
            existing = db.execute("SELECT id FROM sessions WHERE id=?", (session_id,)).fetchone()
            # Only legacy-owned sessions can be marked interrupted. A newly
            # registered live session may coexist with a journal being written.
            legacy_owned = bool(record["legacy_owned"]) if record else existing is None
            if events:
                started = next((event for event in events if event.get("type") == "session_started"), {})
                db.execute("INSERT OR IGNORE INTO sessions (id, source, created_at, status, version, context, speaker_names) VALUES (?, ?, ?, ?, ?, ?, ?)",
                           (session_id, started.get("source", "unknown"), started.get("at", _now()), "recording", 1, "", "{}"))
                for event in events:
                    if event.get("type") in ("source_segment", "segment"):
                        self._upsert(db, session_id, event)
                    elif event.get("type") == "session_finished":
                        db.execute("UPDATE sessions SET status=? WHERE id=?", (event.get("status", "complete"), session_id))
                db.execute("INSERT OR REPLACE INTO imports VALUES (?, ?, ?)", (session_id, len(lines), int(legacy_owned)))
            if legacy_owned:
                db.execute("UPDATE sessions SET status='interrupted' WHERE id=? AND status='recording'", (session_id,))
            return bool(events)
