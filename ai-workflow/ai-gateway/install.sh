#!/usr/bin/env bash
# Install the AI gateway module on this machine, on its own or from mac-setup (setup.sh --only gateway):
#   1. the OpenCode plugin      -> ~/.config/opencode/plugins/ai-gateway
#   2. gateway URL and API key  -> ~/.config/ai-gateway/env (chmod 600), key file (chmod 600)
#   3. Claude Code commands     -> ~/.claude/skills/{gateway-refresh,gateway-status,usage-dashboard,model-comparison}
#      and the usage hook in ~/.claude/settings.json (logs Claude Code calls to ~/.gateway-cost)
#   4. Antigravity usage hook   -> ~/.gemini/config/hooks.json (logs company-gateway Antigravity CLI & Desktop calls)
#   5. model comparison         -> built (Go + Node) into the plugin folder, opened with /model-comparison
# Every part asks first. Changed files are shown and confirmed, the old ones go to ~/.setup_backup/<stamp>/.
# The gateway URL and the key never enter this repo.
# Usage: ./install.sh [--dry-run] [--only plugin|env|claude|antigravity|compare]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Shared prompt/backup helpers (gum menus, install_file, install_tree, ask, ...).
. "$here/../../mac-setup/lib.sh"

GW_ENV="$HOME/.config/ai-gateway/env"
DST="$HOME/.config/opencode/plugins/ai-gateway"
CLAUDE_DIR="$HOME/.claude"
# Repo files that are not part of the installed plugin folder.
NOT_PLUGIN=(README.md install.sh "claude-skills/*" "model-comparison/*" .gitignore)

gw_get() { # gw_get <VAR>: its value from the env file (sourced in a subshell), empty if none
  [ -f "$GW_ENV" ] || return 0
  (set +eu; . "$GW_ENV"; printf '%s' "${!1:-}")
}
gw_value() { # gw_value <VAR>: the process environment first, then the env file
  local v="${!1:-}"
  if [ -z "$v" ]; then v="$(gw_get "$1")"; fi
  printf '%s' "$v"
}
gw_old_dirs() { # older plugin folders (named *-gateway, not ai-gateway) that hold claude_usage.py, one per line
  local d
  for d in "$HOME"/.config/opencode/plugins/*-gateway; do
    if [ -d "$d" ] && [ "$(basename "$d")" != ai-gateway ] && [ -e "$d/claude_usage.py" ]; then printf '%s\n' "$d"; fi
  done
  return 0
}
gw_copy_missing() { # gw_copy_missing <old folder> <new folder>: copy the files the new folder does not have yet
  local rel
  while IFS= read -r rel; do
    rel="${rel#./}"
    if [ -e "$2/$rel" ] || skip_file "$rel"; then continue; fi
    mkdir -p "$(dirname "$2/$rel")"; cp "$1/$rel" "$2/$rel"; info "copied $rel from $1"
  done < <(cd "$1" && find . -type f)
}
gw_cfg_hint() { # opencode.json still points at an old *-gateway folder: say so, the script does not edit it
  local cfg hits
  for cfg in "$HOME/.config/opencode/opencode.json" "$HOME/.config/opencode/opencode.jsonc"; do
    [ -f "$cfg" ] || continue
    hits="$(grep -nE -- '-gateway[/"]' "$cfg" | grep -vE 'ai-gateway[/"]' || true)"
    if [ -n "$hits" ]; then
      info "$cfg still has an old gateway plugin path, change it to .../plugins/ai-gateway by hand:"
      printf '%s\n' "$hits" | sed 's/^/        /'
    fi
  done
}
gw_key() { # gw_key <key file> <gateway url> <old key path, may be empty>
  local keyfile="$1" url="$2" old="$3" f key kdir
  if [ -z "$old" ] || [ ! -f "$old" ]; then
    old=""
    for f in "$HOME"/.keys/*opencode*.key; do
      if [ -f "$f" ]; then old="$f"; break; fi
    done
  fi
  if [ -n "$old" ] && [ "$old" != "$keyfile" ]; then
    if ask "Found the old key file $old. Move it to $keyfile (no copy, no backup)?"; then
      if dry; then info "would move $old -> $keyfile (chmod 600)"; return 0; fi
      kdir="$(dirname "$keyfile")"
      if [ ! -d "$kdir" ]; then mkdir -p "$kdir"; chmod 700 "$kdir"; fi
      mv "$old" "$keyfile"; chmod 600 "$keyfile"; info "moved $old -> $keyfile (chmod 600)"
      return 0
    fi
  fi
  if dry; then info "would ask for the API key and write $keyfile"; return 0; fi
  key="$(secret "API key for $url (typed hidden)")"
  if [ -n "$key" ]; then
    kdir="$(dirname "$keyfile")"
    if [ ! -d "$kdir" ]; then mkdir -p "$kdir"; chmod 700 "$kdir"; fi
    ( umask 077; printf '%s\n' "$key" > "$keyfile" ); chmod 600 "$keyfile"
    info "wrote $keyfile (chmod 600)"
  else info "no key given, $keyfile is still missing"; fi
  key=""
}

part_plugin() {
  bold "OpenCode plugin -> $DST"
  local olds olds_list=() old first_old idx
  ask "Install or update it?" || return 0
  # Old install: its folder is renamed to ai-gateway (no backup, the files live on under the new name).
  olds="$(gw_old_dirs)"
  first_old="${olds%%$'\n'*}"
  # Defaults from an old plugin's index.ts, read before anything moves. They only prefill the env prompts.
  idx="${first_old:-$DST}/index.ts"
  if [ -f "$idx" ]; then
    URL_DEF="$(sed -n 's/^const DEFAULT_BASE_URL = "\(.*\)".*/\1/p' "$idx")"; URL_DEF="${URL_DEF%%$'\n'*}"
    OLD_KEY="$(sed -n 's/^const DEFAULT_KEY_SPEC = "{file:\(.*\)}".*/\1/p' "$idx")"; OLD_KEY="${OLD_KEY%%$'\n'*}"
    if [ -n "$OLD_KEY" ]; then OLD_KEY="${OLD_KEY/#\~/$HOME}"; fi
  fi
  # Into an array first: a loop over <<< would hand its stdin to the questions below.
  while IFS= read -r old; do
    if [ -n "$old" ]; then olds_list+=("$old"); fi
  done <<< "$olds"
  for old in ${olds_list[@]+"${olds_list[@]}"}; do
    if [ ! -e "$DST" ]; then
      if dry; then info "would rename $old -> ai-gateway"; continue; fi
      mv "$old" "$DST"; info "renamed $old -> ai-gateway"
      continue
    fi
    info "$old and $DST both exist"
    if dry; then info "would copy the files ai-gateway lacks and remove $old"; continue; fi
    gw_copy_missing "$old" "$DST"
    if ask "Remove the old folder $old? opencode would load it as a second copy of the plugin" n; then
      rm -rf "$old"; info "removed $old"
    fi
  done
  install_tree "$here" "$DST" "${NOT_PLUGIN[@]}"
  gw_cfg_hint
}

