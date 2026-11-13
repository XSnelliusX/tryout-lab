"""Speech detector and segmenter tests on deterministic synthetic audio."""

import itertools
import unittest

import numpy as np

from meeting_assistant.levels import speech_band_db
from meeting_assistant.vad import FRAME, Segmenter, SpeechDetector, voiced_frames

RATE = 16000
STEP = FRAME / RATE


def scaled(signal, level_db):
    rms = np.sqrt(np.mean(np.square(signal, dtype=np.float64)))
    return (signal * (10 ** (level_db / 20) / rms)).astype(np.float32)


def room_noise(seconds, level_db, seed=1):
    """Far-field room tone: 1/f amplitude spectrum (rumble-heavy), broadband RMS = level_db."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    spectrum = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / RATE)
    spectrum *= np.where(freqs > 20, 20 / np.maximum(freqs, 20), 0.0)
    return scaled(np.fft.irfft(spectrum, n), level_db)


def white_noise(seconds, level_db, seed=1):
    return scaled(np.random.default_rng(seed).standard_normal(int(seconds * RATE)), level_db)


def noise(seconds, level_db, seed=1):
    # -70 dBFS stands for a digital (Teams) source, quieter floors for a room microphone.
    return white_noise(seconds, level_db, seed) if level_db <= -60 else room_noise(seconds, level_db, seed)


def speech(seconds, level_db, seed=2):
    """Speech-like bursts: harmonic syllables (f0 110-190 Hz) at 4-5 per second, short word gaps.

    The RMS over the whole span (gaps included) is level_db.
    """
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    out = np.zeros(n)
    position, syllables = 0, 0
    while position < n:
        length = int(rng.uniform(0.17, 0.26) * RATE)
        t = np.arange(min(length, n - position)) / RATE
        f0 = rng.uniform(110, 190)
        harmonics = np.arange(1, int(4000 // f0) + 1)
        tone = np.sin(2 * np.pi * f0 * np.outer(harmonics, t) + rng.uniform(0, 2 * np.pi, (len(harmonics), 1)))
        tone = (tone / np.sqrt(harmonics)[:, None]).sum(axis=0)
        envelope = np.hanning(length)[:len(t)] * rng.uniform(0.6, 1.0)
        out[position:position + len(t)] = tone * envelope
        position += length
        syllables += 1
        if syllables % 3 == 0:
            position += int(rng.uniform(0.06, 0.15) * RATE)  # word boundary
    return scaled(out, level_db)


def mix(total, base, parts):
    """Noise `base` of `total` seconds with speech arrays added at the given start times."""
    signal = base.copy()[:int(total * RATE)]
    for start, part in parts:
        i = int(start * RATE)
        signal[i:i + len(part)] += part
    return signal


def regions(flags, merge=0.3):
    """(start, end) seconds of True runs, merging gaps shorter than `merge` seconds."""
    runs, start = [], None
    for i, flag in enumerate(list(flags) + [False]):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            runs.append([start * STEP, i * STEP])
            start = None
    merged = []
    for run in runs:
        if merged and run[0] - merged[-1][1] < merge:
            merged[-1][1] = run[1]
        else:
            merged.append(run)
    return [tuple(r) for r in merged]


def run(signal, detector=None):
    detector = detector or SpeechDetector(RATE)
    flags, floors = [], []
    for i in range(0, len(signal) - FRAME + 1, FRAME):
        flags.append(detector.process(signal[i:i + FRAME]))
        floors.append(detector.noise_db)
    return detector, flags, floors


class DetectorTests(unittest.TestCase):
    # Onset may lag the first syllable by its rising edge plus the 3-of-5 rule;
    # release may lag the last syllable's tail by the 64 ms hangover.
    ONSET = (-0.05, 0.20)
    OFFSET = (-0.20, 0.25)

    def test_onset_and_offset_for_each_level_and_floor(self):
        for speech_db, floor_db in itertools.product((-23, -38), (-70, -50, -42)):
            with self.subTest(speech=speech_db, floor=floor_db):
                first, second = speech(2.0, speech_db, seed=3), speech(1.5, speech_db, seed=4)
                signal = mix(10, noise(10, floor_db), [(3.0, first), (7.0, second)])
                _, flags, _ = run(signal)
                found = regions(flags)
                self.assertEqual(len(found), 2, found)
                for (start, end), (true_start, length) in zip(found, ((3.0, 2.0), (7.0, 1.5))):
                    self.assertTrue(self.ONSET[0] <= start - true_start <= self.ONSET[1], (start, true_start))
                    true_end = true_start + length
                    self.assertTrue(self.OFFSET[0] <= end - true_end <= self.OFFSET[1], (end, true_end))

    def test_floor_tracks_noise_and_speech_level(self):
        signal = mix(12, room_noise(12, -42), [(3.0, speech(8.0, -36))])
        detector, _, floors = run(signal)
        band_noise = float(np.median(speech_band_db(room_noise(3, -42)[:3 * RATE // FRAME * FRAME].reshape(-1, FRAME))))
        self.assertLess(abs(floors[int(2.9 / STEP)] - band_noise), 3.0)
        self.assertGreater(detector.speech_db - detector.noise_db, 12.0)
        self.assertAlmostEqual(detector.threshold_db, max(detector.noise_db + 10, -60))

    def test_stationary_noise_alone_is_never_speech(self):
        for floor_db in (-70, -50, -42):
            with self.subTest(floor=floor_db):
                _, flags, _ = run(noise(30, floor_db, seed=7))
                self.assertFalse(any(flags))

    def test_small_noise_step_is_not_speech(self):
        signal = np.concatenate([room_noise(20, -50, seed=8), room_noise(30, -44, seed=9)])
        _, flags, floors = run(signal)
        self.assertFalse(any(flags))
        self.assertGreater(floors[-1] - floors[int(19 / STEP)], 4.0)  # the floor followed the step

    def test_large_noise_step_recovers_within_seconds(self):
        # A 20 dB step looks like speech to any energy detector at first; the
        # flat envelope must end it quickly and keep it from coming back.
        signal = np.concatenate([white_noise(10, -70, seed=10), room_noise(30, -50, seed=11)])
        _, flags, _ = run(signal)
        step = int(10 / STEP)
        self.assertLess(sum(flags[step:]) * STEP, 2.0)
        self.assertFalse(any(flags[step + int(3 / STEP):]))

    def test_floor_does_not_creep_during_continuous_speech(self):
        signal = mix(25, room_noise(25, -50), [(3.0, speech(20.0, -23, seed=12))])
        _, flags, floors = run(signal)
        before, during = floors[int(2.9 / STEP)], floors[int(22.9 / STEP)]
        self.assertLess(during - before, 3.0)
        found = regions(flags)  # word gaps are short non-speech; nothing longer than a pause
        self.assertEqual(len(found), 1, found)
        self.assertTrue(self.ONSET[0] <= found[0][0] - 3.0 <= self.ONSET[1])
        self.assertTrue(self.OFFSET[0] <= found[0][1] - 23.0 <= self.OFFSET[1])

    def test_recovers_after_loud_passage(self):
        signal = np.concatenate([room_noise(5, -50, seed=13), room_noise(6, -30, seed=14),
                                 mix(6, room_noise(6, -50, seed=15), [(2.0, speech(2.0, -38))])])
        _, flags, _ = run(signal)
        found = [r for r in regions(flags) if r[0] > 11.5]
        self.assertEqual(len(found), 1, regions(flags))
        self.assertTrue(self.ONSET[0] <= found[0][0] - 13.0 <= self.ONSET[1], found)

    def test_digital_silence_and_start_up(self):
        detector, flags, _ = run(np.zeros(2 * RATE, np.float32))
        self.assertFalse(any(flags))
        self.assertEqual(detector.noise_db, -100.0)
        # Speech straight after digital silence is detected promptly.
        signal = np.concatenate([np.zeros(RATE, np.float32), speech(1.5, -38)])
        found = regions(run(signal)[1])
        self.assertEqual(len(found), 1)
        self.assertLessEqual(found[0][0] - 1.0, self.ONSET[1])
        # A stream that starts in the middle of speech still finds its floor.
        signal = mix(8, room_noise(8, -50), [(0.0, speech(3.0, -30)), (5.0, speech(2.0, -30, seed=5))])
        found = regions(run(signal)[1])
        self.assertEqual(len(found), 2, found)
        self.assertTrue(self.ONSET[0] <= found[1][0] - 5.0 <= self.ONSET[1])

    def test_voiced_frames_and_tuning(self):
        signal = mix(4, room_noise(4, -50), [(1.0, speech(2.0, -30))])
        flags = voiced_frames(signal[:len(signal) - 100])
        self.assertEqual(len(flags), -(-(len(signal) - 100) // FRAME))
        self.assertEqual(flags[:len(flags) - 1], run(signal[:len(signal) - 100])[1][:len(flags) - 1])
        with self.assertRaises(TypeError):
            SpeechDetector(RATE, onset=3)
        with self.assertRaises(ValueError):
            SpeechDetector(RATE).process(np.zeros(100, np.float32))


class Scripted(SpeechDetector):
    """A detector that replays given decisions; levels are measured from the audio."""

    def __init__(self, flags):
        super().__init__(RATE)
        self.flags = iter(flags)
        self.release_level_db = -40.0

    def process(self, frame):
        self.level_db = float(speech_band_db(frame)[0])
        self.speaking = next(self.flags, False)
        return self.speaking


def tone(frames, amplitude=0.1, seed=0):
    t = np.arange(frames * FRAME) / RATE
    return (amplitude * np.sin(2 * np.pi * 440 * t + seed)).astype(np.float32)


def segment(flags, audio=None, block=FRAME, now=None, **options):
    """Run a Segmenter with scripted decisions; returns (events, audio)."""
    audio = tone(len(flags)) if audio is None else audio
    events = []
    segmenter = Segmenter(events.append, detector=Scripted(flags), **options)
    for index, offset in enumerate(range(0, len(audio), block)):
        segmenter.process(audio[offset:offset + block], None if now is None else now(index))
    segmenter.flush()
    return events, audio


def pattern(*runs):
    """pattern((20, False), (40, True)) -> list of frame flags."""
    return [flag for count, flag in runs for _ in range(count)]


class SegmenterTests(unittest.TestCase):
    def test_pause_then_identical_final(self):
        flags = pattern((20, False), (60, True), (30, False))
        events, audio = segment(flags, now=lambda i: 100.0 + i)
        self.assertEqual([e["kind"] for e in events], ["preview", "pause", "final"])
        preview, pause, final = events
        start = 20 * FRAME - int(0.3 * RATE)
        speech_end = 80 * FRAME
        end = speech_end + int(0.15 * RATE)
        for event in events:
            self.assertEqual((event["utterance"], event["part"], event["start"]), (1, 0, start / RATE))
            self.assertIsInstance(event["audio"], np.ndarray)
            self.assertEqual(event["audio"].dtype, np.float32)
        self.assertEqual(preview["speech_end_at"], 100.0 + 20 + 37)  # first preview at 1.5 s of part audio
        self.assertEqual(preview["speech_end"], 58 * FRAME / RATE)
        self.assertEqual(pause["speech_end"], speech_end / RATE)
        self.assertEqual(final["speech_end"], speech_end / RATE)
        self.assertEqual(pause["end"], end / RATE)
        np.testing.assert_array_equal(pause["audio"], audio[start:end])
        self.assertEqual(final["audio"].tobytes(), pause["audio"].tobytes())
        self.assertIsNot(final["audio"], pause["audio"])
        self.assertEqual((final["cut"], final["clean"], final["same_as_pause"]), ("silence", True, True))
        self.assertEqual(final["speech_end_at"], 100.0 + 79)
        self.assertNotIn("cut", pause)

    def test_pause_and_final_timing(self):
        events = []
        segmenter = Segmenter(events.append, detector=Scripted(pattern((20, True), (40, False))))
        audio = tone(60)
        kinds_at = []
        for i in range(60):
            segmenter.process(audio[i * FRAME:(i + 1) * FRAME])
            kinds_at.extend((i, e["kind"]) for e in events[len(kinds_at):])
        # Pause after 0.3 s of non-speech (10 frames), final after 0.6 s (19 frames).
        self.assertEqual(kinds_at, [(29, "pause"), (38, "final")])

    def test_speech_resuming_after_pause_continues_utterance(self):
        flags = pattern((10, False), (40, True), (12, False), (20, True), (30, False))
        events, audio = segment(flags)
        kinds = [e["kind"] for e in events if e["kind"] != "preview"]
        self.assertEqual(kinds, ["pause", "pause", "final"])
        first, second, final = [e for e in events if e["kind"] != "preview"]
        self.assertEqual({e["utterance"] for e in events}, {1})
        self.assertEqual(first["speech_end"], 50 * FRAME / RATE)
        self.assertEqual(second["speech_end"], 82 * FRAME / RATE)
        self.assertGreater(len(second["audio"]), len(first["audio"]))
        self.assertTrue(final["same_as_pause"])
        np.testing.assert_array_equal(final["audio"], second["audio"])

    def test_valley_cut_keeps_every_sample_once(self):
        frames = 600  # 19.2 s of continuous speech, then silence
        audio = tone(frames + 40)
        notch = int(6.5 * RATE) // FRAME * FRAME  # a quiet 64 ms gap at 6.5 s
        audio[notch:notch + 2 * FRAME] *= 0.001
        flags = pattern((5, False), (frames, True), (35, False))
        events, _ = segment(flags, audio=audio, block=700)
        finals = [e for e in events if e["kind"] == "final"]
        self.assertEqual([(e["cut"], e["part"]) for e in finals], [("valley", 0), ("valley", 1), ("silence", 2)])
        self.assertEqual(finals[0]["end"], (notch + FRAME) / RATE)  # boundary inside the gap
        self.assertTrue(finals[0]["clean"])
        self.assertFalse(finals[1]["clean"])  # nothing quiet in the second stretch
        self.assertFalse(finals[0]["same_as_pause"])
        for before, after in zip(finals, finals[1:]):
            self.assertEqual(before["end"], after["start"])
        start, end = round(finals[0]["start"] * RATE), round(finals[-1]["end"] * RATE)
        np.testing.assert_array_equal(np.concatenate([e["audio"] for e in finals]), audio[start:end])
        self.assertEqual({e["utterance"] for e in finals}, {1})
        self.assertTrue(all(len(e["audio"]) <= 8 * RATE + FRAME for e in finals))
        self.assertLessEqual(finals[0]["speech_end"], finals[0]["end"])

    def test_short_bursts_are_dropped(self):
        flags = pattern((10, False), (5, True), (30, False), (20, True), (30, False))
        events, _ = segment(flags)
        finals = [e for e in events if e["kind"] == "final"]
        self.assertEqual(len(finals), 1)
        self.assertEqual(finals[0]["utterance"], 2)  # utterance 1 (0.16 s) emitted no final

    def test_flush_emits_open_utterance_with_tail(self):
        flags = pattern((10, False), (30, True))
        audio = np.concatenate([tone(40), tone(1)[:188]])
        events, _ = segment(flags, audio=audio, block=700)
        final = events[-1]
        self.assertEqual((final["kind"], final["cut"], final["clean"], final["same_as_pause"]),
                         ("final", "flush", False, False))
        self.assertEqual(final["end"], len(audio) / RATE)
        np.testing.assert_array_equal(final["audio"], audio[round(final["start"] * RATE):])
        # Flushing during a pause reuses the pause audio.
        events, _ = segment(pattern((10, False), (30, True), (12, False)))
        self.assertEqual(events[-1]["cut"], "flush")
        self.assertTrue(events[-1]["same_as_pause"])
        self.assertEqual(events[-1]["audio"].tobytes(), events[-2]["audio"].tobytes())
        # Nothing open: nothing emitted.
        self.assertEqual(segment(pattern((30, False)))[0], [])

    def test_block_size_does_not_change_events(self):
        flags = pattern((15, False), (300, True), (10, False), (50, True), (40, False))
        reference, _ = segment(flags)
        for block in (7, 333, 1600, 4096):
            with self.subTest(block=block):
                events, _ = segment(flags, block=block)
                self.assertEqual(len(events), len(reference))
                for a, b in zip(events, reference):
                    self.assertEqual({k: v for k, v in a.items() if k not in ("audio", "speech_end_at")},
                                     {k: v for k, v in b.items() if k not in ("audio", "speech_end_at")})
                    np.testing.assert_array_equal(a["audio"], b["audio"])

    def test_now_is_the_block_that_completed_the_last_voiced_frame(self):
        flags = pattern((10, False), (30, True), (30, False))
        events, _ = segment(flags, block=700, now=lambda i: 50.0 + i / 10)
        final = events[-1]
        last_voiced_end = 40 * FRAME
        block = -(-last_voiced_end // 700) - 1
        self.assertEqual(final["speech_end_at"], 50.0 + block / 10)
        self.assertEqual(final["speech_end"], last_voiced_end / RATE)
        events, _ = segment(flags)
        self.assertIsNone(events[-1]["speech_end_at"])

    def test_pre_roll_never_reaches_into_previous_final(self):
        flags = pattern((20, True), (12, False), (20, True), (40, False))
        events, _ = segment(flags, end_silence=0.35)
        finals = [e for e in events if e["kind"] == "final"]
        self.assertEqual([e["utterance"] for e in finals], [1, 2])
        self.assertEqual(finals[0]["start"], 0.0)
        self.assertEqual(finals[1]["start"], finals[0]["end"])

    def test_real_detector_on_far_field_speech(self):
        signal = mix(12, room_noise(12, -42), [(2.0, speech(3.0, -38)), (6.5, speech(2.5, -38, seed=6))])
        events = []
        segmenter = Segmenter(events.append)
        for i in range(0, len(signal), 1600):
            segmenter.process(signal[i:i + 1600])
        segmenter.flush()
        finals = [e for e in events if e["kind"] == "final"]
        self.assertEqual([(e["utterance"], e["cut"]) for e in finals], [(1, "silence"), (2, "silence")])
        for final, (start, length) in zip(finals, ((2.0, 3.0), (6.5, 2.5))):
            self.assertLess(final["start"], start)
            self.assertGreater(final["end"], start + length - 0.1)
            self.assertLess(final["end"], start + length + 0.5)


if __name__ == "__main__":
    unittest.main()
