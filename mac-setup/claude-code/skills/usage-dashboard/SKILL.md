---
name: usage-dashboard
description: Log the latest Claude Code calls and open the AI usage and cost dashboard in the browser (same as /usage-dashboard in OpenCode)
disable-model-invocation: true
---
```!
d="$HOME/.config/opencode/plugins/ai-gateway"
if [ ! -f "$d/index.ts" ]; then echo "The ai-gateway plugin is not installed: run mac-setup/setup.sh --only gateway"
elif ! command -v node >/dev/null; then echo "node not found (needs Node 23.6+, setup.sh --only asdf installs it)"
else python3 -I "$d/claude_usage.py" --flush </dev/null 2>&1 | tail -3; node "$d/index.ts" dashboard 2>&1; fi
```

Show the output above to the user as it is, in a code block. Add one sentence only if it reports a problem. Do nothing else.
