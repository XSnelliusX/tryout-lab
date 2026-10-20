#!/usr/bin/env bash
# Interactive setup for a fresh Mac. Safe to re-run: finished steps are detected and skipped.
# Usage: ./setup.sh              xcode and brew, then a menu of the other steps (all preselected)
#        ./setup.sh --all        every step in order, no menu (still asks per step)
#        ./setup.sh --only ssh   run one step (list them with --list)
# Menus and questions use gum once the brew step has installed it, plain prompts otherwise.
# Existing files are backed up as *.bak-<timestamp>. Private keys are never copied anywhere.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
stamp="$(date +%Y%m%d-%H%M%S)"
GW_ENV="$HOME/.config/ai-gateway/env"

STEPS=(xcode brew packages apps shell font zshrc git github ssh claude opencode gateway cmux vorssaint neovim asdf macos)
MENU=()   # the steps the menu offers: everything after xcode and brew, which always run first
for s in "${STEPS[@]}"; do case "$s" in xcode|brew) ;; *) MENU+=("$s") ;; esac; done

ui() { have gum && [ -t 0 ] && [ -t 2 ]; }   # gum widgets only in a real terminal; gum draws on stderr, answers go to stdout ($(...) captures them)
bold() {
  if ui; then echo; gum style --bold "==> $*"; else printf '\n\033[1m==> %s\033[0m\n' "$*"; fi
}
info() { printf '    %s\n' "$*"; }
ask() { # ask <question> [default y|n]
  local def="${2:-y}" hint reply rc=0
  if ui; then
    gum confirm --default="$([ "$def" = y ] && echo true || echo false)" "$1" || rc=$?
    [ "$rc" -le 1 ] || exit "$rc"   # 130 is Ctrl+C: stop the script
    return "$rc"
  fi
  [ "$def" = y ] && hint="Y/n" || hint="y/N"
  read -r -p "    $1 [$hint] " reply || reply=""
  reply="${reply:-$def}"
  [[ "$reply" =~ ^[Yy] ]]
}
input() { # input <prompt> [default]; prints the answer, Enter takes the default
  local v
  if ui; then gum input --prompt "$1 " --value "${2:-}"; return; fi
  read -r -p "    $1${2:+ [$2]}: " v || v=""
  printf '%s\n' "${v:-${2:-}}"
}
secret() { # secret <prompt>; prints what is typed, never echoed
  local v
  if ui; then gum input --password --prompt "$1 "; return; fi
  read -r -s -p "    $1: " v || v=""; echo >&2
  printf '%s\n' "$v"
}
choose() { # choose <header> <names preselected> <item>...; prints the chosen items
  # An item is "name  text": the name is its first word. Item texts must not contain commas (gum splits on them).
  local header="$1" presel="$2" item n st tog on sel=""
  shift 2
  if ui; then
    for item in "$@"; do n="${item%% *}"; case " $presel " in *" $n "*) sel="${sel:+$sel,}$item" ;; esac; done
    gum choose --no-limit --height=25 --header="$header" --selected="$sel" "$@"
    return
  fi
  printf '    %s\n' "$header" >&2
  for item in "$@"; do
    n="${item%% *}"; on=" "
    case " $presel " in *" $n "*) on=x ;; esac
    printf '    [%s] %s\n' "$on" "$item" >&2
  done
  read -r -p "    Names to toggle, space separated (Enter keeps the [x] ones): " tog || tog=""
  for item in "$@"; do
    n="${item%% *}"; st=0
    case " $presel " in *" $n "*) st=1 ;; esac
    case " $tog " in *" $n "*) st=$((1 - st)) ;; esac
    if [ "$st" = 1 ]; then printf '%s\n' "$item"; fi
  done
  return 0
}
backup() { [ -e "$1" ] && cp "$1" "$1.bak-$stamp" || true; }
put() { # put <source> <destination>
  mkdir -p "$(dirname "$2")"; backup "$2"; cp "$1" "$2"; info "installed $2"
}
have() { command -v "$1" >/dev/null 2>&1; }

