"""Adaptive energy speech detection and utterance segmentation for live recognition."""

import collections

import numpy as np

from .levels import speech_band_db

FRAME = 512  # 32 ms at 16 kHz
_SILENT = 1e-5  # digital silence (below one 16-bit step): never speech, never moves the floor
_SILENT_DB = -100.0


class SpeechDetector:
    """Adaptive energy detector with a tracked noise floor and hysteresis.

    Levels are speech-band (250-4000 Hz) RMS in dBFS: in the owner's room
    recordings, low-frequency rumble sets the broadband floor, and the band
    limit gains about 10 dB of signal-to-noise for free.

    The floor follows quieter frames quickly and rises slowly, and only while
    nobody speaks, so it does not creep into sustained speech. Two rules undo
    a floor that is too low (after start-up, or after the room got noisier):
    it never stays below the quietest frame of the last `min_window_s`, and a
    flat second (speech always varies by more than `flat_db` within a second,
    steady noise does not) pulls it up quickly even during detected speech.
    Real speech reaches the floor between words every few seconds; only
    speech without any such gap for 10 s lifts the floor to its quietest dip.
    """

    DEFAULTS = {
        "onset_db": 10.0,      # onset: frames this far above the floor ...
        "min_db": -60.0,       # ... and above this absolute level
        "onset_frames": 3,     # ... in this many of the last `onset_window` frames
        "onset_window": 5,
        "release_db": 6.0,     # speech continues while above floor + release_db
        "release_frames": 2,   # consecutive quiet frames before release (64 ms)
        "fall": 0.1,           # per-frame coefficient towards a quieter frame
        "rise_db_s": 0.5,      # slow rise while not speaking
        "warmup_s": 1.0,       # start-up: the floor jumps straight to the quietest frame
        "min_window_s": 10.0,  # the floor is pulled up to the quietest frame of this window
        "flat_s": 1.0,         # window for the stationarity test
        "flat_db": 5.0,        # p90 - p10 spread below this = stationary noise
        "pull": 0.1,           # per-frame coefficient of both upward pulls
        "speech_s": 10.0,      # speech level: louder half of this much recent speech
    }

    def __init__(self, rate: int = 16000, **tuning):
        unknown = set(tuning) - set(self.DEFAULTS)
        if unknown:
            raise TypeError(f"unknown tuning: {', '.join(sorted(unknown))}")
        self.rate = rate
        self.cfg = cfg = {**self.DEFAULTS, **tuning}
        self._per_s = round(rate / FRAME)
        self._rise = cfg["rise_db_s"] * FRAME / rate
        self._warmup = round(cfg["warmup_s"] * rate / FRAME)
        self._recent = collections.deque(maxlen=max(2, round(cfg["flat_s"] * rate / FRAME)))
        self._minima = collections.deque(maxlen=max(1, round(cfg["min_window_s"])))  # per-second minima
        self._second_min, self._second_count = None, 0
        self._speech = collections.deque(maxlen=max(1, round(cfg["speech_s"] * rate / FRAME)))
        self._onset = collections.deque(maxlen=cfg["onset_window"])
        self.noise_db = None
        self.speech_db = None
        self.threshold_db = None
        self.release_level_db = None
        self.speaking = False
        self.level_db = None   # speech-band level of the latest frame
        self._frames = 0
        self._quiet = 0

    def process(self, frame) -> bool:
        frame = np.asarray(frame, dtype=np.float32)
        if len(frame) != FRAME:
            raise ValueError(f"frame must have {FRAME} samples")
        level = float(speech_band_db(frame, self.rate)[0])
        self.level_db = level
        if not np.any(np.abs(frame) > _SILENT):
            if self.noise_db is None:  # silence before anything else: a floor to start from
                self.noise_db = _SILENT_DB
                self._frames = self._warmup  # a real floor estimate, no start-up jump to the first sound
            self._onset.append(False)
            self.speaking = False
            self._quiet = 0
            return False
        self._track_floor(level)
        cfg = self.cfg
        self.threshold_db = max(self.noise_db + cfg["onset_db"], cfg["min_db"])
        self.release_level_db = max(self.noise_db + cfg["release_db"],
                                    cfg["min_db"] - (cfg["onset_db"] - cfg["release_db"]))
        self._onset.append(level >= self.threshold_db)
        if self.speaking:
            self._quiet = self._quiet + 1 if level < self.release_level_db else 0
            if self._quiet >= cfg["release_frames"]:
                self.speaking = False
        elif sum(self._onset) >= cfg["onset_frames"]:
            self.speaking = True
            self._quiet = 0
        if self.speaking:
            self._speech.append(level)
            recent = np.fromiter(self._speech, float, len(self._speech))
            self.speech_db = float(np.mean(recent[recent >= np.median(recent)]))
        return self.speaking

    def _track_floor(self, level):
        cfg = self.cfg
        self._frames += 1
        self._recent.append(level)
        self._second_min = level if self._second_min is None else min(self._second_min, level)
        self._second_count += 1
        if self._second_count == self._per_s:
            self._minima.append(self._second_min)
            self._second_min, self._second_count = None, 0
        if self.noise_db is None or (self._frames <= self._warmup and level < self.noise_db):
            self.noise_db = level
        elif level < self.noise_db:
            self.noise_db += cfg["fall"] * (level - self.noise_db)
        elif not self.speaking:
            self.noise_db = min(level, self.noise_db + self._rise)
        if len(self._minima) == self._minima.maxlen:
            lowest = min(self._minima)
            if lowest > self.noise_db:
                self.noise_db += cfg["pull"] * (lowest - self.noise_db)
        if len(self._recent) == self._recent.maxlen:
            low, high = np.percentile(self._recent, (10, 90))
            if high - low < cfg["flat_db"] and low > self.noise_db:
                self.noise_db += cfg["pull"] * (low - self.noise_db)


