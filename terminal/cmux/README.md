# cmux Setup [https://cmux.com](https://cmux.com)

Terminal: [cmux](https://cmux.com) — a native macOS terminal built on **libghostty** (same core as Ghostty), made for running coding agents. It replaced [Supacode](https://supacode.sh) + [herdr](https://herdr.dev), because herdr could not add tabs. The full config lives in [config/](config/) — it is the source of truth, this note explains how to rebuild the same setup on a new machine.

Source: [github.com/manaflow-ai/cmux](https://github.com/manaflow-ai/cmux) · Docs: [cmux.com/docs](https://cmux.com/docs/concepts)

## How it is organized

```
Window
└── Workspace group (Space)   optional folder in the sidebar, one per project
    └── Workspace             a sidebar entry
        └── Pane              a split region
            └── Surface       a tab inside a pane (terminal or browser)
```

The sidebar calls groups **Spaces**. The CLI says *workspace*, *workspace-group*, *surface*.

## 1. Set up the shell first

Follow [zsh.md](../zsh.md). The Ghostty config uses the **MesloLGS NF** font, so install it before launching cmux, otherwise prompt icons show as broken glyphs.

## 2. Install cmux

Download it from [cmux.com](https://cmux.com) (or the [releases](https://github.com/manaflow-ai/cmux/releases)), move it to `/Applications`, and launch it once so it creates `~/.config/cmux`. Check the CLI with `cmux --help`.

## 3. Install the config

```bash
cd terminal/cmux      # from the repo root
./install.sh
```

`install.sh` copies the files below into place (an existing file is backed up as `*.bak-<timestamp>`), then runs `cmux config doctor`, `cmux reload-config` and `cmux sidebar select herdr-style`.

| In this repo | Installed to |
|---|---|
| `config/cmux/cmux.json` | `~/.config/cmux/cmux.json` |
| `config/cmux/sidebars/herdr-style.js` | `~/.config/cmux/sidebars/` (main sidebar) |
| `config/cmux/sidebars/panel-subagents.js`, `panel-sessions.js` | `~/.config/cmux/sidebars/` (optional right panels) |
| `config/ghostty/config.ghostty` | `~/Library/Application Support/com.mitchellh.ghostty/` |

## 4. Enable the sidebar and agent hooks

1. **Settings → Custom Sidebars** (beta, `customSidebars.beta.enabled`) on, then `cmux sidebar select herdr-style`.
2. `cmux hooks setup` for Claude Code and the other agents.
3. OpenCode: `cmux hooks opencode install --yes`, then restart OpenCode in a cmux terminal. Sessions started earlier are not tracked.
4. Check: `cmux config doctor` and `cmux sidebar validate herdr-style`.

> Not carried over: agent session IDs (`~/.cmuxterm/*-hook-sessions.json`), browser logins, and the workspaces themselves. Recreate Spaces with `⌃⌘G` or the `+` in the sidebar.

## The sidebar (herdr-style)

A custom **left** sidebar modeled on herdrm's "Spaces, Agents & Terminals" list. Toggle with `⌘B`.

```
Spaces                          +
  All Spaces                 4
  Tryout Lab                 3     <- pick a space to filter the list
[ Search ]
▾ Workspaces                 3
▾ ● tryout k8s               2     arrow, color dot or icon, name, tab count
      zsh                          terminal tab: branch + folder
      my-session           ⎇ main  agent: tab title + branch
      ✦ claude          working    logo, name, status
 ──────────────────────────
▾ ● tryout go                1
```

- **Spaces** filter the list. "All Spaces" shows everything.
- **Workspaces** take one line, fold with ▾/▸, and are separated by a divider.
- **Tabs and agents** are indented under their workspace. A tab that runs an agent shows as the agent only. Click either to focus that tab, also across workspaces.
- **Agent status:** orange = needs input, blue = working, green = idle. Ended agents are hidden.
- **Splits** are not listed, because the sidebar data does not say which tabs share a pane.

### Editing a space or workspace

Double-click it, or right-click → **Edit…**. A bar opens at the top of the sidebar:

- **Name:** type it, Return applies.
- **Color:** 15 swatches. The grey one clears the color.
- **Icon:** 15 SF Symbols. For workspaces the first one (crossed circle) removes the icon.
- Colors and icons apply on click. **Done** or **✕** applies a typed name and closes the bar.

A workspace has no icon field in cmux, so its icon is stored in the workspace **description** as `icon:<symbol>`. Anything else kept in a description is overwritten.

Right-click menus: **Space** — New Workspace in Space, Edit…, Collapse/Expand, Pin/Unpin, Ungroup. **Workspace** — Edit…, Pin/Unpin, Move, Mark as Read, Close Workspace (force-closes running processes, no prompt).

### Tweaking it

`~/.config/cmux/sidebars/herdr-style.js` hot-reloads on save. The `EDIT` block at the top sets the edit bar size (cells per row, dot and icon size, padding). Copy changes back into `config/` to keep this folder current:

```bash
cp ~/.config/cmux/sidebars/herdr-style.js config/cmux/sidebars/
```

Other sidebars: `cmux right-sidebar set custom panel-subagents` (or `panel-sessions`), or right-click the sidebar toggle to switch.

## Keyboard shortcuts

cmux defaults. Verify in **Settings → Keyboard Shortcuts** if one does not match.

| Action | Shortcut |
|---|---|
| New tab / close / rename | `⌘T` / `⌘W` / `⌘R` |
| Next / previous tab | `⌘⇧]` / `⌘⇧[` |
| Split right / down | `⌘D` / `⌘⇧D` |
| Focus pane | `⌘⌥←` `→` `↑` `↓` |
| Zoom split | `⌘⇧↩` |
| New workspace | `⌘N` |
| Jump to workspace 1–8 | `⌘1` … `⌘8` |
| Go to workspace (search) | `⌘P` |
| New group (Space) | `⌃⌘G` |
| Toggle left sidebar | `⌘B` |
| Jump to newest unread | `⌘⇧U` |
| Command palette | `⌘⇧P` |
| Reload config | `⌘⇧,` |

## Config files

| File | What it controls |
|---|---|
| `~/.config/cmux/cmux.json` | cmux settings (JSONC). Only `accentColor` and the mascot are set; the rest is the commented template. |
| `~/.config/cmux/sidebars/*.js` | Custom sidebars. |
| `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty` | Terminal font (`MesloLGS NF`), theme, colors. |

After a config change: `cmux reload-config` (no restart).

## Handy CLI commands

```bash
cmux <path>                       # open a directory in a new workspace
cmux tree --all                   # windows, workspaces, panes, surfaces
cmux workspace-group list         # Spaces
cmux sidebar select herdr-style   # switch sidebar
cmux sidebar validate             # check all sidebars
cmux notify --title "Done" --body "Build finished"
cmux reload-config
cmux config doctor
cmux help <start|navigate|inspect|customize|automation|diagnostics>
```

## Limits

- macOS only.
- Session restore rebuilds layout, directories and scrollback, but **not running processes**. Agents resume only if hooks captured their session ID.
- Detach/reattach needs `cmux local-tmux` or `cmux local-zellij`.
- The custom sidebar feature is beta.

## Sources

- [cmux concepts](https://cmux.com/docs/concepts) · [workspace groups](https://cmux.com/docs/workspace-groups) · [notifications](https://cmux.com/docs/notifications) · [keyboard shortcuts](https://cmux.com/docs/keyboard-shortcuts)
- [Custom sidebars guide](https://github.com/manaflow-ai/cmux/blob/main/docs/custom-sidebars.md)
