-- Logs every inline-prediction request to the shared AI usage log (~/.gateway-cost/usage.jsonl),
-- so dashboard.html there shows Neovim next to OpenCode and Claude Code
-- (tool "nvim", agent "prediction", one session per Neovim process).
--
-- Tokens come from the gateway's own `usage` block (last stream chunk), so cached and
-- reasoning tokens are counted as billed. Cost = tokens x the prices in models.json,
-- the same formula and price list the plugin uses. Requests cancelled because you kept
-- typing (or that timed out) have no usage block: they are logged with finish
-- "cancelled"/"timeout" and 0 tokens, so you can see how many there are.
local gw = require("gateway")

local M = {}

local log_path = gw.cost_dir .. "/usage.jsonl"
local session = ("nvim_%d_%d"):format(vim.fn.getpid(), os.time())
local seq = 0
local catalog, catalog_mtime = {}, nil
local js_timer

local function num(v)
  return type(v) == "number" and v or 0
end

local function tbl(v)
  return type(v) == "table" and v or {}
end

-- models.json rows by model id and alias (ids win over aliases); reloaded when the plugin rewrites it.
local function lookup(model)
  local path = gw.cost_dir .. "/models.json"
  local stat = vim.uv.fs_stat(path)
  if stat and stat.mtime.sec ~= catalog_mtime then
    catalog, catalog_mtime = {}, stat.mtime.sec
    local f = io.open(path, "r")
    local ok, doc = pcall(vim.json.decode, f and f:read("*a") or "")
    if f then
      f:close()
    end
    local rows = ok and tbl(doc).rows or {}
    for _, row in ipairs(rows) do
      catalog[row.model_id] = row
    end
    for _, row in ipairs(rows) do
      for _, alias in ipairs(tbl(row.aliases)) do
        catalog[alias] = catalog[alias] or row
      end
    end
  end
  return catalog[model]
end

-- Same as priceCost() in the plugin: the largest context tier the prompt exceeds wins.
local function prices(row, prompt_tokens)
  local p = row
  for _, tier in ipairs(tbl(row.tiers)) do
    if prompt_tokens > num(tier.size) then
      p = tier
    end
  end
  return num(p.input_per_1M), num(p.output_per_1M), num(p.cache_read_per_1M), num(p.cache_write_per_1M)
end

-- The last `usage` object and finish_reason in an SSE (or plain JSON) response.
local function parse(stdout)
  local usage, finish
  for line in vim.gsplit(stdout or "", "\n", { plain = true }) do
    local ok, j = pcall(vim.json.decode, (line:gsub("^data:%s*", "")))
    if ok and type(j) == "table" then
      if type(j.usage) == "table" then
        usage = j.usage
      end
      local choice = tbl(tbl(j.choices)[1])
      if type(choice.finish_reason) == "string" then
        finish = choice.finish_reason
      end
    end
  end
  return usage, finish
end

-- Dashboard data for file:// pages; the plugin writes the same file on its own flushes.
local function write_log_js()
  local f = io.open(log_path, "r")
  if not f then
    return
  end
  local text = f:read("*a")
  f:close()
  local target = gw.cost_dir .. "/usage-log.js"
  local tmp = ("%s.%d.tmp"):format(target, vim.fn.getpid())
  local out = io.open(tmp, "w")
  if not out then
    return
  end
  out:write("window.GATEWAY_USAGE_LOG = ", vim.json.encode(text), ";\n")
  out:close()
  vim.uv.fs_rename(tmp, target)
end

