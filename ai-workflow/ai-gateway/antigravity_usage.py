#!/usr/bin/env python3
"""Log Antigravity (CLI & Desktop) company-gateway usage to ~/.gateway-cost/usage.jsonl.

Reads Antigravity's transcript.jsonl files ONLY for conversations that ran against
the company Enterprise Gateway (detected via AGY_LLM_GATEWAY_URL in the Antigravity
hook environment), never logging personal Pro account conversations.

Usage (stdlib only, Python 3.9+):
  python3 antigravity_usage.py            scan already-tracked company transcripts
  python3 antigravity_usage.py --dry-run  print what would be logged, write nothing
  python3 antigravity_usage.py --rescan   re-read tracked company transcripts from offset 0 (never duplicates)

As an Antigravity hook (PostInvocation, Stop) in ~/.gemini/config/hooks.json it reads
the camelCase hook JSON on stdin, outputs valid hook JSON on stdout, and always exits 0.
When AGY_LLM_GATEWAY_URL is unset (or does not match GATEWAY_BASE_URL), it is a no-op.
Problems go to antigravity-usage.log.
"""

import argparse
import fcntl
import json
import os
import re
import sys
import time


def expand_home(path):
    """Expand ~ and leading $HOME / ${HOME} from shell-style env files."""
    return os.path.expanduser(re.sub(r"^\$(?:HOME\b|\{HOME\})", "~", path))


