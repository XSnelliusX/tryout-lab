#!/usr/bin/env bash
# Install my Claude Code statusline and keybindings, and set the statusLine key in settings.json.
# The gateway commands (/gateway-refresh, /usage-dashboard, /model-comparison, ...) and the usage hook come
# from the AI gateway module: ../../ai-gateway/install.sh (setup.sh --only gateway).
# Changed files are shown as a diff and you confirm them; the old ones go to ~/.setup_backup/<stamp>/ first (see lib.sh).
# Usage: ./install.sh   (from this folder)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../lib.sh"
claude_dir="$HOME/.claude"
settings="$claude_dir/settings.json"

install_file "$here/statusline.py" "$claude_dir/statusline.py"
# Ctrl+] undoes input: Ctrl+_ (the default) never reaches Claude Code inside Neovim, LazyVim hides the split on it
install_file "$here/keybindings.json" "$claude_dir/keybindings.json"
# settings.json: only the statusLine key. Everything else in the file (also the usage hook) is kept.
# The merged result goes through install_file, so you see the diff first.
merged="$(mktemp)"
python3 - "$settings" "$merged" "$claude_dir/statusline.py" <<'PY2'
import json, os, sys
path, out, script = sys.argv[1:4]
data = json.load(open(path)) if os.path.exists(path) else {}
data["statusLine"] = {"type": "command", "command": f"python3 {script}", "refreshInterval": 30}
open(out, "w").write(json.dumps(data, indent=2) + "\n")
PY2
install_file "$merged" "$settings"
rm -f "$merged"
