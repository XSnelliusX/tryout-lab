#!/usr/bin/env bash
# Interactive setup for a fresh Mac. Safe to re-run: finished steps are detected and skipped.
# Usage: ./setup.sh              walk through every step
#        ./setup.sh --only ssh   run one step (list them with --list)
# Existing files are backed up as *.bak-<timestamp>. Private keys are never copied anywhere.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
stamp="$(date +%Y%m%d-%H%M%S)"

STEPS=(xcode brew packages shell font zshrc git github ssh claude cmux vorssaint neovim asdf macos)

bold() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ask() { # ask <question> [default y|n]
  local def="${2:-y}" hint reply
  [ "$def" = y ] && hint="Y/n" || hint="y/N"
  read -r -p "    $1 [$hint] " reply || reply=""
  reply="${reply:-$def}"
  [[ "$reply" =~ ^[Yy] ]]
}
backup() { [ -e "$1" ] && cp "$1" "$1.bak-$stamp" || true; }
put() { # put <source> <destination>
  mkdir -p "$(dirname "$2")"; backup "$2"; cp "$1" "$2"; info "installed $2"
}
have() { command -v "$1" >/dev/null 2>&1; }

# openssl@3/readline/xz/sqlite are build deps for asdf python; fd/lazygit/tree-sitter-cli for LazyVim
FORMULAE=(git gh fzf eza bat watch jq ripgrep fd lazygit asdf openssl@3 readline xz sqlite nvm neovim k9s tree-sitter-cli yarn powerlevel10k)
CASKS=(rancher cmux vorssaint)
PLUGINS=(
  "zsh-users/zsh-completions"
  "Aloxaf/fzf-tab"
  "Freed-Wu/fzf-tab-source"
  "zsh-users/zsh-autosuggestions"
  "zsh-users/zsh-syntax-highlighting"
  "zsh-users/zsh-history-substring-search"
)

step_xcode() {
  bold "Xcode Command Line Tools (compiler, make and git, needed before Homebrew)"
  if xcode-select -p >/dev/null 2>&1; then info "already installed"; else
    xcode-select --install || true
    info "Finish the installer dialog that just opened, I will wait."
    until xcode-select -p >/dev/null 2>&1; do sleep 5; done
  fi
  info "$(git --version)"
}

step_brew() {
  bold "Homebrew"
  if [ ! -x /opt/homebrew/bin/brew ]; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  else info "already installed"; fi
  eval "$(/opt/homebrew/bin/brew shellenv)"
  # .zshrc does not set up brew itself, so keep it on PATH for every login shell.
  grep -qs 'brew shellenv' "$HOME/.zprofile" 2>/dev/null ||
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
  brew --version | head -1
}

step_packages() {
  bold "Packages: ${FORMULAE[*]} + casks ${CASKS[*]}"
  ask "Install them?" || return 0
  brew install "${FORMULAE[@]}"
  for c in "${CASKS[@]}"; do brew list --cask "$c" >/dev/null 2>&1 || brew install --cask "$c"; done
}

step_shell() {
  bold "oh-my-zsh and zsh plugins"
  if [ ! -d "$HOME/.oh-my-zsh" ]; then
    RUNZSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
  fi
  local custom="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}" p
  for p in "${PLUGINS[@]}"; do
    [ -d "$custom/plugins/${p##*/}" ] || git clone --depth 1 "https://github.com/$p" "$custom/plugins/${p##*/}"
  done
}

step_font() {
  bold "MesloLGS NF font (Powerlevel10k prompt icons, used by cmux)"
  local dir="$HOME/Library/Fonts" base="https://github.com/romkatv/powerlevel10k-media/raw/master" f
  for f in Regular Bold Italic "Bold Italic"; do
    [ -e "$dir/MesloLGS NF $f.ttf" ] || curl -fsSL -o "$dir/MesloLGS NF $f.ttf" "$base/MesloLGS%20NF%20${f// /%20}.ttf"
  done
  info "fonts in $dir"
}

step_zshrc() {
  bold "zsh config (.zshrc, Powerlevel10k)"
  ask "Install them to your home folder?" || return 0
  put "$here/zsh/.zshrc" "$HOME/.zshrc"
  put "$here/zsh/p10k.zsh" "$HOME/.p10k.zsh"
}

step_git() {
  bold "Git identity"
  local name email
  name="$(git config --global user.name || true)"; email="$(git config --global user.email || true)"
  if [ -n "$name" ] && [ -n "$email" ]; then info "already set: $name <$email>"; ask "Keep it?" && return 0; fi
  read -r -p "    Full name [$name]: " n; read -r -p "    Email [$email]: " e
  git config --global user.name "${n:-$name}"; git config --global user.email "${e:-$email}"
  git config --global init.defaultBranch main
}

step_github() {
  bold "GitHub login (gh CLI, browser based)"
  if gh auth status -h github.com >/dev/null 2>&1; then info "already logged in to github.com"; else
    ask "Log in to github.com now?" && gh auth login -h github.com -p https -w
  fi
  gh auth status -h github.com >/dev/null 2>&1 && gh auth setup-git -h github.com || true
  if ask "Also log in to a GitHub Enterprise server?" n; then
    read -r -p "    Hostname: " host
    [ -n "$host" ] && gh auth login -h "$host" -p https -w
  fi
}

