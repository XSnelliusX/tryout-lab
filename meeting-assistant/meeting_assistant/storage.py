"""Private, append-oriented local session archive."""

import json
import os
import threading
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path.home() / "Library" / "Application Support" / "Meeting Assistant"


class Archive:
    def __init__(self, root: Path, source: str):
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
        self.path = root / self.id
        self.path.mkdir(mode=0o700)
        self.lock = threading.Lock()
        self.journal = (self.path / "events.jsonl").open("a", encoding="utf-8")
        os.chmod(self.path / "events.jsonl", 0o600)
        self.audio = wave.open(str(self.path / "audio.wav"), "wb")
        os.chmod(self.path / "audio.wav", 0o600)
        self.audio.setnchannels(1)
        self.audio.setsampwidth(2)
        self.audio.setframerate(16000)
        self.log({"type": "session_started", "source": source, "at": datetime.now(timezone.utc).isoformat()})

    def log(self, event):
        with self.lock:
            self.journal.write(json.dumps(event, ensure_ascii=False) + "\n")
            self.journal.flush()

    def write_audio(self, samples):
        import numpy as np

        pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
        # Update the WAV header as we go so an interrupted process leaves a
        # playable archive up to the most recently written block.
        self.audio.writeframes(pcm.tobytes())

    def close_audio(self):
        self.audio.close()

    def close(self, status):
        self.log({"type": "session_finished", "status": status, "at": datetime.now(timezone.utc).isoformat()})
        with self.lock:
            self.journal.close()
