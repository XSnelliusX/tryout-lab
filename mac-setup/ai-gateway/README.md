# AI gateway model discovery plugin for OpenCode

An OpenCode plugin that discovers the models exposed by a LiteLLM-style gateway
and registers them in OpenCode, one provider per upstream (`acc-bedrock`,
`acc-azure`, `acc-databricks`, ...), with token limits, prices and capabilities.
It also records per-step token usage and cost for every gateway model, in a log
that Neovim and Claude Code (via `claude_usage.py`) write to as well, so one
dashboard shows all AI usage by tool, agent, model and billing. Startup
uses a cached inventory (no network), and the slow metadata endpoint is only
called when the model set changes or the cache is more than 24 h old.

Source of truth is `index.ts` (server half) and `tui.ts` (TUI half: notifications
and `/gateway-status`). This folder is a plugin package (`package.json` ->
`index.ts`, `./tui` -> `tui.ts`) that OpenCode loads as-is: no build step, no
dependencies. `claude_usage.py` ships in the same folder but is run by Claude
Code (see "Claude Code usage").

## How the plugin works

1. **Setup (startup hook).** `setup()` in `index.ts` (section 15) reads the API
   key, registers the single "AI Gateway" integration, and connects it
   (`ensureConnection`) so the `/models` picker groups by provider.
2. **Cached catalog first.** If the OpenCode storage holds the `gateway.models.v5`
   entry, its catalog is loaded immediately (zero network). Otherwise only the
   fast list is fetched so the picker is populated, and the slow call follows.
3. **Background refresh.** `refresh()` (section 14) is started right after setup
   and then every 12 h (`FAST_POLL_MS`) while everything works. While something
   is broken (no key, gateway unreachable, `/model/info` failed) it retries after
   60 s (`GATEWAY_RETRY_MS`), doubling per failed network attempt up to 5 min, and
   returns to the 12 h poll after the first success. The key file's folder is
   watched, so creating, fixing or rotating the key triggers a refresh within a
   second, without a restart:
   * `GET {base}/aiendpoint/v1/models` (fast, about seconds). Its id, `mode`,
     `max_input_tokens` and `max_output_tokens` form a fingerprint.
   * `GET {base}/aiendpoint/v1/model/info` (slow, about 1 min) is called only when
     the fingerprint differs from the cached one, the cache has no entry, or the
     cache `fetchedAt` is older than 24 h (`INFO_STALE_MS`).
   * If the fast list fails (gateway unreachable, key rejected, non-JSON or empty
     answer), the cached catalog is kept.
   * If nothing is registered yet (first start without cache, or the key arrived
     late), the fast list is registered at once; prices follow from `/model/info`.
