#!/usr/bin/env python3
"""Log Claude Code usage to the shared AI cost log (~/.gateway-cost/usage.jsonl).

Reads Claude Code's transcripts (~/.claude/projects/*/*.jsonl and the subagent
transcripts below them) and appends one line per API call, in the format the
opencode gateway plugin writes, so dashboard.html shows Claude Code next to
OpenCode and Neovim.

Usage (stdlib only, Python 3.9+):
  python3 claude_usage.py            import everything new (first run: the whole history)
  python3 claude_usage.py --dry-run  print what would be logged, write nothing
  python3 claude_usage.py --flush    also log the last call of transcripts that are still open
  python3 claude_usage.py --rescan   read all transcripts from the start again (never duplicates)

As a Claude Code hook (Stop, SubagentStop, SessionEnd) it reads the hook JSON on
stdin, stays silent and always exits 0. Problems go to claude-usage.log.

Cost: Claude Code runs on a Claude seat here, not through the gateway, so lines get
billing "subscription" and the cost is the API equivalent: tokens x the Anthropic
prices in models.json (5 min cache writes at the catalog's cache-write price, 1 h
cache writes at 2x the input price, thinking tokens at the output price).
Not in the transcripts, so not counted: Claude Code's small background calls
(session titles, command classification).
"""

import argparse
import fcntl
import glob
import json
import os
import re
import sys
import time

