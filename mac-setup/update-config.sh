#!/usr/bin/env bash
# Pull the configs currently live on this machine back into the repo, so the repo stays the source of truth.
# Shows a diff for every changed file and asks before copying. Home paths are rewritten to $HOME,
# and the gateway URL (from $GATEWAY_BASE_URL or ~/.config/ai-gateway/env) to $GATEWAY_BASE_URL.
# Usage: ./update-config.sh [-n|--dry-run] [-y|--yes]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
dry=0; yes=0
for a in "$@"; do case "$a" in -n|--dry-run) dry=1 ;; -y|--yes) yes=1 ;; *) echo "unknown option $a"; exit 1 ;; esac; done

changed=0
gw_url="${GATEWAY_BASE_URL:-}"
if [ -z "$gw_url" ] && [ -f "$HOME/.config/ai-gateway/env" ]; then
  gw_url="$(set +eu; . "$HOME/.config/ai-gateway/env"; printf '%s' "${GATEWAY_BASE_URL:-}")"
fi
pull() { # pull <live file> <repo file>
  local src="$1" dst="$2" tmp prog
  [ -e "$src" ] || { echo "skip   $dst (not on this machine)"; return 0; }
  tmp="$(mktemp)"; prog="s#$HOME#\$HOME#g"
  if [ -n "$gw_url" ]; then   # the real URL must never reach the repo
    prog="s|$(printf '%s' "$gw_url" | sed 's/[][\.*^$|]/\\&/g')|\$GATEWAY_BASE_URL|g;$prog"
  fi
  sed "$prog" "$src" > "$tmp"
  if [ -n "$gw_url" ] && grep -qF -- "$gw_url" "$tmp"; then
    rm -f "$tmp"; echo "refuse ${dst#"$repo"/}: the gateway URL is still in it"; return 0
  fi
  if [ -e "$dst" ] && cmp -s "$tmp" "$dst"; then rm -f "$tmp"; echo "same   ${dst#"$repo"/}"; return 0; fi
  changed=$((changed + 1))
  echo "CHANGED ${dst#"$repo"/}"
  [ -e "$dst" ] && diff -u "$dst" "$tmp" | sed 's/^/    /' | head -60 || true
  if [ "$dry" = 0 ] && { [ "$yes" = 1 ] || { read -r -p "    take over? [y/N] " r && [[ "$r" =~ ^[Yy] ]]; }; }; then
    mkdir -p "$(dirname "$dst")"; cp "$tmp" "$dst"; echo "    updated"
  fi
  rm -f "$tmp"
}

pull "$HOME/.zshrc"                                  "$here/zsh/.zshrc"
pull "$HOME/.p10k.zsh"                               "$here/zsh/p10k.zsh"
pull "$HOME/.claude/statusline.py"                   "$here/claude-code/statusline.py"
pull "$HOME/.config/cmux/cmux.json"                  "$here/cmux/config/cmux/cmux.json"
pull "$HOME/Library/Application Support/com.mitchellh.ghostty/config.ghostty" "$here/cmux/config/ghostty/config.ghostty"
for f in "$HOME"/.config/cmux/sidebars/*.js; do pull "$f" "$here/cmux/config/cmux/sidebars/$(basename "$f")"; done
# Neovim (LazyVim): every config file, including lazy-lock.json (plugin versions after :Lazy update).
while IFS= read -r f; do pull "$HOME/.config/nvim/$f" "$here/nvim/$f"; done < <(
  cd "$HOME/.config/nvim" 2>/dev/null &&
    find . -type f \( -name '*.lua' -o -name '*.json' -o -name '*.toml' -o -name '*.yaml' \) | sed 's#^\./##' | sort)
# The AI gateway plugin for opencode (the folder setup.sh installs) and the global asdf versions.
for f in index.ts tui.ts check_gateway.py claude_usage.py dashboard.html package.json; do
  pull "$HOME/.config/opencode/plugins/ai-gateway/$f" "$here/ai-gateway/$f"
done
pull "$HOME/.tool-versions" "$here/asdf/tool-versions"

# Vorssaint is a binary plist in defaults, so export it instead of copying a file.
tmp="$(mktemp)"
if python3 "$here/vorssaint/vorssaint.py" export "$tmp" >/dev/null 2>&1; then
  if cmp -s "$tmp" "$here/vorssaint/com.vorssaint.utils.plist"; then echo "same   mac-setup/vorssaint/com.vorssaint.utils.plist"; else
    changed=$((changed + 1)); echo "CHANGED mac-setup/vorssaint/com.vorssaint.utils.plist"
    diff -u "$here/vorssaint/com.vorssaint.utils.plist" "$tmp" | sed 's/^/    /' | head -40 || true
    if [ "$dry" = 0 ] && { [ "$yes" = 1 ] || { read -r -p "    take over? [y/N] " r && [[ "$r" =~ ^[Yy] ]]; }; }; then
      cp "$tmp" "$here/vorssaint/com.vorssaint.utils.plist"; echo "    updated"
    fi
  fi
fi
rm -f "$tmp"

echo; echo "$changed file(s) differ. Review with 'git diff', then commit."
