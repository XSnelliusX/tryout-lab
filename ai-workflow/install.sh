#!/usr/bin/env bash
# Install the AI workflow: three tools that share one model comparison and one recommendation engine.
#   1. gateway   ai-gateway/install.sh: OpenCode plugin, usage log and dashboard, Claude Code commands,
#                and the model comparison with its recommendation engine (asks per part)
#   2. rewrite   opencode-prompt-rewrite: the /rw prompt rewriter for OpenCode (reads the engine's picks)
#   3. herdr     herdr-commander/install.sh: Herdr Command Center (cc-* scripts, planner, cc-models)
# The gateway comes first: the other two read what it writes ($GATEWAY_COST_DIR, default ~/.gateway-cost).
# Every step asks first; replaced files go to ~/.setup_backup/<stamp>/ (one folder for the whole run).
# Usage: ai-workflow/install.sh [--dry-run] [--only gateway|rewrite|herdr]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../mac-setup/lib.sh
. "$here/../mac-setup/lib.sh"

step_gateway() {
  bold "1/3 AI gateway: plugin, usage dashboard, model comparison and recommendation engine"
  if dry; then "$here/ai-gateway/install.sh" --dry-run; else "$here/ai-gateway/install.sh"; fi
}

step_rewrite() {
  bold "2/3 Prompt rewriter for OpenCode (/rw): model advice from the comparison's picks"
  if ! have node; then info "node not found (mac-setup: setup.sh --only asdf), skipped"; return 0; fi
  ask "Install or update the prompt rewriter?" || return 0
  run node "$here/opencode-prompt-rewrite/scripts/install.mjs"
}

step_herdr() {
  bold "3/3 Herdr Command Center: commander, workers, planner, cc-models"
  ask "Install or update herdr-commander?" || return 0
  if dry; then "$here/herdr-commander/install.sh" --dry-run; else "$here/herdr-commander/install.sh"; fi
}

main() {
  local only=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1; export DRY_RUN ;;
      --only) only="${2:-}"; shift ;;
      -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) echo "unknown option $1 (--dry-run, --only gateway|rewrite|herdr)"; exit 2 ;;
    esac
    shift
  done
  if dry; then bold "Dry run: nothing is installed, written, moved or backed up"; fi
  case "$only" in
    "") for s in gateway rewrite herdr; do "step_$s"; done ;;
    gateway|rewrite|herdr) "step_$only" ;;
    *) echo "unknown step $only (gateway, rewrite, herdr)"; exit 2 ;;
  esac
  bold "Next"
  info "Open /model-comparison once (OpenCode or Claude Code): it syncs the benchmarks and writes the"
  info "recommendations that cc-models and the prompt rewriter read. Then: cc-models recommend --profile balanced"
  if [ -d "$BACKUP_DIR" ]; then info "replaced files were backed up to $BACKUP_DIR"; fi
}

main "$@"
