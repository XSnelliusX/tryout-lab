#!/usr/bin/env bash
# Interactive setup for a Mac. Safe to re-run: every step compares with the repo, asks before it
# replaces a file, and copies the replaced file to ~/.setup_backup/<stamp>/ first. Nothing is deleted
# except an old gateway folder, and only after you confirm removing it.
# Usage: ./setup.sh              xcode and brew, then a menu of the other steps (all preselected)
#        ./setup.sh --all        every step in order, no menu (still asks per step)
#        ./setup.sh --only ssh   run one step (list them with --list)
#        ./setup.sh --dry-run    any of the above, but only reports what would change
# Menus and questions use gum once the brew step has installed it, plain prompts otherwise.
# Private keys are never copied anywhere. A fresh Mac: see bootstrap.sh (one command).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # BASH_SOURCE: also right when this file is sourced
repo="$(dirname "$here")"
. "$here/lib.sh"
GW_ENV="$HOME/.config/ai-gateway/env"

STEPS=(xcode brew packages apps shell font zshrc git github ssh claude opencode gateway cmux vorssaint neovim asdf macos)
MENU=()   # the steps the menu offers: everything after xcode and brew, which always run first
for s in "${STEPS[@]}"; do case "$s" in xcode|brew) ;; *) MENU+=("$s") ;; esac; done

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
    packages) echo "Homebrew CLI tools (gum herdr asdf fzf ...) and the casks rancher cmux vorssaint, missing ones only" ;;
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
  if xcode-select -p >/dev/null 2>&1; then info "already installed"
  elif dry; then info "would start the Command Line Tools installer and wait for it"
  else
    xcode-select --install || true
    info "Finish the installer dialog that just opened, I will wait."
    until xcode-select -p >/dev/null 2>&1; do sleep 5; done
  fi
  if xcode-select -p >/dev/null 2>&1; then info "$(git --version)"; fi
}

step_brew() {
  bold "Homebrew (and gum, which draws the menus)"
  if [ -x /opt/homebrew/bin/brew ]; then info "already installed"
  elif dry; then info "would install Homebrew"
  else /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; fi
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    # .zshrc does not set up brew itself, so keep it on PATH for every login shell.
    if ! grep -qs 'brew shellenv' "$HOME/.zprofile" 2>/dev/null; then
      if dry; then info "would add brew shellenv to ~/.zprofile"
      else echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"; fi
    fi
  fi
  if ! have gum; then   # the menus and questions use it from here on
    if dry; then info "would install gum"; else brew install gum; fi
  fi
  hash -r   # the menus must find gum (and brew) right after they were installed
  if have brew; then brew --version | head -1; fi
}

