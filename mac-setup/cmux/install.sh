#!/usr/bin/env bash
# Install my cmux setup on this machine. Existing files are backed up as *.bak-<timestamp>.
# Usage: ./install.sh   (from this folder)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
stamp="$(date +%Y%m%d-%H%M%S)"
cmux_dir="$HOME/.config/cmux"
ghostty_dir="$HOME/Library/Application Support/com.mitchellh.ghostty"

put() { # put <source> <destination>
  mkdir -p "$(dirname "$2")"
  [ -e "$2" ] && cp "$2" "$2.bak-$stamp"
  cp "$1" "$2"
  echo "installed $2"
}

put "$here/config/cmux/cmux.json" "$cmux_dir/cmux.json"
for f in "$here"/config/cmux/sidebars/*.js; do
  put "$f" "$cmux_dir/sidebars/$(basename "$f")"
done
put "$here/config/ghostty/config.ghostty" "$ghostty_dir/config.ghostty"

if command -v cmux >/dev/null 2>&1; then
  cmux config doctor || true
  cmux reload-config || true
  cmux sidebar select herdr-style || echo "Enable Settings > Custom Sidebars (beta), then run: cmux sidebar select herdr-style"
else
  echo "cmux CLI not found. Install cmux first (see README), then re-run."
fi
