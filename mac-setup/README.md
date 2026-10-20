# Mac Setup

One command takes a fresh Mac to the same state as this one. Order matters: Xcode Command Line Tools (they bring git) → Homebrew (which installs gum for the menus) → everything else. Nothing needs to be installed first.

```bash
# fresh Mac: installs the Command Line Tools, clones this repo to ~/tryout_lab and runs setup.sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/XSnelliusX/tryout-lab/main/mac-setup/bootstrap.sh)"
```

Flags go after `bootstrap`, for example `bash -c "$(curl ...)" bootstrap --dry-run`. Set `TRYOUT_LAB_DIR` to clone somewhere else. An existing clone that is clean is updated with `git pull --ff-only`, one with local changes is used as it is.

With a clone already in place, run the script from it:

```bash
cd tryout-lab/mac-setup
./setup.sh
```

`xcode`, `brew` and gum always run first, in the same run. Then a menu lists the other steps, all preselected, each with a one-line description: space toggles a step, Enter runs the selection in the order of the table below. Every step asks first and skips what is already done.

| Flag | What it does |
|---|---|
| (none) | xcode, brew and gum, then the menu |
| `--all` | every step in order, no menu (each step still asks its questions) |
| `--only <step>` | one step, e.g. `./setup.sh --only gateway` |
| `--dry-run` | with any of the above: reports what would change. Nothing is installed, written, moved or backed up, and brew, curl, nvim and gh are not run |
| `--list` | the step names, in order |

The menus and questions use [gum](https://github.com/charmbracelet/gum), which the brew step installs, so the menu comes up in the same run. Before Homebrew exists, or when the script has no terminal, the same questions are plain prompts. In the plain menu you type the names to switch off (Enter keeps them all). `SETUP_PLAIN=1 ./setup.sh` forces the plain prompts. In a gum list, Enter takes the safe default (Skip when a file differs).

### Running it again on a configured Mac

Re-running is safe and quiet. Each step compares what is on the Mac with the repo:

- **Packages and casks** install only what is missing. Nothing is upgraded.
- **Config files** (`.zshrc`, `.p10k.zsh`, `~/.tool-versions`, cmux and Ghostty, the statusline and `settings.json`, the gateway env file, the Neovim config): a file that matches prints `unchanged`. A file that differs shows a one-line summary (`+N/-M lines`) and asks **Overwrite**, **Show diff** or **Skip**. A new file is just copied.
- **Backups:** an overwritten file goes to `~/.setup_backup/<stamp>/` first, at the path it had under your home folder (`~/.zshrc` becomes `~/.setup_backup/<stamp>/.zshrc`). One folder per run, created only when something was replaced. **Nothing is deleted** except an old gateway folder, and only after you confirm removing it (see the gateway section). Files that exist only on the Mac stay where they are.
- **Neovim:** the plugins are restored on the first install, or after you confirm that `lazy-lock.json` changed. A different (non-LazyVim) config moves to the backup folder with its plugin data.
- **Vorssaint:** the live settings are exported and compared with the repo. Before an import, the live export is saved to `~/.setup_backup/<stamp>/vorssaint/`.
- **macOS defaults** are written only when they differ from the wanted value.

The last line of a run names the backup folder, if the run replaced anything.

## What the script does

| Step | What happens |
|---|---|
| `xcode` | Command Line Tools (compiler, make, git), waits until installed |
| `brew` | Homebrew, `brew shellenv` in `~/.zprofile`, and gum |
| `packages` | `git gh fzf eza bat watch jq ripgrep fd lazygit asdf nvm neovim k9s tree-sitter-cli yarn powerlevel10k gum herdr` (+ `openssl@3 readline xz sqlite` to build asdf Python), casks `rancher cmux vorssaint`. Only the missing ones are installed |
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
| `neovim` | [LazyVim config](nvim/README.md) into `~/.config/nvim` (an older non-LazyVim config is moved to the backup folder), plugins at the locked versions |
| `asdf` | global `~/.tool-versions` from [asdf/tool-versions](asdf/tool-versions) (nodejs 26.11.1, golang 1.27.1, python 3.13.16), plugins added, `asdf install` in home and in the repo ([.tool-versions](../.tool-versions)) |
| `macos` | optional defaults (file extensions, path bar, key repeat; only the ones that differ are written), and shows the FileVault status |

Never stored in the repo: SSH private keys, `gh` tokens (`~/.config/gh/hosts.yml`), shell history, the gateway URL and the gateway API key. The script creates keys on the machine and only uploads `*.pub`.

## AI gateway (OpenCode plugin)

The `gateway` step installs [ai-gateway/](ai-gateway/) to `~/.config/opencode/plugins/ai-gateway` (without its README), with the same rule as everything else: new files are copied, changed ones are shown and asked about.

**Moving from an older install** is a rename, not a backup. An old folder `~/.config/opencode/plugins/*-gateway` that holds `claude_usage.py` is renamed to `ai-gateway`, and its files live on under the new name. If `ai-gateway` already exists, the files it lacks are copied across, and you are asked whether to remove the old folder (default: keep it; opencode would otherwise load two copies of the plugin). The repo version then replaces the old files, and the old ones go to `~/.setup_backup/<stamp>/.config/opencode/plugins/ai-gateway/` like any other overwrite. The old key file (the path in the old plugin's `DEFAULT_KEY_SPEC`, else `~/.keys/*opencode*.key`) is moved to the new key path when that one is missing, with no copy and no backup. If `opencode.json` still points at the old folder, the script prints the line and you change it by hand.

It asks for:

- the gateway base URL. The default is the current value from the env file (or the environment), else the URL of the old plugin. There is no built-in URL
- the API key file, default `~/.keys/ai-gateway.key`. If that file is missing and an old key was found, you are asked to move it. Otherwise the key is asked for with hidden input and written with mode 600 into a 700 folder. It is never echoed or stored in the repo

It then writes `~/.config/ai-gateway/env` with mode 600, through the same overwrite question:

```bash
export GATEWAY_BASE_URL="https://gateway.example.com"
export GATEWAY_API_KEY_FILE="$HOME/.keys/ai-gateway.key"
export GATEWAY_COST_DIR="..."   # only when it was set before
```

Then `check_gateway.py` runs once (a failure there does not stop the script). At the end it offers to re-run [claude-code/install.sh](claude-code/install.sh), which registers the usage hook for the new collector path.

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
