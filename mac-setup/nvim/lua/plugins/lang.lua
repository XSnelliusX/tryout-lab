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
        -- nvim-lint picks golangci-lint's dir or file mode once, from nvim's cwd, when the
        -- linter first loads. Under a different Go module that fails (exit 5 / 7), so lint
        -- the buffer's file on every run instead.
        golangcilint = function()
          local linter = vim.deepcopy(require("lint.linters.golangcilint"))
          linter.args = {
            "run",
            "--output.json.path=stdout",
            "--output.text.path=",
            "--output.tab.path=",
            "--output.html.path=",
            "--output.checkstyle.path=",
            "--output.code-climate.path=",
            "--output.junit-xml.path=",
            "--output.teamcity.path=",
            "--output.sarif.path=",
            "--issues-exit-code=0",
            "--show-stats=false",
            "--path-mode=abs",
          }
          return linter
        end,
      },
    },
  },
}
