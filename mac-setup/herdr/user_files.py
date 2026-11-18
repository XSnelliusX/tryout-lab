#!/usr/bin/env python3
"""Helpers for update-config.sh: which Herdr app files are mine, and a clean copy of a layout.

  user_files.py list <herdr-app dir>          print my files, relative to the dir: settings.json, keys.json,
                                              every layout and mod Herdr did not ship (installed.json lists those)
  user_files.py layout <in.json> <out.json>   copy a layout without the live "commander-term" block, whose
                                              terminal id changes on every Commander restart (cc-commander adds it back)
"""
import json
import os
import sys

SKIP = {"gpui-kit.d.ts", "jsconfig.json", ".DS_Store"}  # written by Herdr into every mod folder


def list_files(root):
    try:
        shipped = set(json.load(open(os.path.join(root, "installed.json"))))
    except (OSError, ValueError):
        shipped = set()
    out = [f for f in ("settings.json", "keys.json") if os.path.isfile(os.path.join(root, f))]
    layouts = os.path.join(root, "layouts")
    for f in sorted(os.listdir(layouts)) if os.path.isdir(layouts) else []:
        name, ext = os.path.splitext(f)
        if ext in (".json", ".svg") and f"layout:{name}" not in shipped and os.path.isfile(os.path.join(layouts, f)):
            out.append(f"layouts/{f}")
    mods = os.path.join(root, "mods")
    for m in sorted(os.listdir(mods)) if os.path.isdir(mods) else []:
        if m in shipped or not os.path.isdir(os.path.join(mods, m)):
            continue
        for dirpath, _dirs, files in os.walk(os.path.join(mods, m)):
            for f in sorted(files):
                if f not in SKIP:
                    out.append(os.path.relpath(os.path.join(dirpath, f), root))
    print("\n".join(out))


def strip(node):
    if isinstance(node, dict):
        if isinstance(node.get("children"), list):
            node["children"] = [strip(c) for c in node["children"] if not (isinstance(c, dict) and c.get("id") == "commander-term")]
        return node
    return node


def layout(src, dst):
    with open(src) as f:
        raw = f.read()
    data = json.loads(raw)
    if '"commander-term"' not in raw:  # nothing to strip: keep the file byte for byte
        with open(dst, "w") as f:
            f.write(raw)
        return
    with open(dst, "w") as f:
        json.dump(strip(data), f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "list":
        list_files(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "layout":
        layout(sys.argv[2], sys.argv[3])
    else:
        print(__doc__.strip())
        sys.exit(1)
