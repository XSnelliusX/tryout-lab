-- Catppuccin Mocha (same theme as before). Try others live with <leader>uC.
return {
  {
    "catppuccin/nvim",
    name = "catppuccin",
    opts = {
      flavour = "mocha", -- latte (light), frappe, macchiato, mocha
      -- LazyVim already lists the integrations; auto-detection calls vim.pack on
      -- Neovim 0.12, which leaves an empty site/pack/core that :checkhealth lazy warns about.
      auto_integrations = false,
    },
  },
  { "LazyVim/LazyVim", opts = { colorscheme = "catppuccin" } },
}
