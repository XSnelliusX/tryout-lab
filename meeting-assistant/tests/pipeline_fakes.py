"""Fakes shared by the pipeline, capture and event-stream tests: no real models or capture."""

import json
import os
import stat
import sys
import tempfile
import textwrap
import threading
import time
from pathlib import Path

import numpy as np

from meeting_assistant.inference import Cancelled
from meeting_assistant.server import Application


class FakeModel:
    """Records calls; text depends on the audio's first sample so tests can tell decodes apart."""

    def __init__(self):
        self.calls = []
        self.asr_gate = None            # threading.Event: transcribe waits for it (polling should_cancel)
        self.asr_started = threading.Event()
        self.mt_gate = None
        self.mt_started = threading.Event()
        self.text = None                # fixed text; default: derived from the audio
        self.translation = "translated"
        self.partials = ()              # partial translations passed to on_text
        self.partial_delay = 0.0
        self.before_translation = None
        self.fail_asr = None
        self.lock = threading.Lock()

    def asr_calls(self):
        return [c for c in self.calls if c[0] == "asr"]

    def mt_calls(self):
        return [c for c in self.calls if c[0] == "mt"]

    def transcribe(self, audio, sample_rate=16000, **kwargs):
        with self.lock:
            self.calls.append(("asr", len(audio), kwargs))
        self.asr_started.set()
        cancel = kwargs.get("should_cancel") or (lambda: False)
        if self.asr_gate is not None:
            while not self.asr_gate.wait(0.002):
                if cancel():
                    raise Cancelled("cancelled")
        if cancel():
            raise Cancelled("cancelled")
        if self.fail_asr:
            raise RuntimeError(self.fail_asr)
        if self.text is not None:
            text = self.text
        else:
            value = int(round(float(audio[0]) * 1000)) if len(audio) else 0
            text = f"文字{value}" if value else ""
        return {"raw_text": text, "traditional_text": text, "language": "Chinese", "no_speech": not text.strip(),
                "truncated": False, "redecoded": False, "gain_db": 4.5, "asr_ms": 7,
                "prompt_tokens": 1, "generation_tokens": 1}

    def translate(self, text, **kwargs):
        with self.lock:
            self.calls.append(("mt", text, kwargs))
        self.mt_started.set()
        cancel = kwargs.get("should_cancel") or (lambda: False)
        if self.before_translation:
            action, self.before_translation = self.before_translation, None
            action()
        if self.mt_gate is not None:
            while not self.mt_gate.wait(0.002):
                if cancel():
                    raise Cancelled("cancelled")
        on_text = kwargs.get("on_text")
        for partial in self.partials:
            if cancel():
                raise Cancelled("cancelled")
            if on_text:
                on_text(partial)
            if self.partial_delay:
                time.sleep(self.partial_delay)
        if cancel():
            raise Cancelled("cancelled")
        return self.translation


class FakeArchive:
    id = "fixture"

    def __init__(self):
        self.events = []
        self.closed = None

    def log(self, event):
        self.events.append(json.loads(json.dumps(event, default=str)))

    def close(self, status):
        self.closed = status

    def close_audio(self):
        pass

    def write_audio(self, samples):
        pass


def audio(value, seconds=1.0):
    """Synthetic utterance audio whose first sample identifies it to FakeModel."""
    return np.full(int(seconds * 16000), value, dtype=np.float32)


def event(kind, utterance=1, part=0, start=0.0, end=1.0, value=0.1, same_as_pause=False, speech_end_at=None,
          cut=None):
    samples = audio(value, end - start)
    result = {"kind": kind, "audio": samples, "start": start, "end": end, "utterance": utterance, "part": part,
              "speech_end": end - 0.15, "speech_end_at": time.monotonic() if speech_end_at is None else speech_end_at}
    if kind == "final":
        result.update(cut=cut or "silence", clean=True, same_as_pause=same_as_pause)
    return result


class AppCase:
    """Mixin: an Application on a temporary data directory with a fake model."""

    threads = False

    def make_app(self, helper=None, model=None):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.model = model or FakeModel()
        self.app = Application(self.root / "data", model=self.model, helper=helper or self.root / "missing-helper",
                               start_threads=self.threads)
        return self.app

    def tearDown(self):
        app = getattr(self, "app", None)
        if app is not None:
            capture = app.capture
            if capture is not None and capture.proc is not None and capture.proc.poll() is None:
                capture.proc.kill()
            app.close()
            if app.worker is not None:
                app.worker.join(timeout=2)
            app.instance_lock.close()
        if getattr(self, "temp", None) is not None:
            self.temp.cleanup()

    def begin(self, session_id="fixture"):
        """Put the app into the recording state start() would create, without a helper."""
        app = self.app
        app.library.register_session(session_id, "teams")
        app.session_id = app.capture_session = session_id
        app.archive = FakeArchive()
        app.capture_profile = {"context": "Container security", "vocabulary": [{"term": "容器"}]}
        app.capture_audio = {"device_uid": "", "language": "zh", "normalize": False}
        app.recording_state = "recording"
        return app

    def drain(self, limit=1000):
        """Run queued jobs on this thread until none are left."""
        ran = []
        for _ in range(limit):
            job = self.app.jobs.next(timeout=0)
            if job is None:
                break
            ran.append(job.type)
            self.app.run_job(job)
        return ran

    def saved(self, session_id="fixture"):
        return self.app.library.get_session(session_id)["segments"]

    def wait_for(self, predicate, timeout=5.0, message="condition"):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.005)
        raise AssertionError(f"timed out waiting for {message}")


