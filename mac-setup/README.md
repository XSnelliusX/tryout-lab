# Mac Setup

One interactive script takes a fresh Mac to the same state as this one. Order matters: Xcode Command Line Tools (they bring git) → Homebrew (which installs gum for the menus) → everything else.

```bash
# git comes with the Command Line Tools, so this works on a brand new Mac
xcode-select --install          # finish the dialog, then:
git clone https://github.com/XSnelliusX/tryout-lab.git && cd tryout-lab/mac-setup
./setup.sh
```

`xcode` and `brew` always run first. Then a menu lists the other steps, all preselected, each with a one-line description: space toggles a step, Enter runs the selection in the order of the table below. Every step asks first and skips what is already done, so it is safe to re-run.

| Flag | What it does |
|---|---|
| (none) | xcode and brew, then the menu |
| `--all` | every step in order, no menu (each step still asks its questions) |
| `--only <step>` | one step, e.g. `./setup.sh --only gateway` |
| `--list` | the step names, in order |

The menus and questions use [gum](https://github.com/charmbracelet/gum), which the brew step installs. Before Homebrew exists, or when the script has no terminal, the same questions are plain prompts. In the plain menu you type the names to switch off (Enter keeps them all).

## What the script does

| Step | What happens |
|---|---|
| `xcode` | Command Line Tools (compiler, make, git), waits until installed |
| `brew` | Homebrew, `brew shellenv` in `~/.zprofile`, and gum |
| `packages` | `git gh fzf eza bat watch jq ripgrep fd lazygit asdf nvm neovim k9s tree-sitter-cli yarn powerlevel10k gum herdr` (+ `openssl@3 readline xz sqlite` to build asdf Python), casks `rancher cmux vorssaint` |
| `apps` | optional GUI casks from a multi-select, Google Chrome, Postman and Claude preselected. Apps already in `/Applications` are left out. Rectangle and Maccy are offered but not preselected, Vorssaint does snapping and clipboard history |
| `shell` | oh-my-zsh and the plugins from [zsh/README.md](zsh/README.md) |
| `font` | MesloLGS NF into `~/Library/Fonts` (prompt icons) |
| `zshrc` | [zsh/.zshrc](zsh/.zshrc) and [zsh/p10k.zsh](zsh/p10k.zsh) |
| `git` | asks for name and email, sets `init.defaultBranch main` |
| `github` | `gh auth login` in the browser, then `gh auth setup-git` as credential helper; optional Enterprise host |
| `ssh` | lists existing keys to reuse, or creates an ed25519 key with passphrase; adds it to the Keychain and `~/.ssh/config`; optionally uploads the **public** key with `gh ssh-key add` |
| `claude` | Claude Code via the native installer (updates itself), plus the [statusline](claude-code/README.md) and the usage hook that logs Claude Code to `~/.gateway-cost` |
| `opencode` | OpenCode via the official installer (`~/.opencode/bin`), skipped when `opencode` is already found |
| `gateway` | the AI gateway plugin for OpenCode, its env file and API key, see below |
| `cmux` | [cmux config](cmux/README.md): settings, sidebars, Ghostty |
| `vorssaint` | restores the Vorssaint settings (below) |
| `neovim` | [LazyVim config](nvim/README.md) into `~/.config/nvim` (an older non-LazyVim config is moved aside), plugins at the locked versions |
| `asdf` | global `~/.tool-versions` from [asdf/tool-versions](asdf/tool-versions) (nodejs 26.11.1, golang 1.27.1, python 3.13.16), plugins added, `asdf install` in home and in the repo ([.tool-versions](../.tool-versions)) |
| `macos` | optional defaults (file extensions, path bar, key repeat), and shows the FileVault status |

Never stored in the repo: SSH private keys, `gh` tokens (`~/.config/gh/hosts.yml`), shell history, the gateway URL and the gateway API key. The script creates keys on the machine and only uploads `*.pub`.

## AI gateway (OpenCode plugin)

The `gateway` step copies [ai-gateway/](ai-gateway/) to `~/.config/opencode/plugins/ai-gateway` (without its README). It asks for:

- the gateway base URL. The default is the current value from the env file, there is no built-in URL
- the API key file, default `~/.keys/ai-gateway.key`. If that file is missing, the key is asked for with hidden input and written with mode 600 into a 700 folder. It is never echoed or stored in the repo

It then writes `~/.config/ai-gateway/env` with mode 600 (the old one is backed up as `env.bak-<stamp>`):

```bash
export GATEWAY_BASE_URL="https://gateway.example.com"
export GATEWAY_API_KEY_FILE="$HOME/.keys/ai-gateway.key"
export GATEWAY_COST_DIR="..."   # only when it was set before
```

Then `check_gateway.py` runs once (a failure there does not stop the script).

Old installs are handled too. A `*-gateway` folder in the plugins dir that holds `claude_usage.py` is offered for moving into `~/.config/opencode/plugins-backup-<stamp>/`, so opencode does not load two copies. Key files `~/.keys/*opencode*.key` are offered for copying to the new key path (the old file stays until you delete it). If `opencode.json` still points at an old folder, the script prints the line and you change it by hand. At the end it offers to re-run [claude-code/install.sh](claude-code/install.sh), which registers the usage hook for the new collector path.

## Vorssaint, the central macOS tool

[Vorssaint](https://github.com/vorssaint/vorssaint-utils) is a free, open-source menu bar app that replaces a dozen small Mac utilities behind one icon (no account, no telemetry). Apple Silicon and macOS 14+, GPL-3.0-or-later.

| Area | What it does |
|---|---|
| Sound | Per-app volume (boost past 100%), output switching, mic tools |
| System | CPU, GPU, memory, temperature, battery, network in the menu bar; fan control (beta) |
| Windows and Dock | App/window switcher, snapping and layouts, Dock previews |
| Keyboard and mouse | Text snippets, smooth scrolling, scroll direction, key debounce |
| Clipboard and files | Clipboard history, paste as plain text, file shelf, Clean URL |
| Capture | Screenshots, screen recording, color picker, OCR, Scratchpad notes |
| App management | Updates, cleaner, uninstaller, Homebrew manager, port manager |
| Energy | Keep awake, per-display brightness |

Its settings are the `com.vorssaint.utils` defaults domain. [vorssaint/vorssaint.py](vorssaint/vorssaint.py) exports them to [vorssaint/com.vorssaint.utils.plist](vorssaint/com.vorssaint.utils.plist) and merges them back on a new Mac. Machine-specific and personal keys are left out (feature probes, window sizes, shelf items, the command-bar habit key); clipboard history and scratchpad notes stay local.

macOS permissions cannot be scripted. After the restore, grant Vorssaint **Accessibility** and **Screen Recording** in System Settings → Privacy & Security, and it will do the rest on launch.

```bash
brew uninstall --cask vorssaint
```

## Keeping the repo current

```bash
./update-config.sh              # diff of every live config vs the repo, asks before copying
./update-config.sh --dry-run    # only show what differs
./update-config.sh --yes        # take over everything
```

It covers `.zshrc`, the p10k prompt, the Neovim config (every file in `~/.config/nvim`, including `lazy-lock.json`), the Claude Code statusline, the cmux and Ghostty configs, the Vorssaint settings, the gateway plugin files (`~/.config/opencode/plugins/ai-gateway`) and `~/.tool-versions`. Your home path is rewritten to `$HOME`, and the gateway URL to `$GATEWAY_BASE_URL` (read from the environment or `~/.config/ai-gateway/env`), so the real URL never reaches the repo. The API key file is never opened. Review with `git diff` and commit.

## Checklist for things the script cannot do

- Sign in to the App Store, iCloud, Teams/Slack and your browser
- Turn on FileVault and the firewall (System Settings → Privacy & Security / Network)
- Grant permissions to cmux and Vorssaint when macOS asks
- Add the new SSH key's passphrase to the Keychain once (`ssh-add --apple-use-keychain`, the script does this)

## Sources

The order and the Claude Code, Homebrew and SSH Keychain steps follow common fresh-Mac guides: [DEV: From fresh Mac to productive](https://dev.to/nickytonline/from-fresh-mac-to-productive-in-30-minutes-21db), [macOS Initial Setup 2026](https://codenote.net/en/posts/macos-initial-setup-2026/), [Claude Code install options](https://www.morphllm.com/install-claude-code-mac). Check Homebrew's and Anthropic's official pages if an installer URL changes.