part_env() {
  bold "Gateway URL and API key -> $GW_ENV"
  local cur url keyfile kf cost tmp
  cur="$(gw_value GATEWAY_BASE_URL)"; [ -n "$cur" ] || cur="${URL_DEF:-}"
  url="$(input "Gateway base URL (empty: skip)" "$cur")"
  if [ -z "$url" ]; then info "no URL, the env file is not written"; return 0; fi
  cur="$(gw_value GATEWAY_API_KEY_FILE)"
  keyfile="$(input "API key file" "${cur:-$HOME/.keys/ai-gateway.key}")"
  case "$keyfile" in   # ~, $HOME and ${HOME} typed at the prompt
    "~"|"~/"*) keyfile="$HOME${keyfile#\~}" ;;
    '$HOME'|'$HOME/'*) keyfile="$HOME${keyfile#\$HOME}" ;;
    '${HOME}'|'${HOME}/'*) keyfile="$HOME${keyfile#\$\{HOME\}}" ;;
  esac
  if [ ! -s "$keyfile" ]; then gw_key "$keyfile" "$url" "${OLD_KEY:-}"; fi

  cost="$(gw_value GATEWAY_COST_DIR)"
  kf="${keyfile/#"$HOME"/\$HOME}"; cost="${cost/#"$HOME"/\$HOME}"   # $HOME stays in the file
  tmp="$(mktemp)"
  {
    printf 'export GATEWAY_BASE_URL="%s"\n' "$url"
    printf 'export GATEWAY_API_KEY_FILE="%s"\n' "$kf"
    if [ -n "$cost" ]; then printf 'export GATEWAY_COST_DIR="%s"\n' "$cost"; fi
  } > "$tmp"
  mkdir -p "$(dirname "$GW_ENV")" 2>/dev/null || true
  install_file "$tmp" "$GW_ENV"
  rm -f "$tmp"
  if ! dry && [ -e "$GW_ENV" ]; then chmod 600 "$GW_ENV"; fi

  if dry; then info "would run check_gateway.py"
  elif have python3 && [ -f "$DST/check_gateway.py" ]; then
    ( . "$GW_ENV"; python3 "$DST/check_gateway.py" ) || info "check_gateway.py reported a problem (not fatal, see above)"
  fi
}

