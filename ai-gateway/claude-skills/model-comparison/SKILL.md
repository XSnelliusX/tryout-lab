---
name: model-comparison
description: Sync Artificial Analysis benchmarks with the AI gateway's models and open the model comparison dashboard in the browser (same as /model-comparison in OpenCode)
disable-model-invocation: true
---
```!
d="$HOME/.config/opencode/plugins/ai-gateway"
if [ ! -f "$d/index.ts" ]; then echo "The ai-gateway plugin is not installed: run ai-gateway/install.sh (or mac-setup/setup.sh --only gateway)"
elif ! command -v node >/dev/null; then echo "node not found (needs Node 23.6+, mac-setup/setup.sh --only asdf installs it)"
else node "$d/index.ts" compare 2>&1 | tail -8; fi
```

Show the output above to the user as it is, in a code block. Add one sentence only if it reports a problem. Do nothing else.
