# Repository Agent Instructions

## Always Install to OpenCode After Changes

This repository is the source checkout for the local OpenCode `prompt-rewrite` plugin. OpenCode does **not** load directly from this repository directory — it loads shims in `~/.config/opencode/plugins/prompt-rewrite/` that re-export from the installed copy in `~/.local/share/opencode/prompt-rewrite/`.

Whenever you make changes to plugin code, benchmarks/data, RPC schemas, or configuration in this repository:

1. Run the repository unit tests and syntax checks:
   ```sh
   node --test test/*.test.js
   ```
2. Always install the updated version into OpenCode before completing the task:
   ```sh
   node scripts/install.mjs
   ```
   - `scripts/install.mjs` mirrors the repository into `~/.local/share/opencode/prompt-rewrite` (preserving `.env*`), ensures the loader shims in `~/.config/opencode/plugins/prompt-rewrite/` are present, and runs the test suite against the installed copy.
   - Note: If running inside a filesystem sandbox, run `node scripts/install.mjs` with `BypassSandbox: true` so it can write to `~/.local/share/opencode/prompt-rewrite` and `~/.config/opencode/plugins/prompt-rewrite`.
3. Remind the user to restart OpenCode if a session is already running so the newly installed server and TUI plugin files are loaded.
