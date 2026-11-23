# Model comparison

An interactive dashboard that compares the models on your AI Gateway by
cost-to-performance, using [Artificial Analysis](https://artificialanalysis.ai/)
(AA) benchmark data. It is a sub-module of the ai-gateway OpenCode plugin.

- Reads the gateway catalog the plugin already writes
  (`$GATEWAY_COST_DIR/models.json`). It never calls the gateway itself.
- Fetches public AA pages (no API key), matches every catalog model to an AA
  release, and keeps **all** reasoning-effort variants.
- Opens a local dashboard immediately, showing the last snapshot while it
  refreshes the gateway and then AA. A **Sync** button repeats both steps.
- Runs a temporary server bound to `127.0.0.1` so the page can initiate syncs;
  it exits after 30 minutes without page activity and no sync in progress.

Data: Artificial Analysis. Model availability and prices: your gateway catalog.
See [Attribution and terms](#attribution-and-terms).

## Requirements

| Where | What |
| --- | --- |
| Using the dashboard | Node.js 22 or newer. No npm packages and no Go at runtime. |
| Building (install time) | Go (see `go.mod`; standard library only) and Node.js 22+ with npm. |
| Input | A gateway catalog: run `/gateway-refresh` once so `~/.gateway-cost/models.json` exists. |

## Install

The ai-gateway installer builds and installs this module for you; see
[`../README.md`](../README.md). Under the hood it runs:

```sh
make -C ai-workflow/ai-gateway/model-comparison install DEST=<install dir>
```

which builds the Go joiner and the web app, then copies only the runtime files
to `DEST`:

```text
server.mjs   compare.mjs   parse_aa.mjs   aasync   web/
```

The command is idempotent. `make install DEST=<dir> DRY_RUN=1` prints what it
would do without changing anything.

## Use

Use `/model-comparison` in OpenCode or Claude Code, or run:

```sh
node ~/.config/opencode/plugins/ai-gateway/index.ts compare
```

The page opens before network work completes. Its sync indicator spins through
the gateway refresh and a forced AA refresh; a failed refresh leaves the last
snapshot in place and displays the error. AA can fall back to cached data if
unreachable; the dashboard reports this. Reopen the command if the local
server has shut down.

For a standalone, one-shot snapshot build (without gateway refresh):

```sh
node compare.mjs [--refresh] [--offline] [--no-open] [--quiet]
```

| Flag | Effect |
| --- | --- |
| `--refresh` | Ignore the 24h AA cache and fetch again. |
| `--offline` | Never touch the network; use the cached AA data. |
| `--no-open` | Build only; do not open the dashboard. |
| `--quiet` | Suppress progress messages (the 1-3 line summary is still printed). |
| `--verbose` | Show the AA fetcher's detailed log. |

It exits `0` on success and `1` with a clear message on failure, for example
`No gateway catalog yet: run /gateway-refresh first`. If the AA fetch fails but
a stale cache exists, the stale data is used and the summary says so.

### The `/model-comparison` command

In OpenCode and Claude Code, `/model-comparison` starts the local server and
opens the page. The server performs a gateway refresh followed by an AA refresh
in the background. It requires Node 23.6+ to run the plugin's TypeScript
gateway refresh. The one-shot `compare.mjs` flags above apply only to that CLI.

## Data sources and cache locations

| What | Where |
| --- | --- |
| Gateway catalog (input) | `$GATEWAY_COST_DIR/models.json`, default `~/.gateway-cost/models.json`. Written by the plugin's `/gateway-refresh`. |
| AA HTTP cache | `${XDG_CACHE_HOME:-~/.cache}/ai-gateway/model-comparison/aa` (24h freshness) |
| Intermediates (enriched JSON, CSVs, match report, run metadata) | `${XDG_CACHE_HOME:-~/.cache}/ai-gateway/model-comparison/out` |
| Dashboard (output) | `$GATEWAY_COST_DIR/model-comparison/` (`index.html`, `assets/`, `data/models.js`, and the same data as plain `data/models.json` for other tools, e.g. opencode-prompt-rewrite) |

The catalog's `base_url` is never copied into any output. The dashboard data
keeps only model ids, aliases, modes, token limits, prices and upstream names.

Nothing from AA or from a real catalog is stored in this repository. The
`.gitignore` excludes caches, generated data, `node_modules` and build output.

Optional environment: `GATEWAY_PROVIDER_PREFIX` (default `acc`) is a provider-id
prefix that is stripped when a provider name has to be read out of
`provider_id`. It is rarely needed.

### Local server and `file://` snapshots

Browsers block `fetch()` of local files and Chrome blocks `<script type="module">`
from `file://`. So the web build uses relative URLs (`base: "./"`), is one
classic (IIFE) script, and reads its data from `data/models.js`, a classic script
that sets `window.__MODEL_COMPARISON__`. Under `vite dev` there is no such file
and the app falls back to fetching `data/models.json`.

The interactive sync button requires the loopback server. It uses an
unguessable URL and validates the request origin; it does not listen on other
network interfaces. The one-shot file snapshot remains viewable without a
server, but cannot perform a sync.

## What the data contains

One dashboard row per AA variant of every matched catalog model:

- Intelligence Index and the six AA capability indices
- raw benchmark scores, normalized to 0-100 for display
- every effort variant, including deprecated releases
- model metadata: context window, modalities, open-weights flag, license
- AA provider-host rows: input/output price, cost per task, context, speed
- gateway ids, aliases, upstream ids, prices and the match evidence
- `gateway_routes`: every gateway deployment of the variant as an explicit
  `provider_id` + `model_id` pair with its own prices, cost per task, effort
  levels, tool support and serving speed. Use these: `gateway_ids` and
  `gateway_providers` are two independently sorted sets that do not line up
  (schema 3; older snapshots lack the routes)
- warnings such as `deprecated_release`, `effort_unavailable:max`,
  `provider_host_row_missing`, `aggregator_not_an_aa_host`

AA indices are already on a 0-100 scale. Raw benchmarks are fractions and are
multiplied by 100. A benchmark score is not a success probability, and metrics
must not be compared across tasks or index versions. A missing score means
unmeasured, not zero.

### Scores, prices and value

1. **Score.** The selected metric is used directly.
2. **Price.** The effective price prefers the gateway catalog price, then the
   matched AA provider-host price, then AA's list price; the UI labels which was
   used. When several catalog rows map to one AA variant, the cheapest 3:1
   blended gateway price is used.
3. **Cost per task.** AA's `cost_per_task` is the cost of one Intelligence Index
   task at AA prices. The dashboard re-prices the same token usage at the
   gateway's effective price when possible, and falls back to the AA host or
   model figure.

Value modes: **price focused** = score / cost; **quality focused** = score /
cost^s (adjustable price sensitivity `s`, default 0.10); **quality + speed** =
the quality index times `(tokens/s / 100)^0.2`. These exponents are preferences,
not measured laws. A gateway price of $0 ranks as free rather than receiving an
invented ratio; missing prices are excluded.

## Matching method

AA names and gateway model ids differ in predictable ways, so matching is
token-based rather than string-based (`parse_aa.mjs`):

1. Tokenize names into core tokens, parameter sizes (`120b`, `8x7b`, `a22b`),
   dates (`0731`, `2507`) and optional words (`preview`, `instruct`, `chat`,
   `latest`, `it`).
2. Drop cloud/provider/vendor tokens (`aws`, `azure`, `bedrock`, `vertex`,
   `openrouter`, `google`, ...) and parameter/date noise. Extra provider words
   are learned from the catalog's own `provider_name` / `upstream_provider`, and
   dropped from the gateway side only, so AA names are never altered.
3. Require the normalized core token multiset to match.
4. Reject parameter mismatches when both sides publish parameter sizes, and date
   mismatches when both publish dates.
5. Prefer non-deprecated releases, exact token order and matching parameters.
   A release without any score (an empty AA placeholder with the same display
   name, such as a codename entry) never beats a measured one.
6. If a generic gateway name matches several dated releases, use
   `upstream_model` to disambiguate. Aliases are a lower-priority fallback.

Examples of intended behavior: a name with a different word order still matches
(`vendor-4.6-pro-aws` to AA `vendor-pro-4-6`); a generic name resolves through
`upstream_model` to a dated release; a parameter-qualified name does not drift
to a sibling that has no parameters; an effort suffix the release does not offer
matches the release and records `effort_unavailable:<level>`.

**Primary variant.** With no explicit effort hint the parser picks the variant
matching an effort suffix in the name (`-high`, `-max`, `-reasoning`,
`-non-reasoning`, ...), then the exact variant name, then AA's chart default,
then a deterministic fallback. All variants stay available; the reason is
recorded in `aa.primary_selection_reason`.

**Provider to AA host.** Derived from catalog row fields, never from hardcoded
provider ids. `provider_name` decides first (it names the serving provider, for
example "AWS Bedrock"); only when it is absent are `upstream_provider`, the
provider part of `upstream_model`, and `provider_id` (minus
`GATEWAY_PROVIDER_PREFIX`) consulted. A generic table maps upstream names to AA
hosts (`anthropic`, `openai`, `azure`, `bedrock` to `amazon_bedrock`,
`vertex`/`google` to `google`, `databricks`, ...). Routers and aggregators such
as OpenRouter are not AA hosts: they get model-level scores and the
`aggregator_not_an_aa_host` warning. An unrecognised provider name gets
model-level scores and no host row rather than a guess.

Unmatched rows are listed in the dashboard footer and in
`<cache>/out/aa_match_report.md`. Typical unmatched models: image, audio,
router/auto and mock/test entries, and vendor-specific models AA does not cover.
AA marks many older releases as deprecated and reports `null` for their current
Intelligence Index; their raw benchmark scores are still shown.

## Layout and development

```text
compare.mjs          entry point: catalog -> AA -> joiner -> file:// dashboard
parse_aa.mjs         AA fetcher/decryptor and matcher (no dependencies)
cmd/aasync/          Go joiner CLI (stdlib only)
internal/catalog/    join logic, metrics, snapshot types
web/                 React + Vite dashboard (built to a classic script)
test/                synthetic fixtures, self-test data, end-to-end test
```

```sh
make test      # go vet + go test, parser self-test, Node e2e test, web tests (vitest)
make build     # bin/aasync and web/dist
make clean
```

All tests use small synthetic fixtures (made-up models and AA-shaped records);
no AA data and no real catalog are needed or stored. `node parse_aa.mjs
--self-test` runs the parser checks offline.

## Attribution and terms

Benchmark and pricing data comes from public pages of
[Artificial Analysis](https://artificialanalysis.ai/); the dashboard header and
footer credit it as the source. **Artificial Analysis' terms restrict scraping
and redistribution of their data.** Use this tool for personal analysis, keep
the fetched data and generated dashboard local, do not commit or publish them,
and review the
[AA Terms of Use](https://artificialanalysis.ai/docs/legal/Terms-of-Use.pdf)
before sharing anything derived from the data.

## Troubleshooting

AA changes its page payloads from time to time. If `compare.mjs` reports
"Artificial Analysis step failed", re-run with
`node compare.mjs --refresh --verbose` and check, in order:

1. **No encrypted manifest found.** Inspect the page HTML for a
   `"manifest":{"path":...,"key":...}` descriptor and update `extractManifests()`
   if the field names or escaping changed.
2. **Decryption fails.** Verify the key is still hex, the IV is still
   `SHA-256(key)[:12]`, and the payload is still AES-256-GCM plus gzip; update
   `decryptManifest()` if the envelope changed.
3. **Dataset classification changes.** `classifyDataset()` identifies datasets by
   shape (for example, compact leaderboard rows are keyed by `id`). If a dataset
   is reported as `unknown_*`, add a branch there.
4. **A page no longer holds the expected dataset.** Update the page list in
   `main()`. Any `/models/<slug>` page has carried the full model metadata; the
   evaluation, capability and provider pages supply the rest.
5. **Matching regresses.** Run `node parse_aa.mjs --self-test`, inspect
   `<cache>/out/aa_match_report.md`, and add an assertion with a synthetic model
   to `selfTest()` before changing the token rules.

Other cases:

- *No gateway catalog yet*: run `/gateway-refresh`.
- *No cached AA data yet* (`--offline` on a fresh machine): run once online.
- *AA unreachable*: a stale cache is used automatically and flagged in the
  summary; otherwise the step fails with the fetch error.
- To force a clean fetch, run with `--refresh`; to reset everything, delete
  `${XDG_CACHE_HOME:-~/.cache}/ai-gateway/model-comparison`.
