"""Capture helper process, audio reader thread and helper capability probes.

The reader thread does no application work: per block it archives the audio,
updates the level meter and feeds the segmenter, whose events go straight to
the caller's thread-safe handoff. A wall-clock watchdog flushes an open
utterance when the source stops delivering frames, so a stalled source cannot
hold back a final.
"""

import collections
import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

from .levels import LevelMeter
from .vad import Segmenter

RATE = 16000
READ_BYTES = 16384  # raw pipe reads return whatever has arrived, up to this
STALL_SECONDS = 2.0  # flush an open utterance after this long without frames
_CLEAN_STOP_CODES = {0, -signal.SIGTERM, -signal.SIGKILL, -signal.SIGINT}


def capture_error(lines):
    """Extract the actual native failure instead of displaying a JSON stderr dump."""
    for line in reversed(list(lines)):
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict) or event.get("event") != "error":
            continue
        if event.get("domain") == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" and event.get("code") == -3801:
            return (
                "Screen & System Audio Recording permission was denied (-3801). "
                "Enable the app that launched this tool: Terminal for the double-click launcher, "
                "or cmux/your terminal app if started there. Fully quit and reopen that launcher "
                "after granting access. See the permission guide below the audio source. "
                "For an in-person meeting, Microphone uses separate Microphone permission."
            )
        message = event.get("message")
        if isinstance(message, str) and message:
            return message
    return "Capture failed. Check the selected source, macOS permissions, and the permission guide."


# -- helper capability probes ---------------------------------------------------

_DEVICE_FIELDS = {"uid": str, "name": str, "transport": str, "sample_rate": (int, float), "channels": int,
                  "is_default": bool, "input_volume": (int, float, type(None)), "input_volume_settable": bool}
_probe_lock = threading.Lock()
_protocol_cache = {}
_devices_cache = {}


def _stderr_events(text):
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


def clean_device(event):
    """Keep only the documented device fields with the documented types."""
    if not isinstance(event, dict):
        return None
    device = {}
    for key, kind in _DEVICE_FIELDS.items():
        value = event.get(key)
        if kind is bool:
            value = value if isinstance(value, bool) else None
        elif isinstance(value, bool) or not isinstance(value, kind):
            value = None
        if isinstance(value, str):
            value = value[:300]
        device[key] = value
    return device if device.get("uid") or device.get("name") else None


def helper_protocol(helper):
    """1 for an old helper binary, 2 for one that answers --version; None if missing. Cached per mtime."""
    helper = Path(helper)
    try:
        stat = helper.stat()
    except OSError:
        return None
    if not os.access(helper, os.X_OK):
        return None
    key = (str(helper), stat.st_mtime_ns, stat.st_size)
    with _probe_lock:
        if key in _protocol_cache:
            return _protocol_cache[key]
    protocol = 1
    try:
        done = subprocess.run([str(helper), "--version"], capture_output=True, timeout=3,
                              stdin=subprocess.DEVNULL, start_new_session=True)
        if done.returncode == 0:
            for event in _stderr_events(done.stderr.decode("utf-8", "replace")):
                if event.get("event") == "version" and isinstance(event.get("protocol"), int):
                    protocol = event["protocol"]
    except (OSError, subprocess.SubprocessError):
        protocol = 1
    with _probe_lock:
        _protocol_cache[key] = protocol
    return protocol


def helper_stale(helper, source):
    """True when the Swift source is newer than the built helper binary."""
    try:
        return Path(source).stat().st_mtime > Path(helper).stat().st_mtime
    except OSError:
        return False


def list_devices(helper, max_age=5.0):
    """{"supported": bool, "devices": [...]} from the helper's --list-devices, cached for max_age seconds."""
    if helper_protocol(helper) != 2:
        return {"supported": False, "devices": []}
    key = str(helper)
    now = time.monotonic()
    with _probe_lock:
        cached = _devices_cache.get(key)
        if cached and now - cached[0] < max_age:
            return {"supported": True, "devices": [dict(d) for d in cached[1]]}
        devices = []
        try:
            done = subprocess.run([str(helper), "--list-devices"], capture_output=True, timeout=5,
                                  stdin=subprocess.DEVNULL, start_new_session=True)
            if done.returncode != 0:
                raise ValueError("The capture helper could not list input devices.")
            for event in _stderr_events(done.stderr.decode("utf-8", "replace")):
                if event.get("event") == "device":
                    device = clean_device(event)
                    if device:
                        devices.append(device)
        except subprocess.TimeoutExpired:
            raise ValueError("Listing input devices timed out.") from None
        except OSError:
            raise ValueError("The capture helper could not be run.") from None
        _devices_cache[key] = (time.monotonic(), devices)
        return {"supported": True, "devices": [dict(d) for d in devices]}


def clear_probe_cache():
    with _probe_lock:
        _protocol_cache.clear()
        _devices_cache.clear()


# -- capture -------------------------------------------------------------------