step_packages() {
  bold "Packages: ${FORMULAE[*]} + casks ${CASKS[*]}"
  ask "Install the missing ones?" || return 0
  local installed f c missing=()
  installed="$(brew list --formula 2>/dev/null || true)"   # never upgrades: only what is not installed yet
  for f in "${FORMULAE[@]}"; do
    if ! grep -qx "$f" <<< "$installed"; then missing+=("$f"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then run brew install "${missing[@]}"; else info "all formulae are installed"; fi
  for c in "${CASKS[@]}"; do
    if brew list --cask "$c" >/dev/null 2>&1; then info "already installed: $c"; else run brew install --cask "$c"; fi
  done
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
  for c in $picked; do
    if brew list --cask "$c" >/dev/null 2>&1; then info "already installed: $c"; else run brew install --cask "$c"; fi
  done
}

step_shell() {
  bold "oh-my-zsh and zsh plugins"
  if [ ! -d "$HOME/.oh-my-zsh" ]; then
    if dry; then info "would install oh-my-zsh"
    else RUNZSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"; fi
  fi
  local custom="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}" p
  for p in "${PLUGINS[@]}"; do
    if [ ! -d "$custom/plugins/${p##*/}" ]; then run git clone --depth 1 "https://github.com/$p" "$custom/plugins/${p##*/}"; fi
  done
}

step_font() {
  bold "MesloLGS NF font (Powerlevel10k prompt icons, used by cmux)"
  local dir="$HOME/Library/Fonts" base="https://github.com/romkatv/powerlevel10k-media/raw/master" f
  for f in Regular Bold Italic "Bold Italic"; do
    if [ ! -e "$dir/MesloLGS NF $f.ttf" ]; then run curl -fsSL -o "$dir/MesloLGS NF $f.ttf" "$base/MesloLGS%20NF%20${f// /%20}.ttf"; fi
  done
  info "fonts in $dir"
}

step_zshrc() {
  bold "zsh config (.zshrc, Powerlevel10k)"
  ask "Install them to your home folder?" || return 0
  install_file "$here/zsh/.zshrc" "$HOME/.zshrc"
  install_file "$here/zsh/p10k.zsh" "$HOME/.p10k.zsh"
}

step_git() {
  bold "Git identity"
  local name email n e
  name="$(git config --global user.name || true)"; email="$(git config --global user.email || true)"
  if [ -n "$name" ] && [ -n "$email" ]; then info "already set: $name <$email>"; ask "Keep it?" && return 0; fi
  n="$(input "Full name" "$name")"; e="$(input "Email" "$email")"
  run git config --global user.name "${n:-$name}"; run git config --global user.email "${e:-$email}"
  run git config --global init.defaultBranch main
}

step_github() {
  bold "GitHub login (gh CLI, browser based)"
  local host
  if dry; then info "would check the gh login, log in in the browser if needed, and set up git's credential helper"; return 0; fi
  if gh auth status -h github.com >/dev/null 2>&1; then info "already logged in to github.com"; else
    ask "Log in to github.com now?" && run gh auth login -h github.com -p https -w
  fi
  if gh auth status -h github.com >/dev/null 2>&1; then run gh auth setup-git -h github.com; fi
  if ask "Also log in to a GitHub Enterprise server?" n; then
    host="$(input "GitHub Enterprise hostname" "")"
    if [ -n "$host" ]; then run gh auth login -h "$host" -p https -w; fi
  fi
}

step_ssh() {
  bold "SSH key (stays on this machine, only the public key goes to GitHub)"
  if ! dry; then mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; fi
  local keys=() k key choice
  for k in "$HOME"/.ssh/id_*; do [[ "$k" == *.pub || ! -e "$k" ]] || keys+=("$k"); done
  if [ ${#keys[@]} -gt 0 ]; then
    info "Existing keys:"; printf '      %s\n' "${keys[@]}"
    choice="$(input "Path of the key to use, or Enter to create a new one" "")"
    key="${choice:-}"
  fi
  if [ -z "${key:-}" ]; then
    key="$(input "New key path" "$HOME/.ssh/id_ed25519")"
    if [ -e "$key" ]; then info "$key exists, not overwriting"; return 0; fi
    if dry; then info "would create the key $key"; return 0; fi
    ssh-keygen -t ed25519 -C "$(git config --global user.email)" -f "$key"   # asks for a passphrase
  fi
  if [ ! -e "$key" ]; then info "no such key: $key"; return 0; fi
  run ssh-add --apple-use-keychain "$key"
  if ! grep -qs "IdentityFile $key" "$HOME/.ssh/config" 2>/dev/null; then
    if dry; then info "would add github.com to ~/.ssh/config"; else
      printf '\nHost github.com\n    HostName github.com\n    User git\n    AddKeysToAgent yes\n    UseKeychain yes\n    IdentityFile %s\n' "$key" >> "$HOME/.ssh/config"
      chmod 600 "$HOME/.ssh/config"; info "added github.com to ~/.ssh/config"
    fi
  fi
  if dry; then info "would offer to upload ${key}.pub to GitHub (gh is not called in a dry run)"
  elif have gh && gh auth status -h github.com >/dev/null 2>&1 && ask "Upload ${key}.pub to your GitHub account?"; then
    gh auth refresh -h github.com -s admin:public_key
    gh ssh-key add "$key.pub" --title "$(scutil --get ComputerName || hostname)"
    ssh -T -o StrictHostKeyChecking=accept-new git@github.com || true   # exits 1 on success
  fi
}

step_claude() {
  bold "Claude Code (native installer) and statusline"
  if have claude; then info "already installed: $(claude --version 2>/dev/null || true)"
  elif dry; then info "would run the Claude Code installer (https://claude.ai/install.sh)"
  else curl -fsSL https://claude.ai/install.sh | bash; fi
  ask "Install the statusline?" || return 0
  "$here/claude-code/install.sh"
}

step_opencode() {
  bold "OpenCode (AI coding agent CLI, official installer)"
  local bin
  bin="$(command -v opencode || echo "$HOME/.opencode/bin/opencode")"
  if [ -x "$bin" ]; then info "already installed: $("$bin" --version 2>/dev/null || true)"; return 0; fi
  ask "Install it?" || return 0
  if dry; then info "would run the OpenCode installer (https://opencode.ai/install)"; return 0; fi
  curl -fsSL https://opencode.ai/install | bash
  info "installed: $("$HOME/.opencode/bin/opencode" --version 2>/dev/null || echo "open a new terminal, then run opencode --version")"
}

gw_get() { # gw_get <VAR>: its value from the gateway env file (sourced in a subshell), empty if none
  [ -f "$GW_ENV" ] || return 0
  (set +eu; . "$GW_ENV"; printf '%s' "${!1:-}")
}
gw_value() { # gw_value <VAR>: the process environment first, then the env file
  local v="${!1:-}"
  if [ -z "$v" ]; then v="$(gw_get "$1")"; fi
  printf '%s' "$v"
}
gw_old_dirs() { # the old gateway plugin folders (not ai-gateway) that hold claude_usage.py, one per line
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
gw_key() { # gw_key <key file> <gateway url> <old key path from the old index.ts, may be empty>
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

step_gateway() {
  bold "AI gateway for OpenCode (plugin folder, env file, API key)"
  local src="$here/ai-gateway" dst="$HOME/.config/opencode/plugins/ai-gateway"
  local olds olds_list=() old first_old idx="" url_def="" spec="" oldkey="" cur url keyfile kf cost tmp
  ask "Install it?" || return 0
  if [ ! -d "$src" ]; then info "$src is missing, nothing to install"; return 0; fi

  # Old install: its folder is renamed to ai-gateway (no backup, the files live on under the new name).
  olds="$(gw_old_dirs)"
  first_old="${olds%%$'\n'*}"
  # Defaults from the old plugin's index.ts, read before anything moves. They only prefill the prompts.
  idx="${first_old:-$dst}/index.ts"
  if [ -f "$idx" ]; then
    url_def="$(sed -n 's/^const DEFAULT_BASE_URL = "\(.*\)".*/\1/p' "$idx")"
    url_def="${url_def%%$'\n'*}"
    spec="$(sed -n 's/^const DEFAULT_KEY_SPEC = "{file:\(.*\)}".*/\1/p' "$idx")"
    spec="${spec%%$'\n'*}"
    if [ -n "$spec" ]; then oldkey="${spec/#\~/$HOME}"; fi
  fi
  # The folders go into an array first: a loop over <<< would hand its stdin to the questions below.
  while IFS= read -r old; do
    if [ -n "$old" ]; then olds_list+=("$old"); fi
  done <<< "$olds"
  for old in ${olds_list[@]+"${olds_list[@]}"}; do
    if [ ! -e "$dst" ]; then
      if dry; then info "would rename $old -> ai-gateway"; continue; fi
      mv "$old" "$dst"; info "renamed $old -> ai-gateway"
      continue
    fi
    info "$old and $dst both exist"
    if dry; then info "would copy the files ai-gateway lacks and remove $old"; continue; fi
    gw_copy_missing "$old" "$dst"
    if ask "Remove the old folder $old? opencode would load it as a second copy of the plugin" n; then
      rm -rf "$old"; info "removed $old"
    fi
  done

  install_tree "$src" "$dst" README.md
  gw_cfg_hint

  cur="$(gw_value GATEWAY_BASE_URL)"; [ -n "$cur" ] || cur="$url_def"
  url="$(input "Gateway base URL" "$cur")"
  if [ -z "$url" ]; then info "no URL, the env file is not written"; return 0; fi
  cur="$(gw_value GATEWAY_API_KEY_FILE)"
  keyfile="$(input "API key file" "${cur:-$HOME/.keys/ai-gateway.key}")"
  keyfile="${keyfile/#\~/$HOME}"
  if [ ! -s "$keyfile" ]; then gw_key "$keyfile" "$url" "$oldkey"; fi

  cost="$(gw_value GATEWAY_COST_DIR)"
  kf="${keyfile/#"$HOME"/\$HOME}"; cost="${cost/#"$HOME"/\$HOME}"   # $HOME stays in the file, like the example
  tmp="$(mktemp)"
  {
    printf 'export GATEWAY_BASE_URL="%s"\n' "$url"
    printf 'export GATEWAY_API_KEY_FILE="%s"\n' "$kf"
    if [ -n "$cost" ]; then printf 'export GATEWAY_COST_DIR="%s"\n' "$cost"; fi
  } > "$tmp"
  install_file "$tmp" "$GW_ENV"
  rm -f "$tmp"
  if ! dry && [ -e "$GW_ENV" ]; then chmod 600 "$GW_ENV"; fi

  if dry; then info "would run check_gateway.py"
  elif have python3 && [ -f "$dst/check_gateway.py" ]; then
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

set_default() { # set_default <domain> <key> <-bool|-int> <value>: writes only when the value differs
  local cur
  cur="$(defaults read "$1" "$2" 2>/dev/null || true)"
  if [ "$cur" = "$4" ]; then return 0; fi
  DEFAULTS_CHANGED=1
  if dry; then info "would set $1 $2 to $4"; return 0; fi
  defaults write "$1" "$2" "$3" "$4"; info "set $1 $2 to $4"
}

step_vorssaint() {
  bold "Vorssaint (menu bar tool) settings"
  local live repo="$here/vorssaint/com.vorssaint.utils.plist"
  live="$(mktemp)"
  if ! python3 "$here/vorssaint/vorssaint.py" export "$live" >/dev/null 2>&1; then
    if dry; then info "would launch Vorssaint once, so it creates its settings"; rm -f "$live"; return 0; fi
    open -a Vorssaint 2>/dev/null || true; sleep 3   # creates its settings on first launch
    if ! python3 "$here/vorssaint/vorssaint.py" export "$live" >/dev/null 2>&1; then
      info "no Vorssaint settings yet, open Vorssaint once and run: ./setup.sh --only vorssaint"
      rm -f "$live"; return 0
    fi
  fi
  if cmp -s "$live" "$repo"; then info "unchanged: the live settings match the repo"; rm -f "$live"; return 0; fi
  while :; do
    pick "The live Vorssaint settings differ from the repo. Import the repo settings?" s "i:Import" "d:Show diff" "s:Skip"
    case "$PICKED" in
      i)
        if dry; then info "would back up the live settings to $BACKUP_DIR/vorssaint/ and import the repo settings"
        else
          mkdir -p "$BACKUP_DIR/vorssaint"; cp "$live" "$BACKUP_DIR/vorssaint/com.vorssaint.utils.plist"
          info "live settings saved in $BACKUP_DIR/vorssaint/"
          python3 "$here/vorssaint/vorssaint.py" import "$repo"
          open -a Vorssaint 2>/dev/null || true
        fi
        break ;;
      d) { diff -u <(plutil -p "$repo") <(plutil -p "$live") || true; } | page || true ;;
      *) info "kept the live settings"; break ;;
    esac
  done
  rm -f "$live"
  info "Grant it Accessibility and Screen Recording in System Settings > Privacy & Security."
}

step_neovim() {
  bold "Neovim config (LazyVim, see nvim/README.md)"
  ask "Install it to ~/.config/nvim?" || return 0
  local cfg="$HOME/.config/nvim" d first=0 lock_before=0 lock_after=0
  local lock="$here/nvim/lazy-lock.json"
  # A different (non-LazyVim) config is moved aside into the backup folder, so LazyVim starts clean.
  if [ ! -e "$cfg" ]; then first=1
  elif [ ! -e "$cfg/lua/config/lazy.lua" ]; then
    info "$cfg is a different (non-LazyVim) config. It and its plugin data go to $BACKUP_DIR"
    if ! ask "Move them aside and install LazyVim?"; then info "kept $cfg, LazyVim is not installed"; return 0; fi
    first=1
    if dry; then info "would move the old config and its plugin data aside"
    else
      for d in "$cfg" "$HOME/.local/share/nvim" "$HOME/.local/state/nvim" "$HOME/.cache/nvim"; do
        if [ -e "$d" ]; then move_aside "$d"; fi
      done
    fi
  fi
  if cmp -s "$lock" "$cfg/lazy-lock.json" 2>/dev/null; then lock_before=1; fi
  install_tree "$here/nvim" "$cfg" '*.md'
  if cmp -s "$lock" "$cfg/lazy-lock.json" 2>/dev/null; then lock_after=1; fi
  # Plugins follow lazy-lock.json: restored on the first install, and asked about when the lock file changed.
  if [ "$lock_before" = 0 ] && { [ "$lock_after" = 1 ] || dry; }; then
    if [ "$first" = 0 ] && ! ask "lazy-lock.json changed: restore the plugins at the locked versions now?"; then
      info "not restored, run :Lazy restore in nvim later"; return 0
    fi
    if dry; then info "would run nvim --headless \"+Lazy! restore\" +qa"
    elif have nvim; then
      info "installing plugins at the versions in lazy-lock.json (Mason tools follow on the first start)"
      nvim --headless "+Lazy! restore" +qa || true
    else info "nvim is not installed yet, the plugins are not restored"; fi
  elif [ "$lock_after" = 1 ]; then
    info "plugin versions unchanged, no restore needed"
  fi
}

step_asdf() {
  bold "asdf runtimes (global ~/.tool-versions, plus the repo .tool-versions)"
  ask "Install them?" || return 0
  install_file "$here/asdf/tool-versions" "$HOME/.tool-versions"
  if dry; then info "would add the asdf plugins and run asdf install"; return 0; fi
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
  DEFAULTS_CHANGED=0
  set_default NSGlobalDomain AppleShowAllExtensions -bool 1
  set_default com.apple.finder ShowPathbar -bool 1
  set_default NSGlobalDomain KeyRepeat -int 2
  set_default NSGlobalDomain InitialKeyRepeat -int 20
  if [ "$DEFAULTS_CHANGED" = 1 ]; then
    if dry; then info "would restart Finder"; else killall Finder || true; fi
  fi
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

finish() { # the backup folder, if this run replaced anything
  if [ -d "$BACKUP_DIR" ]; then info "backups of replaced files: $BACKUP_DIR"; fi
}

main() {
  [ "$(uname -s)" = Darwin ] || { echo "macOS only"; exit 1; }
  [ "$(uname -m)" = arm64 ] || { echo "Apple Silicon only (Homebrew paths assume /opt/homebrew)"; exit 1; }
  local mode=menu only="" todo="" s
  while [ $# -gt 0 ]; do
    case "$1" in
      --list) printf '%s\n' "${STEPS[@]}"; exit 0 ;;
      --dry-run) DRY_RUN=1; export DRY_RUN ;;
      --all) mode=all ;;
      --only) mode=only; only="${2:-}"; shift ;;
      *) echo "unknown option $1, see the usage at the top of setup.sh"; exit 1 ;;
    esac
    shift
  done
  [ -t 0 ] || { echo "run this from a terminal, it asks questions"; exit 1; }
  if dry; then bold "Dry run: nothing is installed, written, moved or backed up"; fi
  if [ "$mode" = only ]; then
    [[ " ${STEPS[*]} " == *" $only "* ]] || { echo "unknown step, see --list"; exit 1; }
    if [ "$only" != xcode ] && [ "$only" != brew ] && [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
    "step_$only"
    finish
    exit 0
  fi
  step_xcode; step_brew
  if [ "$mode" = all ]; then todo="${MENU[*]}"; else todo="$(pick_steps)"; fi
  for s in $todo; do "step_$s"; done
  if dry; then bold "Dry run finished, nothing was changed."; else bold "Done. Open a new terminal (or run: exec zsh). Also sign in to your other apps by hand."; fi
  finish
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