# openssl@3/readline/xz/sqlite are build deps for asdf python; fd/lazygit/tree-sitter-cli for LazyVim;
# gum draws the menus; herdr is the terminal agent multiplexer.
FORMULAE=(git gh fzf eza bat watch jq ripgrep fd lazygit asdf openssl@3 readline xz sqlite nvm neovim k9s tree-sitter-cli yarn powerlevel10k gum herdr)
CASKS=(rancher cmux vorssaint)
# cask|app bundle|menu text (no commas)|preselected. Names checked with brew info --cask.
# Rectangle and Maccy are not preselected: Vorssaint already does window snapping and clipboard history.
APP_CASKS=(
  "rectangle|Rectangle.app|window snapping (Vorssaint has it too)|0"
  "maccy|Maccy.app|clipboard history (Vorssaint has it too)|0"
  "visual-studio-code|Visual Studio Code.app|code editor|0"
  "postman|Postman.app|API client|1"
  "google-chrome|Google Chrome.app|browser|1"
  "claude|Claude.app|Claude desktop app|1"
  "spotify|Spotify.app|music|0"
  "wireshark|Wireshark.app|packet capture|0"
  "supacode|supacode.app|terminal app for git worktrees and panes|0"
  "goland|GoLand.app|JetBrains IDE for Go|0"
  "intellij-idea|IntelliJ IDEA.app|JetBrains IDE Ultimate for Java and Kotlin|0"
)
PLUGINS=(
  "zsh-users/zsh-completions"
  "Aloxaf/fzf-tab"
  "Freed-Wu/fzf-tab-source"
  "zsh-users/zsh-autosuggestions"
  "zsh-users/zsh-syntax-highlighting"
  "zsh-users/zsh-history-substring-search"
)

describe() { # the menu text of a step
  case "$1" in
    packages) echo "Homebrew CLI tools (gum herdr asdf fzf ...) and the casks rancher cmux vorssaint" ;;
    apps) echo "Optional GUI apps from a list with Chrome and Postman preselected" ;;
    shell) echo "oh-my-zsh and the zsh plugins" ;;
    font) echo "MesloLGS NF font for the prompt icons" ;;
    zshrc) echo "zsh config and the Powerlevel10k prompt" ;;
    git) echo "Git name and email" ;;
    github) echo "gh login in the browser and git credentials" ;;
    ssh) echo "SSH key in the Keychain and the public key on GitHub" ;;
    claude) echo "Claude Code (native installer) and the statusline" ;;
    opencode) echo "OpenCode CLI from the official installer" ;;
    gateway) echo "AI gateway plugin for OpenCode with its env file and API key" ;;
    cmux) echo "cmux config with sidebars and Ghostty" ;;
    vorssaint) echo "Vorssaint menu bar settings" ;;
    neovim) echo "LazyVim config at the locked plugin versions" ;;
    asdf) echo "Global runtimes node go python via asdf" ;;
    macos) echo "macOS defaults (optional) and the FileVault status" ;;
  esac
}

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
  bold "Homebrew (and gum, which draws the menus)"
  if [ ! -x /opt/homebrew/bin/brew ]; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  else info "already installed"; fi
  eval "$(/opt/homebrew/bin/brew shellenv)"
  # .zshrc does not set up brew itself, so keep it on PATH for every login shell.
  grep -qs 'brew shellenv' "$HOME/.zprofile" 2>/dev/null ||
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
  have gum || brew install gum   # the menus and questions use it from here on
  brew --version | head -1
}

step_packages() {
  bold "Packages: ${FORMULAE[*]} + casks ${CASKS[*]}"
  ask "Install them?" || return 0
  brew install "${FORMULAE[@]}"
  for c in "${CASKS[@]}"; do brew list --cask "$c" >/dev/null 2>&1 || brew install --cask "$c"; done
}

step_apps() {
  bold "Optional GUI apps (casks)"
  ask "Choose GUI apps to install?" || return 0
  local line c app desc pre presel="" items=() names="" picked=""
  for line in "${APP_CASKS[@]}"; do
    IFS='|' read -r c app desc pre <<< "$line"
    if [ -e "/Applications/$app" ]; then info "already in /Applications: $app"; continue; fi
    items+=("$(printf '%-18s %s' "$c" "$desc")")
    if [ "$pre" = 1 ]; then presel="$presel $c"; fi
  done
  if [ "${#items[@]}" -eq 0 ]; then info "all of them are installed"; return 0; fi
  names="$(choose "GUI apps to install" "$presel" "${items[@]}")"
  while IFS= read -r line; do
    if [ -n "$line" ]; then picked="$picked ${line%% *}"; fi
  done <<< "$names"
  for c in $picked; do brew list --cask "$c" >/dev/null 2>&1 || brew install --cask "$c"; done
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
  local name email n e
  name="$(git config --global user.name || true)"; email="$(git config --global user.email || true)"
  if [ -n "$name" ] && [ -n "$email" ]; then info "already set: $name <$email>"; ask "Keep it?" && return 0; fi
  n="$(input "Full name" "$name")"; e="$(input "Email" "$email")"
  git config --global user.name "${n:-$name}"; git config --global user.email "${e:-$email}"
  git config --global init.defaultBranch main
}

