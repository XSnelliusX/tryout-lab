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
cd terminal/claude-code      # from the repo root
./install.sh
```

`install.sh` copies the script to `~/.claude/statusline.py` and merges this into `~/.claude/settings.json` (both backed up as `*.bak-<timestamp>` first):

```json
"statusLine": {
  "type": "command",
  "command": "python3 /Users/<you>/.claude/statusline.py",
  "refreshInterval": 30
}
```

## OneDrive path fix

`~/Documents` and `~/Desktop` are symlinks into `~/Library/CloudStorage/OneDrive/`, so Claude Code reports the long real path. The script maps it back: it checks every symlink in `$HOME`, and if the working directory is below a link's target it shows the path through that link (the most specific link wins). That gives `~/Documents/tryout_lab` instead of `~/Library/CloudStorage/OneDrive/Documents/tryout_lab`, for every folder in Documents and Desktop, without hardcoded paths.

Test it without Claude Code:

```bash
echo '{"workspace":{"current_dir":"'$HOME'/Library/CloudStorage/OneDrive/Documents/tryout_lab"}}' | python3 statusline.py
```
