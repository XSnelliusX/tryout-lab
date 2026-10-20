---
name: gateway-refresh
description: Re-read the AI gateway API key and reload the model list and prices now (same as /gateway-refresh in OpenCode)
disable-model-invocation: true
---
```!
p="$HOME/.config/opencode/plugins/ai-gateway/index.ts"
if [ ! -f "$p" ]; then echo "The ai-gateway plugin is not installed: run mac-setup/setup.sh --only gateway"
elif ! command -v node >/dev/null; then echo "node not found (needs Node 23.6+, setup.sh --only asdf installs it)"
else node "$p" refresh 2>&1; fi
```

Show the output above to the user as it is, in a code block. Add one sentence only if it reports a problem. Do nothing else.
