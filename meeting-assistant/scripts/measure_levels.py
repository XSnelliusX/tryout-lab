#!/usr/bin/env python3
"""Measure input levels, speech detection and segmentation of recorded sessions.

Usage: python scripts/measure_levels.py [--last N] [--json] [<session dir or .wav>...]

Reads only audio.wav (16 kHz mono 16-bit), streaming, and never opens any
transcript or journal. Without arguments it measures the newest sessions.
"""

import argparse
import json
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from meeting_assistant.levels import CLIP, advice, normalize_for_asr, to_db  # noqa: E402
from meeting_assistant.vad import FRAME, Segmenter, SpeechDetector  # noqa: E402

RATE = 16000
SESSIONS = Path.home() / "Library/Application Support/Meeting Assistant/sessions"
CHUNK = RATE * 10


class LegacySegments:
    """The previous live rule: 100 ms RMS >= 0.008, final after 0.8 s quiet, forced cut at 10 s with 2 s overlap."""

    FRAME, THRESHOLD, END, MAX, OVERLAP, PRE = 1600, 0.008, 8, 100, 20, 2  # counted in 100 ms frames

    def __init__(self):
        self.finals = []  # (duration seconds, cut)
        self.length = self.silence = self.pre = 0
        self.open = self.new_voice = False

    def frame(self, voiced):
        if not self.open:
            if not voiced:
                self.pre = min(self.pre + 1, self.PRE)
                return
            self.open, self.length, self.new_voice = True, self.pre, False
            self.pre = 0
        self.length += 1
        self.new_voice |= voiced
        self.silence = 0 if voiced else self.silence + 1
        if self.silence >= self.END:
            self.flush()
        elif self.length >= self.MAX:
            self.finals.append((self.length / 10, "forced"))
            self.length, self.silence, self.new_voice = self.OVERLAP, 0, False

    def flush(self):
        if self.open and self.new_voice:
            self.finals.append((self.length / 10, "silence"))
        self.open, self.new_voice, self.length, self.silence = False, False, 0, 0


class TrackingDetector(SpeechDetector):
    """Records the voiced frame count and the tracked levels after every frame."""

    def __init__(self):
        super().__init__(RATE)
        self.voiced, self.noise, self.speech = 0, [], []

    def process(self, frame):
        speaking = super().process(frame)
        self.voiced += speaking
        if self.noise_db is not None:
            self.noise.append(self.noise_db)
        if speaking and self.speech_db is not None:
            self.speech.append(self.speech_db)
        return speaking


def sessions(last):
    folders = sorted((p for p in SESSIONS.glob("*") if (p / "audio.wav").is_file()), key=lambda p: p.name)
    return folders[-last:] if last else folders


def audio_path(item):
    item = Path(item)
    return item / "audio.wav" if item.is_dir() else item


def percentile(values, q):
    return round(float(np.percentile(values, q)), 1) if len(values) else None


def share(count, total):
    return round(100.0 * count / total, 1) if total else None


