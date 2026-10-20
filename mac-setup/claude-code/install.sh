#!/usr/bin/env bash
# Install my Claude Code statusline, and register the usage hook that logs Claude Code's
# tokens to ~/.gateway-cost (needs the ai-gateway opencode plugin, which ships claude_usage.py;
# set it up with mac-setup/setup.sh --only gateway). Existing files are backed up as *.bak-<timestamp>.
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

# Usage hook: after every turn, subagent and session, claude_usage.py appends the new API
# calls from the transcripts to ~/.gateway-cost/usage.jsonl (silent, always exits 0).
# Any usage hook already in settings.json (also one pointing at an older plugin path) is
# replaced, so re-running this script is safe.
collector="$HOME/.config/opencode/plugins/ai-gateway/claude_usage.py"
if [ -e "$collector" ] || grep -q 'claude_usage.py' "$settings"; then
  python3 - "$settings" "$collector" <<'PY'
import json, sys
path, collector = sys.argv[1:3]
data = json.load(open(path))
hooks = data.setdefault("hooks", {})
command = f'[ -f "{collector}" ] && python3 -I "{collector}"; true'
for event in ("Stop", "SubagentStop", "SessionEnd"):
    groups = [g for g in hooks.get(event, []) if not any("claude_usage.py" in h.get("command", "") for h in g.get("hooks", []))]
    groups.append({"hooks": [{"type": "command", "command": command, "timeout": 30}]})
    hooks[event] = groups
json.dump(data, open(path, "w"), indent=2)
print(f"registered the usage hook (Stop, SubagentStop, SessionEnd) in {path}")
PY
  if [ -e "$collector" ]; then
    python3 -I "$collector" </dev/null   # import what is not logged yet (first run: the history)
  else
    echo "note: $collector does not exist yet, the hook does nothing until the ai-gateway plugin is installed (mac-setup/setup.sh --only gateway)"
  fi
else
  echo "skipped the usage hook: $collector not found (install the ai-gateway opencode plugin first: mac-setup/setup.sh --only gateway)"
fi
