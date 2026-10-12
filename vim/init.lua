-- ~/.config/nvim/init.lua
-- Neovim config: lazy.nvim + nvim-treesitter (syntax highlighting)
--               + nvim-lspconfig + Mason (LSP servers / auto-completion)
--               + nvim-cmp (completion popup) + tokyonight (colorscheme)

vim.g.mapleader = " "

-- Make Mason-installed servers and system Go tools (gopls in ~/go/bin)
-- visible to Neovim. Mason also prepends its bin dir itself; this is a
-- safety net so it works even before Mason finishes first-time installs.
vim.env.PATH = vim.fn.stdpath("data")
  .. "/mason/bin:"
  .. vim.env.HOME
  .. "/go/bin:"
  .. vim.env.PATH

------------------------------------------------------------------------
-- Bootstrap lazy.nvim (plugin manager)
------------------------------------------------------------------------
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
  vim.fn.system({
    "git", "clone", "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

------------------------------------------------------------------------
-- Global options
------------------------------------------------------------------------
local opt = vim.opt
opt.number = true          -- absolute line number on the cursor line
opt.relativenumber = true  -- other lines show distance to cursor (hybrid)
                           -- set to false if you want plain 1,2,3... numbers
opt.completeopt = { "menu", "menuone", "noselect" } -- needed by nvim-cmp
opt.updatetime = 250                                -- faster diagnostics
opt.signcolumn = "yes"                              -- no gutter jumping
opt.termguicolors = true                            -- true colors

------------------------------------------------------------------------
-- Plugins
------------------------------------------------------------------------
require("lazy").setup({
  -- Syntax highlighting -------------------------------------------------
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate", -- keep parsers fresh when the plugin updates
    config = function()
      -- Install all maintained parsers (~314 languages, including Go).
      -- Note: in current nvim-treesitter, "stable" alone is only ~10 parsers;
      -- mainstream languages (go, c, lua, ...) are tier "unstable".
      -- Alternatives: { "all" } (adds unmaintained/unsupported), or a
      -- hand-picked list like { "go", "lua", "python", "javascript" }.
      require("nvim-treesitter").install({ "stable", "unstable" })

      -- Turn on Tree-sitter highlighting (+ indentation) for any file type
      -- that has a parser installed; silent no-op otherwise.
      vim.api.nvim_create_autocmd("FileType", {
        pattern = "*",
        callback = function()
          pcall(vim.treesitter.start)
          pcall(function()
            vim.bo.indentexpr = "v:lua:require'nvim-treesitter'.indentexpr()"
          end)
        end,
      })
    end,
  },

  -- Colorscheme (treesitter-aware). Swap "catppuccin" for e.g.
  -- "folke/tokyonight.nvim" -> "tokyonight" or "rose-pine/neovim" -> "rose-pine".
  {
    "catppuccin/nvim",
    name = "catppuccin",
    lazy = false,
    priority = 1000,
    config = function()
      vim.cmd.colorscheme("catppuccin-mocha") -- or latte, frappe, macchiato

      -- Custom treesitter colors: override any @capture group like this
      -- (run :Inspect on a token to find out which group it uses).
      -- Must come AFTER colorscheme, since colorschemes reset highlights.
      -- local hl = vim.api.nvim_set_hl
      -- hl(0, "@keyword",        { fg = "#cba6f7", bold = true })
      -- hl(0, "@function",       { fg = "#89b4fa" })
      -- hl(0, "@function.call",  { fg = "#89b4fa" })
      -- hl(0, "@string",         { fg = "#a6e3a1" })
      -- hl(0, "@comment",        { fg = "#6c7086", italic = true })
      -- hl(0, "@type",           { fg = "#94e2d5" })
      -- hl(0, "@variable",       { fg = "#cdd6f4" })
    end,
  },

  -- LSP servers: auto-install via Mason, defaults via nvim-lspconfig ------
  { "williamboman/mason.nvim", config = true },
  {
    "williamboman/mason-lspconfig.nvim",
    dependencies = { "williamboman/mason.nvim" },
    config = function()
      -- LSP servers to auto-install via Mason (npm/python-based ones).
      -- Server names must be lspconfig names (e.g. "yamlls", NOT "yaml_ls").
      --
      -- gopls is deliberately NOT here: Mason's `go install` build fails in
      -- some setups; gopls is instead used from the system Go install
      -- (~/go/bin/gopls, installed with `go install golang.org/x/tools/gopls
      -- @latest`), which the PATH line at the top of this file exposes.
      --
      -- Servers needing extra toolchains are intentionally left out:
      --   jdtls        -> needs JDK 17+   (:MasonInstall jdtls later)
      --   rust_analyzer-> needs rustup/cargo
      require("mason-lspconfig").setup({
        ensure_installed = {
          "pyright",   -- Python
          "ts_ls",     -- TypeScript / JavaScript
          "html",      -- HTML
          "cssls",     -- CSS / SCSS
          "jsonls",    -- JSON
          "yamlls",    -- YAML
          "marksman",  -- Markdown
          "bashls",    -- Bash
          "lua_ls",    -- Lua (Neovim config itself)
        },
        automatic_enable = true, -- vim.lsp.enable once installed
      })
    end,
  },

  -- nvim-lspconfig provides the default server configs for vim.lsp.enable --
  { "neovim/nvim-lspconfig" },

  -- Completion engine + sources ------------------------------------------
  {
    "hrsh7th/nvim-cmp",
    event = "InsertEnter",
    dependencies = {
      "hrsh7th/cmp-nvim-lsp", -- LSP completions
      "hrsh7th/cmp-buffer",   -- words from open buffers
      "hrsh7th/cmp-path",     -- file paths
      "hrsh7th/cmp-cmdline",  -- : and / command completion
      "L3MON4D3/LuaSnip",     -- snippet engine
      "saadparwaiz1/cmp_luasnip",
    },
    config = function()
      local cmp = require("cmp")
      local luasnip = require("luasnip")

      cmp.setup({
        snippet = {
          expand = function(args)
            luasnip.lsp_expand(args.body)
          end,
        },
        mapping = cmp.mapping.preset.insert({
          ["<C-b>"] = cmp.mapping.scroll_docs(-4),
          ["<C-f>"] = cmp.mapping.scroll_docs(4),
          ["<C-Space>"] = cmp.mapping.complete(), -- trigger manually
          ["<C-e>"] = cmp.mapping.abort(),
          ["<CR>"] = cmp.mapping.confirm({ select = true }), -- Enter accepts
          ["<Tab>"] = cmp.mapping(function(fallback)
            if cmp.visible() then
              cmp.select_next_item()
            elseif luasnip.expand_or_jumpable() then
              luasnip.expand_or_jump()
            else
              fallback()
            end
          end, { "i", "s" }),
          ["<S-Tab>"] = cmp.mapping(function(fallback)
            if cmp.visible() then
              cmp.select_prev_item()
            elseif luasnip.jumpable(-1) then
              luasnip.jump(-1)
            else
              fallback()
            end
          end, { "i", "s" }),
        }),
        sources = cmp.config.sources({
          { name = "nvim_lsp" },
          { name = "luasnip" },
        }, {
          { name = "buffer" },
          { name = "path" },
        }),
      })

      -- Completions also for : and / command lines
      cmp.setup.cmdline({ "/", "?" }, {
        mapping = cmp.mapping.preset.cmdline(),
        sources = { { name = "buffer" } },
      })
      cmp.setup.cmdline(":", {
        mapping = cmp.mapping.preset.cmdline(),
        sources = cmp.config.sources(
          { { name = "path" } },
          { { name = "cmdline" } }
        ),
      })
    end,
  },
}, {
  ui = { border = "rounded" },
})

------------------------------------------------------------------------
-- LSP: capabilities for completion + keymaps when a server attaches
------------------------------------------------------------------------
-- Advertise completion/snippet capabilities to every server
vim.lsp.config("*", {
  capabilities = require("cmp_nvim_lsp").default_capabilities(),
})

-- LSP keymaps, active only in buffers with a running server
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    local map = function(lhs, rhs, desc)
      vim.keymap.set("n", lhs, rhs, { buffer = args.buf, desc = "LSP: " .. desc })
    end
    map("gd", vim.lsp.buf.definition, "go to definition")
    map("gD", vim.lsp.buf.declaration, "go to declaration")
    map("gr", vim.lsp.buf.references, "references")
    map("K", vim.lsp.buf.hover, "hover docs")
    map("<leader>rn", vim.lsp.buf.rename, "rename symbol")
    map("<leader>ca", vim.lsp.buf.code_action, "code action")
    map("<leader>f", function()
      vim.lsp.buf.format({ async = true })
    end, "format buffer")
  end,
})

-- Enable system-installed servers (gopls from ~/go/bin). Mason-managed
-- servers are enabled automatically by mason-lspconfig (automatic_enable),
-- including right after they finish installing on first launch.
vim.schedule(function()
  for _, server in ipairs({ "gopls" }) do
    local cfg = vim.lsp.config[server]
    local cmd = cfg and cfg.cmd and cfg.cmd[1]
    if cmd and vim.fn.executable(cmd) == 1 then
      vim.lsp.enable(server)
    end
  end
end)
