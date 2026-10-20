# Claude Code Statusline

A custom two-line statusline for [Claude Code](https://claude.com/claude-code). Claude Code pipes session JSON to a command on stdin and shows whatever it prints. The script is [statusline.py](statusline.py) (Python 3, no dependencies).

```
~/Documents/tryout_lab  ·  main ●2 ↑1  ·  PR #12 ✓                 Sonnet 5.5  ·  effort high
██░░░░░░░░ 18% 36k/200k  ·  5h ███░░░ 42% ↻3h10m  ·  7d ████░░ 75% ↻4d2h  ·  25m  ·  +120 −30      $1.20
```

| Line | Shows |
|---|---|
| 1 left | directory, git branch (`●` dirty files, `↑` ahead, `↓` behind), worktree, PR number and review state, agent, vim mode |
| 1 right | model, effort, fast mode |
| 2 left | context bar and tokens, 5h session limit and 7d weekly limit as bars with reset time, session time, lines added/removed, cold prompt cache |
| 2 right | session cost, right-aligned under the model |

Colors turn yellow at 70% and red at 90%. On narrow terminals the least important segments of line 2 are dropped (the cost stays). Any failure falls back to a minimal line, so the statusline is never blank.

The 5h and 7d limits only appear on subscription accounts (Pro/Max), because Claude Code only sends `rate_limits` there. On an Enterprise/API account they are simply not shown. The monthly usage credits from `/usage` are not part of the statusline input, so they cannot be shown.

## Install

```bash
cd mac-setup/claude-code      # from the repo root
./install.sh
```

`install.sh` copies the script to `~/.claude/statusline.py` and merges this into `~/.claude/settings.json`. Each file that differs is shown as a diff and you confirm it; the old version goes to `~/.setup_backup/<stamp>/` when overwritten. The other keys in `settings.json` are kept:

```json
"statusLine": {
  "type": "command",
  "command": "python3 /Users/<you>/.claude/statusline.py",
  "refreshInterval": 30
}
```

## Keybindings

`install.sh` also copies [keybindings.json](keybindings.json) to `~/.claude/keybindings.json`. It adds `Ctrl+]` as undo for the prompt input, next to the default `Ctrl+_`. Inside Neovim `Ctrl+_` never reaches Claude Code (LazyVim hides the agent split on it), `Ctrl+]` does. `Ctrl+Z` was the first choice, but Claude Code always uses it to suspend itself, and `Ctrl+Y` already pastes deleted text. `Ctrl+]` is the one Ctrl key Claude Code, LazyVim and the Neovim terminal all leave free.

## Gateway commands

`install.sh` also copies three skills to `~/.claude/skills/`, so Claude Code has the same commands as OpenCode:

| Command | Does |
|---|---|
| `/usage-dashboard` | logs the latest Claude Code calls (`claude_usage.py --flush`), updates the usage data and opens `~/.gateway-cost/dashboard.html` |
| `/gateway-refresh` | re-reads the API key, reloads the model list and prices, rewrites `~/.gateway-cost/models.json` and `models.csv` |
| `/gateway-status` | gateway URL, key file, a quick check that the gateway answers, the time of the last model refresh |

They run the ai-gateway plugin's own code (`node ~/.config/opencode/plugins/ai-gateway/index.ts refresh|dashboard|status`), so they need the plugin (`setup.sh --only gateway`) and Node 23.6+ (`setup.sh --only asdf`). Each command runs its shell part first and Claude only shows the output, a short reply. Claude never runs them on its own (`disable-model-invocation`).

## Usage and cost tracking

`install.sh` also registers a hook (`Stop`, `SubagentStop`, `SessionEnd`) that runs `claude_usage.py` from the ai-gateway opencode plugin (`~/.config/opencode/plugins/ai-gateway/`). The plugin is set up with `mac-setup/setup.sh --only gateway`. It reads the new API calls from Claude Code's transcripts and appends them to `~/.gateway-cost/usage.jsonl`, the log OpenCode and Neovim write too, so `~/.gateway-cost/dashboard.html` shows all AI usage together:

- `tool`: `claude-code`, or `claude-desktop` for sessions started from the desktop app
- `agent`: `main`, or the subagent type (`general-purpose`, `Explore`, ...)
- `billing`: `subscription`. The Enterprise seat is not billed per token, so `cost` is the **API equivalent** (tokens × Anthropic prices from the gateway catalog). Useful against the monthly limit (`monthlyLimitUSD` in `~/.gateway-cost/config.js`), not an invoice.

The first run imports the whole history; every call is logged once (deduplicated by request id). The hook is silent and always exits 0; problems go to `~/.gateway-cost/claude-usage.log`. Run it by hand with `python3 ~/.config/opencode/plugins/ai-gateway/claude_usage.py` (`--dry-run` to preview). Without the plugin installed, `install.sh` skips the hook. A hook left over from the plugin's old folder name is repointed to `ai-gateway` on the next run, so re-running `install.sh` after the rename is enough; it does nothing until the plugin exists.

The statusline's `$` is Claude Code's own session cost; the dashboard's Claude Code numbers come from the transcripts and leave out Claude Code's small background calls (titles, classifiers), so they can be slightly lower.

## OneDrive path fix

`~/Documents` and `~/Desktop` are symlinks into `~/Library/CloudStorage/OneDrive/`, so Claude Code reports the long real path. The script maps it back: it checks every symlink in `$HOME`, and if the working directory is below a link's target it shows the path through that link (the most specific link wins). That gives `~/Documents/tryout_lab` instead of `~/Library/CloudStorage/OneDrive/Documents/tryout_lab`, for every folder in Documents and Desktop, without hardcoded paths.

Test it without Claude Code:

```bash
echo '{"workspace":{"current_dir":"'$HOME'/Library/CloudStorage/OneDrive/Documents/tryout_lab"}}' | python3 statusline.py
```
