#!/usr/bin/env python3
"""Explicitly install NVIDIA's pinned Apple Silicon runtime and V3 GGUF."""

import argparse
import hashlib
import json
import os
import platform
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meeting_assistant.diarization import MODEL_REVISION, MODEL_SHA256, MODEL_SIZE, RUNTIME_VERSION
from meeting_assistant.storage import DATA_DIR

RUNTIME_SHA256 = {
    "metal": "2b972ed8b5dba07492212acf8cb75cbf34ecb141198ffa1997febe84b7c4d9ed",
    "cpu": "2c3a7a719b778daeb14f147e011891f16e4b2ac62388d8b8d8b365cc2eebdf15",
}
MODEL_URL = ("https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/"
             f"{MODEL_REVISION}/Nemotron-3-Diarization.q8_0.gguf")


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise ValueError("Download attempted a non-HTTPS redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, target, sha256, max_size, exact_size=None):
    digest = hashlib.sha256()
    size = 0
    opener = urllib.request.build_opener(HTTPSRedirect())
    with opener.open(urllib.request.Request(url, headers={"User-Agent": "MeetingAssistant/1"}), timeout=60) as response, target.open("xb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > max_size:
                raise ValueError("Download exceeds expected size limit")
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != sha256 or (exact_size is not None and size != exact_size):
        raise ValueError("Downloaded artifact failed SHA-256 or size verification")


def extract_runtime(archive, destination, expected_root):
    # The data filter rejects traversal, absolute links, special files and links
    # escaping the extraction directory. The package contains relative symlinks.
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if len(members) > 10000 or sum(m.size for m in members) > 2 * 1024**3:
            raise ValueError("Runtime archive exceeds extraction limits")
        for member in members:
            name = Path(member.name)
            if not name.parts or name.parts[0] != expected_root or ".." in name.parts or name.is_absolute():
                raise ValueError("Unexpected runtime archive path")
        bundle.extractall(destination, members=members, filter="data")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--backend", choices=("metal", "cpu"), default="metal")
    parser.add_argument("--download", action="store_true", help="Explicitly download the pinned runtime and 107 MB model")
    args = parser.parse_args()
    if not args.download:
        parser.error("pass --download to explicitly download and install the pinned assets")
    if platform.system() != "Darwin" or platform.machine() not in ("arm64", "aarch64"):
        parser.error("these pinned binaries require Apple Silicon macOS")
    os.umask(0o077)
    root = args.data_dir.expanduser().resolve() / "diarization"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    installed = root / f"nemo-speech-{RUNTIME_VERSION}-{args.backend}"
    config_path = root / "config.json"
    if os.path.lexists(installed) or os.path.lexists(config_path):
        parser.error("installation or config already exists; inspect it rather than overwriting")
    name = f"nemo-speech-{RUNTIME_VERSION}-macos-aarch64-{args.backend}"
    url = f"https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v{RUNTIME_VERSION}/{name}.tar.gz"
    print(f"Downloading pinned {args.backend} runtime and V3 model (107 MB); no inference will run.", flush=True)
    with tempfile.TemporaryDirectory(prefix="setup-", dir=root) as temporary:
        stage = Path(temporary)
        archive = stage / "runtime.tar.gz"
        download(url, archive, RUNTIME_SHA256[args.backend], 1024**3)
        extract_runtime(archive, stage, name)
        unpacked = stage / name
        executable = unpacked / "bin" / "nemo-speech"
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValueError("Verified runtime archive has no executable")
        model = unpacked / "models" / "Nemotron-3-Diarization.q8_0.gguf"
        model.parent.mkdir(mode=0o700, exist_ok=True)
        download(MODEL_URL, model, MODEL_SHA256, MODEL_SIZE, MODEL_SIZE)
        executable_hash = hashlib.sha256(executable.read_bytes()).hexdigest()
        # Do not overwrite an existing installation or config, including races.
        os.rename(unpacked, installed)
        config = {"runtime_version": RUNTIME_VERSION, "model_revision": MODEL_REVISION,
                  "device": args.backend, "executable": str(installed / "bin" / "nemo-speech"),
                  "executable_sha256": executable_hash,
                  "model": str(installed / "models" / model.name)}
        fd = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(config, stream, indent=2)
            stream.write("\n")
    print(f"Configured: {config_path}")
    print(f"Executable: {config['executable']}")
    print(f"Model: {config['model']}")
    print("Assets verified; actual hardware compatibility and inference are untested.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as exc:
        print(f"Diarization setup failed: {exc}", file=sys.stderr)
        sys.exit(1)