part_claude() {
  bold "Claude Code: /gateway-refresh, /gateway-status, /usage-dashboard, /model-comparison and the usage hook"
  local settings="$CLAUDE_DIR/settings.json" collector="$DST/claude_usage.py" merged
  if ! have claude && [ ! -d "$CLAUDE_DIR" ]; then info "Claude Code is not installed, skipped"; return 0; fi
  ask "Install them?" || return 0
  # Only these skill folders are written; other skills in ~/.claude/skills are left alone.
  install_tree "$here/claude-skills" "$CLAUDE_DIR/skills"
  # Usage hook: after every turn, subagent and session, claude_usage.py appends the new API calls from the
  # transcripts to ~/.gateway-cost/usage.jsonl (silent, always exits 0). An older usage hook (also one pointing
  # at an older plugin path) is replaced, everything else in settings.json is kept. You see the diff first.
  merged="$(mktemp)"
  python3 - "$settings" "$merged" "$collector" <<'PY'
import json, os, sys
path, out, collector = sys.argv[1:4]
data = json.load(open(path)) if os.path.exists(path) else {}
hooks = data.setdefault("hooks", {})
command = f'[ -f "{collector}" ] && python3 -I "{collector}"; true'
for event in ("Stop", "SubagentStop", "SessionEnd"):
    groups = [g for g in hooks.get(event, []) if not any("claude_usage.py" in h.get("command", "") for h in g.get("hooks", []))]
    groups.append({"hooks": [{"type": "command", "command": command, "timeout": 30}]})
    hooks[event] = groups
open(out, "w").write(json.dumps(data, indent=2) + "\n")
PY
  install_file "$merged" "$settings"
  rm -f "$merged"
  info "usage hook: Stop, SubagentStop, SessionEnd (claude_usage.py)"
  if [ ! -e "$collector" ]; then info "note: $collector is not installed yet, the hook does nothing until the plugin part runs"
  elif dry; then info "would import the Claude Code usage history with claude_usage.py"
  else python3 -I "$collector" </dev/null; fi   # import what is not logged yet (first run: the history)
}

part_antigravity() {
  bold "Antigravity (CLI & Desktop): company-gateway usage hook -> ~/.gemini/config/hooks.json"
  local hooks_file="$HOME/.gemini/config/hooks.json" collector="$DST/antigravity_usage.py" merged
  if ! have agy && [ ! -d "/Applications/Antigravity.app" ] && [ ! -d "$HOME/.gemini" ]; then
    info "Antigravity is not installed, skipped"; return 0
  fi
  ask "Install or update the Antigravity usage hook?" || return 0
  merged="$(mktemp)"
  python3 - "$hooks_file" "$merged" "$collector" <<'PY'
import json, os, sys
path, out, collector = sys.argv[1:4]
data = json.load(open(path)) if os.path.exists(path) else {}
cmd_post = f'[ -f "{collector}" ] && python3 -I "{collector}" || printf \'{{}}\\n\''
cmd_stop = f'[ -f "{collector}" ] && python3 -I "{collector}" || printf \'{{"decision":"allow"}}\\n\''
data["ai-gateway-usage"] = {
    "PostInvocation": [{"type": "command", "command": cmd_post, "timeout": 15}],
    "Stop": [{"type": "command", "command": cmd_stop, "timeout": 15}],
}
open(out, "w").write(json.dumps(data, indent=2) + "\n")
PY
  mkdir -p "$(dirname "$hooks_file")" 2>/dev/null || true
  install_file "$merged" "$hooks_file"
  rm -f "$merged"
  info "usage hook: PostInvocation, Stop (antigravity_usage.py — company gateway only)"
}

part_compare() {
  bold "Model comparison dashboard (Artificial Analysis benchmarks joined with the gateway catalog)"
  local src="$here/model-comparison" stage
  if [ ! -f "$src/Makefile" ]; then info "$src is missing, skipped"; return 0; fi
  if ! have go || ! have node || ! have npm; then
    info "needs go, node and npm to build (mac-setup: setup.sh --only asdf), skipped"; return 0
  fi
  ask "Build and install it into $DST/model-comparison?" || return 0
  if dry; then info "would run make -C $src install and copy the result to $DST/model-comparison"; return 0; fi
  stage="$(mktemp -d)"
  # DRY_RUN is cleared for make: lib.sh exports DRY_RUN=0, and the Makefile has its own dry-run switch.
  if DRY_RUN= make -s -C "$src" install DEST="$stage" && [ -f "$stage/compare.mjs" ] && [ -d "$stage/web" ]; then
    # Everything in there is generated: replace it as a whole (no backup needed, the source is this repo).
    mkdir -p "$DST/model-comparison"
    rsync -a --delete "$stage/" "$DST/model-comparison/"
    info "installed $DST/model-comparison (open it with /model-comparison, or: node $DST/index.ts compare)"
  else
    info "the build failed, see above; the dashboard is not installed"
  fi
  rm -rf "$stage"
}

main() {
  local only="" p
  URL_DEF=""; OLD_KEY=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1; export DRY_RUN ;;
      --only) only="${2:-}"; shift ;;
      -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) echo "unknown option $1 (see --help)"; exit 1 ;;
    esac
    shift
  done
  if dry; then bold "Dry run: nothing is installed, written, moved or backed up"; fi
  case "$only" in
    "") for p in plugin env claude antigravity compare; do "part_$p"; done ;;
    plugin|env|claude|antigravity|compare) "part_$only" ;;
    *) echo "unknown part $only (plugin, env, claude, antigravity, compare)"; exit 1 ;;
  esac
  if [ -d "$BACKUP_DIR" ]; then info "replaced files were backed up to $BACKUP_DIR"; fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
