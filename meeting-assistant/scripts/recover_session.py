#!/usr/bin/env python3
"""Replay a recorded session locally into separate recovery files."""

import argparse
import json
import math
import os
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path

# Allow running this script directly, regardless of the current directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

RATE = 16000
WINDOW = 6 * RATE
THRESHOLD = 0.008


def nonnegative_seconds(value):
    try:
        seconds = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a number of seconds")
    if not math.isfinite(seconds) or seconds < 0:
        raise argparse.ArgumentTypeError("must be a finite, nonnegative number")
    return seconds


def private_file(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, "w", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Replay a local meeting archive into new recovery files.")
    parser.add_argument("session", type=Path, help="Exact session directory containing audio.wav and events.jsonl")
    parser.add_argument("--start-seconds", type=nonnegative_seconds, default=0.0,
                        help="Replay from this audio offset (default: 0)")
    parser.add_argument("--confirm", action="store_true", help="Explicitly allow local model inference")
    args = parser.parse_args()
    if not args.confirm:
        parser.error("--confirm is required to run local inference")

    session = args.session.expanduser().resolve()
    if not session.is_dir():
        parser.error("session must be an existing directory")
    audio_path = session / "audio.wav"
    journal_path = session / "events.jsonl"
    if not audio_path.is_file() or not journal_path.is_file():
        parser.error("session must contain audio.wav and events.jsonl")

    try:
        # Open the journal to check availability; it is not modified or used
        # to skip windows, so skipped or incomplete live work is replayed too.
        with journal_path.open("rb"):
            pass
        with wave.open(str(audio_path), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, RATE, "NONE"):
                raise ValueError("audio.wav must be uncompressed mono 16-bit PCM at 16 kHz")
            total = audio.getnframes()
            first = int(args.start_seconds * RATE)
            if first >= total:
                raise ValueError("start offset is at or beyond the archived audio duration")

            # These imports and model loading happen only after explicit consent.
            import numpy as np
            from meeting_assistant.inference import LocalModels
            from meeting_assistant.storage import DATA_DIR

            models = LocalModels(DATA_DIR, status_callback=lambda message: print(message, file=sys.stderr))
            models.load()
            audio.setpos(first)

            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            base = session / f"recovery-{stamp}"
            json_path = base.with_suffix(".jsonl")
            text_path = base.with_suffix(".txt")
            errors = 0
            with private_file(json_path) as journal, private_file(text_path) as text:
                def write(event):
                    journal.write(json.dumps(event, ensure_ascii=False) + "\n")
                    journal.flush()

                write({"type": "recovery_started", "start_seconds": first / RATE,
                       "window_seconds": 6, "rms_threshold": THRESHOLD,
                       "recorded_frames": total})
                text.write("Recovery transcript — approximate non-overlapping audio windows\n\n")
                offset = first
                try:
                    while offset < total:
                        count = min(WINDOW, total - offset)
                        raw = audio.readframes(count)
                        if len(raw) != count * 2:
                            raise ValueError("audio.wav is truncated before its declared frame count")
                        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
                        rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
                        end = offset + count
                        event = {"type": "window", "start": offset / RATE, "end": end / RATE, "rms": rms}
                        if rms < THRESHOLD:
                            event["status"] = "skipped_low_rms"
                        else:
                            event.update({"raw_text": "", "traditional_text": "", "english": ""})
                            stage = "transcription"
                            try:
                                result = models.transcribe(samples, sample_rate=RATE)
                                event["raw_text"] = result.get("raw_text", "")
                                event["traditional_text"] = result.get("traditional_text", "")
                                stage = "translation"
                                if event["traditional_text"].strip():
                                    event["english"] = models.translate(event["traditional_text"])
                                event["status"] = "complete"
                            except Exception as exc:
                                errors += 1
                                event.update(status="error", error_stage=stage, error=str(exc))
                            text.write(f"[{event['start']:.2f}–{event['end']:.2f}s]\n")
                            text.write(f"{event['traditional_text']}\n{event['english']}\n")
                            if event["status"] == "error":
                                text.write(f"[{stage} failed; see JSONL for details]\n")
                            text.write("\n")
                            text.flush()
                        write(event)
                        offset = end
                        print(f"Processed {offset / RATE:.1f} / {total / RATE:.1f} seconds", file=sys.stderr)
                except BaseException as exc:
                    write({"type": "recovery_interrupted", "next_seconds": offset / RATE,
                           "error": str(exc) or type(exc).__name__})
                    raise
                write({"type": "recovery_finished", "errors": errors, "end_seconds": offset / RATE})
            print(f"Recovery journal: {json_path}\nRecovery transcript: {text_path}")
            if errors:
                print(f"{errors} windows failed; see the recovery journal.", file=sys.stderr)
                return 1
            return 0
    except KeyboardInterrupt:
        print("Interrupted. Partial recovery files, if created, are retained in the session folder.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"Recovery failed: {exc}. Partial recovery files, if created, are retained in the session folder.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