local function record(req, result)
  local usage, finish = parse(result.stdout)
  if not usage then
    finish = (result.signal ~= 0 or result.code == 143) and "cancelled" or result.code == 28 and "timeout" or "error"
  end
  local u = tbl(usage)
  local pd, cd = tbl(u.prompt_tokens_details), tbl(u.completion_tokens_details)
  local cache_read = num(pd.cached_tokens)
  local cache_write = type(pd.cache_creation_tokens) == "number" and pd.cache_creation_tokens
    or num(u.cache_creation_input_tokens)
  local reasoning = num(cd.reasoning_tokens)
  local t = {
    input = math.max(num(u.prompt_tokens) - cache_read - cache_write, 0),
    output = math.max(num(u.completion_tokens) - reasoning, 0),
    reasoning = reasoning,
    cache_read = cache_read,
    cache_write = cache_write,
  }

  local row = lookup(req.model)
  local in_p, out_p, cr_p, cw_p = 0, 0, 0, 0
  if row then
    in_p, out_p, cr_p, cw_p = prices(row, t.input + t.cache_read + t.cache_write)
  end
  local cost = (t.input * in_p + (t.output + t.reasoning) * out_p + t.cache_read * cr_p + t.cache_write * cw_p) / 1e6

  seq = seq + 1
  local id = ("%s_%d"):format(session, seq)
  local line = vim.json.encode({
    ts = os.date("!%Y-%m-%dT%H:%M:%S.000Z", req.started),
    event_id = id,
    session_id = session,
    message_id = id,
    tool = "nvim",
    billing = "gateway",
    agent = "prediction",
    provider_id = row and row.provider_id or "unknown",
    model_id = row and row.model_id or req.model,
    model_name = row and row.model_name or req.model,
    gateway = row ~= nil,
    upstream_provider = row and row.upstream_provider ~= vim.NIL and row.upstream_provider or vim.NIL,
    finish = finish or "unknown",
    input_tokens = t.input,
    output_tokens = t.output,
    reasoning_tokens = t.reasoning,
    cache_read_tokens = t.cache_read,
    cache_write_tokens = t.cache_write,
    input_per_1M = in_p,
    output_per_1M = out_p,
    cache_read_per_1M = cr_p,
    cache_write_per_1M = cw_p,
    cost = math.floor(cost * 1e8 + 0.5) / 1e8,
    reported_cost = 0, -- the gateway reports cost only on non-streamed requests
  })

  vim.fn.mkdir(gw.cost_dir, "p")
  local f = io.open(log_path, "a")
  if not f then
    return
  end
  f:write(line, "\n")
  f:close()

  js_timer = js_timer or assert(vim.uv.new_timer())
  js_timer:start(3000, 0, vim.schedule_wrap(write_log_js))
end

-- minuet has no response hook, so wrap the function that runs every curl request.
-- Only requests to the gateway are logged; any failure here never breaks a completion.
function M.setup()
  -- No gateway configured: nothing is sent, and an empty base URL would match every request.
  if vim.env.GATEWAY_USAGE_DISABLED == "1" or not gw.configured then
    return
  end
  local common = require("minuet.backends.common")
  if common.gateway_usage_wrapped then
    return
  end
  common.gateway_usage_wrapped = true

  local start_job = common.start_job
  ---@diagnostic disable-next-line: duplicate-set-field
  common.start_job = function(command, args, handlers)
    local req
    pcall(function()
      local url, body_file
      for i, a in ipairs(args) do
        if a:find(gw.base, 1, true) == 1 then
          url = a
        elseif a == "-d" and args[i + 1] then
          body_file = args[i + 1]:gsub("^@", "")
        end
      end
      if url and body_file then
        local f = assert(io.open(body_file, "r"))
        local body = vim.json.decode(f:read("*a"))
        f:close()
        req = { model = body.model, started = os.time() }
      end
    end)
    if req then
      local on_exit = handlers.on_exit
      handlers = vim.tbl_extend("force", handlers, {
        on_exit = function(job, result)
          local ok, err = pcall(record, req, result)
          if not ok then
            vim.notify_once("gateway usage log: " .. tostring(err), vim.log.levels.WARN)
          end
          return on_exit(job, result)
        end,
      })
    end
    return start_job(command, args, handlers)
  end

  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = vim.api.nvim_create_augroup("gateway_usage", { clear = true }),
    callback = function()
      if js_timer and js_timer:is_active() then
        js_timer:stop()
        write_log_js()
      end
    end,
  })
end

return M
