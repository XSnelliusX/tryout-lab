"""Input level metering, ASR level normalisation and plain-language level advice."""

import collections

import numpy as np

RATE = 16000
CLIP = 0.999
_FLOOR_DB = -120.0
_SILENT_DB = -100.0      # below this a frame is treated as digital silence
_LEVEL_FRAME = 512       # 32 ms, the same frame the speech detector uses
QUIET_SPEECH_DB = -40.0  # speech below this needs > 17 dB of gain to reach the ASR target
POOR_SNR_DB = 10.0
SPEECH_BAND = (250.0, 4000.0)  # Hz; room rumble below 250 Hz dominates far-field noise floors
_WINDOW = np.hanning(_LEVEL_FRAME)


def to_db(amplitude: float) -> float:
    amplitude = float(amplitude)
    return 20.0 * np.log10(amplitude) if amplitude > 1e-6 else _FLOOR_DB


def speech_band_db(frames, rate: int = RATE) -> np.ndarray:
    """Speech-band (250-4000 Hz) RMS level in dBFS of each row of a (n, 512) frame array.

    Scaled so that white noise reads its band share of the broadband RMS:
    a band level is directly comparable to a dBFS meter, just without the
    low-frequency rumble and high-frequency hiss.
    """
    frames = np.atleast_2d(np.asarray(frames, dtype=np.float32))
    spectrum = np.fft.rfft(frames * _WINDOW, axis=1)
    freqs = np.fft.rfftfreq(frames.shape[1], 1.0 / rate)
    band = (freqs >= SPEECH_BAND[0]) & (freqs <= SPEECH_BAND[1])
    power = np.sum(np.abs(spectrum[:, band]) ** 2, axis=1) * 2.0 / (frames.shape[1] * np.sum(_WINDOW ** 2))
    return 10.0 * np.log10(np.maximum(power, 1e-12))


class LevelMeter:
    """Running input diagnostics. Thread-compatible: one writer thread calls
    update(), others call snapshot(), which only reads one immutable dict."""

    def __init__(self, rate: int = RATE):
        self.bucket = rate // 10  # 100 ms
        self._sumsq = 0.0
        self._peak = 0.0
        self._clips = 0
        self._filled = 0
        self._recent = collections.deque(maxlen=100)  # (peak, clips) per 100 ms bucket, 10 s
        self._clipped_total = 0
        self._snapshot = {"rms_db": _FLOOR_DB, "peak_db": _FLOOR_DB, "clipped_recent": 0, "clipped_total": 0}

    def update(self, block) -> None:
        block = np.asarray(block, dtype=np.float32).ravel()
        rms_db = self._snapshot["rms_db"]
        while len(block):
            take = block[:self.bucket - self._filled]
            block = block[len(take):]
            magnitude = np.abs(take)
            self._sumsq += float(np.dot(take.astype(np.float64), take))
            self._peak = max(self._peak, float(magnitude.max()))
            clips = int(np.count_nonzero(magnitude >= CLIP))
            self._clips += clips
            self._clipped_total += clips
            self._filled += len(take)
            if self._filled == self.bucket:
                rms_db = to_db(np.sqrt(self._sumsq / self.bucket))
                self._recent.append((self._peak, self._clips))
                self._sumsq = self._peak = 0.0
                self._clips = self._filled = 0
        last_second = list(self._recent)[-10:]
        peak = max([p for p, _ in last_second] + [self._peak])
        self._snapshot = {"rms_db": rms_db, "peak_db": to_db(peak),
                          "clipped_recent": sum(c for _, c in self._recent) + self._clips,
                          "clipped_total": self._clipped_total}

    def snapshot(self) -> dict:
        return dict(self._snapshot)


def speech_level_db(samples) -> float | None:
    """Typical speech-band level of a segment, from its louder frames.

    The mean dB of the frames at or above the median non-silent frame, so
    pauses and trailing silence cannot drag it down. Same scale as
    SpeechDetector.speech_db.
    """
    samples = np.asarray(samples, dtype=np.float32)
    if not len(samples):
        return None
    count = -(-len(samples) // _LEVEL_FRAME)
    frames = np.pad(samples, (0, count * _LEVEL_FRAME - len(samples))).reshape(count, _LEVEL_FRAME)
    db = speech_band_db(frames)
    db = db[db > _SILENT_DB]
    if not len(db):
        return None
    return float(np.mean(db[db >= np.median(db)]))


def normalize_for_asr(samples, *, speech_db: float | None = None, target_db: float = -23.0,
                      max_gain_db: float = 20.0, peak_limit_db: float = -1.0) -> tuple[np.ndarray, float]:
    """Return (float32 copy, applied_gain_db) with the speech level moved to target_db.

    Gain is clamped to [-12, max_gain_db] and then lowered until the peak sits
    at or below peak_limit_db, so the result never clips and is never limited.
    Digital silence or an empty array comes back unchanged with gain 0.0.
    """
    out = np.array(samples, dtype=np.float32, copy=True)
    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    if speech_db is None:
        speech_db = speech_level_db(out)
    if peak <= 0.0 or speech_db is None or to_db(peak) <= _SILENT_DB:
        return out, 0.0
    gain = min(max(target_db - speech_db, -12.0), max_gain_db)
    gain = min(gain, peak_limit_db - to_db(peak))
    if gain:
        out *= np.float32(10.0 ** (gain / 20.0))
    return out, gain


def advice(levels: dict) -> str:
    """One short hint for the UI; "" when the input looks healthy."""
    peak = levels.get("peak_db")
    if peak is not None and peak <= -90.0:
        return "No audio signal. Check that the right input is selected and not muted."
    if levels.get("clipped_recent"):
        return "Input is clipping (too loud). Lower the macOS input volume or move the microphone away."
    speech = levels.get("speech_db")
    if speech is not None and speech < QUIET_SPEECH_DB:
        volume = levels.get("input_volume")
        if volume is not None and volume < 0.99:
            return "Speech is very quiet. Raise the input volume in System Settings > Sound > Input."
        return "Speech is very quiet. Move the microphone closer to the people speaking."
    snr = levels.get("snr_db")
    if snr is None and speech is not None and levels.get("noise_db") is not None:
        snr = speech - levels["noise_db"]
    if snr is not None and snr < POOR_SNR_DB:
        return "Background noise is almost as loud as the speech. Move the microphone closer or reduce the noise."
    return ""