FAKE_HELPER = r'''#!{python}
"""Fake capture helper for tests: speaks protocol {protocol} and writes synthetic PCM."""
import json, math, os, signal, sys, time

def status(event, **fields):
    fields["event"] = event
    sys.stderr.write(json.dumps(fields) + "\n")
    sys.stderr.flush()

args = sys.argv[1:]
mode = os.environ.get("FAKE_HELPER_MODE", "{mode}")
log = os.environ.get("FAKE_HELPER_LOG")
if log:
    with open(log, "a") as out:
        out.write(json.dumps({{"args": args, "sid": os.getsid(0), "pgid": os.getpgid(0)}}) + "\n")
if args == ["--version"]:
    if {protocol} >= 2:
        status("version", protocol={protocol})
        sys.exit(0)
    status("error", message="Usage: capture-audio --source teams|system|microphone")
    sys.exit(2)
if args == ["--list-devices"]:
    status("device", uid="BuiltIn", name="MacBook Pro Microphone", transport="built-in", sample_rate=48000,
           channels=1, is_default=True, input_volume=0.62, input_volume_settable=True)
    status("device", uid="USB-1", name="USB Mic", transport="usb", sample_rate=44100, channels=2,
           is_default=False, input_volume=None, input_volume_settable=False, extra="ignored")
    sys.exit(0)
if len(args) < 2 or args[0] != "--source":
    status("error", message="usage")
    sys.exit(2)
if mode == "ignore-term":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
device = None
if args[1] == "microphone":
    device = dict(uid=args[3] if len(args) > 3 else "BuiltIn", name="MacBook Pro Microphone", transport="built-in",
                  sample_rate=48000, channels=1, input_volume=0.5, input_volume_settable=True)
fields = dict(source=args[1], format="f32le", sample_rate=16000, channels=1)
if {protocol} >= 2:
    fields["protocol"] = {protocol}
    if device:
        fields["device"] = device
status("started", **fields)
status("format", sample_rate=48000, channels=1)
RATE = 16000
speed = float(os.environ.get("FAKE_HELPER_SPEED", "20"))  # times real time

def chunk(seconds, speech, t0):
    n = int(seconds * RATE)
    out = bytearray()
    import struct
    for i in range(n):
        t = t0 + i / RATE
        if speech:
            env = 0.5 + 0.5 * math.sin(2 * math.pi * 3 * t)
            value = 0.2 * env * math.sin(2 * math.pi * 700 * t) + 0.05 * math.sin(2 * math.pi * 1900 * t)
        else:
            value = 0.0
        out += struct.pack("<f", value)
    return bytes(out)

def play(plan):
    t = 0.0
    for seconds, speech in plan:
        remaining = seconds
        while remaining > 1e-9:
            step = min(0.1, remaining)
            sys.stdout.buffer.write(chunk(step, speech, t))
            sys.stdout.buffer.flush()
            t += step
            remaining -= step
            time.sleep(step / speed)

try:
    if mode in ("utterances", "ignore-term", "forever"):
        play([(0.5, False), (1.5, True), (1.2, False), (1.5, True), (1.2, False)])
        if mode == "ignore-term":
            status("input", input_volume=0.8)
        while True:
            play([(0.5, False)])
    elif mode == "speech-at-stop":
        play([(0.5, False), (1.5, True)])
        while True:
            play([(0.3, True)])
    elif mode == "stall":
        play([(0.5, False), (1.5, True)])
        time.sleep(60)  # stdout stays open, no frames
    elif mode == "fail":
        status("error", message="Microphone permission denied or restricted.")
        sys.exit(1)
except BrokenPipeError:
    sys.exit(0)
'''


def write_helper(directory, protocol=2, mode="utterances"):
    path = Path(directory) / f"fake-helper-p{protocol}-{mode}"
    path.write_text(FAKE_HELPER.format(python=sys.executable, protocol=protocol, mode=mode))
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def env_mode(mode):
    os.environ["FAKE_HELPER_MODE"] = mode


def dedent(text):
    return textwrap.dedent(text)
