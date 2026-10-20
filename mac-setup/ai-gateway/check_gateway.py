#!/usr/bin/env python3
"""
Manual checker for the AI gateway model discovery plugin logic.

Runs the same two-endpoint discovery / fingerprinting / provider-grouping /
cost-report logic as the OpenCode plugin, but standalone so you can verify
everything without OpenCode. Uses only the Python stdlib.

Usage:
  python3 check_gateway.py            # fast list + slow info (slow: ~1 min)
  python3 check_gateway.py --fast     # only the fast /models endpoint
  python3 check_gateway.py --info     # only the slow /model/info endpoint
  python3 check_gateway.py --out DIR  # write models.json/models.csv to DIR

Settings (each one: process environment, then the env file, then the default):
  GATEWAY_BASE_URL       gateway base URL, no default (required)
  GATEWAY_API_KEY_FILE   key file, default ~/.keys/ai-gateway.key
  GATEWAY_COST_DIR       out dir, default ~/.gateway-cost
  The env file is ~/.config/ai-gateway/env, or $GATEWAY_ENV_FILE if set.
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
import urllib.request


# Same lookup as setting() in index.ts. The env file is read because a GUI-started
# OpenCode never sources ~/.zshrc. Format: `export NAME=value` or `NAME=value`, # comments, quotes.
def env_file_values():
    values = {}
    try:
        with open(os.path.expanduser(os.environ.get("GATEWAY_ENV_FILE", "~/.config/ai-gateway/env")), encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$", line)
                if m:
                    quoted = re.fullmatch(r"([\"'])(.*)\1", m.group(2))
                    values[m.group(1)] = quoted.group(2) if quoted else re.sub(r"\s+#.*$", "", m.group(2))
    except (OSError, ValueError):  # no env file, or not readable text: the defaults apply
        pass
    return values


ENV_FILE_VALUES = env_file_values()


def setting(name, fallback):
    return os.environ.get(name, ENV_FILE_VALUES.get(name, fallback))


BASE_URL = setting("GATEWAY_BASE_URL", "").strip().rstrip("/")
# Same spec as the plugin: "{file:path}" or a plain path, "~" works on every OS.
KEY_FILE = os.path.expanduser(setting("GATEWAY_API_KEY_FILE", "~/.keys/ai-gateway.key").removeprefix("{file:").removesuffix("}").strip())
DEFAULT_OUT = os.path.expanduser(setting("GATEWAY_COST_DIR", "~/.gateway-cost"))

FAST_URL = f"{BASE_URL}/aiendpoint/v1/models"
INFO_URL = f"{BASE_URL}/aiendpoint/v1/model/info"
SKIP_MODES = {"evaluation", "embedding"}


def read_key():
    try:
        with open(KEY_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError as e:
        print(f"[!] could not read key file {KEY_FILE}: {e}")
        sys.exit(1)


def auth_headers(key):
    return {"Authorization": f"Bearer {key}"}


def fetch(url, key, timeout=150):
    req = urllib.request.Request(url, headers=auth_headers(key))
    start = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode())
    return body, time.time() - start


def load_fast(key):
    body, elapsed = fetch(FAST_URL, key, timeout=20)
    data = body.get("data", body if isinstance(body, list) else [])
    return [m for m in data if str(m.get("mode", "")) not in SKIP_MODES], elapsed


def load_info(key):
    body, elapsed = fetch(INFO_URL, key, timeout=150)
    data = body.get("data", body if isinstance(body, list) else [])
    return data, elapsed


def fingerprint(models):
    lines = sorted(
        "|".join(
            [
                m.get("id", ""),
                m.get("mode", "") or "",
                str(m.get("max_input_tokens") or 0),
                str(m.get("max_output_tokens") or 0),
            ]
        )
        for m in models
    )
    payload = "\n".join(lines).encode()
    return f"{len(models)}:{hashlib.sha1(payload).hexdigest()[:10]}"


def norm(s):
    return "".join(c.lower() for c in s if c.isalnum())


# Same folding as the plugin: the gateway spells one upstream several ways.
PROVIDER_ALIASES = {
    "bedrock": "bedrock", "awsbedrock": "bedrock", "amazonbedrock": "bedrock",
    "azure": "azure", "azureai": "azure", "azurefoundry": "azure",
    "vertex": "vertex-ai", "vertexai": "vertex-ai", "googlevertexai": "vertex-ai",
}
PROVIDER_NAMES = {
    "bedrock": "AWS Bedrock", "azure": "Azure Foundry", "vertex-ai": "Vertex AI",
    "openai": "OpenAI", "anthropic": "Anthropic",
    "databricks": "Databricks", "3rd-party": "3rd Party", "gateway": "Gateway",
}


def slug(s):
    out = "".join(c if c.isalnum() else "-" for c in s.lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-") or "unknown"


def upstream_key(entry):
    entry = entry or {}
    info = entry.get("model_info") or {}
    params = entry.get("litellm_params") or {}
    raw = (
        (info.get("page_display_data") or {}).get("provider")
        or info.get("litellm_provider")
        or str(params.get("model", "")).split("/")[0]
        or "gateway"
    )
    key = PROVIDER_ALIASES.get(norm(raw)) or slug(raw)
    name = PROVIDER_NAMES.get(key) or raw.replace("_", " ").replace("-", " ").title()
    return key, name


def build_rows(fast, info):
    info_by_norm = {}
    for e in info:
        info_by_norm.setdefault(norm(e.get("model_name", "")), e)

    rows = []
    seen = set()
    for fm in fast:
        mid = fm.get("id", "")
        if mid in seen:
            continue
        seen.add(mid)
        entry = info_by_norm.get(norm(mid))
        mi = (entry or {}).get("model_info") or {}
        context = (
            mi.get("max_input_tokens")
            or fm.get("max_input_tokens")
            or mi.get("max_tokens")
            or 200_000
        )
        output = (
            mi.get("max_output_tokens")
            or fm.get("max_output_tokens")
            or mi.get("max_tokens")
            or 32_000
        )
        inp = mi.get("input_cost_per_token") or 0
        out = mi.get("output_cost_per_token") or 0
        cw = mi.get("cache_creation_input_token_cost") or 0
        cr = mi.get("cache_read_input_token_cost") or 0
        up = mi.get("litellm_provider") or None
        upstream_model = ((entry or {}).get("litellm_params") or {}).get("model") or None
        input_modes = ["text"]
        if mi.get("supports_vision"):
            input_modes.append("image")
        if mi.get("supports_pdf_input"):
            input_modes.append("pdf")
        if mi.get("supports_audio_input"):
            input_modes.append("audio")
        pkey, pname = upstream_key(entry)
        rows.append(
            {
                "provider_id": f"acc-{pkey}",
                "provider_name": pname,
                "model_id": mid,
                "aliases": [],
                "model_name": ((mi.get("page_display_data") or {}).get("name")) or mid,
                "mode": mi.get("mode") or fm.get("mode") or "chat",
                "enriched": bool(entry),
                "max_input_tokens": context,
                "max_output_tokens": output,
                "input_per_1M": round(inp * 1_000_000, 6),
                "output_per_1M": round(out * 1_000_000, 6),
                "cache_write_per_1M": round(cw * 1_000_000, 6),
                "cache_read_per_1M": round(cr * 1_000_000, 6),
                "input_per_1k": round(inp * 1_000, 6),
                "output_per_1k": round(out * 1_000, 6),
                "input_cost_above_200k_per_1M": (
                    round((mi.get("input_cost_per_token_above_200k_tokens") or 0) * 1_000_000, 6)
                    if mi.get("input_cost_per_token_above_200k_tokens") is not None
                    else None
                ),
                "output_cost_above_200k_per_1M": (
                    round((mi.get("output_cost_per_token_above_200k_tokens") or 0) * 1_000_000, 6)
                    if mi.get("output_cost_per_token_above_200k_tokens") is not None
                    else None
                ),
                "tools": mi.get("supports_function_calling", True),
                "vision": bool(mi.get("supports_vision")),
                "pdf": bool(mi.get("supports_pdf_input")),
                "audio": bool(mi.get("supports_audio_input")),
                "upstream_provider": up,
                "upstream_model": upstream_model,
            }
        )
    return dedupe_aliases(rows)


def dedupe_aliases(rows):
    """Fold gateway ids that point at the same deployment (same upstream model,
    display name and price) into one canonical row, like the plugin does."""
    groups = {}
    for r in rows:
        if r["enriched"] and r["upstream_model"]:
            key = (r["provider_id"], r["upstream_model"], r["model_name"], r["input_per_1M"], r["output_per_1M"])
        else:
            key = ("id", r["model_id"])
        groups.setdefault(key, []).append(r)
    out = []
    for group in groups.values():
        canonical = next((r for r in group if norm(r["model_id"]) == norm(r["model_name"])), group[0])
        canonical["aliases"] = [r["model_id"] for r in group if r is not canonical]
        out.append(canonical)
    names = {}
    for r in out:
        names[(r["provider_id"], r["model_name"])] = names.get((r["provider_id"], r["model_name"]), 0) + 1
    for r in out:
        if names[(r["provider_id"], r["model_name"])] > 1:
            r["model_name"] = r["model_id"]
    return sorted(out, key=lambda r: (r["provider_name"].lower(), r["model_name"].lower()))


def write_reports(rows, fp, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    doc = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fingerprint": fp,
        "base_url": BASE_URL,
        "count": len(rows),
        "rows": rows,
    }
    with open(os.path.join(out_dir, "models.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    cols = list(rows[0].keys()) if rows else []
    with open(os.path.join(out_dir, "models.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in rows:
            w.writerow([";".join(r[c]) if isinstance(r[c], list) else ("" if r[c] is None else r[c]) for c in cols])
    print(f"[i] wrote {len(rows)} rows to {out_dir}/models.json and models.csv")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true", help="only the fast /models endpoint")
    ap.add_argument("--info", action="store_true", help="only the slow /model/info endpoint")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--no-write", action="store_true", help="print only, do not write files")
    args = ap.parse_args()
    if not BASE_URL:
        sys.exit("[!] GATEWAY_BASE_URL is not set. Run mac-setup/setup.sh --only gateway, or add it to ~/.config/ai-gateway/env (or the file in GATEWAY_ENV_FILE).")

    key = read_key()
    print(f"[i] gateway  : {BASE_URL}")
    print(f"[i] key file : {KEY_FILE}")

    if not args.info:
        print("[i] fetching fast /models ...")
        fast, fast_elapsed = load_fast(key)
        print(f"[i] fast /models: {len(fast)} models in {fast_elapsed:.1f}s")
        fp = fingerprint(fast)
        print(f"[i] fingerprint: {fp}")
        if len(fast) < 20:
            for m in fast[:10]:
                print("   ", m["id"], m.get("mode"))
        if args.fast:
            rows = build_rows(fast, [])
            print(f"[i] computed {len(rows)} rows (fast-only, enriched=False)")
            if not args.no_write:
                write_reports(rows, fp, args.out)
            return

    print("[i] fetching slow /model/info ... (this may take a minute)")
    info, info_elapsed = load_info(key)
    print(f"[i] slow /model/info: {len(info)} entries in {info_elapsed:.1f}s")

    fast = fast if not args.info else None
    if fast is None:
        print("[i] fetching fast /models for the change signal ...")
        fast, _ = load_fast(key)

    rows = build_rows(fast, info)
    n_enriched = sum(1 for r in rows if r["enriched"])
    print(f"[i] merged {len(rows)} models; {n_enriched} enriched from slow endpoint")

    n_aliases = sum(len(r["aliases"]) for r in rows)
    print(f"[i] folded {n_aliases} alias ids into their canonical model")
    by_provider = {}
    for r in rows:
        by_provider.setdefault(r["provider_id"], []).append(r["model_id"])
    for prov, ids in sorted(by_provider.items()):
        print(f"   {prov:28s} {len(ids):3d} models  e.g. {', '.join(ids[:3])}")

    if not args.no_write:
        write_reports(rows, fp, args.out)


if __name__ == "__main__":
    main()