def voiced_frames(samples, rate: int = 16000) -> list[bool]:
    """Run a fresh detector over a whole array: one bool per FRAME, last partial frame zero-padded."""
    samples = np.asarray(samples, dtype=np.float32)
    detector = SpeechDetector(rate)
    result = []
    for start in range(0, len(samples), FRAME):
        frame = samples[start:start + FRAME]
        if len(frame) < FRAME:
            frame = np.pad(frame, (0, FRAME - len(frame)))
        result.append(detector.process(frame))
    return result


class Segmenter:
    """Turn a stream of audio blocks into utterance events for the recogniser.

    Events: "preview" (on voiced frames) while speech goes on, "pause" once `pause` seconds of non-speech follow speech, "final" when
    the silence reaches `end_silence`, at a low-energy valley once a part
    reaches `soft_max`, or on flush(). Parts of one utterance never overlap and
    leave no gap. An utterance with less than `min_voiced` seconds of voiced
    audio emits no final; its previews or pause event may already have been sent.
    """

    TAIL = 0.15  # seconds of audio kept after the last voiced frame in pause/final events

    def __init__(self, emit, *, rate=16000, pre_roll=0.3, pause=0.3, end_silence=0.6, min_voiced=0.3,
                 soft_max=8.0, valley_search=3.0, preview_interval=1.5, detector: SpeechDetector | None = None):
        self.emit = emit
        self.rate = rate
        self.detector = detector if detector is not None else SpeechDetector(rate)
        sec = lambda value: int(round(value * rate))
        self.pre_roll, self.pause, self.end_silence = sec(pre_roll), sec(pause), sec(end_silence)
        self.min_voiced, self.soft_max = sec(min_voiced), sec(soft_max)
        self.valley_search, self.preview_interval, self.tail = sec(valley_search), sec(preview_interval), sec(self.TAIL)
        self.position = 0          # stream samples consumed into frames
        self.utterance = 0
        self._pending = np.zeros(0, np.float32)
        self._history = collections.deque(maxlen=self.pre_roll // FRAME + 2)  # (start, samples)
        self._emitted_end = 0      # pre-roll never reaches back into audio already emitted
        self._close()

    # -- state helpers -----------------------------------------------------
    def _close(self):
        self.open = False
        self._records = []         # [start, samples, level_db | None, voiced, now] of the current part
        self._part = 0
        self._voiced = 0           # voiced samples of the whole utterance
        self._silence = 0
        self._part_voiced = False  # a part holding only trailing non-speech emits no pause or final
        self._paused = False
        self._last_pause = None
        self._last_preview = 0
        self._speech_end = None
        self._speech_end_at = None

    def _part_start(self):
        return self._records[0][0]

    def _part_length(self):
        last = self._records[-1]
        return last[0] + len(last[1]) - self._part_start()

    def _audio(self, end=None):
        audio = np.concatenate([r[1] for r in self._records])
        return audio if end is None else audio[:end - self._part_start()]

    def _send(self, kind, audio, **extra):
        start = self._part_start()
        event = {"kind": kind, "audio": audio.copy(), "start": start / self.rate,
                 "end": (start + len(audio)) / self.rate, "utterance": self.utterance, "part": self._part,
                 "speech_end": None if self._speech_end is None else self._speech_end / self.rate,
                 "speech_end_at": self._speech_end_at, **extra}
        self.emit(event)

    def _trimmed_end(self):
        return min(self._speech_end + self.tail, self._part_start() + self._part_length())

    # -- streaming ---------------------------------------------------------
    def process(self, block, now: float | None = None) -> None:
        block = np.asarray(block, dtype=np.float32).ravel()
        data = np.concatenate([self._pending, block]) if len(self._pending) else block
        usable = len(data) - len(data) % FRAME
        for offset in range(0, usable, FRAME):
            self._frame(data[offset:offset + FRAME].copy(), now)
        self._pending = data[usable:].copy()

    def _frame(self, frame, now):
        start = self.position
        self.position += FRAME
        voiced = self.detector.process(frame)
        level = self.detector.level_db
        if not self.open:
            if voiced:
                self._open(start)
            else:
                self._history.append((start, frame))
                return
        self._history.append((start, frame))
        self._records.append([start, frame, level, voiced, now])
        if voiced:
            self._voiced += FRAME
            self._speech_end, self._speech_end_at = start + FRAME, now
            self._silence = 0
            self._part_voiced = True
            self._paused = False
        else:
            self._silence += FRAME
        if self._silence >= self.end_silence:
            self._finish("silence")
        elif self._silence >= self.pause:
            if not self._paused and self._part_voiced:
                self._paused = True
                self._last_pause = self._audio(self._trimmed_end())
                self._send("pause", self._last_pause)
        elif self._part_length() >= self.soft_max:
            self._valley_cut()
        elif voiced and self._part_length() - self._last_preview >= self.preview_interval:
            self._last_preview = self._part_length()
            self._send("preview", self._audio())

    def _open(self, onset):
        self.open = True
        self.utterance += 1
        earliest = max(onset - self.pre_roll, self._emitted_end, 0)
        for start, samples in self._history:
            keep = samples[max(0, earliest - start):]
            if len(keep):
                self._records.append([start + len(samples) - len(keep), keep, None, False, None])

    def _finish(self, cut):
        if self._voiced >= self.min_voiced and self._part_voiced:
            if self._paused:
                audio, same = self._last_pause, True
            else:
                audio, same = self._audio(None if cut == "flush" else self._trimmed_end()), False
            self._send("final", audio, cut=cut, clean=cut == "silence" or self._paused, same_as_pause=same)
            self._emitted_end = self._part_start() + len(audio)
        self._close()

    def _valley_cut(self):
        # Boundary k sits between records k-1 and k; score it by their mean power.
        records = self._records
        end = records[-1][0] + FRAME
        best, best_power = None, None
        for k in range(len(records) - 1, 0, -1):
            if records[k][0] < end - self.valley_search:
                break
            a, b = records[k - 1][2], records[k][2]
            if a is None or b is None:
                continue
            power = (10 ** (a / 10) + 10 ** (b / 10)) / 2
            if best_power is None or power < best_power:
                best, best_power = k, power
        if best is None:
            best, best_power = len(records) - 1, 0.0
        cut = records[best][0]
        valley_db = 10 * np.log10(max(best_power, 1e-12))
        clean = self.detector.release_level_db is not None and valley_db < self.detector.release_level_db
        head, tail = records[:best], records[best:]
        speech_end, speech_end_at = None, None
        for start, samples, _, voiced, now in head:
            if voiced:
                speech_end, speech_end_at = start + len(samples), now
        if self._voiced >= self.min_voiced and speech_end is not None:
            saved = self._speech_end, self._speech_end_at
            self._speech_end, self._speech_end_at = speech_end, speech_end_at
            self._send("final", self._audio(cut), cut="valley", clean=bool(clean), same_as_pause=False)
            self._speech_end, self._speech_end_at = saved
            self._emitted_end = cut
        self._records = tail
        self._part_voiced = any(r[3] for r in tail)
        self._part += 1
        self._last_preview = self._part_length()
        self._last_pause = None

    def flush(self) -> None:
        if self.open and len(self._pending):
            start = self.position
            self.position += len(self._pending)
            self._records.append([start, self._pending.copy(), None, False, None])
        else:
            self.position += len(self._pending)
        self._pending = np.zeros(0, np.float32)
        if self.open:
            self._finish("flush")
