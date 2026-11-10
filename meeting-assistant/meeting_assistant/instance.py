"""Single-server ownership for a data directory; never kill another process."""

import fcntl
import os
from pathlib import Path


class InstanceLock:
    def __init__(self, data_dir):
        self.fd = None
        root = Path(os.path.abspath(data_dir))
        if any(part.is_symlink() for part in (root, *root.parents)):
            raise ValueError("Application data paths must not contain symlinks.")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(root / ".server.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.fd = fd
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            self.fd = None
            raise ValueError("Another Meeting Assistant server owns this data directory. Stop it with Ctrl+C before relaunching; no existing process was interrupted.") from None

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __del__(self):
        self.close()