def setting(name, fallback):
    if name in os.environ:
        return os.environ[name]
    value = fallback
    try:
        with open(expand_home(os.environ.get("GATEWAY_ENV_FILE", "~/.config/ai-gateway/env")), encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$", line)
                if m and m.group(1) == name:
                    quoted = re.fullmatch(r"([\"'])(.*?)\1(?:\s+#.*)?", m.group(2))
                    value = quoted.group(2) if quoted else re.sub(r"\s+#.*$", "", m.group(2))
    except (OSError, ValueError):
        pass
    return value


COST_DIR = expand_home(setting("GATEWAY_COST_DIR", "~/.gateway-cost"))
USAGE_LOG = os.path.join(COST_DIR, "usage.jsonl")
STATE_FILE = os.path.join(COST_DIR, "antigravity-state.json")
ERROR_LOG = os.path.join(COST_DIR, "antigravity-usage.log")
EFFORT_SUFFIX_RE = re.compile(r"-(?:low|medium|high|xhigh|max|minimal)$", re.IGNORECASE)
UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def hook_response(event_name):
    if event_name == "Stop":
        return '{"decision": "allow"}\n'
    return "{}\n"


def is_company_gateway():
    """True only when Antigravity is routed through the configured company gateway."""
    agy_url = os.environ.get("AGY_LLM_GATEWAY_URL", "").strip().rstrip("/")
    if not agy_url:
        return False
    gw_base = setting("GATEWAY_BASE_URL", "").strip().rstrip("/")
    if gw_base and not agy_url.lower().startswith(gw_base.lower()):
        return False
    return True


# ---------- prices (models.json from the gateway plugin) ----------

def load_catalog():
    try:
        with open(os.path.join(COST_DIR, "models.json"), encoding="utf-8") as f:
            rows = json.load(f).get("rows") or []
    except (OSError, ValueError):
        return {}, {}
    by_id = {r.get("model_id"): r for r in rows if r.get("model_id")}
    by_alias = {}
    for r in rows:
        for a in r.get("aliases") or []:
            by_alias.setdefault(a, r)
    return by_id, by_alias


def strip_effort(model):
    return EFFORT_SUFFIX_RE.sub("", model or "")


def price_row(model, catalog):
    """Resolve an Antigravity model id (e.g. gemini-4-neon-high) to its models.json row."""
    if not model:
        return None
    by_id, by_alias = catalog
    base = strip_effort(model)
    no_preview = re.sub(r"-preview$", "", base)
    candidates = [model, base, no_preview]

    # Fallback if an Anthropic model is ever routed through the gateway
    for m_str in (model, base):
        m = re.match(r"^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$", m_str)
        if m:
            family, major, minor = m.groups()
            version = f"{major}.{minor}" if minor else major
            candidates.append(f"{m_str}-anthropic")
            candidates.append(f"claude-{version}-{family}-anthropic")

    for c in candidates:
        if c in by_id:
            return by_id[c]
    for c in candidates:
        if c in by_alias:
            return by_alias[c]
    return None


def prices(row, prompt_tokens):
    """Base prices, or the largest context tier the prompt exceeds (same rule as index.ts)."""
    p = row
    for tier in row.get("tiers") or []:
        if prompt_tokens > num(tier.get("size")):
            p = tier
    return (
        num(p.get("input_per_1M")),
        num(p.get("output_per_1M")),
        num(p.get("cache_read_per_1M")),
        num(p.get("cache_write_per_1M")),
    )


# ---------- tool & transcript metadata ----------

def tool_of(transcript_path):
    norm = (transcript_path or "").replace("\\", "/")
    if "/antigravity-cli/" in norm:
        return "antigravity-cli"
    if "/antigravity-ide/" in norm:
        return "antigravity-ide"
    if "/antigravity/" in norm or "antigravity-company-userdata" in norm:
        return "antigravity-desktop"
    app_dir = os.environ.get("ANTIGRAVITY_APP_DATA_DIR", "").replace("\\", "/")
    if "/antigravity-cli" in app_dir:
        return "antigravity-cli"
    if "/antigravity-ide" in app_dir:
        return "antigravity-ide"
    if "Antigravity.app" in os.environ.get("ANTIGRAVITY_AGENTAPI_EXE", ""):
        return "antigravity-desktop"
    return "antigravity"


def conversation_id_of(transcript_path, fallback=""):
    norm = (transcript_path or "").replace("\\", "/")
    m = re.search(r"/brain/([^/]+)/", norm)
    if m:
        return m.group(1)
    return fallback or os.path.basename(os.path.dirname(norm)) or "unknown"


def brain_dir_of(transcript_path):
    norm = (transcript_path or "").replace("\\", "/")
    idx = norm.rfind("/brain/")
    if idx != -1:
        return norm[: idx + len("/brain")]
    return None


def discover_subagents(transcript_path, line, state, parent_meta):
    """If a tracked transcript spawns subagents, track their transcripts too."""
    bdir = brain_dir_of(transcript_path)
    if not bdir:
        return
    if line.get("type") == "PLANNER_RESPONSE":
        for tc in line.get("tool_calls") or []:
            if tc.get("name") == "invoke_subagent":
                args = tc.get("args") or {}
                role = (args.get("Role") or args.get("TypeName") or "subagent").strip('"')
                parent_meta.setdefault("pending_subagent_roles", []).append(role)
        return
    if line.get("type") == "GENERIC" and parent_meta.get("pending_subagent_roles"):
        content = line.get("content") or ""
        for cid in UUID_RE.findall(content):
            if cid == parent_meta.get("conversation_id"):
                continue
            child_path = os.path.join(bdir, cid, ".system_generated", "logs", "transcript.jsonl")
            if child_path in state["tracked"] or os.path.exists(child_path):
                roles = parent_meta.get("pending_subagent_roles") or []
                role = roles.pop(0) if roles else "subagent"
                state["tracked"].setdefault(child_path, {
                    "conversation_id": cid,
                    "tool": parent_meta.get("tool") or tool_of(child_path),
                    "agent": role,
                    "first_seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                })


def record_from_step(line, meta, catalog):
    if line.get("type") != "PLANNER_RESPONSE":
        return None
    if line.get("status") != "DONE":
        return None
    step_idx = line.get("step_index")
    if step_idx is None:
        return None

    inp = num(line.get("input_tokens"))
    out = num(line.get("output_tokens"))
    reasoning = num(line.get("reasoning_tokens"))
    cache_read = num(line.get("cache_read_tokens"))
    cache_write = num(line.get("cache_write_tokens"))
    if inp + out + reasoning + cache_read + cache_write == 0:
        return None

    raw_model = line.get("model") or meta.get("model_fallback") or ""
    if not raw_model:
        return None

    row = price_row(raw_model, catalog)
    base_model = strip_effort(raw_model)
    prompt_tokens = inp + cache_read + cache_write
    in_p, out_p, cr_p, cw_p = prices(row, prompt_tokens) if row else (0, 0, 0, 0)
    cost = (inp * in_p + (out + reasoning) * out_p + cache_read * cr_p + cache_write * cw_p) / 1e6

    cid = meta["conversation_id"]
    event_id = f"agy_{cid}_{step_idx}"
    finish = "tool-calls" if line.get("tool_calls") else "stop"

    return event_id, {
        "ts": line.get("created_at") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event_id": event_id,
        "session_id": cid,
        "message_id": f"{cid}:{step_idx}",
        "tool": meta["tool"],
        "billing": "gateway",
        "agent": meta.get("agent") or "main",
        "provider_id": (row.get("provider_id") if row else None) or "acc-vertex-ai",
        "model_id": (row.get("model_id") if row else None) or base_model,
        "model_name": (row.get("model_name") if row else None) or base_model,
        "gateway": True,
        "upstream_provider": (row.get("upstream_provider") if row else None) or "vertex_ai",
        "finish": finish,
        "input_tokens": inp,
        "output_tokens": out,
        "reasoning_tokens": reasoning,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "input_per_1M": in_p,
        "output_per_1M": out_p,
        "cache_read_per_1M": cr_p,
        "cache_write_per_1M": cw_p,
        "cost": round(cost, 8),
        "reported_cost": 0,
    }


# ---------- state ----------

def logged_in_log():
    ids = set()
    try:
        with open(USAGE_LOG, encoding="utf-8") as f:
            for line in f:
                if '"agy_' in line:
                    try:
                        eid = json.loads(line).get("event_id")
                        if eid and eid.startswith("agy_"):
                            ids.add(eid)
                    except (ValueError, KeyError):
                        pass
    except OSError:
        pass
    return ids


def load_state(rescan):
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    state.setdefault("tracked", {})
    state.setdefault("files", {})
    logged = set(state.get("logged") or [])
    if rescan or not state.get("files"):
        state["files"] = {}
        logged |= logged_in_log()
    return state, logged


def save_state(state, logged):
    state["logged"] = sorted(logged)
    tmp = f"{STATE_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def write_log_js():
    """Refresh usage-log.js for file:// dashboard pages (OpenCode rewrites it too when running)."""
    with open(USAGE_LOG, encoding="utf-8") as f:
        text = f.read()
    target = os.path.join(COST_DIR, "usage-log.js")
    tmp = f"{target}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("window.GATEWAY_USAGE_LOG = " + json.dumps(text) + ";\n")
    os.replace(tmp, target)


# ---------- scanning ----------

def scan_tracked(state, logged, catalog):
    """Read new complete lines from tracked company transcripts only."""
    new_records = []
    seen_paths = set()
    # Loop because scanning a parent transcript can discover newly spawned subagent transcripts.
    while True:
        paths = [p for p in list(state["tracked"].keys()) if p not in seen_paths]
        if not paths:
            break
        for path in paths:
            seen_paths.add(path)
            meta = state["tracked"][path]
            try:
                st = os.stat(path)
            except OSError:
                continue
            info = state["files"].get(path) or {"offset": 0}
            if st.st_size < info["offset"]:
                info = {"offset": 0}
            if st.st_size > info["offset"]:
                with open(path, "rb") as f:
                    f.seek(info["offset"])
                    data = f.read()
                end = data.rfind(b"\n") + 1
                for raw in data[:end].splitlines():
                    if not raw.strip():
                        continue
                    has_planner = b'"PLANNER_RESPONSE"' in raw
                    has_subagent = b"invoke_subagent" in raw or bool(meta.get("pending_subagent_roles"))
                    if not has_planner and not has_subagent:
                        continue
                    try:
                        line = json.loads(raw)
                    except ValueError:
                        continue
                    discover_subagents(path, line, state, meta)
                    if has_planner:
                        found = record_from_step(line, meta, catalog)
                        if found:
                            eid, rec = found
                            if eid not in logged:
                                logged.add(eid)
                                new_records.append(rec)
                info = {"offset": info["offset"] + end}
            info["mtime"] = st.st_mtime
            state["files"][path] = info
    new_records.sort(key=lambda r: (r["ts"] or "", r["event_id"]))
    return new_records


_in_hook = False


def main():
    global _in_hook
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--flush", action="store_true", help="accepted for compatibility with claude_usage.py")
    ap.add_argument("--rescan", action="store_true")
    args = ap.parse_args()

    hook = {}
    if not sys.stdin.isatty():
        try:
            raw_stdin = sys.stdin.read()
            if raw_stdin.strip():
                parsed = json.loads(raw_stdin)
                if isinstance(parsed, dict):
                    hook = parsed
        except ValueError:
            hook = {}
    is_hook = bool(hook)
    _in_hook = is_hook
    event_name = hook.get("hookEventName") or ""

    if os.environ.get("GATEWAY_USAGE_DISABLED") == "1":
        if is_hook:
            sys.stdout.write(hook_response(event_name))
        return

    # Strict company-endpoint gate: personal Pro sessions never have AGY_LLM_GATEWAY_URL set.
    if is_hook and not is_company_gateway():
        sys.stdout.write(hook_response(event_name))
        return

    os.makedirs(COST_DIR, exist_ok=True)
    with open(os.path.join(COST_DIR, ".antigravity-usage.lock"), "w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state, logged = load_state(args.rescan)

        tpath = hook.get("transcriptPath") or ""
        if is_hook and tpath:
            cid = hook.get("conversationId") or conversation_id_of(tpath)
            entry = state["tracked"].setdefault(tpath, {
                "conversation_id": cid,
                "tool": tool_of(tpath),
                "agent": "main",
                "first_seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            if hook.get("modelName"):
                entry["model_fallback"] = hook["modelName"]

        catalog = load_catalog()
        records = scan_tracked(state, logged, catalog)

        if args.dry_run:
            for r in records:
                print(json.dumps(r))
        elif records:
            with open(USAGE_LOG, "a", encoding="utf-8") as f:
                f.write("".join(json.dumps(r) + "\n" for r in records))
            write_log_js()

        if not args.dry_run:
            save_state(state, logged)

    if is_hook:
        sys.stdout.write(hook_response(event_name))
    else:
        cost = sum(r["cost"] for r in records)
        unpriced = sorted({r["model_id"] for r in records if not r["input_per_1M"]})
        print(
            f"{'would log' if args.dry_run else 'logged'} {len(records)} Antigravity gateway calls, "
            f"${cost:.2f}; {len(state['tracked'])} tracked transcripts"
            + (f"; no price for: {', '.join(unpriced)}" if unpriced else "")
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        if not _in_hook and sys.stdin.isatty():
            raise
        try:
            os.makedirs(COST_DIR, exist_ok=True)
            with open(ERROR_LOG, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {type(e).__name__}: {e}\n")
        except OSError:
            pass
        if _in_hook:
            sys.stdout.write("{}\n")
    sys.exit(0)
