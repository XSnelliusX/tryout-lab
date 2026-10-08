#############################################################################################
######################   ZSH Setup - using oh my zsh + fuzzy search    ######################
#############################################################################################

export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="agnoster"
DEFAULT_USER=$USER

# Extra completion definitions (must be in fpath BEFORE oh-my-zsh runs compinit)
fpath+=${ZSH_CUSTOM:-$ZSH/custom}/plugins/zsh-completions/src

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

# fzf keybindings: Ctrl-R history, Ctrl-T files, Ctrl+F cd
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

# Binds Ctrl+F to cd instead of Alt+C since Alt+C on mac returns ç
bindkey '^F' fzf-cd-widget    # Ctrl-F opens the folder jump

############################################################################################
######################                 END ZSH SETUP                  ######################
############################################################################################

# Added by Teamwork Graph CLI installer
export PATH="$HOME/.local/bin:$PATH"

export NVM_DIR="$HOME/.nvm"
  [ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"  # This loads nvm
  [ -s "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm" ] && \. "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm"  # This loads nvm bash_completion

### MANAGED BY RANCHER DESKTOP START (DO NOT EDIT)
export PATH="$HOME/.rd/bin:$PATH"
### MANAGED BY RANCHER DESKTOP END (DO NOT EDIT)

### ASDF Shims dir
export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"

### Add carapace for tool completion
export CARAPACE_BRIDGES='zsh,fish,bash,inshellisense'
source <(carapace _carapace)

###########################################################################################
######                                  ALIASSES                                      #####
###########################################################################################

### Vim Aliasses
alias vim="nvim"
alias vi="nvim"

### kubectl
alias k="kubectl"
alias kgp="kubectl get pods"
alias kgpw="kubectl get pods -o wide"