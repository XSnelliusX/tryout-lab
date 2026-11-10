"""Read-only, local re-recognition of an archived recording as proposals."""

from pathlib import Path
import unicodedata
import wave

import numpy as np

from .audio import RATE, THRESHOLD

_FRAME = RATE // 10
_WINDOW = 24 * RATE
_OVERLAP = 3 * RATE // 2
_PRE_ROLL = RATE // 5
_SILENCE_FRAMES = 6
_PAUSE_SEARCH = 6 * RATE
_MAX_FRAMES = 12 * 60 * 60 * RATE


class RefinementCancelled(Exception):
    """A refinement was cancelled; no partial proposal should be applied."""


def _check_cancel(cancelled):
    if cancelled is not None and cancelled():
        raise RefinementCancelled("Refinement cancelled")


def _read_samples(audio, start, count):
    audio.setpos(start)
    data = audio.readframes(count)
    if len(data) != count * 2:
        raise ValueError("audio.wav is truncated before its declared frame count")
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def _voiced_frames(samples):
    # Energy is a cheap speech candidate detector, not a speech classifier.
    return [float(np.sqrt(np.mean(np.square(samples[i:i + _FRAME], dtype=np.float64)))) >= THRESHOLD
            for i in range(0, len(samples), _FRAME)]


def _cut_at_pause(voiced, length):
    """Find the latest 600ms quiet stretch in the last six seconds."""
    run = 0
    candidate = None
    for i, active in enumerate(voiced):
        run = 0 if active else run + 1
        boundary = min((i + 1) * _FRAME, length)
        if run >= _SILENCE_FRAMES and boundary >= length - _PAUSE_SEARCH:
            candidate = boundary
    return candidate


def _normalized(text):
    # Only compare complete text for an overlap warning, never fuzzy-correct it.
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def refine_session(session_path: Path, models, *, context="", vocabulary=None,
                   progress=None, cancelled=None) -> dict:
    """Replay audio into independent, reviewable windows, never editing the archive.

    ``progress`` receives a dict. Cancellation is cooperative between operations;
    an in-flight model invocation cannot be interrupted by this function.
    """
    if progress is not None and not callable(progress):
        raise TypeError("progress must be callable")
    if cancelled is not None and not callable(cancelled):
        raise TypeError("cancelled must be callable")
    # Validate even an entirely silent archive, before touching any model.
    from .inference import _hints
    _hints(context, vocabulary)
    _check_cancel(cancelled)
    proposals = []
    skipped = 0
    with wave.open(str(Path(session_path) / "audio.wav"), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, RATE, "NONE"):
            raise ValueError("audio.wav must be uncompressed mono 16-bit PCM at 16 kHz")
        total = audio.getnframes()
        if total > _MAX_FRAMES:
            raise ValueError("audio.wav exceeds the 12-hour refinement limit")
        cursor = 0
        covered_until = 0

        def report(position):
            if progress is not None:
                progress({"stage": "refine", "processed_seconds": position / RATE,
                          "total_seconds": total / RATE,
                          "percent": round(100 * position / total, 1) if total else 100.0})

        report(0)
        while cursor < total:
            _check_cancel(cancelled)
            probe = _read_samples(audio, cursor, min(_WINDOW, total - cursor))
            active = _voiced_frames(probe)
            # Overlap alone is not new speech; do not repeatedly transcribe it.
            novel_frame = (max(0, covered_until - cursor) + _FRAME - 1) // _FRAME
            if not any(active[novel_frame:]):
                cursor += len(probe)
                skipped += 1
                report(cursor)
                continue
            first = novel_frame + next(i for i, value in enumerate(active[novel_frame:]) if value)
            first_position = cursor + first * _FRAME
            if cursor < covered_until and first_position <= covered_until + RATE // 2:
                start = cursor
            else:
                start = max(cursor, first_position - _PRE_ROLL)
            samples = _read_samples(audio, start, min(_WINDOW, total - start))
            voiced = _voiced_frames(samples)
            # Cut long windows on quiet audio when possible; otherwise overlap.
            cut = _cut_at_pause(voiced, len(samples)) if len(samples) == _WINDOW else None
            if cut is not None:
                samples = samples[:cut]
            end = start + len(samples)
            covered_until = end
            _check_cancel(cancelled)
            asr = models.transcribe(samples, sample_rate=RATE, context=context,
                                    vocabulary=vocabulary, max_tokens=1024)
            _check_cancel(cancelled)
            raw = asr["raw_text"]
            traditional = asr["traditional_text"]
            if not isinstance(raw, str) or not isinstance(traditional, str):
                raise ValueError("ASR returned invalid text")
            if raw.strip() or traditional.strip():
                english = models.translate(traditional, context=context, vocabulary=vocabulary) if traditional.strip() else ""
                _check_cancel(cancelled)
                proposal = {"id": len(proposals) + 1, "start": start / RATE, "end": end / RATE,
                            "kind": "audio", "raw_text": raw, "traditional_text": traditional,
                            "english": english, "origin": "offline_refinement",
                            "timing": "coarse_audio_window", "speaker": "unknown"}
                # Do not discard even exact duplicates: without word alignment a
                # real repeated utterance cannot be distinguished from overlap.
                if (proposals and start / RATE < proposals[-1]["end"] and
                        _normalized(raw) and _normalized(raw) == _normalized(proposals[-1]["raw_text"])):
                    proposal["possible_overlap_duplicate_of"] = proposals[-1]["id"]
                proposals.append(proposal)
            if end == total:
                cursor = total
            elif cut is not None:
                cursor = end
            else:
                cursor = end - _OVERLAP
            report(end)
        _check_cancel(cancelled)
    return {"segments": proposals, "mapping": "no_exact_original_segment_mapping",
            "provenance": {"method": "local_offline_asr",
            "audio": "audio.wav", "sample_rate": RATE, "window_seconds": 24,
            "max_overlap_seconds": 1.5, "asr_max_tokens": 1024,
            "detector": "100ms RMS >= 0.008", "pause_seconds": 0.6,
            "boundary": "prefer quiet in final 6 seconds; otherwise overlap"},
            "limitations": ["Times describe audio windows, not word or speaker alignment.",
                            "Energy gating can miss quiet speech or include non-speech noise.",
                            "Overlapping windows can repeat text; exact whole-window matches are flagged, not removed.",
                            "Windows do not map exactly to original segments; results are review-only and do not replace original recognition."],
            "skipped_low_energy_windows": skipped}
