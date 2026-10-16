#!/usr/bin/env bash
# Install my Claude Code statusline. Existing files are backed up as *.bak-<timestamp>.
# Usage: ./install.sh   (from this folder)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
stamp="$(date +%Y%m%d-%H%M%S)"
claude_dir="$HOME/.claude"
settings="$claude_dir/settings.json"

mkdir -p "$claude_dir"
[ -e "$claude_dir/statusline.py" ] && cp "$claude_dir/statusline.py" "$claude_dir/statusline.py.bak-$stamp"
cp "$here/statusline.py" "$claude_dir/statusline.py"
echo "installed $claude_dir/statusline.py"

# Merge the statusLine key into settings.json, keeping everything else.
[ -e "$settings" ] && cp "$settings" "$settings.bak-$stamp"
python3 - "$settings" "$claude_dir/statusline.py" <<'PY'
import json, os, sys
path, script = sys.argv[1:3]
data = json.load(open(path)) if os.path.exists(path) else {}
data["statusLine"] = {"type": "command", "command": f"python3 {script}", "refreshInterval": 30}
json.dump(data, open(path, "w"), indent=2)
print(f"set statusLine in {path}")
PY
