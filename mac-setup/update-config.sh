#!/usr/bin/env bash
# Pull the configs currently live on this machine back into the repo, so the repo stays the source of truth.
# Shows a diff for every changed file and asks before copying. Home paths are rewritten to $HOME.
# Usage: ./update-config.sh [-n|--dry-run] [-y|--yes]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
dry=0; yes=0
for a in "$@"; do case "$a" in -n|--dry-run) dry=1 ;; -y|--yes) yes=1 ;; *) echo "unknown option $a"; exit 1 ;; esac; done

changed=0
pull() { # pull <live file> <repo file>
  local src="$1" dst="$2" tmp
  [ -e "$src" ] || { echo "skip   $dst (not on this machine)"; return 0; }
  tmp="$(mktemp)"; sed "s#$HOME#\$HOME#g" "$src" > "$tmp"
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
