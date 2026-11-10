#!/usr/bin/env python3
"""Download the two pinned models explicitly; runtime never calls this script.

The model directory is outside the repository. Re-running is resumable. Only
files needed for inference are downloaded, including the reviewed PLaMo code.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from huggingface_hub import snapshot_download


DEFAULT_DATA_DIR = Path.home() / "Library/Application Support/Meeting Assistant"
MODELS = (
    (
        "Qwen3 ASR 1.7B 8-bit",
        "mlx-community/Qwen3-ASR-1.7B-8bit",
        "a8379a2e2f9e313c9292cdf1af4055ab56d50d55",
        "qwen3-asr-1.7b-8bit",
        [
            "chat_template.json", "config.json", "generation_config.json", "merges.txt",
            "model.safetensors", "model.safetensors.index.json",
            "preprocessor_config.json", "tokenizer_config.json", "vocab.json",
        ],
        "bf304b009cc7eca79283056f787b44c952d24ac22cec787b39732bba3c23c13c",
    ),
    (
        "PLaMo 3 Translate 0.8B 4-bit",
        "pfnet/plamo-3-translate-0.8b-MLX-4bit",
        "1f9227818908350380fa576794c01f5fbcbf8569",
        "plamo-3-translate-0.8b-4bit",
        [
            "chat_template.jinja", "config.json", "generation_config.json",
            "model.safetensors", "modeling_plamo_mlx.py", "special_tokens_map.json",
            "tokenization_plamo.py", "tokenizer.jsonl", "tokenizer_config.json",
        ],
        "4769685905d03c7f5ceaef316cbef245c9099f548f8dea00ecfdf980d698b29f",
    ),
)


def verify_weight(path: Path, expected: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError(f"Weight checksum mismatch: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir", type=Path, default=DEFAULT_DATA_DIR,
        help="Application data directory; models are stored in its models/ subdirectory",
    )
    args = parser.parse_args()
    models_dir = args.data_dir.expanduser().resolve() / "models"
    models_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, repo, revision, dirname, files, weights_sha256 in MODELS:
        target = models_dir / dirname
        print(f"Downloading {name} at {revision} to {target}...", flush=True)
        snapshot_download(
            repo_id=repo, revision=revision, local_dir=target,
            allow_patterns=files,
        )
        missing = [filename for filename in files if not (target / filename).is_file()]
        if missing:
            raise RuntimeError(f"Incomplete download for {name}: {', '.join(missing)}")
        print(f"Verifying {name} weights...", flush=True)
        verify_weight(target / "model.safetensors", weights_sha256)
        print(f"Ready: {name}", flush=True)


if __name__ == "__main__":
    main()