4. **Mapping.** `buildCatalog()` (section 8) joins each fast model to its
   `/model/info` entry (by normalized model name, falling back to the litellm
   model's tail). `toEntry()` builds one catalog row:
   * provider = `<PROVIDER_PREFIX>-<upstream>` (upstream from the gateway's display
     provider, then `litellm_provider`, then the litellm prefix; spellings folded
     through `PROVIDER_ALIASES`, e.g. `AWS Bedrock` and `bedrock` -> `acc-bedrock`);
   * limits: `max_input_tokens` and `max_output_tokens` (falling back to
     `max_tokens`, then 200 000 / 32 000 defaults), each passed through
     `floorToKiB`;
   * costs per 1M tokens (input, output, cache read/write, and the optional
     `_above_<N>k_tokens` context tiers);
   * capabilities: tools, vision, pdf, audio, video;
   * reasoning effort levels as model variants (`supports_reasoning`,
     `supports_<level>_reasoning_effort`, Bedrock effort ceiling);
   * responses-only models use the OpenAI responses package.
   * Gateway ids that point at the same deployment with the same name and prices
     are de-duplicated: one canonical id is registered, the others are kept as
     `aliases`. Models with `mode` `evaluation` or `embedding` are skipped.
5. **Token limit rounding.** Limits are rounded **down to a multiple of 1024**
   (`floorToKiB`, around line 136). Provider metadata is sometimes slightly
   above the real limit, for example `131100` where the real limit is `131072`.
   Sending the larger value makes the upstream reject the request with
   `max_tokens (131100) cannot exceed 131072`.
6. **Injection into OpenCode.** `toProviders()` groups the catalog into provider
   records (openai-compatible package, `baseURL` = `{base}/aiendpoint/v1`) and
   `ctx.provider.transform` registers them. After a slow refresh,
   `ctx.provider.reload()` re-applies the transform, so `/models` updates live
   without a restart.
7. **Persistence.** The catalog is stored with `ctx.storage.set("gateway.models.v5",
   { fingerprint, fetchedAt, catalog })`. The API key is not stored there.
8. **Reports.** After every refresh (and every cache-hit check),
   `writeCatalogReport()` writes `models.json` and `models.csv` to the cost
   directory (see "Output files").
9. **Usage tracking.** `trackUsage()` listens for finished model steps and
   appends them to `usage.jsonl`, aggregating into `usage-summary.json` and
   `usage-data.js`, and mirrors the log to `usage-log.js` for the dashboard
   (section 12). Disable with `GATEWAY_USAGE_DISABLED=1`. Other tools may
   append lines in the same format (the Neovim config logs its inline
   predictions with `agent: "nvim"`): the cost folder is watched and new
   lines are aggregated within seconds, deduplicated by `event_id`.
10. **Health and notifications.** Every failure becomes an issue (section 13):
   logged to `gateway-models.log`, written to `status.json`, and shown as an
   OpenCode toast by `tui.ts` (see "Notifications").
11. **`/usage-dashboard` command.** Rewrites the data files, copies
   `dashboard.html` next to them and opens it in the default browser (`open` on macOS, `explorer.exe` on
   Windows, `xdg-open` on Linux).

## Install

Install from the repo, not by hand. From the `tryout_lab` checkout:

```sh
mac-setup/setup.sh --only gateway
```

The step does four things:

1. Copies this folder to `~/.config/opencode/plugins/ai-gateway/`. OpenCode loads
   every folder in its plugins directory automatically, so `opencode.json` needs
   no entry for it.
2. Writes `~/.config/ai-gateway/env` with `GATEWAY_BASE_URL` (see "Configuration").
3. Stores the API key in `~/.keys/ai-gateway.key` (`chmod 600`).
4. Runs `check_gateway.py` to test the gateway URL and the key.

Then restart OpenCode. Check with `opencode api get /api/plugin`
(`gateway-models` should be `active`), then type `/usage-dashboard`.

Nothing is built: OpenCode runs `index.ts` directly. It works on macOS, Linux and
Windows (OpenCode uses `~/.config/opencode` on every OS).

Plugin IDs must be unique. The plugin ID is `gateway-models`, so a second copy in
the plugins directory (for example an older folder with another name) fails with
`Duplicate plugin ID: gateway-models` and never runs. Remove any such copy first.

**Updating.** Run the same command again. It replaces the copy in the plugins
folder. The usage history is not in the plugin folder (see "Output files"), so it
is kept.

`index.ts` imports only **types** from `@opencode/plugin` (`import type`, erased
at load time), because OpenCode cannot resolve that package from local plugin
files (anomalyco/opencode #49608 and #50434). Keep it that way: a value import
brings the build step back.

## Notifications

The server half of a plugin cannot show toasts, and its console output does not
reach `opencode.log`. So `index.ts` writes every problem to `status.json` in the
cost directory, and `tui.ts` (loaded automatically as the plugin's TUI half)
watches that file:

* A toast appears when a problem appears or changes (errors stay 15 s, warnings
  8 s), and a "Working again" toast when the last error is gone.
* **`/gateway-status`** (also in the command palette) shows the gateway, the key
  source, the number of models, the last successful refresh, the next retry and
  all open problems.
* **`/gateway-refresh`** re-reads the key and reloads the model list now instead
  of waiting for the next retry.

| Problem | Level | What happens |
| --- | --- | --- |
| No API key (file missing, empty or unreadable) | error | No requests are sent; picked up as soon as the file is fixed. If a key was loaded earlier, it is kept (warning). |
| API key rejected (HTTP 401/403) | error | Message includes the gateway's reason; cached models stay registered. |
| Gateway unreachable / timeout | error, warning with cached models | Check network / VPN; retried with backoff. |
| Gateway error (other HTTP status), non-JSON or empty answer | error, warning with cached models | Catalog is not replaced by an empty one. |
| Model details unavailable (`/model/info`) | warning | Models stay listed (without prices if none were cached). |
| Integration not connected | warning | Models still work; `/models` may not group by provider. |
| Not configured (`GATEWAY_BASE_URL` empty or missing) | error | Nothing is registered. Run `mac-setup/setup.sh --only gateway` or fix the env file (see "Configuration"). |
| Model cache, catalog report, usage log/summary, dashboard, browser, event stream | warning | Write/read failures in the cost directory or OpenCode storage. |

The TUI ignores a `status.json` whose writer process is gone. When the TUI
connects to a server on another machine (`--server`), it cannot see that
server's status file, so no toasts appear.

## Configuration

Each setting is looked up in this order:

1. the process environment (`export GATEWAY_BASE_URL=...`),
2. the env file, `~/.config/ai-gateway/env` (or the file named by `GATEWAY_ENV_FILE`),
3. the default in the table.

The env file is there because OpenCode started from the Dock or Spotlight never
sources `~/.zshrc`. It is a plain shell file. Lines look like `NAME=value` or
`export NAME=value`. Blank lines and `#` comments are ignored, single or double
quotes around a value are removed, and a leading `~` in a path is expanded:

```sh
# ~/.config/ai-gateway/env
export GATEWAY_BASE_URL="https://gateway.example.com"
```

`GATEWAY_BASE_URL` is **required** and has no default. Without it the plugin
registers nothing and shows a "Not configured" toast, and `check_gateway.py` exits
with an error. A trailing slash is removed.

These variables use the lookup above. `index.ts`, `tui.ts`, `claude_usage.py` and
`check_gateway.py` all read the same env file:

| Env var | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_BASE_URL` | **none, required** | Gateway base URL, for example `https://gateway.example.com` |
| `GATEWAY_API_KEY_FILE` | `{file:~/.keys/ai-gateway.key}` | Key source: `{file:path}`, a plain path, or `""` for no auth |
| `GATEWAY_INTEGRATION_ID` | `ai-gateway` | ID of the integration all providers belong to |
| `GATEWAY_COST_DIR` | `~/.gateway-cost` | Where catalog and usage files are written, for every tool that logs there. Never inside the plugins folder (see "Output files"). |
| `GATEWAY_ENV_FILE` | `~/.config/ai-gateway/env` | Path of the env file. Read from the process environment only. |

These are read from the process environment only:

| Env var | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_API_KEY` | (unset) | API key as a literal; takes precedence over the key file |
| `GATEWAY_AUTH_HEADER` | `authorization` | `authorization` (sends `Bearer <key>`) or `x-api-key` |
| `GATEWAY_PROVIDER_PREFIX` | `acc` | Prefix for provider ids (`acc-bedrock/...`) |
| `GATEWAY_CONNECT_INTEGRATION` | on | Set to `0` to skip connecting the integration |
| `GATEWAY_COST_DISABLED` | off | `1` stops writing `models.json` / `models.csv` |
| `GATEWAY_USAGE_DISABLED` | off | `1` stops usage tracking |
| `GATEWAY_RETRY_MS` | `60000` | First retry delay while something is broken (doubles per failed network attempt, max 5 min) |

Other tuning constants (edit in `index.ts`):

* `FAST_POLL_MS` (12 h): how often the fast list is re-checked.
* `INFO_STALE_MS` (24 h): how old the cache may be before `/model/info` is
  re-fetched even if the model set did not change.
* `SKIP_MODES` (`evaluation`, `embedding`).
* `CACHE_KEY` (`gateway.models.v5`): bumping this forces a rebuild (see below).

## When the model config updates

The catalog is rebuilt from the gateway only when:

* the fast `/models` fingerprint (ids, modes, token limits) differs from the
  cached one, or
* the cached entry is missing, or
* the cached entry's `fetchedAt` is more than 24 h old.

Otherwise the cached catalog is used, even after a plugin reload or a restart.
The fingerprint does not include the rounding logic, so a code change like the
1024 rounding is **not** applied to a cache that is still fresh.

Restarting OpenCode alone does not refresh the catalog while the cache is
fresh. The background refresh runs at startup and every 12 h, but it returns
early without touching the cache.

## Forcing a manual refresh

Pick one:

1. **Bump the cache key (recommended, permanent).** In `index.ts`, change
   `const CACHE_KEY = "gateway.models.v5"` to `"gateway.models.v6"` and restart
   OpenCode. The next startup rebuilds the catalog from
   the gateway with the current code.
2. **Delete the cached entry (one-off).** Quit OpenCode first, then back up and
   remove the row from its database (`opencode debug paths` shows where it is;
   on macOS/Linux it is `~/.local/share/opencode`):

   ```sh
   cp ~/.local/share/opencode/opencode.db ~/opencode.db.bak
   sqlite3 ~/.local/share/opencode/opencode.db \
     "DELETE FROM kv WHERE key LIKE '%gateway.models.v5';"
   ```

   Start OpenCode again. Until the background refresh finishes, models are
   registered from the fast list only (no costs yet).
3. **Wait.** The cache becomes older than 24 h and is rebuilt on the next refresh
   (startup or the 12 h poll).

Check the result:

```sh
opencode api get /api/model     # limit.output for the model
grep -n '"max_output_tokens"' ~/.gateway-cost/models.json | head
```

## Output files

Written to `~/.gateway-cost/` (Windows: `%USERPROFILE%\.gateway-cost\`), or
`GATEWAY_COST_DIR`. Versions before 2026-10-19 used
`~/.config/opencode/gateway-costs/`; the first start of this version moves that
folder (if both exist, `usage.jsonl` is merged by `event_id`), unless
`GATEWAY_COST_DIR` is set (in the environment or the env file).

This is deliberately **not** inside the plugin folder: OpenCode watches
`~/.config/opencode/plugins/` and reloads its whole configuration on any file
write there (measured on 2.0.27: two reloads per write, which would mean every
model step). Writes to `~/.gateway-cost/` trigger nothing. It also means
reinstalling the plugin never touches the history.

| File | Content |
| --- | --- |
| `models.json` / `models.csv` | Catalog snapshot: one row per registered model (limits, prices per 1M tokens, capabilities, aliases). Rewritten on every refresh and on every cache-hit check. |
| `usage.jsonl` | Append-only log, one JSON line per model call from every tool (OpenCode, Neovim, Claude Code). Source of truth for usage. |
| `usage-summary.json` | Aggregates rebuilt from the log: `totals`, `providers`, `tools`, `billing`, `agents` (per tool), `models` (by cost), `daily`. |
| `usage-data.js` | Same summary as `window.GATEWAY_USAGE = {...}`, so a `file://` page can load it with a script tag. |
| `usage-log.js` | The raw `usage.jsonl` as `window.GATEWAY_USAGE_LOG = "..."`, read by the dashboard. |
| `dashboard.html` | Copy of the plugin's dashboard, refreshed at startup and by `/usage-dashboard`. |
| `status.json` | Current health: key source, model count, last success, next retry, open problems. Read by `tui.ts`. |
| `gateway-models.log` | Plugin log: every problem and when it was resolved (rotated to `.log.1` at 512 KB). |
| `config.js` | Dashboard settings (`monthlyLimitUSD`). Created once, never overwritten: edit it. |
| `claude-code-state.json` | `claude_usage.py`'s read positions per transcript, calls not finished yet, and the request ids already logged. Delete it to re-import (nothing is logged twice). |
| `claude-usage.log` | Errors of `claude_usage.py` when it runs as a hook (it never prints there). |

## Usage dashboard

Type **`/usage-dashboard`** in OpenCode, or open `~/.gateway-cost/dashboard.html`
directly (reload the page for new data). It is a single static file with no
dependencies and works offline. It loads `usage-log.js` and `config.js` next to
itself, or from `../../../../.gateway-cost/` (the default folder seen from
`plugins/ai-gateway/`). With a custom
`GATEWAY_COST_DIR` or plugin location, use `/usage-dashboard`, or pick a
`usage.jsonl` with the button (or drag and drop).

* **Filters** (one row, scope every view): date presets and custom range,
  tool, billing, provider, model, agent, session. Each dropdown lists only values that exist
  under the other filters. Clicking a bar or a table row filters to it; clicking
  again clears it.
* **Measure**: cost, tokens or steps. Free models show $0, so switch to tokens
  to see where the volume goes.
* **Views**: KPI tiles (cost with its split by billing, this month against
  `monthlyLimitUSD` with a month-end projection, steps, sessions, tokens, cache
  hit rate, effective price per 1M tokens); spend over time stacked by model
  (hourly for ranges of 2 days or less, weekly above 150 days); cost by model,
  provider, tool and agent (agents are per tool: `claude-code · Explore`,
  `opencode · build`, `nvim · prediction`); what the
  money pays for (cost split into input, output, reasoning, cache read, cache
  write, overall and per model); a weekday by hour heatmap; top sessions; a
  sortable model table; the raw step log (latest 300). **Export CSV** downloads
  the filtered steps.
* Model colors are fixed by total cost over all data, so a model keeps its color
  when filters change. Models past the 8th fold into "Other models". Tools have
  fixed colors (OpenCode blue, Claude Code orange, Neovim green, Claude Desktop yellow).
* **This month** counts the calendar month so far under the tool, billing,
  provider, model, agent and session filters (not the date range), so
  `Billing = Gateway` shows the gateway spend alone and `All` everything.

A `usage.jsonl` line looks like:

```json
{"ts":"2026-10-06T03:53:54.474Z","provider_id":"acc-example","model_id":"deepseek-v4-flash-0731-gmi-ray",
 "input_tokens":9938,"output_tokens":3,"reasoning_tokens":22,"cache_read_tokens":256,"cache_write_tokens":0,
 "input_per_1M":0,"output_per_1M":0,"cache_read_per_1M":0,"cache_write_per_1M":0,"cost":0,"reported_cost":0}
```

Fields that say where a line comes from:

| Field | Values |
| --- | --- |
| `tool` | `opencode`, `nvim`, `claude-code`, `claude-desktop` (Claude Code started from the desktop app). Missing in lines from before 2026-10-19: agent `nvim` means Neovim, anything else OpenCode. |
| `billing` | `gateway` (billed per token through the gateway), `subscription` (Claude seat: `cost` is the API equivalent, not an invoice), `other` (an OpenCode provider outside the gateway). |
| `agent` | OpenCode: `build`, `plan`, ... · Claude Code: `main` or the subagent type (`general-purpose`, `Explore`, ...) · Neovim: `prediction`. |

Any tool can join: append lines with a unique `event_id`, the token fields and
the per-1M prices (so the dashboard can split the cost), and write
`usage-log.js` afterwards or let the plugin do it (it watches the folder).

Cost is computed from the gateway price list at the time of each step; prices
are snapshotted into each line. Above 200k prompt tokens, the `_above_200k`
prices are used when the gateway provides them. Reasoning tokens are billed at
the output price. `reported_cost` is OpenCode's own figure, kept as a
cross-check.

## Claude Code usage: `claude_usage.py`

Claude Code does not go through the gateway, so it cannot be seen there. Its
transcripts (`~/.claude/projects/**/*.jsonl`, subagents included) record every
API call with its exact token usage; `claude_usage.py` (stdlib Python) turns
new calls into `usage.jsonl` lines with `tool: claude-code`, `billing:
subscription`, `agent: main` or the subagent type.

```sh
python3 claude_usage.py            # import what is new (first run: all history)
python3 claude_usage.py --dry-run  # print the lines, write nothing
python3 claude_usage.py --flush    # also log the last call of transcripts still open
```

Run it from Claude Code hooks so it stays current. In `~/.claude/settings.json`,
for each of `Stop`, `SubagentStop` and `SessionEnd`:

```json
{ "hooks": [{ "type": "command", "timeout": 30,
  "command": "[ -f \"$HOME/.config/opencode/plugins/ai-gateway/claude_usage.py\" ] && python3 -I \"$HOME/.config/opencode/plugins/ai-gateway/claude_usage.py\"; true" }] }
```

(`mac-setup/claude-code/install.sh` in tryout_lab does this.) As a hook it is
silent, takes ~0.2 s, and always exits 0; errors go to `claude-usage.log`.

How it counts:
* One line per API call, deduplicated by request id across all transcripts
  (resumed and forked sessions copy history into new files). A call is logged
  once it is finished: another line follows it, its transcript is idle for 2
  minutes, or its session ended. Token counts are the largest seen for the call
  (the transcript repeats a call per content block while it streams).
* Cost is the **API equivalent**: tokens × the gateway catalog's direct-Anthropic
  prices (`claude-opus-5-5` → `claude-5.5-opus-anthropic`), with 5 min cache
  writes at the catalog's cache-write price, 1 h cache writes at 2× the input
  price, thinking tokens at the output price. On a Claude seat this is what the
  usage would cost at API rates (useful against an extra-usage limit), not an
  invoice.
* Not in the transcripts, so not counted: Claude Code's small background calls
  (session titles, command classification), and the price premium of fast mode.

## Helper script: `check_gateway.py`

A stdlib-only script that runs the same discovery, fingerprint, grouping and
cost logic outside OpenCode, to verify the gateway, the key and the mapping:

```sh
python3 check_gateway.py            # fast /models + slow /model/info (about 1 min)
python3 check_gateway.py --fast     # fast /models only (no costs)
python3 check_gateway.py --info     # slow /model/info only
python3 check_gateway.py --out DIR  # write models.json / models.csv to DIR
python3 check_gateway.py --no-write # print only
```

It prints the base URL, key file, model counts, the fingerprint and the number
of computed rows, then writes `models.json` and `models.csv`. Its default output
directory is `~/.gateway-cost`, the folder the plugin uses (`GATEWAY_COST_DIR`
overrides it; `--out DIR` overrides both). Without `GATEWAY_BASE_URL` it exits
with an error.

**Note:** `check_gateway.py` does **not** apply the 1024 rounding, so its
`models.json` can still show values such as `131100`. The plugin does round.
Use it to inspect the gateway's raw metadata, not as the limits the plugin
registers.

## Troubleshooting

**`max_tokens (131100) cannot exceed 131072`** (HTTP 400 from the upstream).
OpenCode sends the registered `limit.output` as `max_tokens`. The registered
value is still the old, un-rounded one from the cache. Fix it by forcing a
refresh (see "Forcing a manual refresh"). Check first:

```sh
grep -n 'max_tokens (' ~/.local/share/opencode/log/opencode.log | tail -3
grep -n '"max_output_tokens"' ~/.gateway-cost/models.json | grep 131100
```

If `models.json` still contains `131100` after a restart, the cache was used.
Confirm that the installed `index.ts` contains `floorToKiB`
(`grep -c floorToKiB ~/.config/opencode/plugins/ai-gateway/index.ts`).

**First stop: `/gateway-status`** or `~/.gateway-cost/gateway-models.log`.
Both show what failed and when.

**Models missing, or no provider grouping in `/models`.** Check the plugin with
`opencode api get /api/plugin` (`gateway-models` should be `active`) and make
sure the key file exists (`GATEWAY_API_KEY_FILE`). Run `check_gateway.py --fast`
to test the endpoint and the key directly.

**"Not configured" toast.** `GATEWAY_BASE_URL` is empty in the environment and in
the env file. Run `mac-setup/setup.sh --only gateway`, or add the line to
`~/.config/ai-gateway/env`. Restart OpenCode afterwards, because the plugin reads
its settings at startup.

**"No API key" toast.** The key path in `GATEWAY_API_KEY_FILE` or the default
`~/.keys/ai-gateway.key` is missing, empty or unreadable. Create
or fix the file; no restart is needed. If the key lives in a synced folder
(OneDrive and similar), make sure the file is kept on the device: cloud-only
files can look missing at startup.

**Fast list fails at startup.** The plugin keeps the cached catalog and retries
after 60 s (then with backoff). Without a cache, no models are registered until
the gateway is reachable; `/gateway-refresh` retries at once.

## Tuning and limits

* Cost and usage files are only written when `GATEWAY_COST_DISABLED` / `GATEWAY_USAGE_DISABLED` are not `1`.
* The API key is never written to the plugin cache or the report files.
* `FAST_POLL_MS`, `INFO_STALE_MS` and `SKIP_MODES` are the main tuning constants.
