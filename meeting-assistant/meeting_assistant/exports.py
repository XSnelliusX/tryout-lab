"""Private, local exports of a supplied session snapshot; no model calls."""

import html
import json
import os
import re
import uuid
from pathlib import Path


_SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z")
_PRIVATE_KEYS = {"settings", "gateway", "api_key", "apikey", "authorization", "access_token", "secret", "password"}


def _clean(value):
    """Remove settings and credential fields, including nested ones."""
    if isinstance(value, dict):
        return {key: _clean(item) for key, item in value.items()
                if str(key).lower().replace("-", "_") not in _PRIVATE_KEYS}
    if isinstance(value, list):
        return [_clean(item) for item in value]
    return value


def _snapshot(session):
    # A session is not a settings object. Restrict the top level to session
    # records, while retaining fields on segments/artifacts such as revisions.
    fields = ("id", "source", "created_at", "status", "version", "context", "attribution_unreliable",
              "segments", "speaker_names", "artifacts", "history")
    result = _clean({key: session[key] for key in fields if key in session})
    for artifact in result.get("artifacts", []):
        artifact["stale"] = _stale(artifact, session)
    return result


def _stale(artifact, session):
    # A missing version is not evidence that a derivative is current.
    return (artifact.get("stale") is True or session.get("version") is None
            or artifact.get("source_version") != session.get("version"))


def _md(value):
    text = html.escape(str(value if value is not None else ""), quote=False)
    return re.sub(r"([\\`*_{}\[\]()#+.!|>~-])", r"\\\1", text).replace("\n", "  \n")


def _time(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return "unknown"
    return f"{value:g}s"


def _speaker(segment, names):
    cluster = segment.get("speaker") or "unknown"
    if cluster == "unknown":
        return "unknown"
    name = names.get(cluster)
    return f"{name} ({cluster})" if isinstance(name, str) and name.strip() else str(cluster)


def _markdown(session):
    names = session.get("speaker_names") or {}
    lines = ["# Meeting transcript", "", f"Session: {_md(session.get('id'))}",
             f"Version: {_md(session.get('version'))}", "",
              "Times are coarse, not word-level alignment.", "", "## Transcript", ""]
    if session.get("attribution_unreliable"):
        lines += ["**Speaker attribution is flagged unreliable. Do not treat names or per-person notes as verified.**", ""]
    for segment in session.get("segments", []):
        lines += [f"### Segment {_md(segment.get('id'))} · {_time(segment.get('start'))}–{_time(segment.get('end'))}",
                  "", f"Speaker: {_md(_speaker(segment, names))}",
                  f"Revision: {_md(segment.get('revision'))}", "",
                  f"Traditional Chinese: {_md(segment.get('traditional_text', ''))}", "",
                  f"English: {_md(segment.get('english', ''))}", ""]
        if segment.get("edited") or segment.get("raw_text", "") != segment.get("traditional_text", ""):
            lines += [f"Original ASR: {_md(segment.get('raw_text', ''))}", ""]
    lines += ["## Artifacts", "", "Artifacts are generated derivatives, not automatically reviewed or approved.", ""]
    for artifact in session.get("artifacts", []):
        stale = _stale(artifact, session)
        lines += [f"### {'STALE — not current' if stale else 'Current source version'}: {_md(artifact.get('kind', 'artifact'))}",
                  "", f"ID: {_md(artifact.get('id'))} · Status: {_md(artifact.get('status'))} · Source version: {_md(artifact.get('source_version'))}", ""]
        # Escaped JSON keeps arbitrary proposed content readable, without letting
        # model-supplied Markdown/HTML alter the document structure.
        lines += [f"Data: {_md(json.dumps(_clean(artifact.get('data')), ensure_ascii=False, indent=2))}", ""]
    return "\n".join(lines) + "\n"


def _field(value):
    if value is None:
        value = ""
    elif isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch if ch in "\n\t" or ord(ch) >= 32 and ord(ch) != 127 else " " for ch in text)
    text = text.replace("\t", " ").replace("\n", " ")
    # TSV may also be opened in a spreadsheet. Avoid formula evaluation even
    # after leading whitespace; the apostrophe is deliberately visible in Anki.
    if text.lstrip().startswith(("=", "+", "-", "@")):
        text = "'" + text
    return html.escape(text, quote=True)


def _anki(session):
    rows = []
    segments = {segment.get("id"): segment for segment in session.get("segments", [])}
    for artifact in session.get("artifacts", []):
        if artifact.get("kind") != "learning" or _stale(artifact, session):
            continue
        if artifact.get("status") not in ("ready", "review-needed", "review_needed"):
            continue
        data = artifact.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            continue
        for item in data["items"]:
            if not isinstance(item, dict):
                continue
            term = item.get("traditional") or item.get("term")
            if not isinstance(term, str) or not term.strip():
                continue
            validation = item.get("validation") or item.get("validation_status") or "review-needed (not validated)"
            sources = item.get("segment_ids", item.get("source_ids", item.get("segment_id", "")))
            segment = segments.get(item.get("segment_id"), {}) if isinstance(item.get("segment_id"), (int, str)) else {}
            source = f"Segment(s): {sources}; time: {_time(item.get('start', segment.get('start')))}–{_time(item.get('end', segment.get('end')))} (coarse)"
            provenance = item.get("dictionary_provenance", "not supplied")
            values = [term, item.get("pinyin", ""), item.get("contextual_meaning", item.get("meaning", "")),
                      item.get("quote", ""), source,
                      f"{validation}; dictionary: {provenance}; artifact status: {artifact.get('status')}; not automatically reviewed"]
            rows.append("\t".join(_field(value) for value in values))
    if not rows:
        raise ValueError("No non-stale learning items ready for export")
    return "\n".join(rows) + "\n"


def _open_directory(parent_fd, name):
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)


def export_session(session: dict, data_dir: Path, format: str) -> Path:
    """Save a unique owner-only export under sessions/<id>/exports."""
    if not isinstance(session, dict) or not isinstance(session.get("id"), str) or not _SESSION_ID.fullmatch(session["id"]):
        raise ValueError("Invalid session id; use a single safe directory name")
    if format not in ("markdown", "json", "anki"):
        raise ValueError("Unsupported export format")
    snapshot = _snapshot(session)
    if format == "json":
        content = json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"
    elif format == "markdown":
        content = _markdown(snapshot)
    else:
        content = _anki(snapshot)

    root = Path(os.path.abspath(data_dir))
    # Match the library's policy of rejecting symlink components.
    if any(path.is_symlink() for path in (root, *root.parents)):
        raise ValueError("Symlinks are not allowed in app-owned paths")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    fds = []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fds.append(fd)
        for name in ("sessions", session["id"], "exports"):
            fd = _open_directory(fd, name)
            fds.append(fd)
        extension = {"markdown": "md", "json": "json", "anki": "tsv"}[format]
        while True:
            filename = f"{format}-{uuid.uuid4().hex}.{extension}"
            try:
                file_fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                break
            except FileExistsError:
                continue
        try:
            with os.fdopen(file_fd, "w", encoding="utf-8", newline="") as output:
                output.write(content)
        except BaseException:
            os.unlink(filename, dir_fd=fd)
            raise
    finally:
        for fd in reversed(fds):
            os.close(fd)
    return root / "sessions" / session["id"] / "exports" / filename