class Capture:
    """Run the helper and turn its PCM into level updates and segmenter events.

    Callbacks (all must be quick and must not block on application locks):
      on_segment(event)     Segmenter event, from the reader or watchdog thread
      on_block(capture, now) after each block: levels/detector state are current
      on_status(event)      helper stderr event (started, format, input, permission, error)
      on_done(error)        once, after the final flush; error is None for a clean stop
    """

    def __init__(self, executable: Path, source, archive, *, on_segment, on_block=None, on_status=None,
                 on_done=None, device_uid=None, segmenter_options=None, stall_seconds=STALL_SECONDS):
        self.executable = executable
        self.source = source
        self.archive = archive
        self.on_segment = on_segment
        self.on_block = on_block
        self.on_status = on_status
        self.on_done = on_done
        self.device_uid = device_uid
        self.stall_seconds = stall_seconds
        self.proc = None
        self.reader = None
        self.stderr_reader = None
        self.watchdog = None
        self.stop_requested = False
        self.stderr_tail = collections.deque(maxlen=20)
        self.meter = LevelMeter(RATE)
        self.segmenter = Segmenter(self._emit, rate=RATE, **(segmenter_options or {}))
        self.detector = self.segmenter.detector
        self.samples = 0
        self.last_frame_at = None
        self.stall_flushes = 0
        self._seg_lock = threading.Lock()
        self._finished = threading.Event()

    def command(self):
        command = [str(self.executable), "--source", self.source]
        if self.device_uid:
            command += ["--device", self.device_uid]
        return command

    def start(self):
        # A new session keeps terminal Ctrl-C away from the helper: the app stops
        # it explicitly and still collects the final audio.
        self.proc = subprocess.Popen(self.command(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
        self.stderr_reader = threading.Thread(target=self._stderr, name="capture-stderr", daemon=True)
        self.stderr_reader.start()
        self.reader = threading.Thread(target=self._read, name="capture-reader", daemon=True)
        self.reader.start()
        self.watchdog = threading.Thread(target=self._watch, name="capture-watchdog", daemon=True)
        self.watchdog.start()

    def _emit(self, event):
        # Called by the segmenter with _seg_lock held.
        self.on_segment(event)

    def _stderr(self):
        # Drain diagnostics so a verbose helper cannot block the audio pipe.
        while True:
            line = self.proc.stderr.readline(4096)
            if not line:
                break
            message = line.decode("utf-8", "replace").strip()
            self.stderr_tail.append(message)
            if self.on_status:
                try:
                    event = json.loads(message)
                except (ValueError, TypeError):
                    continue
                if isinstance(event, dict) and event.get("event") in ("permission", "started", "error", "format", "input"):
                    try:
                        self.on_status(event)
                    except Exception:
                        pass  # Diagnostics must never stop the drain.

    def stop(self):
        self.stop_requested = True
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass

    def _watch(self):
        while not self._finished.wait(0.25):
            with self._seg_lock:
                if self._finished.is_set():
                    return
                last = self.last_frame_at
                if self.segmenter.open and last is not None and time.monotonic() - last >= self.stall_seconds:
                    self.stall_flushes += 1
                    self.segmenter.flush()

    def _process(self, block):
        import numpy as np

        block = np.nan_to_num(block, nan=0.0, posinf=0.0, neginf=0.0)
        self.archive.write_audio(block)
        now = time.monotonic()
        self.meter.update(block)
        with self._seg_lock:
            self.samples += len(block)
            self.last_frame_at = now
            self.segmenter.process(block, now)
            if self.on_block:
                self.on_block(self, now)

    def _read(self):
        import numpy as np

        pending = b""
        error = None
        flushed = False
        try:
            while True:
                data = self.proc.stdout.read(READ_BYTES)
                if not data:
                    break
                pending += data
                usable = len(pending) - len(pending) % 4
                if usable:
                    self._process(np.frombuffer(pending[:usable], dtype="<f4").copy())
                    pending = pending[usable:]
            if pending:
                error = "Capture ended with an incomplete audio sample."
            with self._seg_lock:
                self.segmenter.flush()
            flushed = True
        except Exception as exc:
            error = f"Audio capture/archive failed: {exc}"
            if self.proc.poll() is None:
                self.proc.terminate()
        finally:
            if not flushed:
                try:
                    with self._seg_lock:
                        self.segmenter.flush()
                except Exception:
                    pass  # Report the original capture/archive failure.
            self._finished.set()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
            self.stderr_reader.join(timeout=1)
            for stream in (self.proc.stdout, self.proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass
            try:
                self.archive.close_audio()
            except Exception as exc:
                error = error or f"Could not finalize audio archive: {exc}"
            code = self.proc.returncode
            if self.stop_requested and code in _CLEAN_STOP_CODES:
                pass  # A requested stop, even by signal, is a clean end.
            elif code != 0:
                error = error or capture_error(self.stderr_tail)
            elif not self.stop_requested:
                error = error or "Capture ended unexpectedly."
            if self.on_done:
                self.on_done(error)
