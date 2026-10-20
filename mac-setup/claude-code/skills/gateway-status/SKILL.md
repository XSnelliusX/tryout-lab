---
name: gateway-status
description: AI gateway settings, API key, a quick gateway check and the last model refresh (like /gateway-status in OpenCode)
disable-model-invocation: true
---
```!
p="$HOME/.config/opencode/plugins/ai-gateway/index.ts"
if [ ! -f "$p" ]; then echo "The ai-gateway plugin is not installed: run mac-setup/setup.sh --only gateway"
elif ! command -v node >/dev/null; then echo "node not found (needs Node 23.6+, setup.sh --only asdf installs it)"
else node "$p" status 2>&1; fi
```

Show the output above to the user as it is, in a code block. Add one sentence only if it reports a problem. Do nothing else.