def measure(path):
    finals, gains, segment_levels = [], [], []

    def on_event(event):
        if event["kind"] == "final":
            audio = event["audio"]
            finals.append((len(audio) / RATE, event["cut"], event["clean"]))
            _, gain = normalize_for_asr(audio, speech_db=segmenter.detector.speech_db)
            gains.append(gain)
            segment_levels.append(normalize_for_asr(audio)[1])

    detector = TrackingDetector()
    segmenter = Segmenter(on_event, detector=detector)
    legacy = LegacySegments()
    rms_frames = []
    peak, clipped, total = 0.0, 0, 0
    leftover = np.zeros(0, np.float32)
    with wave.open(str(path), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, RATE):
            raise ValueError(f"{path}: expected 16 kHz mono 16-bit audio")
        while True:
            data = audio.readframes(CHUNK)
            if not data:
                break
            block = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
            total += len(block)
            magnitude = np.abs(block)
            peak = max(peak, float(magnitude.max()))
            clipped += int(np.count_nonzero(magnitude >= CLIP))
            # 100 ms frames for the RMS percentiles and the legacy rule.
            joined = np.concatenate([leftover, block])
            usable = len(joined) - len(joined) % 1600
            frames = joined[:usable].reshape(-1, 1600)
            leftover = joined[usable:]
            rms = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1))
            rms_frames.extend(rms.tolist())
            for value in rms:
                legacy.frame(value >= LegacySegments.THRESHOLD)
            segmenter.process(block)
    segmenter.flush()
    legacy.flush()
    rms_db = [to_db(v) for v in rms_frames]
    noise, speech, voiced = detector.noise, detector.speech, detector.voiced * FRAME
    noise_db = percentile(noise, 50)
    speech_db = percentile(speech, 50)
    snr = round(speech_db - noise_db, 1) if noise_db is not None and speech_db is not None else None
    peak_db = round(to_db(peak), 1)
    result = {
        "file": str(path), "duration_s": round(total / RATE, 1),
        "peak_dbfs": peak_db, "clipped_samples": clipped,
        "rms_db": {"p10": percentile(rms_db, 10), "p50": percentile(rms_db, 50), "p90": percentile(rms_db, 90)},
        "detector": {"noise_db": noise_db, "noise_db_p10_p90": [percentile(noise, 10), percentile(noise, 90)],
                     "speech_db": speech_db, "snr_db": snr, "speech_percent": share(voiced, total)},
        "gain_db": {"tracked_median": percentile(gains, 50), "tracked_min_max": [percentile(gains, 0), percentile(gains, 100)],
                    "self_estimate_median": percentile(segment_levels, 50)},
        "new": summarize(finals, {"silence", "valley", "flush"}),
        "legacy": summarize([(d, cut, False) for d, cut in legacy.finals], {"silence", "forced"}),
    }
    result["advice"] = advice({"rms_db": percentile(rms_db, 50), "peak_db": peak_db, "clipped_recent": clipped,
                               "noise_db": noise_db, "speech_db": speech_db, "snr_db": snr, "input_volume": None})
    return result


def summarize(finals, cuts):
    durations = [d for d, _, _ in finals]
    summary = {"finals": len(finals), "median_s": percentile(durations, 50), "p90_s": percentile(durations, 90),
               "speech_s": round(sum(durations), 1)}
    for cut in sorted(cuts):
        summary[f"{cut}_percent"] = share(sum(1 for _, c, _ in finals if c == cut), len(finals))
    valleys = [clean for _, cut, clean in finals if cut == "valley"]
    if "valley" in cuts:
        summary["valley_not_clean_percent"] = share(sum(1 for clean in valleys if not clean), len(valleys))
    return summary


def report(r):
    d, n, l, g = r["detector"], r["new"], r["legacy"], r["gain_db"]
    lines = [
        r["file"],
        f"  duration {r['duration_s'] / 60:.1f} min, peak {r['peak_dbfs']} dBFS, clipped samples {r['clipped_samples']}",
        f"  100 ms RMS dBFS p10/p50/p90: {r['rms_db']['p10']} / {r['rms_db']['p50']} / {r['rms_db']['p90']}",
        f"  detector (250-4000 Hz band levels): noise {d['noise_db']} dB (p10..p90 {d['noise_db_p10_p90'][0]}..{d['noise_db_p10_p90'][1]}), "
        f"speech {d['speech_db']} dB, SNR {d['snr_db']} dB, in speech {d['speech_percent']}%",
        f"  ASR gain: median {g['tracked_median']} dB (range {g['tracked_min_max'][0]}..{g['tracked_min_max'][1]}), "
        f"self-estimated {g['self_estimate_median']} dB",
        f"  new:    {n['finals']} finals, median {n['median_s']} s, p90 {n['p90_s']} s, total {n['speech_s']} s; "
        f"silence {n['silence_percent']}%, valley {n['valley_percent']}% (not clean {n['valley_not_clean_percent']}%), flush {n['flush_percent']}%",
        f"  legacy: {l['finals']} finals, median {l['median_s']} s, p90 {l['p90_s']} s, total {l['speech_s']} s; "
        f"silence {l['silence_percent']}%, forced 10 s cut {l['forced_percent']}%",
        f"  advice: {r['advice'] or '(none)'}",
    ]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*", help="session folders or .wav files")
    parser.add_argument("--last", type=int, default=3, help="newest N sessions when no path is given (0 = all)")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    args = parser.parse_args(argv)
    paths = [audio_path(p) for p in args.paths] or [p / "audio.wav" for p in sessions(args.last)]
    if not paths:
        parser.error(f"no sessions found in {SESSIONS}")
    results = [measure(p) for p in paths]
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print("\n\n".join(report(r) for r in results))


if __name__ == "__main__":
    main()
