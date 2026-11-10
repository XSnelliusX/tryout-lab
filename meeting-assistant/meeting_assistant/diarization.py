"""Local, review-only speaker activity from the pinned NeMo-Speech.cpp V3 CLI."""

import hashlib
import functools
import json
import math
import os
import re
import signal
import subprocess
import tempfile
import time
import wave
from pathlib import Path

MODEL_REVISION = "f667ed73aee57d40cc39428eb768b4fd87a0a29e"
MODEL_SHA256 = "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1"
MODEL_SIZE = 107012128
RUNTIME_VERSION = "0.3.0"
MAX_AUDIO_SECONDS = 12 * 60 * 60
TIMEOUT_SECONDS = 6 * 60 * 60
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
_SPEAKER = re.compile(r"speaker_[1-8]\Z")


class DiarizationCancelled(Exception):
    """A cancelled run has no usable partial result."""


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _fingerprint(path):
    stat = path.stat()
    return (str(path.resolve()), stat.st_dev, stat.st_ino, stat.st_mode, stat.st_uid,
            stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


@functools.lru_cache(maxsize=32)
def _cached_digest(fingerprint):
    path = Path(fingerprint[0])
    result = _sha256(path)
    if _fingerprint(path) != fingerprint:
        raise ValueError("Diarization asset changed during verification.")
    return result


def _verified_digest(path, force=False):
    fingerprint = _fingerprint(path)
    if not force:
        return _cached_digest(fingerprint)
    digest = _sha256(path)
    if _fingerprint(path) != fingerprint:
        raise ValueError("Diarization asset changed during verification.")
    return digest


def _config(data_dir):
    path = Path(data_dir) / "diarization" / "config.json"
    if not path.is_file() or path.is_symlink():
        raise ValueError("Diarization is not configured; run scripts/setup_diarization.py.")
    if path.stat().st_mode & 0o077:
        raise ValueError("Diarization config must be private (mode 600).")
    if path.stat().st_size > 16384:
        raise ValueError("Diarization config is too large.")
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError):
        raise ValueError("Diarization config is invalid JSON.") from None
    if not isinstance(config, dict):
        raise ValueError("Diarization config must be an object.")
    if config.get("runtime_version") != RUNTIME_VERSION or config.get("model_revision") != MODEL_REVISION:
        raise ValueError("Diarization configuration does not select the pinned runtime and V3 model.")
    if config.get("device") not in ("metal", "cpu"):
        raise ValueError("Diarization device must be metal or cpu.")
    for field in ("executable", "model"):
        value = config.get(field)
        if not isinstance(value, str) or not value or not Path(value).is_absolute():
            raise ValueError("Diarization executable and model must be absolute local paths.")
    if not isinstance(config.get("executable_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", config["executable_sha256"]):
        raise ValueError("Diarization executable checksum is missing or invalid.")
    return config


def capabilities(data_dir) -> dict:
    """Check configured files and their hashes; do not load models or use network."""
    return _capabilities(data_dir, force=False)


def _capabilities(data_dir, *, force):
    result = {"ready": False, "reason": "", "executable": None, "model": None,
              "device": None, "model_revision": MODEL_REVISION, "max_speakers": 8,
              "runtime_version": RUNTIME_VERSION}
    try:
        config = _config(data_dir)
        result.update({key: config[key] for key in ("executable", "model", "device")})
        executable, model = Path(config["executable"]), Path(config["model"])
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValueError("Configured NeMo-Speech.cpp executable is missing or not executable.")
        if _verified_digest(executable, force=force) != config["executable_sha256"]:
            raise ValueError("Configured executable checksum does not match the config.")
        if not model.is_file() or model.stat().st_size != MODEL_SIZE:
            raise ValueError("Pinned V3 model is missing or has the wrong size.")
        if _verified_digest(model, force=force) != MODEL_SHA256:
            raise ValueError("Pinned V3 model checksum does not match.")
        result.update(ready=True, reason="Configured assets verified; inference and hardware have not been tested.")
    except (OSError, ValueError) as exc:
        result["reason"] = str(exc) if isinstance(exc, ValueError) else "Cannot read diarization configuration or assets."
    return result


def _audio_path(session_path, data_dir):
    sessions = (Path(data_dir) / "sessions").resolve()
    path = Path(session_path)
    # Only a single app-owned session directory; do not follow a directory or audio symlink.
    if path.is_symlink() or path.resolve().parent != sessions or not path.is_dir():
        raise ValueError("Session must be an app-owned directory under data_dir/sessions.")
    audio = path / "audio.wav"
    if audio.is_symlink() or not audio.is_file():
        raise ValueError("Session audio.wav is missing or is not a regular local file.")
    try:
        with wave.open(str(audio), "rb") as stream:
            if (stream.getnchannels(), stream.getsampwidth(), stream.getframerate(), stream.getcomptype()) != (1, 2, 16000, "NONE"):
                raise ValueError("Session audio must be mono 16-bit PCM at 16 kHz.")
            frames = stream.getnframes()
            if not frames or frames > MAX_AUDIO_SECONDS * 16000:
                raise ValueError("Session audio is empty or exceeds the 12-hour limit.")
            # An incomplete archive must not be silently treated as complete.
            remaining = frames
            while remaining:
                count = min(remaining, 16000 * 60)
                if len(stream.readframes(count)) != count * 2:
                    raise ValueError("Session audio is truncated.")
                remaining -= count
    except (wave.Error, EOFError):
        raise ValueError("Session audio is not a valid WAV file.") from None
    return audio.resolve(), frames / 16000


def _stop(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def _read_result(path, duration):
    if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_OUTPUT_BYTES:
        raise ValueError("Diarization output is missing or too large.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        rows = data["segments"]
        if not isinstance(rows, list):
            raise ValueError
        timeline = []
        for row in rows:
            start, end, speaker = row["start"], row["end"], row["speaker"]
            if (isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, (int, float))
                    or not isinstance(end, (int, float)) or not math.isfinite(start) or not math.isfinite(end)
                    or start < 0 or start >= duration or end <= start or end > duration + 0.1
                    or type(speaker) is not int or not 1 <= speaker <= 8):
                raise ValueError
            timeline.append({"start": start, "end": min(end, duration), "speaker": f"speaker_{speaker}"})
        return sorted(timeline, key=lambda row: (row["start"], row["end"], row["speaker"]))
    except (OSError, ValueError, KeyError, TypeError, UnicodeError):
        raise ValueError("Diarization returned invalid speaker activity.") from None


def diarize_session(session_path, *, data_dir, progress=None, cancelled=None) -> dict:
    """Run one stateful chunked pass, with no implicit model download or archive edits."""
    if progress is not None and not callable(progress):
        raise TypeError("progress must be callable")
    if cancelled is not None and not callable(cancelled):
        raise TypeError("cancelled must be callable")
    if cancelled and cancelled():
        raise DiarizationCancelled("Diarization cancelled")
    status = _capabilities(data_dir, force=True)
    if not status["ready"]:
        raise RuntimeError(status["reason"])
    audio, duration = _audio_path(session_path, data_dir)
    if cancelled and cancelled():
        raise DiarizationCancelled("Diarization cancelled")
    if progress:
        progress({"stage": "diarize", "status": "running", "total_seconds": duration})
    # No inherited NeMo overrides or downloader PATH; explicit existing local model.
    env = {"PATH": "", "HOME": str(Path(data_dir).resolve()), "NO_COLOR": "1"}
    with tempfile.TemporaryDirectory(prefix="diarize-", dir=Path(data_dir) / "diarization") as temp:
        output = Path(temp) / "result.json"
        args = [status["executable"], "diarize", str(audio), "--model", status["model"],
                "--device", status["device"], "--preset", "v3-offline", "--format", "json", "--output", str(output)]
        try:
            process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, cwd=temp, env=env, start_new_session=True)
        except OSError:
            raise RuntimeError("Could not start the local diarization backend.") from None
        deadline = time.monotonic() + TIMEOUT_SECONDS
        try:
            while process.poll() is None:
                if cancelled and cancelled():
                    raise DiarizationCancelled("Diarization cancelled")
                if time.monotonic() >= deadline:
                    raise TimeoutError("Diarization exceeded its time limit.")
                for candidate in (output, Path(str(output) + ".tmp")):
                    if candidate.exists() and candidate.stat().st_size > MAX_OUTPUT_BYTES:
                        raise ValueError("Diarization output is too large.")
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
            if cancelled and cancelled():
                raise DiarizationCancelled("Diarization cancelled")
            if process.returncode:
                raise RuntimeError("Local diarization backend failed; verify the installed runtime and device.")
            timeline = _read_result(output, duration)
        finally:
            _stop(process)
    if progress:
        progress({"stage": "diarize", "status": "complete", "total_seconds": duration})
    return {"timeline": timeline, "provenance": {"backend": "NeMo-Speech.cpp", "runtime_version": RUNTIME_VERSION,
            "model": "nvidia/Nemotron-3-Diarization", "model_revision": MODEL_REVISION,
            "model_sha256": MODEL_SHA256, "device": status["device"], "preset": "v3-offline",
            "mode": "stateful_chunked", "audio_seconds": duration},
            "limitations": ["Anonymous clusters are not verified identities.",
                            "At most eight distinct voices per session; overflow cannot be detected reliably and must be flagged by the user.",
                            "Accuracy and two-hour performance on this Mac have not been validated."]}


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def assign_segments(segments, timeline) -> list[dict]:
    """Assign only single-cluster windows with >=80% coverage, preserving uncertainty."""
    if not isinstance(segments, list) or not isinstance(timeline, list):
        raise ValueError("Segments and timeline must be lists.")
    intervals = []
    for row in timeline:
        if (not isinstance(row, dict) or not _number(row.get("start")) or not _number(row.get("end"))
                or row["start"] < 0 or row["end"] <= row["start"] or not isinstance(row.get("speaker"), str)
                or not _SPEAKER.fullmatch(row["speaker"])):
            raise ValueError("Timeline contains invalid anonymous speaker activity.")
        intervals.append((row["start"], row["end"], row["speaker"]))
    assignments = []
    for segment in segments:
        if not isinstance(segment, dict) or "id" not in segment:
            raise ValueError("Each segment needs an id.")
        start, end = segment.get("start"), segment.get("end")
        if not _number(start) or not _number(end) or start < 0 or end <= start:
            assignments.append({"id": segment["id"], "speaker": "unknown", "ambiguous": True,
                                "speaker_candidates": [], "reason": "missing_or_invalid_timing"})
            continue
        overlaps = {}
        for left, right, speaker in intervals:
            a, b = max(start, left), min(end, right)
            if b > a:
                overlaps.setdefault(speaker, []).append((a, b))
        ratios = {}
        for speaker, spans in overlaps.items():
            spans.sort()
            left, right = spans[0]
            total = 0.0
            for a, b in spans[1:]:
                if a <= right:
                    right = max(right, b)
                else:
                    total += right - left
                    left, right = a, b
            ratios[speaker] = round((total + right - left) / (end - start), 6)
        candidates = sorted(ratios)
        clear = len(candidates) == 1 and ratios[candidates[0]] >= 0.8
        assignments.append({"id": segment["id"], "speaker": candidates[0] if clear else "unknown",
                            "ambiguous": not clear, "speaker_candidates": candidates,
                            "overlap_ratios": ratios,
                            "reason": "single_speaker_coverage" if clear else
                                      "multiple_speakers" if len(candidates) > 1 else "insufficient_coverage"})
    return assignments
