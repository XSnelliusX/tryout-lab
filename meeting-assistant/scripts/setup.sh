#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v python3.13 >/dev/null 2>&1; then
  echo "Python 3.13 is required. Install it and rerun scripts/setup.sh." >&2
  exit 1
fi
if [ ! -f requirements-models.txt ]; then
  echo "requirements-models.txt is missing. Wait for the model dependencies to be added, then rerun scripts/setup.sh." >&2
  exit 1
fi
if [ ! -f scripts/build_capture.sh ] || [ ! -f scripts/download_models.py ]; then
  echo "Capture build or model download script is missing. Wait for implementation to finish, then rerun scripts/setup.sh." >&2
  exit 1
fi

python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements-models.txt -c requirements-lock.txt numpy
bash scripts/build_capture.sh
.venv/bin/python scripts/download_models.py
echo "Setup complete. Start with scripts/start.sh."
