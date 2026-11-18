# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

#############################################################################################
######################   ZSH Setup - using oh my zsh + fuzzy search    ######################
#############################################################################################

export ZSH="$HOME/.oh-my-zsh"
DEFAULT_USER=$USER

# Completion directories must be in fpath BEFORE oh-my-zsh runs compinit.
# Login shells get Homebrew's path from brew shellenv; interactive non-login
# shells don't read ~/.zprofile, so include it explicitly there as well.
if [[ -d /opt/homebrew/share/zsh/site-functions ]] &&
   (( ! ${fpath[(Ie)/opt/homebrew/share/zsh/site-functions]} )); then
  fpath=(/opt/homebrew/share/zsh/site-functions $fpath)
fi
fpath+=("${ZSH_CUSTOM:-$ZSH/custom}/plugins/zsh-completions/src")

# Let Powerlevel10k display the active venv instead of venv modifying PS1.
export VIRTUAL_ENV_DISABLE_PROMPT=1

# Plugin settings (before sourcing oh-my-zsh)
ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=6'
ZSH_AUTOSUGGEST_STRATEGY=(history completion)

# Order matters: fzf-tab first, then autosuggestions, syntax-highlighting, history-substring-search last
plugins=(
  git
  docker
  asdf
  fzf-tab
  fzf-tab-source
  zsh-autosuggestions
  zsh-syntax-highlighting
  zsh-history-substring-search
)

source $ZSH/oh-my-zsh.sh   # this runs compinit for you, so don't call it yourself

# fzf keybindings: Ctrl-R history, Ctrl-T files, Ctrl+F cd. Its Tab widget
# delegates ordinary completion to fzf-tab and handles the ** trigger itself.
source <(fzf --zsh)

# Up/Down search history by what you've typed
bindkey '^[[A' history-substring-search-up
bindkey '^[[B' history-substring-search-down

# ---------- Completion + fzf-tab ----------
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'        # case-insensitive
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}

zstyle ':fzf-tab:complete:*:*' fzf-preview '
if [[ -n $realpath && -e $realpath ]]; then
  # files and folders
  if [[ -d $realpath ]]; then
    eza -1 --color=always --icons=always --group-directories-first "$realpath"
  else
    bat --color=always --style=numbers --line-range=:200 "$realpath"
  fi
elif [[ -d ${word/#\~/$HOME} ]]; then
  # directories without a realpath (no longer needed for vim/python3, kept as fallback)
  eza -1 --color=always --icons=always --group-directories-first "${word/#\~/$HOME}"
elif (( $#words == 1 )); then
  # first word: the command itself -> man page
  man -w "$word" >/dev/null 2>&1 && MANWIDTH=$FZF_PREVIEW_COLUMNS man "$word" | col -bx | bat -l man -p --color=always || echo "$desc"
elif [[ $group == *command* && $word != -* ]]; then
  # subcommands (kubectl, docker, gh, helm ...) -> their --help
  ${words[1,-2]} $word --help 2>&1 | head -200
elif [[ $group == *parameter* ]]; then
  echo ${(P)word}
else
  # options, pods, branches ... -> full untruncated description
  echo "$desc"
fi'

zstyle ':fzf-tab:*' fzf-flags --preview-window=right:50%:wrap
zstyle ':fzf-tab:*' fzf-bindings 'ctrl-/:toggle-preview'
# Tab enters the highlighted folder (continue completing inside it) instead of cycling
zstyle ':fzf-tab:*' continuous-trigger 'tab'
zstyle ':fzf-tab:*' fzf-bindings-default 'btab:up,change:top,ctrl-space:toggle,bspace:backward-delete-char/eof,ctrl-h:backward-delete-char/eof'

# Binds Ctrl+F to cd instead of Alt+C since Alt+C on mac returns ç
bindkey '^F' fzf-cd-widget    # Ctrl-F opens the folder jump

############################################################################################
######################                 END ZSH SETUP                  ######################
############################################################################################
############################################################################################
#######                                  ALIASSES                                     ######
############################################################################################

### Vim aliases
alias vim="nvim"
alias vi="nvim"

### Default editor (git, kubectl, k9s, crontab; aliases are not seen by subprocesses)
export EDITOR="nvim"
export VISUAL="nvim"

### kubectl
alias k="kubectl"
alias kgp="kubectl get pods"
alias kgpw="kubectl get pods -o wide"

############################################################################################
#######                                 END ALIASSES                                  ######
############################################################################################

# Added by Teamwork Graph CLI installer
export PATH="$HOME/.local/bin:$PATH"

# opencode
export PATH="$HOME/.opencode/bin:$PATH"

export NVM_DIR="$HOME/.nvm"
  [ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"  # This loads nvm
  [ -s "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm" ] && \. "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm"  # This loads nvm bash_completion

### ASDF Shims dir
export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"

# kubectl completion loaded straight from the binary; k alias gets the same completion
if (( $+commands[kubectl] )); then
  source <(kubectl completion zsh)
  compdef k=kubectl
fi

# helm completion loaded straight from the binary (same pattern as kubectl)
if (( $+commands[helm] )); then
  source <(helm completion zsh)
fi

# These tools don't install native zsh completion files into Homebrew's fpath.
# Register pip's native completion lazily so the active Python environment is used.
_local_pip_completion() {
  local -a completions
  completions=(${(f)"$(COMP_WORDS="${words[*]}" COMP_CWORD=$((CURRENT - 1)) \
    PIP_AUTO_COMPLETE=1 "${words[1]}" 2>/dev/null)"})
  compadd -a completions
}
compdef _local_pip_completion -P 'pip[0-9.]#'

# AWS CLI supplies a bash-style completer, including for the local installation.
if (( $+commands[aws_completer] )); then
  autoload -Uz bashcompinit
  bashcompinit
  complete -C "${commands[aws_completer]}" aws
fi

# AI gateway settings (GATEWAY_BASE_URL, key file), written by mac-setup/setup.sh --only gateway
[[ -r "$HOME/.config/ai-gateway/env" ]] && source "$HOME/.config/ai-gateway/env"

source /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# User-local binaries (Claude Code native installer, herdr-core hc, cc-* scripts).
# ~/.zprofile only covers login shells, so add it here too.
export PATH="$HOME/.local/bin:$PATH"
