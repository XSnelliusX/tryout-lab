"""Level meter, ASR normalisation and level advice tests on synthetic audio."""

import unittest

import numpy as np

from meeting_assistant.levels import LevelMeter, advice, normalize_for_asr, speech_band_db, speech_level_db, to_db

RATE = 16000


def sine(seconds, amplitude, freq=440.0):
    t = np.arange(int(seconds * RATE)) / RATE
    return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def syllables(seconds, level_db, seed=0):
    """Harmonic bursts at 4 per second; RMS over the span = level_db."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * RATE)) / RATE
    tone = sum(np.sin(2 * np.pi * 150 * k * t + rng.uniform(0, 6)) / np.sqrt(k) for k in range(1, 26))
    signal = tone * np.abs(np.sin(np.pi * 4 * t))
    return (signal * 10 ** (level_db / 20) / np.sqrt(np.mean(signal ** 2))).astype(np.float32)


class LevelMeterTests(unittest.TestCase):
    def feed(self, meter, signal, block=700):
        for i in range(0, len(signal), block):
            meter.update(signal[i:i + block])

    def test_empty_meter(self):
        self.assertEqual(LevelMeter().snapshot(),
                         {"rms_db": -120.0, "peak_db": -120.0, "clipped_recent": 0, "clipped_total": 0})

    def test_rms_and_peak_windows(self):
        meter = LevelMeter()
        self.feed(meter, sine(2, 0.1))
        snap = meter.snapshot()
        self.assertAlmostEqual(snap["rms_db"], to_db(0.1 / np.sqrt(2)), places=1)
        self.assertAlmostEqual(snap["peak_db"], to_db(0.1), places=1)
        spike = sine(0.2, 0.01)
        spike[100] = 0.5
        self.feed(meter, spike)
        self.assertAlmostEqual(meter.snapshot()["peak_db"], to_db(0.5), places=3)
        self.assertAlmostEqual(meter.snapshot()["rms_db"], to_db(0.01 / np.sqrt(2)), places=0)
        self.feed(meter, sine(1.2, 0.01))  # the spike leaves the 1 s peak window
        self.assertAlmostEqual(meter.snapshot()["peak_db"], to_db(0.01), places=1)

    def test_clip_counting_and_window(self):
        meter = LevelMeter()
        block = sine(0.5, 0.2)
        block[[10, 20, 30, 40, 50]] = 1.0
        block[[60, 70]] = -0.9995
        block[80] = 0.998  # just below the clip level
        self.feed(meter, block, block=333)
        self.assertEqual(meter.snapshot()["clipped_recent"], 7)
        self.assertEqual(meter.snapshot()["clipped_total"], 7)
        self.feed(meter, sine(9.3, 0.2), block=1600)
        self.assertEqual(meter.snapshot()["clipped_recent"], 7)  # still within 10 s
        self.feed(meter, sine(1.0, 0.2), block=1600)
        self.assertEqual(meter.snapshot()["clipped_recent"], 0)
        self.assertEqual(meter.snapshot()["clipped_total"], 7)

    def test_snapshot_is_a_copy(self):
        meter = LevelMeter()
        snap = meter.snapshot()
        snap["rms_db"] = 0
        self.assertEqual(meter.snapshot()["rms_db"], -120.0)


class NormalizeTests(unittest.TestCase):
    def test_gain_reaches_target_from_tracked_level(self):
        quiet = sine(1, 0.01)
        out, gain = normalize_for_asr(quiet, speech_db=-38.0)
        self.assertAlmostEqual(gain, 15.0)
        np.testing.assert_allclose(out, quiet * 10 ** 0.75, rtol=1e-5)
        self.assertEqual(out.dtype, np.float32)

    def test_self_estimate_ignores_trailing_silence(self):
        speech = syllables(2, -38)
        _, alone = normalize_for_asr(speech)
        _, padded = normalize_for_asr(np.concatenate([speech, np.zeros(3 * RATE, np.float32)]))
        self.assertAlmostEqual(alone, padded, delta=0.5)
        self.assertTrue(10 < alone < 20, alone)  # quiet speech is raised towards -23
        self.assertAlmostEqual(speech_level_db(speech), -23 - alone, places=3)

    def test_gain_clamps(self):
        _, gain = normalize_for_asr(sine(1, 0.001), speech_db=-70.0)
        self.assertEqual(gain, 20.0)
        _, gain = normalize_for_asr(sine(1, 0.001), speech_db=-70.0, max_gain_db=6.0)
        self.assertEqual(gain, 6.0)
        _, gain = normalize_for_asr(sine(1, 0.3), speech_db=0.0)
        self.assertEqual(gain, -12.0)

    def test_peak_limit_never_clips(self):
        signal = sine(1, 0.01)
        signal[500] = 0.5  # a transient 34 dB above the speech
        out, gain = normalize_for_asr(signal, speech_db=-40.0)
        self.assertAlmostEqual(gain, -1.0 - to_db(0.5), places=4)
        self.assertLessEqual(to_db(np.max(np.abs(out))), -1.0 + 1e-4)
        # Already too hot: the gain goes negative to keep the peak at -1 dBFS.
        hot = sine(1, 0.999)
        out, gain = normalize_for_asr(hot, speech_db=-23.0)
        self.assertLess(gain, 0)
        self.assertLessEqual(np.max(np.abs(out)), 10 ** (-1 / 20) * 1.0001)

    def test_silence_and_empty_are_unchanged(self):
        zeros = np.zeros(RATE, np.float32)
        out, gain = normalize_for_asr(zeros)
        self.assertEqual(gain, 0.0)
        np.testing.assert_array_equal(out, zeros)
        self.assertIsNot(out, zeros)
        out, gain = normalize_for_asr(np.zeros(0, np.float32), speech_db=-40.0)
        self.assertEqual((len(out), gain), (0, 0.0))

    def test_input_is_never_mutated(self):
        signal = syllables(1, -40)
        before = signal.copy()
        out, gain = normalize_for_asr(signal)
        self.assertNotEqual(gain, 0.0)
        np.testing.assert_array_equal(signal, before)
        out[:] = 0
        np.testing.assert_array_equal(signal, before)
        as_list = [0.0, 0.01, -0.02] * 1000
        out, _ = normalize_for_asr(as_list)
        self.assertEqual(out.dtype, np.float32)

    def test_band_level_scale(self):
        # A tone inside 250-4000 Hz reads its RMS; rumble below 250 Hz barely registers.
        frames = sine(0.032 * 4, 0.1, 1000)[:4 * 512].reshape(4, 512)
        np.testing.assert_allclose(speech_band_db(frames), to_db(0.1 / np.sqrt(2)), atol=0.5)
        rumble = sine(0.032 * 4, 0.1, 60)[:4 * 512].reshape(4, 512)
        self.assertLess(np.max(speech_band_db(rumble)), to_db(0.1) - 40)


class AdviceTests(unittest.TestCase):
    HEALTHY = {"rms_db": -30.0, "peak_db": -8.0, "clipped_recent": 0, "noise_db": -60.0,
               "speech_db": -28.0, "snr_db": 32.0, "input_volume": 0.7}

    def advise(self, **changes):
        return advice({**self.HEALTHY, **changes})

    def test_healthy_is_silent(self):
        self.assertEqual(self.advise(), "")
        self.assertEqual(advice({"rms_db": -30.0, "peak_db": -10.0, "clipped_recent": 0}), "")

    def test_each_condition(self):
        self.assertIn("clipping", self.advise(clipped_recent=3))
        self.assertIn("raise the input volume", self.advise(speech_db=-45.0, snr_db=15.0).lower())
        self.assertIn("closer", self.advise(speech_db=-45.0, snr_db=15.0, input_volume=1.0))
        self.assertIn("closer", self.advise(speech_db=-45.0, snr_db=15.0, input_volume=None))
        self.assertIn("noise", self.advise(snr_db=7.0))
        self.assertIn("noise", self.advise(snr_db=None, speech_db=-38.0, noise_db=-45.0))
        self.assertIn("No audio", self.advise(rms_db=-120.0, peak_db=-120.0))

    def test_priority(self):
        # No signal beats everything; clipping beats quiet speech and noise.
        self.assertIn("No audio", self.advise(peak_db=-120.0, clipped_recent=0, speech_db=-50.0))
        self.assertIn("clipping", self.advise(clipped_recent=1, speech_db=-50.0, snr_db=3.0))


if __name__ == "__main__":
    unittest.main()
