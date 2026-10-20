-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- (mouse = "a", relative numbers, system clipboard, ... are already LazyVim defaults)

vim.opt.mousemoveevent = true -- hover events for UI plugins

-- Python LSP (read by the lang.python extra)
vim.g.lazyvim_python_lsp = "basedpyright"

-- No plugin here uses the remote-plugin hosts; silences their :checkhealth warnings.
vim.g.loaded_python3_provider = 0
vim.g.loaded_node_provider = 0
vim.g.loaded_perl_provider = 0
vim.g.loaded_ruby_provider = 0

-- Language runtimes come from asdf (versions pinned in .tool-versions).
-- Same shims line as .zshrc, so Neovim resolves go/python/node the same way
-- even when it was not started from an asdf-aware shell (Mason, LSPs, :terminal).
local asdf_shims = (vim.env.ASDF_DATA_DIR or (vim.env.HOME .. "/.asdf")) .. "/shims"
if not (vim.env.PATH or ""):find(asdf_shims, 1, true) then
  vim.env.PATH = asdf_shims .. ":" .. vim.env.PATH
end