step_ssh() {
  bold "SSH key (stays on this machine, only the public key goes to GitHub)"
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  local keys=() k key choice
  for k in "$HOME"/.ssh/id_*; do [[ "$k" == *.pub || ! -e "$k" ]] || keys+=("$k"); done
  if [ ${#keys[@]} -gt 0 ]; then
    info "Existing keys:"; printf '      %s\n' "${keys[@]}"
    read -r -p "    Path of the key to use, or press Enter to create a new one: " choice
    key="${choice:-}"
  fi
  if [ -z "${key:-}" ]; then
    read -r -p "    New key path [$HOME/.ssh/id_ed25519]: " key; key="${key:-$HOME/.ssh/id_ed25519}"
    [ -e "$key" ] && { info "$key exists, not overwriting"; return 0; }
    ssh-keygen -t ed25519 -C "$(git config --global user.email)" -f "$key"   # asks for a passphrase
  fi
  [ -e "$key" ] || { info "no such key: $key"; return 0; }
  ssh-add --apple-use-keychain "$key"
  if ! grep -qs "IdentityFile $key" "$HOME/.ssh/config" 2>/dev/null; then
    printf '\nHost github.com\n    HostName github.com\n    User git\n    AddKeysToAgent yes\n    UseKeychain yes\n    IdentityFile %s\n' "$key" >> "$HOME/.ssh/config"
    chmod 600 "$HOME/.ssh/config"; info "added github.com to ~/.ssh/config"
  fi
  if have gh && gh auth status -h github.com >/dev/null 2>&1 && ask "Upload ${key}.pub to your GitHub account?"; then
    gh auth refresh -h github.com -s admin:public_key
    gh ssh-key add "$key.pub" --title "$(scutil --get ComputerName || hostname)"
    ssh -T -o StrictHostKeyChecking=accept-new git@github.com || true   # exits 1 on success
  fi
}

step_claude() {
  bold "Claude Code (native installer) and statusline"
  if have claude; then info "already installed: $(claude --version 2>/dev/null || true)"; else
    curl -fsSL https://claude.ai/install.sh | bash
  fi
  ask "Install the statusline?" && "$here/claude-code/install.sh"
}

step_cmux() {
  bold "cmux config (terminal, sidebars, Ghostty)"
  ask "Install it?" && "$here/cmux/install.sh"
}

step_vorssaint() {
  bold "Vorssaint (menu bar tool) settings"
  open -a Vorssaint 2>/dev/null || true; sleep 3   # creates its settings on first launch
  ask "Restore my settings?" && python3 "$here/vorssaint/vorssaint.py" import "$here/vorssaint/com.vorssaint.utils.plist"
  open -a Vorssaint 2>/dev/null || true
  info "Grant it Accessibility and Screen Recording in System Settings > Privacy & Security."
}

step_neovim() {
  bold "Neovim config (LazyVim, see nvim/README.md)"
  ask "Install it to ~/.config/nvim?" || return 0
  local cfg="$HOME/.config/nvim" d
  # A different (non-LazyVim) config: move it and its plugin data aside, LazyVim starts clean.
  if [ -e "$cfg" ] && [ ! -e "$cfg/lua/config/lazy.lua" ]; then
    for d in "$cfg" "$HOME/.local/share/nvim" "$HOME/.local/state/nvim" "$HOME/.cache/nvim"; do
      [ -e "$d" ] && mv "$d" "$d.bak-$stamp" && info "moved $d to $d.bak-$stamp"
    done
  fi
  mkdir -p "$cfg"
  rsync -a --exclude '*.md' "$here/nvim/" "$cfg/"
  info "installed $cfg"
  info "installing plugins at the versions in lazy-lock.json (Mason tools follow on the first start)"
  nvim --headless "+Lazy! restore" +qa || true
}

step_asdf() {
  bold "asdf runtimes from .tool-versions"
  ask "Install them?" || return 0
  local tool
  while read -r tool _; do [ -n "$tool" ] && asdf plugin add "$tool" 2>/dev/null || true; done < "$repo/.tool-versions"
  (cd "$repo" && asdf install)
}

step_macos() {
  bold "macOS preferences (optional)"
  ask "Show file extensions, path bar, and use a faster key repeat?" n || { fdesetup status || true; return 0; }
  defaults write NSGlobalDomain AppleShowAllExtensions -bool true
  defaults write com.apple.finder ShowPathbar -bool true
  defaults write NSGlobalDomain KeyRepeat -int 2
  defaults write NSGlobalDomain InitialKeyRepeat -int 20
  killall Finder || true
  fdesetup status || info "turn FileVault on in System Settings"
}

main() {
  [ "$(uname -s)" = Darwin ] || { echo "macOS only"; exit 1; }
  [ "$(uname -m)" = arm64 ] || { echo "Apple Silicon only (Homebrew paths assume /opt/homebrew)"; exit 1; }
  [ "${1:-}" = --list ] && { printf '%s\n' "${STEPS[@]}"; exit 0; }
  [ -t 0 ] || { echo "run this from a terminal, it asks questions"; exit 1; }
  case "${1:-}" in
    --only) shift; [[ " ${STEPS[*]} " == *" ${1:-} "* ]] || { echo "unknown step, see --list"; exit 1; }
            if [ "$1" != xcode ] && [ "$1" != brew ] && [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
            "step_$1"; exit 0 ;;
  esac
  local s; for s in "${STEPS[@]}"; do "step_$s"; done
  bold "Done. Open a new terminal (or run: exec zsh). Also sign in to your other apps by hand."
}
main "$@"
