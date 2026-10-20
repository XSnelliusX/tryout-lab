-- AI gateway (LiteLLM, OpenAI-compatible): base URL, API key and the models offered for
-- inline prediction. The opencode ai-gateway plugin and the Claude Code usage hook read the
-- same settings. Each one comes from the environment, then the env file, then its default:
--   GATEWAY_BASE_URL        required, no default: the gateway URL
--   GATEWAY_API_KEY_FILE    ~/.keys/ai-gateway.key
--   GATEWAY_COST_DIR        ~/.gateway-cost
--   GATEWAY_ENV_FILE        the env file itself (default ~/.config/ai-gateway/env)
--   GATEWAY_USAGE_DISABLED  1 = do not log usage
--   MINUET_MODEL            model used at startup (one of M.models)
-- Env file lines look like: export GATEWAY_BASE_URL="..."   Setup: mac-setup/setup.sh --only gateway
local M = {}

local home = os.getenv("HOME") or ""

-- ~/path, $HOME/path and ${HOME}/path -> the home folder (the env file is shell syntax,
-- setup.sh writes "$HOME/.keys/...")
local function expand(path)
  path = path:gsub("^%${HOME}", "~"):gsub("^%$HOME$", "~"):gsub("^%$HOME/", "~/")
  return (path:gsub("^~", function()
    return home
  end))
end

-- KEY=value and export KEY=value lines. Comments, blank lines and quotes are dropped.
local function read_env_file(path)
  local values = {}
  local f = io.open(path, "r")
  if not f then
    return values
  end
  for line in f:lines() do
    line = vim.trim(line):gsub("^export%s+", "")
    if line ~= "" and line:sub(1, 1) ~= "#" then
      local key, value = line:match("^([%w_]+)%s*=%s*(.-)%s*$")
      if key then
        -- "v", 'v' (each may be followed by # note), or v with an optional " # note"
        values[key] = value:match('^"(.-)"%s+#') or value:match('^"(.*)"$') or value:match("^'(.-)'%s+#")
          or value:match("^'(.*)'$") or (value:gsub("%s+#.*$", ""))
      end
    end
  end
  f:close()
  return values
end

local file = read_env_file(expand(vim.env.GATEWAY_ENV_FILE or "~/.config/ai-gateway/env"))

-- Environment variable first, then the env file, then the default.
local function setting(name, default)
  for _, value in ipairs({ vim.env[name] or "", file[name] or "" }) do
    if value ~= "" then
      return value
    end
  end
  return default
end

-- Without a base URL there is no gateway: ai.lua turns automatic prediction off and says so once.
M.base = (setting("GATEWAY_BASE_URL", ""):gsub("/+$", ""))
M.configured = M.base ~= ""
M.hint = "AI gateway not configured: run mac-setup/setup.sh --only gateway"
M.endpoint = M.configured and (M.base .. "/aiendpoint/v1/chat/completions") or ""
-- A plain path or OpenCode's {file:path} form, like the plugin accepts
M.key_file = expand(vim.trim(setting("GATEWAY_API_KEY_FILE", "~/.keys/ai-gateway.key"):gsub("^{file:(.*)}$", "%1")))
M.cost_dir = expand(setting("GATEWAY_COST_DIR", "~/.gateway-cost"))

-- Fast, cheap models and the request fields that switch their reasoning off.
-- With reasoning on, the whole token budget goes into thinking and the ghost
-- text stays empty. Measured on the gateway 2026-10-19 (~2k token context):
--   gpt-6-luna         ~0.5s first token, ~$0.00007/request (prompt cache hits)
--   deepseek-v4.1-...  ~0.55s,            ~$0.0002  (no cache)
--   glm-5.3-flash-dbs  ~0.9s,             ~$0.0001  ("none" is rejected, "low" still thinks a bit)
--   claude-haiku-5-5   ~0.5s,             ~$0.0003  (tokenizer counts ~50% more tokens)
M.models = {
  ["gpt-6-luna"] = { reasoning_effort = "none" },
  ["deepseek-v4.1-flash-1017"] = { reasoning = { enabled = false } },
  ["glm-5.3-flash-dbs"] = { reasoning_effort = "low" },
  ["claude-haiku-5-5"] = { thinking = { type = "disabled" } },
}
M.default_model = M.models[vim.env.MINUET_MODEL or ""] and vim.env.MINUET_MODEL or "gpt-6-luna"

-- Request body fields for a model: its reasoning switch, a short answer, and the
-- token usage in the last stream chunk (read by gateway.usage).
function M.request_fields(model)
  return vim.tbl_extend("force", {
    max_tokens = 64,
    stream_options = { include_usage = true },
  }, M.models[model] or {})
end

-- Read at request time, so a rotated key applies without a restart; never stored in the config.
function M.key()
  local f = io.open(M.key_file, "r")
  if not f then
    return nil
  end
  local key = f:read("*a"):gsub("%s+", "")
  f:close()
  return key ~= "" and key or nil
end

return M
