-- AI in Neovim, all through endpoints the company controls:
--   1. Inline ghost-text prediction -> minuet-ai.nvim -> AI gateway (lua/gateway)
--   2. Claude Code                  -> ai.claudecode extra (lua/config/lazy.lua), keys <leader>a...
--   3. OpenCode                     -> opencode.nvim, keys <leader>o...
-- Prediction usage is logged next to OpenCode's (lua/gateway/usage.lua).
local gw = require("gateway")

-- Switch the prediction model at runtime (:AIModel or <leader>am); MINUET_MODEL sets the default.
local function set_model(model)
  local opts = require("minuet").config.provider_options.openai_compatible
  opts.model = model
  opts.optional = gw.request_fields(model)
end

local opencode_term = { win = { position = "right", width = 0.4 } }

-- Send one of opencode.nvim's built-in prompts (explain, fix, review, test, ...; see <leader>os).
-- prompt() sends its text as is, so look the text up by name.
local function opencode_prompt(name)
  require("opencode").prompt(require("opencode.config").opts.select.prompts[name])
end

return {
  {
    "milanglacier/minuet-ai.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    event = "InsertEnter",
    cmd = { "Minuet", "AIModel" },
    keys = {
      { "<leader>am", "<cmd>AIModel<cr>", desc = "Prediction model" },
      { "<leader>ap", "<cmd>Minuet virtualtext toggle<cr>", desc = "Toggle prediction (buffer)" },
    },
    opts = {
      provider = "openai_compatible",
      n_completions = 1, -- ghost text shows one suggestion; more only costs output tokens
      request_timeout = 3,
      throttle = 1000, -- at most one request per second
      debounce = 400, -- wait for a typing pause
      provider_options = {
        openai_compatible = {
          api_key = gw.key,
          end_point = gw.endpoint,
          model = gw.default_model,
          name = "ai-gateway",
          stream = true,
          optional = gw.request_fields(gw.default_model),
        },
      },
      -- Ctrl keys that blink.cmp leaves free in insert mode (it owns C-y, C-k, C-n, C-p).
      -- C-e falls through to minuet when the completion menu is closed.
      virtualtext = {
        -- Without GATEWAY_BASE_URL there is no gateway: no automatic prediction (see the notice in config).
        auto_trigger_ft = gw.configured and {
          "go",
          "python",
          "typescript",
          "javascript",
          "lua",
          "sh",
          "bash",
          "zsh",
          "yaml",
          "sql",
          "terraform",
          "dockerfile",
          "markdown",
        } or {},
        keymap = {
          accept = "<C-l>", -- whole suggestion
          accept_line = "<C-j>", -- first line only
          next = "<C-]>", -- next suggestion, or ask for one when none is shown
          dismiss = "<C-e>",
        },
        show_on_completion_menu = false,
      },
    },
    config = function(_, opts)
      require("minuet").setup(opts)
      if not gw.configured then
        vim.notify_once(gw.hint, vim.log.levels.WARN)
      end
      require("gateway.usage").setup()
      vim.api.nvim_create_user_command("AIModel", function(cmd)
        if gw.models[cmd.args] then
          return set_model(cmd.args)
        end
        local models = vim.tbl_keys(gw.models)
        table.sort(models)
        local current = require("minuet").config.provider_options.openai_compatible.model
        vim.ui.select(models, { prompt = "Prediction model (now: " .. current .. ")" }, function(choice)
          if choice then
            set_model(choice)
            vim.notify("Prediction model: " .. choice)
          end
        end)
      end, {
        nargs = "?",
        complete = function()
          return vim.tbl_keys(gw.models)
        end,
        desc = "Choose the inline prediction model",
      })
    end,
  },

  -- The extra's "add file" key only covers neo-tree/nvim-tree/oil; LazyVim's explorer is snacks.
  {
    "coder/claudecode.nvim",
    keys = {
      { "<leader>as", "<cmd>ClaudeCodeTreeAdd<cr>", desc = "Add file", ft = { "snacks_picker_list" } },
    },
  },

  -- Ctrl+q hides the agent split (any snacks terminal) from insert mode; the cursor goes back to
  -- the code window. LazyVim's Ctrl+/ and Ctrl+_ hide too, but both are byte 0x1f, which Claude Code
  -- uses for undo. Claude Code, OpenCode and LazyVim leave Ctrl+q alone inside terminals.
  {
    "folke/snacks.nvim",
    opts = {
      terminal = {
        win = {
          keys = {
            hide_ctrl_q = { "<C-q>", "hide", desc = "Hide terminal", mode = "t" },
          },
        },
      },
    },
  },

  -- OpenCode TUI in a right split; opencode.nvim finds its server and sends
  -- prompts with context (@this = selection or cursor, @buffer, @diagnostics, ...).
  -- `main` follows OpenCode v2 (installed: 2.0.x).
  {
    "nickjvandyke/opencode.nvim",
    dependencies = { "folke/snacks.nvim" },
    init = function()
      vim.g.opencode_opts = {
        server = {
          start = function()
            Snacks.terminal.open("opencode", opencode_term)
          end,
        },
      }
    end,
    keys = {
      { "<leader>o", "", desc = "+opencode", mode = { "n", "x" } },
      {
        "<leader>oo",
        function()
          Snacks.terminal.toggle("opencode", opencode_term)
        end,
        desc = "Toggle OpenCode",
      },
      {
        "<leader>oa",
        function()
          require("opencode").ask("@this: ")
        end,
        desc = "Ask about this",
        mode = { "n", "x" },
      },
      {
        "<leader>ob",
        function()
          require("opencode").ask("@buffer: ")
        end,
        desc = "Ask about buffer",
      },
      {
        "<leader>os",
        function()
          require("opencode").select()
        end,
        desc = "Prompts and actions",
        mode = { "n", "x" },
      },
      {
        "<leader>oe",
        function()
          opencode_prompt("explain")
        end,
        desc = "Explain this",
        mode = { "n", "x" },
      },
      {
        "<leader>of",
        function()
          opencode_prompt("fix")
        end,
        desc = "Fix diagnostics",
      },
      {
        "<leader>or",
        function()
          opencode_prompt("review")
        end,
        desc = "Review this",
        mode = { "n", "x" },
      },
    },
  },
}
