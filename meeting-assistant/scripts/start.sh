#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -x .venv/bin/python ]; then
  echo "Virtual environment not found. Run scripts/setup.sh first." >&2
  exit 1
fi
exec .venv/bin/python -m meeting_assistant "$@"
