"""Read the capture helper and segment speech without blocking audio capture."""

import collections
import json
import subprocess
import threading
from pathlib import Path

RATE = 16000
FRAME = 1600  # 100 ms
THRESHOLD = 0.008


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


class Capture:
    def __init__(self, executable: Path, source, archive, on_chunk, on_level, on_done, on_status=None):
        self.executable = executable
        self.source = source
        self.archive = archive
        self.on_chunk = on_chunk
        self.on_level = on_level
        self.on_done = on_done
        self.on_status = on_status
        self.proc = None
        self.reader = None
        self.stop_requested = False
        self.stderr_tail = collections.deque(maxlen=20)

    def start(self):
        self.proc = subprocess.Popen(
            [str(self.executable), "--source", self.source],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
        )
        self.stderr_reader = threading.Thread(target=self._stderr, daemon=True)
        self.stderr_reader.start()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

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
                    if isinstance(event, dict) and event.get("event") in ("permission", "started", "error"):
                        self.on_status(event)
                except (ValueError, TypeError):
                    pass

    def stop(self):
        self.stop_requested = True
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass

    def _read(self):
        import numpy as np

        parts = []
        pre = collections.deque(maxlen=2)
        samples_seen = 0
        chunk_start = 0
        chunk_length = 0
        silence = 0
        pending = b""
        error = None

        def flush():
            nonlocal parts, chunk_length, silence
            if parts:
                self.on_chunk(np.concatenate(parts), chunk_start / RATE, (chunk_start + chunk_length) / RATE)
            parts = []
            chunk_length = 0
            silence = 0

        def process(block):
            nonlocal samples_seen, chunk_start, chunk_length, silence, parts
            self.archive.write_audio(block)
            level = float(np.sqrt(np.mean(np.square(block, dtype=np.float64)))) if len(block) else 0.0
            self.on_level(level, (samples_seen + len(block)) / RATE)
            start = samples_seen
            samples_seen += len(block)
            voiced = level >= THRESHOLD
            if not parts:
                if not voiced:
                    pre.append((start, block))
                    return
                chunk_start = pre[0][0] if pre else start
                parts = [p[1] for p in pre]
                chunk_length = sum(len(p) for p in parts)
                pre.clear()
            parts.append(block)
            chunk_length += len(block)
            silence = 0 if voiced else silence + len(block)
            if chunk_length >= RATE * 6 or (chunk_length >= RATE and silence >= int(RATE * 0.6)):
                flush()

        try:
            while True:
                data = self.proc.stdout.read(FRAME * 4)
                if not data:
                    break
                pending += data
                while len(pending) >= FRAME * 4:
                    block = np.frombuffer(pending[:FRAME * 4], dtype="<f4").copy()
                    pending = pending[FRAME * 4:]
                    process(np.nan_to_num(block, nan=0.0, posinf=0.0, neginf=0.0))
            usable = len(pending) - len(pending) % 4
            if usable:
                process(np.nan_to_num(np.frombuffer(pending[:usable], dtype="<f4").copy(), nan=0.0, posinf=0.0, neginf=0.0))
            if len(pending) % 4:
                error = "Capture ended with an incomplete audio sample."
            flush()
        except Exception as exc:
            error = f"Audio capture/archive failed: {exc}"
            if self.proc.poll() is None:
                self.proc.terminate()
        finally:
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
            self.stderr_reader.join(timeout=1)
            try:
                self.archive.close_audio()
            except Exception as exc:
                error = error or f"Could not finalize audio archive: {exc}"
            if self.proc.returncode != 0:
                error = error or capture_error(self.stderr_tail)
            elif not self.stop_requested:
                error = error or "Capture ended unexpectedly."
            self.on_done(error)