# Same lookup as setting() in index.ts: process environment, then the env file
# (GATEWAY_ENV_FILE, default ~/.config/ai-gateway/env), then the default.
def setting(name, fallback):
    if name in os.environ:
        return os.environ[name]
    value = fallback
    try:
        with open(os.path.expanduser(os.environ.get("GATEWAY_ENV_FILE", "~/.config/ai-gateway/env")), encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$", line)
                if m and m.group(1) == name:
                    quoted = re.fullmatch(r"([\"'])(.*)\1", m.group(2))
                    value = quoted.group(2) if quoted else re.sub(r"\s+#.*$", "", m.group(2))
    except (OSError, ValueError):  # no env file, or not readable text: the default applies
        pass
    return value


COST_DIR = os.path.expanduser(setting("GATEWAY_COST_DIR", "~/.gateway-cost"))
PROJECTS = os.path.expanduser(os.path.join(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"), "projects"))
USAGE_LOG = os.path.join(COST_DIR, "usage.jsonl")
STATE_FILE = os.path.join(COST_DIR, "claude-code-state.json")
ERROR_LOG = os.path.join(COST_DIR, "claude-usage.log")
IDLE_SECONDS = 120  # a transcript untouched this long has no call in progress


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


# ---------- prices (models.json from the gateway plugin) ----------

def load_catalog():
    try:
        with open(os.path.join(COST_DIR, "models.json")) as f:
            rows = json.load(f).get("rows") or []
    except (OSError, ValueError):
        return {}, {}
    by_id = {r.get("model_id"): r for r in rows}
    by_alias = {}
    for r in rows:
        for a in r.get("aliases") or []:
            by_alias.setdefault(a, r)
    return by_id, by_alias


def price_row(model, catalog):
    """The gateway's direct-Anthropic row for a Claude Code model id (claude-opus-5-5 ->
    claude-5.5-opus-anthropic); the catalog spells versions both ways, so try both."""
    by_id, by_alias = catalog
    candidates = [model + "-anthropic"]
    m = re.match(r"^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$", model)
    if m:
        family, major, minor = m.groups()
        version = f"{major}.{minor}" if minor else major
        candidates.append(f"claude-{version}-{family}-anthropic")
    for c in candidates:
        if c in by_id:
            return by_id[c]
    return by_alias.get(model)


def prices(row, prompt_tokens):
    """Base prices, or the largest context tier the prompt exceeds (same rule as the plugin)."""
    p = row
    for tier in row.get("tiers") or []:
        if prompt_tokens > num(tier.get("size")):
            p = tier
    return (num(p.get("input_per_1M")), num(p.get("output_per_1M")),
            num(p.get("cache_read_per_1M")), num(p.get("cache_write_per_1M")))


# ---------- transcripts ----------

def transcripts():
    return glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")) + glob.glob(
        os.path.join(PROJECTS, "*", "*", "subagents", "*.jsonl"))


_agent_types = {}


def agent_of(path, line):
    """main, or the subagent type from the agent-<id>.meta.json next to its transcript."""
    if not line.get("isSidechain"):
        return "main"
    if path not in _agent_types:
        try:
            with open(path[: -len(".jsonl")] + ".meta.json") as f:
                _agent_types[path] = json.load(f).get("agentType")
        except (OSError, ValueError):
            _agent_types[path] = None
    return _agent_types[path] or line.get("attributionAgent") or "subagent"


def tool_of(entrypoint):
    # cli -> claude-code; claude-desktop, claude-vscode, ... keep their name
    if entrypoint and entrypoint.startswith("claude-"):
        return entrypoint
    return "claude-code"


def call_of(path, line):
    """(request id, call) for an assistant line with usage, else None."""
    if line.get("type") != "assistant":
        return None
    msg = line.get("message") or {}
    u = msg.get("usage")
    rid = line.get("requestId") or msg.get("id")
    model = msg.get("model") or ""
    if not isinstance(u, dict) or not rid or not model.startswith("claude"):
        return None  # "<synthetic>" messages carry no real usage
    cc = u.get("cache_creation") or {}
    cache_write = num(u.get("cache_creation_input_tokens"))
    write_1h = min(num(cc.get("ephemeral_1h_input_tokens")), cache_write)
    thinking = num((u.get("output_tokens_details") or {}).get("thinking_tokens"))
    output = num(u.get("output_tokens"))
    return rid, {
        "ts": line.get("timestamp"),
        "session_id": line.get("sessionId"),
        "message_id": msg.get("id"),
        "tool": tool_of(line.get("entrypoint")),
        "agent": agent_of(path, line),
        "model": model,
        "finish": msg.get("stop_reason") or "unknown",
        "input": num(u.get("input_tokens")),
        "output": max(output - thinking, 0),  # output_tokens includes thinking
        "reasoning": min(thinking, output),
        "cache_read": num(u.get("cache_read_input_tokens")),
        "cache_write": cache_write,
        "cache_write_1h": write_1h,
        "reported": num(line.get("costUSD")),
        "file": path,
    }


def merge(old, new):
    """Lines of one call repeat per content block; token counts only grow."""
    if not old:
        return new
    for k in ("input", "output", "reasoning", "cache_read", "cache_write", "cache_write_1h", "reported"):
        new[k] = max(new[k], old[k])
    if new["finish"] == "unknown":
        new["finish"] = old["finish"]
    return new


def record(rid, c, catalog):
    row = price_row(c["model"], catalog)
    in_p, out_p, cr_p, cw_p = prices(row, c["input"] + c["cache_read"] + c["cache_write"]) if row else (0, 0, 0, 0)
    write_5m = c["cache_write"] - c["cache_write_1h"]
    write_cost = write_5m * cw_p + c["cache_write_1h"] * 2 * in_p
    cost = (c["input"] * in_p + (c["output"] + c["reasoning"]) * out_p + c["cache_read"] * cr_p + write_cost) / 1e6
    return {
        "ts": c["ts"],
        "event_id": "cc_" + rid,
        "session_id": c["session_id"],
        "message_id": c["message_id"],
        "tool": c["tool"],
        "billing": "subscription",
        "agent": c["agent"],
        "provider_id": "anthropic",
        "model_id": c["model"],
        "model_name": c["model"],
        "gateway": False,
        "upstream_provider": "anthropic",
        "finish": c["finish"],
        "input_tokens": c["input"],
        "output_tokens": c["output"],
        "reasoning_tokens": c["reasoning"],
        "cache_read_tokens": c["cache_read"],
        "cache_write_tokens": c["cache_write"],
        "input_per_1M": in_p,
        "output_per_1M": out_p,
        "cache_read_per_1M": cr_p,
        # blended 5 min / 1 h write price, so tokens x price adds up to `cost`
        "cache_write_per_1M": write_cost / c["cache_write"] if c["cache_write"] else cw_p,
        "cost": round(cost, 8),
        "reported_cost": c["reported"],
    }


# ---------- state ----------

def load_state(rescan):
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    state.setdefault("files", {})
    state.setdefault("pending", {})
    logged = set(state.get("logged") or [])
    if rescan or not state.get("files"):
        state["files"] = {}
        logged |= logged_in_log()  # never log a call twice, whatever the state says
    return state, logged


def logged_in_log():
    ids = set()
    try:
        with open(USAGE_LOG) as f:
            for line in f:
                if '"cc_' in line:
                    try:
                        ids.add(json.loads(line)["event_id"][3:])
                    except (ValueError, KeyError):
                        pass
    except OSError:
        pass
    return ids


def save_state(state, logged):
    state["logged"] = sorted(logged)
    tmp = f"{STATE_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def write_log_js():
    """Dashboard data for file:// pages (the plugin rewrites it too when OpenCode runs)."""
    with open(USAGE_LOG) as f:
        text = f.read()
    target = os.path.join(COST_DIR, "usage-log.js")
    tmp = f"{target}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        f.write("window.GATEWAY_USAGE_LOG = " + json.dumps(text) + ";\n")
    os.replace(tmp, target)


# ---------- main ----------

def scan(state, logged, flush_files, flush_all):
    """Read new transcript lines, return the calls that are complete."""
    pending = state["pending"]
    now = time.time()
    for path in transcripts():
        try:
            st = os.stat(path)
        except OSError:
            continue
        info = state["files"].get(path) or {"offset": 0}
        if st.st_size < info["offset"]:
            info = {"offset": 0}  # rewritten
        if st.st_size > info["offset"]:
            with open(path, "rb") as f:
                f.seek(info["offset"])
                data = f.read()
            end = data.rfind(b"\n") + 1  # complete lines only
            tail = None
            for raw in data[:end].splitlines():
                if not raw.strip():
                    continue
                tail = None
                if b'"usage"' not in raw:
                    continue  # any other line ends the call before it
                try:
                    line = json.loads(raw)
                except ValueError:
                    continue
                found = call_of(path, line)
                if found:
                    rid, call = found
                    tail = rid
                    if rid not in logged:
                        pending[rid] = merge(pending.get(rid), call)
            info = {"offset": info["offset"] + end, "tail": tail if end else info.get("tail")}
        info["mtime"] = st.st_mtime
        state["files"][path] = info

    done = []
    for rid, call in list(pending.items()):
        if rid in logged:
            del pending[rid]
            continue
        info = state["files"].get(call["file"]) or {}
        still_open = info.get("tail") == rid and now - info.get("mtime", 0) < IDLE_SECONDS
        forced = flush_all or any(call["file"].startswith(p) for p in flush_files)
        if not still_open or forced:
            done.append((rid, call))
    return done


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--flush", action="store_true")
    ap.add_argument("--rescan", action="store_true")
    args = ap.parse_args()

    hook = {}
    if not sys.stdin.isatty():
        try:
            hook = json.load(sys.stdin)
        except ValueError:
            hook = {}
    flush_files = []
    if hook.get("hook_event_name") == "SessionEnd" and hook.get("transcript_path"):
        t = hook["transcript_path"]
        flush_files = [t, t[: -len(".jsonl")] + os.sep]  # the session and its subagents

    os.makedirs(COST_DIR, exist_ok=True)
    with open(os.path.join(COST_DIR, ".claude-usage.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # hooks of parallel sessions take turns
        state, logged = load_state(args.rescan)
        done = scan(state, logged, flush_files, args.flush)
        catalog = load_catalog()
        lines = [record(rid, call, catalog) for rid, call in sorted(done, key=lambda d: d[1]["ts"] or "")]
        if args.dry_run:
            for r in lines:
                print(json.dumps(r))
        elif lines:
            with open(USAGE_LOG, "a") as f:
                f.write("".join(json.dumps(r) + "\n" for r in lines))
            write_log_js()
        if not args.dry_run:
            for rid, _ in done:
                logged.add(rid)
                state["pending"].pop(rid, None)
            save_state(state, logged)

    if not hook:
        cost = sum(r["cost"] for r in lines)
        unpriced = sorted({r["model_id"] for r in lines if not r["input_per_1M"]})
        print(f"{'would log' if args.dry_run else 'logged'} {len(lines)} Claude Code calls, "
              f"${cost:.2f} API equivalent; {len(state['pending']) - (len(done) if args.dry_run else 0)} still open"
              + (f"; no price for: {', '.join(unpriced)}" if unpriced else ""))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # a hook must never break Claude Code
        if sys.stdin.isatty():
            raise
        try:
            os.makedirs(COST_DIR, exist_ok=True)
            with open(ERROR_LOG, "a") as f:
                f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {type(e).__name__}: {e}\n")
        except OSError:
            pass
    sys.exit(0)
