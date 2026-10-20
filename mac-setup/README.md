# Mac Setup

One interactive script takes a fresh Mac to the same state as this one. Order matters: Xcode Command Line Tools (they bring git) → Homebrew → everything else.

```bash
# git comes with the Command Line Tools, so this works on a brand new Mac
xcode-select --install          # finish the dialog, then:
git clone https://github.com/XSnelliusX/tryout-lab.git && cd tryout-lab/mac-setup
./setup.sh
```

Every step asks first and skips what is already done, so it is safe to re-run. Run a single step with `./setup.sh --only ssh` (`./setup.sh --list` shows them).

## What the script does

| Step | What happens |
|---|---|
| `xcode` | Command Line Tools (compiler, make, git), waits until installed |
| `brew` | Homebrew, and `brew shellenv` in `~/.zprofile` so it is on PATH |
| `packages` | `git gh fzf eza bat watch jq ripgrep fd lazygit asdf nvm neovim k9s tree-sitter-cli yarn powerlevel10k` (+ `openssl@3 readline xz sqlite` to build asdf Python), casks `rancher cmux vorssaint` |
| `shell` | oh-my-zsh and the plugins from [zsh/README.md](zsh/README.md) |
| `font` | MesloLGS NF into `~/Library/Fonts` (prompt icons) |
| `zshrc` | [zsh/.zshrc](zsh/.zshrc) and [zsh/p10k.zsh](zsh/p10k.zsh) |
| `git` | asks for name and email, sets `init.defaultBranch main` |
| `github` | `gh auth login` in the browser, then `gh auth setup-git` as credential helper; optional Enterprise host |
| `ssh` | lists existing keys to reuse, or creates an ed25519 key with passphrase; adds it to the Keychain and `~/.ssh/config`; optionally uploads the **public** key with `gh ssh-key add` |
| `claude` | Claude Code via the native installer (updates itself), plus the [statusline](claude-code/README.md) and the usage hook that logs Claude Code to `~/.gateway-cost` |
| `cmux` | [cmux config](cmux/README.md): settings, sidebars, Ghostty |
| `vorssaint` | restores the Vorssaint settings (below) |
| `neovim` | [LazyVim config](nvim/README.md) into `~/.config/nvim` (an older non-LazyVim config is moved aside), plugins at the locked versions |
| `asdf` | runtimes from [.tool-versions](../.tool-versions) |
| `macos` | optional defaults (file extensions, path bar, key repeat), and shows the FileVault status |

Never stored in the repo: SSH private keys, `gh` tokens (`~/.config/gh/hosts.yml`), shell history. The script creates keys on the machine and only uploads `*.pub`.

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

It covers `.zshrc`, the p10k prompt, the Neovim config (every file in `~/.config/nvim`, including `lazy-lock.json`), the Claude Code statusline, the cmux and Ghostty configs and the Vorssaint settings. Your home path is rewritten to `$HOME`. Review with `git diff` and commit.

## Checklist for things the script cannot do

- Sign in to the App Store, iCloud, Teams/Slack and your browser
- Turn on FileVault and the firewall (System Settings → Privacy & Security / Network)
- Grant permissions to cmux and Vorssaint when macOS asks
- Add the new SSH key's passphrase to the Keychain once (`ssh-add --apple-use-keychain`, the script does this)

## Sources

The order and the Claude Code, Homebrew and SSH Keychain steps follow common fresh-Mac guides: [DEV: From fresh Mac to productive](https://dev.to/nickytonline/from-fresh-mac-to-productive-in-30-minutes-21db), [macOS Initial Setup 2026](https://codenote.net/en/posts/macos-initial-setup-2026/), [Claude Code install options](https://www.morphllm.com/install-claude-code-mac). Check Homebrew's and Anthropic's official pages if an installer URL changes.
