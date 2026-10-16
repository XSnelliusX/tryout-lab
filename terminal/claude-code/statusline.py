#!/usr/bin/env python3
"""Claude Code status line.

Line 1: directory · git branch/dirty · PR                    model · effort
Line 2: context bar + tokens · rate limits · cost · time · lines changed

Claude Code passes session JSON on stdin and sets COLUMNS. Any failure
falls back to a minimal line, so the status line is never blank.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

ESC = "\033"
RESET = f"{ESC}[0m"
DIM = f"{ESC}[2m"
CYAN = f"{ESC}[36m"
GREEN = f"{ESC}[32m"
YELLOW = f"{ESC}[33m"
RED = f"{ESC}[31m"
MAGENTA = f"{ESC}[35m"
BLUE = f"{ESC}[34m"

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\")
SEP = f"{DIM}  ·  {RESET}"
RIGHT_MARGIN = 6  # notifications share the row and the terminal edge clips text


def c(color, text):
    return f"{color}{text}{RESET}"


def vlen(s):
    return len(ANSI_RE.sub("", s))


def threshold_color(pct):
    if pct >= 90:
        return RED
    if pct >= 70:
        return YELLOW
    return GREEN


def fmt_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1000:
        return f"{n / 1000:.0f}k" if n >= 100_000 else f"{n / 1000:.1f}k"
    return str(n)


def fmt_duration(ms):
    secs = int(ms // 1000)
    h, rem = divmod(secs, 3600)
    m = rem // 60
    if h:
        return f"{h}h{m:02d}m"
    return f"{m}m" if m else f"{secs}s"


def fmt_until(epoch):
    secs = int(epoch - time.time())
    if secs <= 0:
        return "now"
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    if d:
        return f"{d}d{h}h"
    if h:
        return f"{h}h{m:02d}m"
    return f"{m}m"


def bar(pct, cells=10):
    filled = max(0, min(cells, round(pct / 100 * cells)))
    return c(threshold_color(pct), "█" * filled) + c(DIM, "░" * (cells - filled))


def git_info(cwd, session_id):
    """Branch, dirty count, ahead/behind — cached ~5s per session (git is slow in big repos)."""
    cache = os.path.join(tempfile.gettempdir(), f"claude-statusline-{session_id or 'x'}.json")
    try:
        with open(cache) as f:
            cached = json.load(f)
        if cached.get("cwd") == cwd and time.time() - cached.get("t", 0) < 5:
            return cached["info"]
    except Exception:
        pass

    info = None
    try:
        out = subprocess.run(
            ["git", "-C", cwd, "--no-optional-locks", "status", "--porcelain=v1", "-b"],
            capture_output=True, text=True, timeout=2,
        ).stdout.splitlines()
        if out and out[0].startswith("## "):
            head = out[0][3:]
            branch = re.split(r"\.\.\.|\s", head)[0]
            if branch.startswith("No commits yet on "):
                branch = head.split()[-1]
            ahead = re.search(r"ahead (\d+)", head)
            behind = re.search(r"behind (\d+)", head)
            info = {
                "branch": branch,
                "dirty": len(out) - 1,
                "ahead": int(ahead.group(1)) if ahead else 0,
                "behind": int(behind.group(1)) if behind else 0,
            }
    except Exception:
        pass

    try:
        with open(cache, "w") as f:
            json.dump({"cwd": cwd, "t": time.time(), "info": info}, f)
    except Exception:
        pass
    return info


def build(d):
    ws = d.get("workspace") or {}
    cwd = ws.get("current_dir") or d.get("cwd") or os.getcwd()
    home = os.path.expanduser("~")
    # Show symlinked home folders (e.g. OneDrive-synced Documents/Desktop) by their ~/ name.
    cwd_display, best = cwd, 0
    for name in os.listdir(home):
        link = os.path.join(home, name)
        if os.path.islink(link):
            target = os.path.realpath(link)
            if (cwd == target or cwd.startswith(target + os.sep)) and len(target) > best:
                cwd_display, best = link + cwd[len(target):], len(target)
    short = "~" + cwd_display[len(home):] if cwd_display.startswith(home) else cwd_display

    # ---- line 1, left: directory, git, PR ----
    left = [c(CYAN, short)]
    git = git_info(cwd, d.get("session_id"))
    if git:
        g = c(GREEN, git["branch"])
        if git["dirty"]:
            g += c(YELLOW, f" ●{git['dirty']}")
        if git["ahead"]:
            g += c(CYAN, f" ↑{git['ahead']}")
        if git["behind"]:
            g += c(RED, f" ↓{git['behind']}")
        left.append(g)
    wt = d.get("worktree") or {}
    if wt.get("name"):
        left.append(c(DIM, f"worktree {wt['name']}"))
    pr = d.get("pr") or {}
    if pr.get("number"):
        state = pr.get("review_state") or ""
        mark = {"approved": c(GREEN, "✓"), "changes_requested": c(RED, "✗"),
                "pending": c(YELLOW, "…"), "draft": c(DIM, "draft")}.get(state, "")
        label = f"PR #{pr['number']}" + (f" {mark}" if mark else "")
        if pr.get("url"):  # OSC 8 hyperlink where the terminal supports it
            label = f"{ESC}]8;;{pr['url']}{ESC}\\{label}{ESC}]8;;{ESC}\\"
        left.append(label)
    agent = (d.get("agent") or {}).get("name")
    if agent:
        left.append(c(BLUE, f"agent {agent}"))
    vim = (d.get("vim") or {}).get("mode")
    if vim:
        left.append(c(YELLOW, vim))

    # ---- line 1, right: model · effort ----
    right = []
    model = (d.get("model") or {}).get("display_name")
    if model:
        right.append(c(MAGENTA, model))
    effort = d.get("effort")
    level = effort.get("level") if isinstance(effort, dict) else effort
    if level:
        right.append(c(DIM, f"effort {level}"))
    if d.get("fast_mode"):
        right.append(c(YELLOW, "fast"))

    # ---- line 2: context, rate limits, cost, time, lines ----
    parts = []
    cw = d.get("context_window") or {}
    usage = cw.get("current_usage") or {}
    tokens = sum(usage.get(k) or 0 for k in
                 ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    size = cw.get("context_window_size") or 0
    pct = cw.get("used_percentage")
    if pct is None and size and tokens:
        pct = tokens / size * 100
    if pct is not None:
        txt = f"{bar(pct)} {c(threshold_color(pct), f'{pct:.0f}%')}"
        if tokens:
            txt += c(DIM, f" {fmt_tokens(tokens)}" + (f"/{fmt_tokens(size)}" if size else ""))
        parts.append(txt)
    elif tokens:
        parts.append(c(DIM, f"ctx {fmt_tokens(tokens)}"))
    if d.get("exceeds_200k_tokens"):
        parts.append(c(YELLOW, ">200k"))

    # Subscription limits: same bar style as the context window.
    rl = d.get("rate_limits") or {}
    for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
        w = rl.get(key) or {}
        if w.get("used_percentage") is not None:
            p = w["used_percentage"]
            t = f"{label} {bar(p, 6)} {c(threshold_color(p), f'{p:.0f}%')}"
            if w.get("resets_at"):
                t += c(DIM, f" ↻{fmt_until(w['resets_at'])}")
            parts.append(t)

    cost = d.get("cost") or {}
    cost_txt = c(DIM, f"${cost['total_cost_usd']:.2f}") if cost.get("total_cost_usd") is not None else ""
    if cost.get("total_duration_ms"):
        parts.append(c(DIM, fmt_duration(cost["total_duration_ms"])))
    added, removed = cost.get("total_lines_added") or 0, cost.get("total_lines_removed") or 0
    if added or removed:
        parts.append(c(GREEN, f"+{added}") + " " + c(RED, f"−{removed}"))

    pc = d.get("prompt_cache") or {}
    if pc.get("caching_observed") and pc.get("warm") is False:
        parts.append(c(YELLOW, "cache cold"))

    return left, right, parts, cost_txt


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        d = {}
    try:
        cols = int(os.environ.get("COLUMNS") or 0) or 100
        left, right, parts, cost_txt = build(d)
        l1 = SEP.join(left)
        r1 = SEP.join(right)
        room = cols - RIGHT_MARGIN - vlen(l1) - vlen(r1)
        if r1 and room >= 2:
            line1 = l1 + " " * room + r1
        elif r1:
            line1 = l1 + SEP + r1
        else:
            line1 = l1
        lines = [line1]
        # On narrow terminals drop the least important segments instead of overflowing.
        # Cost sits right-aligned on line 2, under the model.
        budget = cols - RIGHT_MARGIN - (vlen(cost_txt) + 2 if cost_txt else 0)
        while len(parts) > 1 and vlen(SEP.join(parts)) > budget:
            parts.pop()
        l2 = SEP.join(parts)
        if cost_txt:
            l2 += " " * max(2, cols - RIGHT_MARGIN - vlen(l2) - vlen(cost_txt)) + cost_txt
        if l2:
            lines.append(l2)
        print("\n".join(lines))
    except Exception:
        print(c(CYAN, os.path.basename(os.getcwd()) or "~"))


main()
