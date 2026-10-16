# zsh Setup [https://ohmyz.sh/](https://ohmyz.sh/)

Terminal setup: [cmux](https://cmux.com) as the terminal emulator, oh-my-zsh with fuzzy-search plugins inside it. The full config lives in [.zshrc](.zshrc) — it is the source of truth, this note just explains how to rebuild the same setup from scratch.

## Terminal: cmux

[cmux](https://cmux.com) — native macOS terminal built on **libghostty** (same core as Ghostty), made for running coding agents: workspaces grouped into Spaces, tabs and splits, and a sidebar with agent status. It replaced Supacode + herdr. Setup and configs: [cmux/README.md](cmux/README.md).

## 1. Install the tools

```bash
# Homebrew packages
brew install fzf eza bat asdf nvm neovim

# oh-my-zsh itself
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

- `fzf` — fuzzy finder (powering completion + keybindings)
- `eza` / `bat` — used in the tab-completion preview pane (folders / files)
- `carapace` — extra completions for many CLIs
- `asdf`, `nvm` — runtime version managers
- `neovim` — what the `vim` alias points to

## 2. Clone the plugins

oh-my-zsh only auto-loads plugins that live in its custom plugins dir:

```bash
ZSH_CUSTOM=${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}

git clone https://github.com/zsh-users/zsh-completions            $ZSH_CUSTOM/plugins/zsh-completions
git clone https://github.com/Aloxaf/fzf-tab                       $ZSH_CUSTOM/plugins/fzf-tab
git clone https://github.com/Freed-Wu/fzf-tab-source              $ZSH_CUSTOM/plugins/fzf-tab-source
git clone https://github.com/zsh-users/zsh-autosuggestions        $ZSH_CUSTOM/plugins/zsh-autosuggestions
git clone https://github.com/zsh-users/zsh-syntax-highlighting    $ZSH_CUSTOM/plugins/zsh-syntax-highlighting
git clone https://github.com/zsh-users/zsh-history-substring-search $ZSH_CUSTOM/plugins/zsh-history-substring-search
```

> The order in `plugins=(...)` matters: `fzf-tab` first, then autosuggestions, syntax-highlighting, and history-substring-search **last**. Also don't call `compinit` yourself — oh-my-zsh does it (the `zsh-completions` fpath line in [.zshrc](.zshrc) must come before that).

## 3. Use the config

```bash
cp terminal/.zshrc ~/.zshrc   # from the repo root
exec zsh                      # or open a new terminal
```

> Tip: the prompt needs a **Nerd/Powerline font**, otherwise it shows broken glyphs. cmux uses **MesloLGS NF** (set in the [Ghostty config](cmux/config/ghostty/config.ghostty)); `.zshrc` also loads Powerlevel10k at the end.

## What's in the config

- **Theme:** The prompt comes from Powerlevel10k, sourced at the end of the file.
- **Tab completion:** case-insensitive, colored lists, fzf-powered via fzf-tab with a live preview pane — folders preview with `eza`, files with `bat`, commands with their man page, subcommands (`kubectl`, `docker`, `helm`, …) with their `--help`.
- **fzf integration:** `source <(fzf --zsh)` wires up the keybindings below.
- **Autosuggestions:** gray inline suggestions from history + completion (`fg=6` highlight).
- **carapace:** `CARAPACE_BRIDGES='zsh,fish,bash,inshellisense'` — completions for many tools by bridging other shells' completion definitions.
- **PATH additions:** `~/.local/bin` (Teamwork Graph CLI), Homebrew `nvm`, asdf shims, and the Rancher Desktop block (auto-managed — **do not edit** — see [Rancher Desktop](../kubernetes/rancher.md)).

## Keybindings

- `Tab` — fuzzy completion menu with preview pane
- `Ctrl-/` — toggle the completion preview pane
- `Ctrl-R` — search history (fzf)
- `Ctrl-T` — fuzzy file finder
- `Ctrl-F` — fuzzy directory jump (`cd`) — remapped from `Alt-c`, which types `ç` on a Mac keyboard
- `↑` / `↓` — search history by the text already typed (history-substring-search)

## Aliases

`k*` shortcuts for the commands in [kubectl](../kubernetes/kubectl.md):

```bash
alias vim="nvim"                   # neovim
alias vi="nvim"

alias k="kubectl"
alias kgp="kubectl get pods"
alias kgpw="kubectl get pods -o wide"
```
