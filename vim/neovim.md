# Neovim

Setup notes for my Neovim configuration — syntax highlighting, auto-completion, and themes.

## What's installed

Config lives in `~/.config/nvim/init.lua` (single file, plain Lua). Plugin manager is [lazy.nvim](https://github.com/folke/lazy.nvim), which bootstraps itself on first launch.

| Plugin | Purpose |
|---|---|
| [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter) | Syntax highlighting + indentation for ~311 languages |
| [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig) | Default configs for LSP language servers |
| [mason.nvim](https://github.com/williamboman/mason.nvim) + mason-lspconfig | Auto-installs language servers into `~/.local/share/nvim/mason/` |
| [nvim-cmp](https://github.com/hrsh7th/nvim-cmp) + sources | Auto-completion popup (LSP, buffer words, paths, `:` and `/` cmdline) |
| [LuaSnip](https://github.com/L3MON4D3/LuaSnip) | Snippet engine behind the completion popup |
| [catppuccin](https://github.com/catppuccin/nvim) | Colorscheme (`catppuccin-mocha`) |

### Requirements

- Neovim ≥ 0.11 (config uses `vim.lsp.config` / `vim.lsp.enable`)
- `tree-sitter` CLI for compiling parsers: `brew install tree-sitter-cli`
  (the `brew install tree-sitter` formula is only the C library — the CLI is separate!)
- A C compiler (Xcode Command Line Tools)
- Node/npm for the JS/TS/HTML/CSS/JSON servers (managed via asdf, see [zsh](../terminal/zsh.md))
- Go toolchain for `gopls`

## First-time setup (from scratch)

```bash
# 1. tooling
brew install neovim tree-sitter-cli

# 2. config — copy init.lua from this repo (see vim/ below)
mkdir -p ~/.config/nvim && cp vim/init.lua ~/.config/nvim/init.lua

# 3. language servers that live outside Mason
go install golang.org/x/tools/gopls@latest   # Go LSP -> ~/go/bin/gopls

# 4. first launch compiles all parsers + installs Mason servers (few minutes)
nvim
```

On first launch lazy.nvim clones all plugins, treesitter compiles every parser, and Mason installs the language servers in the background. `:checkhealth treesitter` and `:checkhealth mason` verify everything worked.

## Syntax highlighting

Tree-sitter is the modern highlighting engine (parses the real syntax tree instead of regex patterns). All maintained parsers are installed automatically, so any language just works — Go, Python, TS/JS, HTML, YAML, ...

> Gotcha: in current nvim-treesitter, `:TSInstall stable` covers only ~10 parsers. Mainstream languages (go, c, lua, ...) are tier "unstable" — that's a maintenance label, not a quality one. The config therefore installs `{ "stable", "unstable" }`.

Handy commands:

```vim
:TSInstall <lang>    " add one more parser
:TSUpdate            " update all parsers
:Inspect             " show what's highlighting the token under the cursor
:checkhealth treesitter
```

## Auto-completion (LSP)

Language servers give completions, go-to-definition, hover docs, rename, and formatting.

| Language | Server | Installed by |
|---|---|---|
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` (Mason's build can fail) |
| Python | `pyright` | Mason (auto) |
| TypeScript / JavaScript | `ts_ls` | Mason (auto) |
| HTML / CSS / JSON | `html`, `cssls`, `jsonls` | Mason (auto) |
| YAML / Markdown / Bash | `yamlls`, `marksman`, `bashls` | Mason (auto) |
| Lua | `lua_ls` | Mason (auto) |
| Java | `jdtls` | not set up — needs JDK 17+ (`:MasonInstall jdtls` later) |
| Rust | `rust_analyzer` | not set up — needs rustup/cargo |

Keymaps (only active in buffers with a running LSP):

```text
gd        go to definition        K         hover docs
gr        references              <leader>rn  rename symbol
gD        declaration             <leader>ca  code action
<leader>f format buffer
Tab / S-Tab  cycle completion items (also jumps snippets)
Enter     accept completion       C-Space   trigger completion manually
```

> asdf gotcha: `gopls` shells out to `go`, and asdf shims fail with "No version is set for command go" in directories without a matching `.tool-versions`. Keep `go <version>` in `~/.tool-versions` (home-wide fallback) or the project's `.tool-versions`.

## Theme

Default is **Catppuccin Mocha** (dark). Switch flavor in the colorscheme block of `init.lua`:

```lua
vim.cmd.colorscheme("catppuccin-mocha")  -- or latte (light), frappe, macchiato
```

Other themes: replace the plugin block with e.g. `"folke/tokyonight.nvim"` → `colorscheme("tokyonight")`, `"rose-pine/neovim"` → `"rose-pine"`, `"ellisonleao/gruvbox.nvim"` → `"gruvbox"`. Preview any installed theme with `:colorscheme <Tab>`.

Custom per-token colors override any treesitter capture group — put them **after** `colorscheme()` in the config (themes reset highlights on load), and use `:Inspect` on a token to find its group:

```lua
local hl = vim.api.nvim_set_hl
hl(0, "@keyword", { fg = "#cba6f7", bold = true })
hl(0, "@string",  { fg = "#a6e3a1" })
```

## Daily commands

```text
:Mason              " UI for installed language servers
:MasonInstall <srv> " add a server
:LspRestart         " restart LSP after config changes
:Lazy               " plugin manager UI
:colorscheme <Tab>  " preview themes
```

## Files

- `vim/init.lua` — the full config, copy to `~/.config/nvim/init.lua`
