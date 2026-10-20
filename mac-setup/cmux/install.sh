#!/usr/bin/env bash
# Install my cmux setup on this machine. A changed file is shown as a diff and you confirm it;
# the old file goes to ~/.setup_backup/<stamp>/ first (see lib.sh).
# Usage: ./install.sh   (from this folder)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../lib.sh"
cmux_dir="$HOME/.config/cmux"
ghostty_dir="$HOME/Library/Application Support/com.mitchellh.ghostty"

install_file "$here/config/cmux/cmux.json" "$cmux_dir/cmux.json"
for f in "$here"/config/cmux/sidebars/*.js; do
  install_file "$f" "$cmux_dir/sidebars/$(basename "$f")"
done
install_file "$here/config/ghostty/config.ghostty" "$ghostty_dir/config.ghostty"

if dry; then
  info "would run: cmux config doctor, cmux reload-config, cmux sidebar select herdr-style"
elif have cmux; then
  cmux config doctor || true
  cmux reload-config || true
  cmux sidebar select herdr-style || echo "Enable Settings > Custom Sidebars (beta), then run: cmux sidebar select herdr-style"
else
  echo "cmux CLI not found. Install cmux first (see README), then re-run."
fi
