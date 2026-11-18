#!/usr/bin/env bash
# Install my Herdr desktop app setup (~/.config/herdr-app): settings, keys, my layouts and my mods.
# This is the Herdr app (https://github.com/herdrdev/herdr-app), not the herdr TUI from the brew formula.
# Herdr's shipped mods, layouts and icons are left alone; Herdr writes those itself.
# A changed file is shown as a diff and you confirm it; the old file goes to ~/.setup_backup/<stamp>/ first (see lib.sh).
# Usage: ./install.sh   (from this folder; DRY_RUN=1 ./install.sh only reports)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../lib.sh"
cfg="$here/config"
dst="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

app=""
for d in /Applications "$HOME/Applications"; do   # the cask and the DMG use /Applications, the install script ~/Applications
  if [ -z "$app" ] && [ -d "$d/Herdr.app" ]; then app="$d/Herdr.app"; fi
done
if [ -z "$app" ] && ! have herdr-app; then
  if dry; then info "Herdr.app is not installed (yet): showing what would be written anyway"
  else
    echo "Herdr.app not found. Install it (brew install --cask herdr-app), launch it once, then re-run (see README.md)."
    exit 0
  fi
fi

install_file "$cfg/settings.json" "$dst/settings.json"
install_file "$cfg/keys.json" "$dst/keys.json"
for f in "$cfg"/layouts/*; do
  t="$dst/layouts/$(basename "$f")"
  # The repo keeps layouts without the live "commander-term" block (update-config.sh strips it, cc-commander adds it
  # back on start), so a live layout that only differs by that block is the same layout: leave it alone.
  if [[ "$f" == *.json ]] && [ -f "$t" ]; then
    lt="$(mktemp)"; python3 "$here/user_files.py" layout "$t" "$lt"
    if cmp -s "$lt" "$f"; then rm -f "$lt"; info "unchanged $t"; continue; fi
    rm -f "$lt"
  fi
  install_file "$f" "$t"
done
# gpui-kit.d.ts and jsconfig.json are written into every mod folder by Herdr: never synced.
for m in "$cfg"/mods/*/; do
  install_tree "$m" "$dst/mods/$(basename "$m")" gpui-kit.d.ts jsconfig.json
done

if dry; then
  info "would run: herdr-app check on every mod above"
elif have herdr-app; then
  for m in "$cfg"/mods/*/; do
    n="$(basename "$m")"
    if herdr-app check "$dst/mods/$n" >/dev/null 2>&1; then info "check ok $n"
    else info "check FAILED $n: run herdr-app check $dst/mods/$n"; fi
  done
  info "switch to the layout with: herdr-app do layout.switch command-center   (or cmd-shift-l in Herdr)"
else
  # the cask links herdr-app into the brew bin folder, and Herdr itself creates ~/.local/bin/herdr-app on launch
  info "herdr-app CLI not on PATH: launch Herdr once (it creates ~/.local/bin/herdr-app), or: ln -s \"${app:-/Applications/Herdr.app}/Contents/MacOS/Herdr\" ~/.local/bin/herdr-app"
fi
if ! have hc && [ ! -x "$HOME/.local/bin/hc" ]; then
  info "hc (herdr-core, which runs the terminals) is not on PATH yet: launch Herdr once; if it is still missing,"
  info "the official installer adds it: curl -fsSL https://releases.herdr.dev/app/install.sh | sh"
fi
