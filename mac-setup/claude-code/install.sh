#!/usr/bin/env bash
# Install my Claude Code statusline and keybindings, and register the usage hook that logs Claude Code's
# tokens to ~/.gateway-cost (needs the ai-gateway opencode plugin, which ships claude_usage.py;
# set it up with mac-setup/setup.sh --only gateway). Changed files are shown as a diff and you
# confirm them; the old ones go to ~/.setup_backup/<stamp>/ first (see lib.sh).
# Usage: ./install.sh   (from this folder)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../lib.sh"
claude_dir="$HOME/.claude"
settings="$claude_dir/settings.json"
collector="$HOME/.config/opencode/plugins/ai-gateway/claude_usage.py"

install_file "$here/statusline.py" "$claude_dir/statusline.py"
# Ctrl+] undoes input: Ctrl+_ (the default) never reaches Claude Code inside Neovim, LazyVim hides the split on it
install_file "$here/keybindings.json" "$claude_dir/keybindings.json"

# settings.json: the statusLine key, and the usage hook when the plugin is there (or was registered before).
# Everything else in the file is kept. The merged result goes through install_file, so you see the diff first.
with_hook=0
if [ -e "$collector" ] || grep -qs 'claude_usage.py' "$settings"; then with_hook=1; fi
merged="$(mktemp)"
python3 - "$settings" "$merged" "$claude_dir/statusline.py" "$collector" "$with_hook" <<'PY'
import json, os, sys
path, out, script, collector, with_hook = sys.argv[1:6]
data = json.load(open(path)) if os.path.exists(path) else {}
data["statusLine"] = {"type": "command", "command": f"python3 {script}", "refreshInterval": 30}
# Usage hook: after every turn, subagent and session, claude_usage.py appends the new API
# calls from the transcripts to ~/.gateway-cost/usage.jsonl (silent, always exits 0).
# Any usage hook already in settings.json (also one pointing at an older plugin path) is
# replaced, so re-running this script is safe.
if with_hook == "1":
    hooks = data.setdefault("hooks", {})
    command = f'[ -f "{collector}" ] && python3 -I "{collector}"; true'
    for event in ("Stop", "SubagentStop", "SessionEnd"):
        groups = [g for g in hooks.get(event, []) if not any("claude_usage.py" in h.get("command", "") for h in g.get("hooks", []))]
        groups.append({"hooks": [{"type": "command", "command": command, "timeout": 30}]})
        hooks[event] = groups
json.dump(data, open(out, "w"), indent=2)
PY
install_file "$merged" "$settings"
rm -f "$merged"
if [ "$with_hook" = 1 ]; then info "usage hook: Stop, SubagentStop, SessionEnd (claude_usage.py)"; fi

if [ "$with_hook" = 0 ]; then
  info "skipped the usage hook: $collector not found (install the ai-gateway opencode plugin first: mac-setup/setup.sh --only gateway)"
elif [ ! -e "$collector" ]; then
  info "note: $collector does not exist yet, the hook does nothing until the ai-gateway plugin is installed (mac-setup/setup.sh --only gateway)"
elif dry; then
  info "would import the usage history with claude_usage.py"
else
  python3 -I "$collector" </dev/null   # import what is not logged yet (first run: the history)
fi