step_github() {
  bold "GitHub login (gh CLI, browser based)"
  local host
  if gh auth status -h github.com >/dev/null 2>&1; then info "already logged in to github.com"; else
    ask "Log in to github.com now?" && gh auth login -h github.com -p https -w
  fi
  gh auth status -h github.com >/dev/null 2>&1 && gh auth setup-git -h github.com || true
  if ask "Also log in to a GitHub Enterprise server?" n; then
    host="$(input "GitHub Enterprise hostname" "")"
    if [ -n "$host" ]; then gh auth login -h "$host" -p https -w; fi
  fi
}

step_ssh() {
  bold "SSH key (stays on this machine, only the public key goes to GitHub)"
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  local keys=() k key choice
  for k in "$HOME"/.ssh/id_*; do [[ "$k" == *.pub || ! -e "$k" ]] || keys+=("$k"); done
  if [ ${#keys[@]} -gt 0 ]; then
    info "Existing keys:"; printf '      %s\n' "${keys[@]}"
    choice="$(input "Path of the key to use, or Enter to create a new one" "")"
    key="${choice:-}"
  fi
  if [ -z "${key:-}" ]; then
    key="$(input "New key path" "$HOME/.ssh/id_ed25519")"
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
  ask "Install the statusline?" || return 0
  "$here/claude-code/install.sh"
}

step_opencode() {
  bold "OpenCode (AI coding agent CLI, official installer)"
  local bin
  bin="$(command -v opencode || echo "$HOME/.opencode/bin/opencode")"
  if [ -x "$bin" ]; then info "already installed: $("$bin" --version 2>/dev/null || true)"; return 0; fi
  ask "Install it?" || return 0
  curl -fsSL https://opencode.ai/install | bash
  info "installed: $("$HOME/.opencode/bin/opencode" --version 2>/dev/null || echo "open a new terminal, then run opencode --version")"
}

gw_get() { # gw_get <VAR>: its value from the gateway env file (sourced in a subshell), empty if none
  [ -f "$GW_ENV" ] || return 0
  (set +eu; . "$GW_ENV"; printf '%s' "${!1:-}")
}

gw_migrate() { # old gateway folders from an earlier install: out of the plugins dir, and point at the config
  local d cfg hits
  for d in "$HOME"/.config/opencode/plugins/*-gateway; do
    if [ ! -d "$d" ] || [ "$(basename "$d")" = ai-gateway ] || [ ! -e "$d/claude_usage.py" ]; then continue; fi
    info "found an old gateway folder: $d"
    if ask "Move it out of the plugins dir (opencode would load both)?"; then
      mkdir -p "$HOME/.config/opencode/plugins-backup-$stamp"
      mv "$d" "$HOME/.config/opencode/plugins-backup-$stamp/"
      info "moved to $HOME/.config/opencode/plugins-backup-$stamp/"
    fi
  done
  for cfg in "$HOME/.config/opencode/opencode.json" "$HOME/.config/opencode/opencode.jsonc"; do
    [ -f "$cfg" ] || continue
    hits="$(grep -nE -- '-gateway[/"]' "$cfg" | grep -vE 'ai-gateway[/"]' || true)"
    if [ -n "$hits" ]; then
      info "$cfg still has an old gateway plugin path, change it to .../plugins/ai-gateway by hand:"
      printf '%s\n' "$hits" | sed 's/^/        /'
    fi
  done
}

step_gateway() {
  bold "AI gateway for OpenCode (plugin folder, env file, API key)"
  local src="$here/ai-gateway" dst="$HOME/.config/opencode/plugins/ai-gateway"
  local url cur keyfile kf cost key f
  ask "Install it?" || return 0
  if [ ! -d "$src" ]; then info "$src is missing, nothing to install"; return 0; fi
  mkdir -p "$(dirname "$dst")"
  rsync -a --exclude README.md --exclude .DS_Store "$src/" "$dst/"
  info "installed $dst"
  gw_migrate

  url="$(input "Gateway base URL" "$(gw_get GATEWAY_BASE_URL)")"
  if [ -z "$url" ]; then info "no URL, the env file is not written"; return 0; fi
  cur="$(gw_get GATEWAY_API_KEY_FILE)"
  keyfile="$(input "API key file" "${cur:-$HOME/.keys/ai-gateway.key}")"
  keyfile="${keyfile/#\~/$HOME}"
  if [ ! -s "$keyfile" ]; then
    for f in "$HOME"/.keys/*opencode*.key; do
      [ -f "$f" ] || continue
      if ask "Found the key file $f from an earlier install. Copy it to $keyfile?"; then
        mkdir -p "$(dirname "$keyfile")"; cp "$f" "$keyfile"; chmod 600 "$keyfile"
        info "copied $f (delete the old file once everything works)"; break
      fi
    done
  fi
  if [ ! -s "$keyfile" ]; then
    key="$(secret "API key for $url (typed hidden)")"
    if [ -n "$key" ]; then
      mkdir -p "$(dirname "$keyfile")"; chmod 700 "$(dirname "$keyfile")"
      ( umask 077; printf '%s\n' "$key" > "$keyfile" ); chmod 600 "$keyfile"
      info "wrote $keyfile (chmod 600)"
    else info "no key given, $keyfile is still missing"; fi
    key=""
  fi

  cost="$(gw_get GATEWAY_COST_DIR)"
  kf="${keyfile/#"$HOME"/\$HOME}"; cost="${cost/#"$HOME"/\$HOME}"   # $HOME stays in the file, like the example
  mkdir -p "$(dirname "$GW_ENV")"; backup "$GW_ENV"
  ( umask 077
    {
      printf 'export GATEWAY_BASE_URL="%s"\n' "$url"
      printf 'export GATEWAY_API_KEY_FILE="%s"\n' "$kf"
      if [ -n "$cost" ]; then printf 'export GATEWAY_COST_DIR="%s"\n' "$cost"; fi
    } > "$GW_ENV" )
  chmod 600 "$GW_ENV"; info "wrote $GW_ENV (chmod 600)"

  if have python3 && [ -f "$dst/check_gateway.py" ]; then
    ( . "$GW_ENV"; python3 "$dst/check_gateway.py" ) || info "check_gateway.py reported a problem (not fatal, see above)"
  fi
  ask "Re-run the Claude Code installer so its usage hook points at the new collector?" || return 0
  "$here/claude-code/install.sh"
}

step_cmux() {
  bold "cmux config (terminal, sidebars, Ghostty)"
  ask "Install it?" || return 0
  "$here/cmux/install.sh"
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
  bold "asdf runtimes (global ~/.tool-versions, plus the repo .tool-versions)"
  ask "Install them?" || return 0
  put "$here/asdf/tool-versions" "$HOME/.tool-versions"
  local f tool
  for f in "$HOME/.tool-versions" "$repo/.tool-versions"; do
    [ -f "$f" ] || continue
    while read -r tool _; do [ -n "$tool" ] && asdf plugin add "$tool" 2>/dev/null || true; done < "$f"
  done
  (cd "$HOME" && asdf install)
  if [ -f "$repo/.tool-versions" ]; then (cd "$repo" && asdf install); fi
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

pick_steps() { # prints the menu's picks, one per line, in STEPS order
  local items=() s line sel names=" "
  for s in "${MENU[@]}"; do items+=("$(printf '%-9s %s' "$s" "$(describe "$s")")"); done
  sel="$(choose "Steps to run" "${MENU[*]}" "${items[@]}")"
  while IFS= read -r line; do
    if [ -n "$line" ]; then names="$names${line%% *} "; fi
  done <<< "$sel"
  for s in "${MENU[@]}"; do
    case "$names" in *" $s "*) echo "$s" ;; esac
  done
  return 0
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
    --all|"") ;;
    *) echo "unknown option $1, see the usage at the top of setup.sh"; exit 1 ;;
  esac
  step_xcode; step_brew
  local run
  if [ "${1:-}" = --all ]; then run="${MENU[*]}"; else run="$(pick_steps)"; fi
  for s in $run; do "step_$s"; done
  bold "Done. Open a new terminal (or run: exec zsh). Also sign in to your other apps by hand."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
