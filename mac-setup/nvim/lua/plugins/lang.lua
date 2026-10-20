-- Tweaks on top of the language extras in lua/config/lazy.lua.
return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        -- Kubernetes manifests: yamlls' built-in "kubernetes" schema for these globs
        -- (lang.yaml wires SchemaStore for everything else). Per-file override:
        -- put  # yaml-language-server: $schema=<url>  on line 1.
        yamlls = {
          settings = {
            yaml = {
              schemas = {
                kubernetes = { "k8s/**/*.yaml", "manifests/**/*.yaml", "deploy*/**/*.yaml", "*.k8s.yaml" },
              },
            },
          },
        },
        -- Shell scripts (setup.sh and friends); uses shellcheck for diagnostics.
        bashls = {},
        -- basedpyright's default ("recommended") flags every untyped value
        -- (~130 warnings on a small script). "standard" matches pyright.
        basedpyright = {
          settings = {
            basedpyright = { analysis = { typeCheckingMode = "standard" } },
          },
        },
      },
    },
  },
  { "mason-org/mason.nvim", opts = { ensure_installed = { "shellcheck" } } },
  {
    "mfussenegger/nvim-lint",
    opts = {
      linters = {
        ["markdownlint-cli2"] = {
          args = { "--config", vim.fn.stdpath("config") .. "/.markdownlint.yaml", "-" },
        },
      },
    },
  },
}
