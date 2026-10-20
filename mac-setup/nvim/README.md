# Neovim (LazyVim)

My editor config: [LazyVim](https://www.lazyvim.org) v16 on Neovim 0.12, with language extras for Go, Python, TypeScript, YAML/Kubernetes, Helm, Docker, Terraform and SQL, AI prediction through the AI gateway, and Claude Code and OpenCode in a split. Keys and day-to-day usage: [usage.md](usage.md).

Why LazyVim: it works out of the box (work machine, no time to build a config), the defaults are documented and discoverable (press `Space` and wait), and one line enables a whole language. Kickstart, AstroNvim, NvChad, Helix and plain Neovim 0.12 (`vim.pack`) were compared; kickstart is nice for learning but means maintaining every line myself.

## Install

`./setup.sh --only neovim` (from `mac-setup/`) copies this folder to `~/.config/nvim` (Markdown files excluded) and installs the plugins at the versions in `lazy-lock.json`. If `~/.config/nvim` holds a different (non-LazyVim) config, it and its data (`~/.local/share/nvim`, `~/.local/state/nvim`, `~/.cache/nvim`) are moved to `~/.setup_backup/<stamp>/` first (after you confirm).

Needs (all from `setup.sh`'s `packages` step): Neovim ≥ 0.11.2, `tree-sitter-cli`, a C compiler (Xcode CLT), `ripgrep`, `fd`, `lazygit`, `git`, Go/Python/Node through asdf. Optional for image previews in docs: `brew install imagemagick ghostscript` (`:checkhealth snacks` lists them as errors, everything else works without).

The first start installs the Mason tools (LSP servers, formatters, linters) in the background, a few minutes; `:Mason` shows progress. Then check with `:checkhealth` (see [Troubleshooting](#troubleshooting) for the expected leftovers).

After changing the config live, pull it back with `../update-config.sh` (diff per file, asks before copying), review with `git diff`, commit.

## Files

| File | What it does |
|---|---|
| `init.lua` | Loads `lua/config/lazy.lua` (nothing else, LazyVim convention) |
| `lua/config/lazy.lua` | Bootstraps lazy.nvim, imports LazyVim and the **extras** (the language list) |
| `lua/config/options.lua` | Options on top of [LazyVim's defaults](https://www.lazyvim.org/configuration/general): basedpyright, asdf shims on `PATH`, unused providers off |
| `lua/config/keymaps.lua`, `autocmds.lua` | Own keymaps/autocmds (empty, the defaults are enough so far) |
| `lua/plugins/*.lua` | Plugin specs, merged into LazyVim's: `ai.lua` (minuet, opencode), `lang.lua` (yamlls, basedpyright, bashls, markdownlint), `colorscheme.lua` (Catppuccin Mocha) |
| `lua/gateway/` | AI gateway settings and the env file reader (`init.lua`), and the usage logger (`usage.lua`) |
| `lazy-lock.json` | Exact plugin commits. `:Lazy update` changes it; commit it so both Macs run the same versions |
| `lazyvim.json` | LazyVim's state (news, version). Extras toggled in `:LazyExtras` land here; I keep them in `lazy.lua` instead |
| `.markdownlint.yaml` | Turns off line length (MD013) and table style (MD060) for my notes |

How to change things the LazyVim way: a file in `lua/plugins/` returns plugin specs; a spec with the same name as a LazyVim plugin is **merged** into it (`opts` tables are deep-merged, `keys` added). So `{ "neovim/nvim-lspconfig", opts = { servers = { bashls = {} } } }` adds a server without copying LazyVim's LSP setup. `<leader>sp` searches the specs of every installed plugin, which is the fastest way to see LazyVim's defaults for one.

## Languages

| Language | Extra | LSP | Format / lint |
|---|---|---|---|
| Go | `lang.go` | gopls | goimports, gofumpt; golangci-lint; delve (debug), neotest-golang |
| Python | `lang.python` | basedpyright (`standard` mode), ruff | ruff; debugpy, neotest-python, venv-selector (`<leader>cv`) |
| TypeScript/JS | `lang.typescript` | vtsls | (prettier when installed) |
| YAML / Kubernetes | `lang.yaml` | yamlls + SchemaStore | Kubernetes schema for `k8s/**`, `manifests/**`, `deploy*/**`, `*.k8s.yaml` |
| Helm | `lang.helm` | helm-ls | |
| Docker | `lang.docker` | dockerls, docker-compose-ls | hadolint |
| Terraform | `lang.terraform` | terraform-ls | tflint |
| SQL | `lang.sql` | | sqlfluff; dadbod UI (`<leader>D`) |
| JSON / TOML | `lang.json`, `lang.toml` | jsonls, taplo | |
| Markdown | `lang.markdown` | marksman | markdownlint-cli2, render-markdown, preview (`<leader>cp`) |
| Shell | own (`lang.lua`) | bashls | shellcheck, shfmt |
| Lua | core | lua_ls | stylua |

Other extras: `dap.core` (debugger, `<leader>d`), `test.core` (neotest, `<leader>t`), `util.rest` (kulala HTTP client, `.http` files, `<leader>R`), `ai.claudecode`.

Kubernetes: any YAML can pick its own schema with `# yaml-language-server: $schema=<url>` on line 1. Run k9s in a terminal split (`<leader>ft`).

Runtimes come from asdf (`.tool-versions` in the repo root, `~/.tool-versions` as the fallback). `options.lua` puts `~/.asdf/shims` on Neovim's `PATH`, so Mason, gopls and basedpyright use the pinned versions even when Neovim was not started from a shell. After changing the Python version, reinstall Mason's Python tools (`:Mason`, select, `X` to uninstall, `i` to install): their virtualenvs belong to the old Python.

> asdf gotcha: gopls calls `go`, and the asdf shim fails with "No version is set for command go" in folders without a `.tool-versions`. Keep `golang <version>` in `~/.tool-versions`.

## AI

Everything goes through endpoints the company controls: the AI gateway (LiteLLM) for prediction, and Claude Code / OpenCode with their own setup. No Copilot, Codeium, Supermaven or Tabnine (vendor clouds).

### Inline prediction (ghost text)

[minuet-ai.nvim](https://github.com/milanglacier/minuet-ai.nvim) asks a fast model for the code at the cursor after a 400 ms typing pause (at most one request per second) and shows it as grey ghost text. It runs automatically in Go, Python, TS/JS, Lua, shell, YAML, SQL, Terraform, Dockerfile and Markdown buffers.

| Key (insert mode) | Action |
|---|---|
| `Ctrl+l` | accept the whole suggestion |
| `Ctrl+j` | accept the first line |
| `Ctrl+]` | next suggestion, or ask for one now (also in buffers without auto-trigger) |
| `Ctrl+e` | dismiss (when the completion menu is closed) |
| `<leader>ap` | (normal mode) toggle auto-prediction for the buffer |
| `<leader>am` / `:AIModel` | choose the model for this session |

Gateway settings are shared with the opencode ai-gateway plugin and the Claude Code hook. Each comes from the environment, then the env file `~/.config/ai-gateway/env` (or `$GATEWAY_ENV_FILE`; lines like `export GATEWAY_BASE_URL="..."`, which also works without a shell environment), then the default:

| Variable | Default | Note |
|---|---|---|
| `GATEWAY_BASE_URL` | none, required | the URL in your gateway settings; without it prediction stays off and Neovim says so once |
| `GATEWAY_API_KEY_FILE` | `~/.keys/ai-gateway.key` | read on every request, never stored in the config |
| `GATEWAY_COST_DIR` | `~/.gateway-cost` | the shared usage log folder |

Set up with `mac-setup/setup.sh --only gateway`. The start model is set with `MINUET_MODEL` in `~/.zshrc`.

Models (measured on the gateway 2026-10-19, ~2k tokens of context, 64 output tokens):

| Model | First token | Cost per request | Note |
|---|---|---|---|
| `gpt-6-luna` (default) | ~0.5 s | ~$0.00007 | Prompt caching hits ~99% of the context; `reasoning_effort: none` |
| `deepseek-v4.1-flash-1017` | ~0.55 s | ~$0.0002 | Lowest list price, but no cache hits; needs `reasoning.enabled: false` |
| `glm-5.3-flash-dbs` | ~0.9 s | ~$0.0001 | Reasoning can only go down to `low` (`none` = HTTP 400) |
| `claude-haiku-5-5` | ~0.5 s | ~$0.0003 | Same list price as luna, but its tokenizer counts ~50% more tokens and nothing was cached; thinking must be disabled |

Lesson behind this table: list price ≠ cost. The bill is tokens × price, and the same file is 1 800 tokens for one model and 2 700 for another; cached prompt tokens cost a tenth. All four reason by default on this gateway, which spends the whole token budget on thinking and returns **empty** ghost text; `lua/gateway/init.lua` holds the switch per model.

### Claude Code

The `ai.claudecode` extra ([coder/claudecode.nvim](https://github.com/coder/claudecode.nvim)) runs `claude` in a split and connects it to Neovim like an IDE: it sees the current selection, open buffers and diagnostics, and its edits open as diffs in Neovim.

| Key | Action |
|---|---|
| `<leader>ac` / `<leader>af` | toggle / focus Claude |
| `<leader>ar` / `<leader>aC` | resume a session (picker) / continue the last one |
| `<leader>ab` | add the current file to the context |
| `<leader>as` | (visual) send the selection; in the explorer: add the file |
| `<leader>aa` / `<leader>ad` | accept / deny the proposed diff (or `:w` / `:q` in the diff) |

It uses the normal Claude Code login and settings (`~/.claude`). A Claude Code started elsewhere (another cmux pane) can attach with `/ide`.

### OpenCode

[opencode.nvim](https://github.com/nickjvandyke/opencode.nvim) (branch `main`, for OpenCode v2) talks to the running OpenCode server: it finds it automatically, and `<leader>oo` opens the TUI in a right split. Prompts can carry context placeholders: `@this` (selection or cursor position), `@buffer`, `@buffers`, `@diagnostics`, `@visible`, `@quickfix`, `@marks`.

| Key | Action |
|---|---|
| `<leader>oo` | toggle the OpenCode TUI |
| `<leader>oa` | ask about `@this` (normal or visual) |
| `<leader>ob` | ask about the whole buffer |
| `<leader>oe` / `<leader>or` / `<leader>of` | explain / review `@this`, fix `@diagnostics` |
| `<leader>os` | all built-in prompts (document, implement, optimize, test, ...) and actions |

OpenCode reloads files it changed (`autoread` is on), so edits show up in the buffer. Its model choice and costs are OpenCode's own (`/models`).

### Moving between the code and the agent split

The agent opens in a split on the right and takes the keyboard: you land in its terminal, in insert mode. In insert mode a `<leader>` key is typed into the agent (the space goes to its TUI), so leave insert mode first or use the keys below.

| Want to | Keys | Note |
|---|---|---|
| Leave terminal mode (scroll, copy, `q`) | `Ctrl+\` `Ctrl+n` | always works. `Esc Esc` (two quick taps, under about 200 ms) works too |
| Send one `Esc` to the agent | `Esc` | it goes to the TUI, where it stops a running reply |
| Undo in Claude Code's input | `Ctrl+]` | `Ctrl+_` hides the split here, see below |
| Jump to the code window | `Ctrl+h` | works in insert mode too |
| Back to the agent | `Ctrl+l` (normal mode, in the code window) | the agent is the right-hand window |
| Hide the agent (it keeps running) | `Ctrl+q` in insert mode, or `q` in normal mode | the cursor goes back to the code window. `Ctrl+/` hides it too (same byte as `Ctrl+_`) |
| Show the agent and focus it | `<leader>oo` (OpenCode) / `<leader>ac` (Claude), from the code window | toggles: shows and focuses when hidden, hides when visible, even when you are in the code window |
| Focus Claude without hiding it | `<leader>af` | visible: focuses it; focused: hides it. OpenCode has no focus-only key, use `Ctrl+l` |
| Close the agent | quit it in its own TUI | the split closes with the process |

Some keys do not reach the agent: while it has focus, `Ctrl+h/j/k/l` are window moves. So `Ctrl+j` (newline in Claude Code and OpenCode), `Ctrl+k` (OpenCode: delete to end of line) and `Ctrl+l` (Claude Code: clear input) are lost. Claude Code takes a newline with `\` then `Enter`. `Ctrl+_` (Claude Code's undo) hides the window, because LazyVim maps that byte to hide, so undo in Claude Code is `Ctrl+]` here (set in `~/.claude/keybindings.json` by [claude-code/install.sh](../claude-code/README.md#keybindings)).

### Usage and cost tracking

All AI usage lands in one log, `~/.gateway-cost/usage.jsonl`: OpenCode's steps (gateway plugin), Claude Code's API calls (hook, see [claude-code](../claude-code/README.md#usage-and-cost-tracking)) and every prediction request from here (`tool: nvim`, `agent: prediction`, one session per Neovim process). **`~/.gateway-cost/dashboard.html`** shows them together and filters by tool, billing, agent and model, with this month's spend against the limit in `~/.gateway-cost/config.js` (OpenCode: `/usage-dashboard`). Token counts are the gateway's own (`usage` in the last stream chunk, including cached and reasoning tokens), and cost is tokens × the prices in `models.json`, the same formula the plugin uses. Requests cancelled because I kept typing (or that timed out) carry no usage: they are logged with finish `cancelled`/`timeout` and 0 tokens. The opencode plugin watches the log and adds these lines to `usage-summary.json` within seconds. `GATEWAY_USAGE_DISABLED=1` turns logging off.

## Updating

- `:Lazy` → `U` updates plugins (`lazy-lock.json` changes); `:Lazy` → `R` restores the locked versions. The checker looks for updates in the background without notifying.
- `:Mason` → `U` updates LSP servers and tools.
- `:LazyExtras` lists all extras; `<leader>L` shows LazyVim's changelog (read it after big updates, breaking changes are listed there).

## Troubleshooting

| Symptom | Fix |
|---|---|
| No ghost text | `:AIModel` (is a model set?), key file present? `:Minuet virtualtext toggle`; check the last lines of `usage.jsonl` for `error` |
| Ghost text always empty after changing models | the model reasons by default: add its switch in `lua/gateway/init.lua` |
| "AI gateway not configured" on first insert | set `GATEWAY_BASE_URL` in `~/.config/ai-gateway/env` (or the environment), then restart Neovim |
| Keys in the agent split do nothing in Neovim, or type into the agent | you are in insert mode: `Ctrl+\` `Ctrl+n` first (see [Moving between the code and the agent split](#moving-between-the-code-and-the-agent-split)) |
| LSP not attaching | `<leader>cl` (LSP info), `:Mason` (installed?), `:LspRestart` |
| Formatting changed my file on save | LazyVim formats on save; `<leader>uf` (global) / `<leader>uF` (buffer) toggles it |
| Alt-keys type `˙` or `∆` | Ghostty needs `macos-option-as-alt = left` (in `../cmux/config/ghostty/`) |

Expected `:checkhealth` leftovers: snacks image (`magick`, `gs`, `tectonic`, `mmdc` missing, only for images/PDF/LaTeX/Mermaid in docs). When run headless: "setup did not run", "vim.ui.input is not set", "terminal does not support the kitty graphics protocol" (Ghostty does).
