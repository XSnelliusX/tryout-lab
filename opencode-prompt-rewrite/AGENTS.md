# Repository Agent Instructions

## Always Install to OpenCode After Changes

This repository is the source checkout for the local OpenCode `prompt-rewrite` plugin. OpenCode does **not** load directly from this repository directory — it loads shims in `~/.config/opencode/plugins/prompt-rewrite/` that re-export from the installed copy in `~/.local/share/opencode/prompt-rewrite/`.

Whenever you make changes to plugin code, RPC schemas, or configuration in this repository:

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

## Gateway and benchmark data

This repository must not contain gateway ids/URLs, internal model data or benchmark datasets. Catalog and scores are read at runtime from the sibling `ai-gateway` module (`$GATEWAY_COST_DIR/models.json` and `$GATEWAY_COST_DIR/model-comparison/data/models.json`); see `README.md`. Tests use synthetic fixtures (`test/fixtures.js`) with made-up ids and must not read the real machine's gateway files.
