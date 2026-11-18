#!/usr/bin/env bash
# Install (or uninstall) HerdrCommander: the cc-* scripts, hc templates and agent skills.
#
#   ./install.sh [--dry-run]       install / update
#   ./install.sh --uninstall       remove what this script installed (your models.json is kept)
#   ./install.sh --help
#
# Environment overrides:
#   PREFIX               install prefix for the scripts (default ~/.local -> ~/.local/bin)
#   CC_CONFIG            config file (default ~/.config/command-center/models.json)
#   HC_TEMPLATES_DIR     hc template folder (default ~/.config/herdr-core/templates)
#   HC_CONFIG_FILE       hc settings file (default ~/.config/herdr-core/config.toml; draft_wait = 0 is added)
#   SKILLS_DIR           skills folder (default ~/.agents/skills)
#
# Anything that would be replaced and differs is first copied to ~/.setup_backup/<stamp>/ (same convention as
# mac-setup/lib.sh). Plain bash 3.2 compatible (macOS /bin/bash). Dependencies are checked, never installed.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
MODELS_JSON="${CC_CONFIG:-$HOME/.config/command-center/models.json}"
case "$MODELS_JSON" in "~"/*) MODELS_JSON="$HOME/${MODELS_JSON#\~/}" ;; esac
TEMPLATES_DIR="${HC_TEMPLATES_DIR:-$HOME/.config/herdr-core/templates}"
HC_CONFIG="${HC_CONFIG_FILE:-$HOME/.config/herdr-core/config.toml}"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.agents/skills}"
LINK_DIRS="$HOME/.config/opencode/skills $HOME/.claude/skills"   # symlinked into only when they already exist
SKILLS="herdr-commander herdr-model-router herdr-worker"
BACKUP_DIR="${SETUP_BACKUP_DIR:-$HOME/.setup_backup/$(date +%Y%m%d-%H%M%S)}"

have() { command -v "$1" >/dev/null 2>&1; }
dry() { [ "$DRY_RUN" = 1 ]; }
bold() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    ! %s\n' "$*" >&2; }

backup_dst() {
  case "$1" in
    "$HOME"/*) printf '%s/%s\n' "$BACKUP_DIR" "${1#"$HOME"/}" ;;
    *) printf '%s/_root%s\n' "$BACKUP_DIR" "$1" ;;
  esac
}
backup() { # copy a file, folder or symlink into $BACKUP_DIR; nothing when it does not exist
  local dst
  [ -e "$1" ] || [ -L "$1" ] || return 0
  dst="$(backup_dst "$1")"
  mkdir -p "$(dirname "$dst")"
  cp -Rp "$1" "$dst"
}
diffstat() { # "+N/-M lines"
  diff "$1" "$2" 2>/dev/null | awk '/^>/{p++} /^</{m++} END{ if (p + m == 0) print "differs"; else printf "+%d/-%d lines", p, m }' || true
}

# install_file <src> <dst> [mode]: missing -> create; same -> nothing; different -> back up, replace.
install_file() {
  local src="$1" dst="$2" mode="${3:-644}"
  if [ -L "$dst" ]; then
    if dry; then info "would replace symlink $dst with a file (old link backed up)"; return 0; fi
    backup "$dst"; rm -f "$dst"
  fi
  if [ ! -e "$dst" ]; then
    if dry; then info "would create $dst"; return 0; fi
    mkdir -p "$(dirname "$dst")"; cat "$src" > "$dst"; chmod "$mode" "$dst"; info "new       $dst"; return 0
  fi
  if cmp -s "$src" "$dst"; then
    if ! dry && [ "$mode" = 755 ] && [ ! -x "$dst" ]; then chmod 755 "$dst"; fi
    info "unchanged $dst"; return 0
  fi
  if dry; then info "would update $dst ($(diffstat "$dst" "$src"); old copy goes to $(backup_dst "$dst"))"; return 0; fi
  backup "$dst"; cat "$src" > "$dst"; chmod "$mode" "$dst"
  info "updated   $dst ($(diffstat "$(backup_dst "$dst")" "$dst"); old copy in $(backup_dst "$dst"))"
}

check_deps() {
  local missing=0 v
  bold "Checking dependencies"
  if have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
    info "ok   python3 $(python3 -c 'import platform; print(platform.python_version())')"
  else
    warn "python3 >= 3.9 missing  -> macOS: xcode-select --install or 'brew install python'; Linux: use your package manager"; missing=1
  fi
  if have git; then
    v="$(git --version | sed -n 's/^git version \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')"
    if [ -n "$v" ] && { [ "${v%% *}" -gt 2 ] || { [ "${v%% *}" -eq 2 ] && [ "${v##* }" -ge 31 ]; }; }; then
      info "ok   $(git --version)"
    else
      warn "git >= 2.31 required (found: $(git --version))  -> 'brew install git' or your package manager"; missing=1
    fi
  else
    warn "git missing  -> 'brew install git' or your package manager"; missing=1
  fi
  if have hc || [ -x "$HOME/.local/bin/hc" ]; then info "ok   hc (herdr-core)"; else
    warn "hc (herdr-core) not found  -> install Herdr and make 'hc' available on PATH (see the Herdr docs)"; missing=1
  fi
  if have herdr-app || [ -x "$HOME/.local/bin/herdr-app" ]; then info "ok   herdr-app"; else
    warn "herdr-app not found  -> install the Herdr desktop app and make 'herdr-app' available on PATH"; missing=1
  fi
  if have opencode || [ -x "$HOME/.opencode/bin/opencode" ]; then info "ok   opencode"; else
    warn "opencode not found  -> curl -fsSL https://opencode.ai/install | bash   (or: brew install sst/tap/opencode)"; missing=1
  fi
  if [ "$missing" = 1 ]; then info "Missing tools are not installed by this script; installing HerdrCommander anyway."; fi
}

render_template() { # render_template <src> <out>: fill in the real cc-agent path
  local esc
  esc="$(printf '%s' "$BIN_DIR/cc-agent" | sed 's/[&|\\]/\\&/g')"
  sed "s|__CC_AGENT__|$esc|g" "$1" > "$2"
}

link_skill() { # link_skill <name> <linkdir>
  local name="$1" linkdir="$2" link target
  link="$linkdir/$name"; target="$SKILLS_DIR/$name"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then info "unchanged $link"; return 0; fi
  if [ -e "$link" ] || [ -L "$link" ]; then
    if dry; then info "would replace $link (old one backed up to $(backup_dst "$link"))"; else backup "$link"; rm -rf "$link"; fi
  fi
  if dry; then info "would link $link -> $target"; return 0; fi
  ln -s "$target" "$link"; info "linked    $link -> $target"
}

do_install() {
  local t name out d tmp
  check_deps

  bold "Scripts -> $BIN_DIR"
  for f in "$here"/bin/*; do [ -f "$f" ] || continue; install_file "$f" "$BIN_DIR/$(basename "$f")" 755; done

  bold "hc templates -> $TEMPLATES_DIR"
  tmp="$(mktemp -d)"
  for t in "$here"/templates/*.md; do
    out="$tmp/$(basename "$t")"; render_template "$t" "$out"
    install_file "$out" "$TEMPLATES_DIR/$(basename "$t")" 644
  done
  rm -rf "$tmp"

  bold "Skills -> $SKILLS_DIR"
  for name in $SKILLS; do install_file "$here/skills/$name/SKILL.md" "$SKILLS_DIR/$name/SKILL.md" 644; done
  for d in $LINK_DIRS; do
    if [ -d "$d" ]; then
      for name in $SKILLS; do link_skill "$name" "$d"; done
    else
      info "skip links: $d does not exist"
    fi
  done

  bold "hc settings -> $HC_CONFIG"
  # Reports must reach the Commander at once, not wait up to 60 s for a draft typed into it.
  # Only adds the key when it is missing, so a deliberate own value is kept.
  if [ -e "$HC_CONFIG" ] && grep -qE '^[[:space:]]*draft_wait[[:space:]]*=' "$HC_CONFIG"; then
    info "kept draft_wait in $HC_CONFIG ($(grep -E '^[[:space:]]*draft_wait' "$HC_CONFIG" | head -1 | tr -d ' '))"
  elif dry; then
    info "would set draft_wait = 0 in $HC_CONFIG"
  else
    backup "$HC_CONFIG"; mkdir -p "$(dirname "$HC_CONFIG")"
    printf '# HerdrCommander: deliver hc send / parent notes without waiting for a typed draft\ndraft_wait = 0\n' >> "$HC_CONFIG"
    info "set draft_wait = 0 in $HC_CONFIG"
  fi

  bold "Config -> $MODELS_JSON"
  if [ -e "$MODELS_JSON" ]; then
    info "kept existing config (never overwritten)"
  elif dry; then
    info "would create $MODELS_JSON from config/models.example.json"
  else
    mkdir -p "$(dirname "$MODELS_JSON")"; cp "$here/config/models.example.json" "$MODELS_JSON"
    info "created $MODELS_JSON from the example (no models chosen yet)"
  fi
  if ! dry && grep -q '"<provider>/' "$MODELS_JSON" 2>/dev/null; then
    if [ -t 0 ] && [ -t 1 ]; then
      bold "Models: balanced recommendation (other profiles: cc-models recommend --profile lean|max)"
      "$BIN_DIR/cc-models" recommend --apply || warn "no models written: run 'cc-models recommend --apply' later, or edit $MODELS_JSON by hand"
    else
      warn "no models chosen yet: run 'cc-models recommend --apply' (or replace each <provider>/<model> placeholder by hand)"
    fi
  fi

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH. Add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  if dry; then bold "Dry run: nothing was changed."; elif [ -d "$BACKUP_DIR" ]; then info "Backups of replaced files: $BACKUP_DIR"; fi
  bold "Done. Next: cc-commander   (see README.md)"
}

remove_file() { # remove_file <path> <src or empty>: back up then delete
  [ -e "$1" ] || [ -L "$1" ] || return 0
  if dry; then info "would remove $1"; return 0; fi
  backup "$1"; rm -rf "$1"; info "removed   $1 (copy in $(backup_dst "$1"))"
}

do_uninstall() {
  local f name d link
  bold "Removing scripts from $BIN_DIR"
  for f in "$here"/bin/*; do [ -f "$f" ] || continue; remove_file "$BIN_DIR/$(basename "$f")"; done
  bold "Removing hc templates from $TEMPLATES_DIR"
  for f in "$here"/templates/*.md; do remove_file "$TEMPLATES_DIR/$(basename "$f")"; done
  bold "Removing skills"
  for d in $LINK_DIRS; do
    for name in $SKILLS; do
      link="$d/$name"
      if [ -L "$link" ] && [ "$(readlink "$link")" = "$SKILLS_DIR/$name" ]; then remove_file "$link"; fi
    done
  done
  for name in $SKILLS; do
    remove_file "$SKILLS_DIR/$name/SKILL.md"
    if ! dry; then rmdir "$SKILLS_DIR/$name" 2>/dev/null || true; fi
  done
  info "kept $MODELS_JSON and ~/.local/state/command-center (delete them by hand if you want them gone)"
  if dry; then bold "Dry run: nothing was changed."; fi
}

if [ "$UNINSTALL" = 1 ]; then do_uninstall; else do_install; fi
