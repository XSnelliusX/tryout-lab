# Prompt Rewrite for OpenCode

An OpenCode plugin that turns rough prompts into high-signal, context-aware instructions—complete with a pre-rewrite **"Grill Me"** clarifying interview, substantive prompt restructuring, a tailored **model + reasoning-effort recommendation**, **live progress & elapsed timer**, **background/multi-window execution**, and an interactive **Review, Edit & Refine Studio** styled with OpenCode's native theme tokens.

---

## Features

- **Works before or during a session**:
  - **Start screen**: draft or `/rw <prompt>` before creating a session; nothing creates a session until you explicitly confirm submission.
  - **Active session**: pulls recent user/assistant conversation prose as context while excluding system prompts, hidden reasoning, and raw tool outputs.
- **Interactive "Grill Me" interview (default in `/rw`)**:
  - Analyzes your draft + conversation for blind spots, missing constraints, edge cases, and verification gaps.
  - Presents concise diagnosis + missing angles + up to 4 targeted questions with clickable **`[1]`–`[5]`** options and **`[E]`** custom answers (or **`[S]` Skip & Rewrite**, or `/rw-direct` / `--fast` when you already know every detail).
- **Real prompt engineering + inline Review Studio**:
  - Produces a structured, ready-to-send prompt plus a concrete summary of what improved.
  - **Workspace tabs**: preview (`Improved Prompt`), inline multi-line edit (`[E]` / `Ctrl+S`), and `Compare Original` (`[C]`).
  - **Iterative refinement**: one-click chips (`Shorter`, `More Detail`, `Focus Tests`, `Re-grill [G]`, `Custom Tweak… [F]`).
- **Model & reasoning effort advisor**:
  - Evaluates available enabled chat models (including OpenRouter/custom provider IDs, effort variants, context limits, reasoning/toolcall capabilities) and optionally suggests a runner-up alternative.
  - Never switches your model silently: switching requires your opt-in toggle (`[R]`) plus an inline confirmation step (`Switch session model to … and submit? [↵]` / `Back [N]`), or choose any available model via the inline filterable **Model Picker** (`[M]` / `Ctrl+M`).
- **Live model state, elapsed timer & background window switching**:
  - Streams server-side phase updates (`context` -> `grilling` -> `rewriting` / `refining` -> `questions` / `ready`) over OpenCode RPC events.
  - Shows a live spinner, active model, and elapsed time both inside the modal and in OpenCode's `prompt.footer.status` / `home.footer.status` footer pill.
  - Press **`Esc`** or **`[B]`** (or switch sessions/windows directly) to move work to the background—each session and start-screen directory runs and retains its own independent state.

---

## Commands & Flags

| Command | Behavior |
|---|---|
| `/rw [flags] [prompt]` or `/rewrite [flags] [prompt]` | Opens Rewrite Studio or runs the **Grill Me -> Rewrite -> Review** pipeline on `[prompt]`. |
| `/rw-direct [flags] [prompt]` or `/rwd [flags] [prompt]` | Skips Grill Me and goes straight to **Rewrite -> Review** (same as `/rw --fast ...`). |
| `/rw-last` | Reopens the active/latest Rewrite Studio window (draft, running job, clarifying questions, or ready proposal). |
| `/rw-cancel` | Cancels an in-flight rewrite/grill job in the current window (or another running window). |

Supported flags (place before prompt text):

- `--model <provider/model[#variant]>` / `-m <provider/model[#variant]>` — override which model performs the grilling & rewriting for this request.
- `--fast` / `--direct` / `--no-grill` — skip the Grill Me interview and rewrite directly.
- `--grill` — force the Grill Me step (default).
- `--help` / `-h` — show quick usage toast.

---

## Keyboard Shortcuts Inside the Modal

- **Draft**: `Ctrl+S` continue · `Ctrl+G` toggle Grill Me / Direct · `Ctrl+M` pick rewrite model · `Esc` close.
- **Running**: `B` / `Esc` continue in background · `C` cancel request.
- **Grill Me**: `↑`/`↓` move between questions · `1`–`5` toggle option · `E` edit custom note (`Ctrl+S` save / `Ctrl+D` done) · `↵` or `Ctrl+S` generate improved prompt · `S` skip & rewrite · `Esc` minimize to background.
- **Review & Refine**:
  - `↵` submit (`Confirm & Send [↵]` / `Back [N]` when a model switch is enabled)
  - `E` inline edit (`Ctrl+S` done) · `F` custom refinement instruction (`Ctrl+S` apply / `Ctrl+D` cancel) · `C` compare with original
  - `R` toggle model switch · `M` open inline model picker · `G` re-grill · `O` send original unchanged · `I` insert into prompt composer (when supported by host) · `Esc` close to background.

---

## Installation & Configuration

Install or update the local OpenCode plugin (`~/.local/share/opencode/prompt-rewrite` + loader shims in `~/.config/opencode/plugins/prompt-rewrite`):

```sh
node scripts/install.mjs
```

Or add this directory as an OpenCode plugin in your OpenCode config (or symlink/point your OpenCode plugin config to it). `package.json` declares dual server/TUI entrypoints:

- `.` -> `./index.js` (server plugin)
- `./tui` -> `./tui.tsx` (TUI plugin)
- `./rpc` -> `./rpc.js` (shared RPC schema + live `progress` event contract)

Optional server plugin option:

- `model`: `"provider/model[#variant]"` — default model used by the rewriter when not overridden via `--model` or the Draft model picker. When unset, uses the current session/default working model (there is no built-in fallback model).
- `preferredProviders`: list (or comma-separated string) of provider ids, e.g. `["provider-a", "provider-b"]`. When the same model is available from several providers at equal price, the recommendation list prefers the session's provider, then these (in order), then the provider that matches the model's creator. Default: none.

No `npm install` or build step is required; OpenCode loads the zero-dependency ESM modules and `tui.tsx` directly (`solid-js`, `@opentui/solid`, and `@opencode/plugin/rpc` are provided by OpenCode at runtime).

---

## Gateway catalog & benchmark data

The plugin ships **no** gateway values and **no** benchmark data. At runtime it reads two files that the sibling [`ai-gateway`](../ai-gateway/README.md) module maintains on your machine:

| What | Provided by | File |
|---|---|---|
| Model catalog: provider ids, prices (incl. cache and context tiers), token limits, capabilities, effort levels | the **ai-gateway OpenCode plugin** (refreshes it automatically) | `$GATEWAY_COST_DIR/models.json` |
| Benchmark scores: intelligence index, capability indices, speed/TTFT, cost per task per gateway route and effort | the ai-gateway **`/model-comparison`** command (OpenCode or Claude Code) | `$GATEWAY_COST_DIR/model-comparison/data/models.json` |
| The recommendation engine's picks per task tier, and its workload score definitions | the same command (its recommendation engine) | `$GATEWAY_COST_DIR/model-comparison/data/recommendations.json` |

**How the model advice works.** The rewrite model first classifies the task
(quick, standard, complex, deep reasoning). For each of these tiers the
comparison's recommendation engine (the same one Herdr's `cc-models` and the
comparison dashboard use) has picked a route and effort: the cheapest model whose
agentic-coding score (60% Terminal-Bench 4.0 + 40% Intelligence Index) is good
enough for that tier, at the route's cost per task. Those picks are passed as
`routing.benchmark_picks`, are always among the offered routes, and are the
default answer; the rewrite model deviates only for a reason it names (context
size, vision, the current model already fits, non-coding work). Each route also
carries `codingScore`, `agenticScore`, `costPerTaskUSD` and a `balanceScore`
computed per task, so a high effort is not mistaken for a bargain because its
token price is the same. Without `recommendations.json` (an older comparison),
the plugin falls back to its own price tiers.

`GATEWAY_COST_DIR` defaults to `~/.gateway-cost`. It, `GATEWAY_PROVIDER_PREFIX` and `GATEWAY_USAGE_DISABLED` can be set in the environment or in the ai-gateway env file (`GATEWAY_ENV_FILE`, default `~/.config/ai-gateway/env`); see `.env.example`. The plugin joins both files at runtime (cached by file mtimes), so refreshing either one is picked up without reinstalling. A provider counts as part of the gateway when the catalog lists it (or it starts with `$GATEWAY_PROVIDER_PREFIX-`, if set).

**Requirements:** the ai-gateway plugin installed (`../ai-gateway/install.sh --only plugin`) for prices/limits/capabilities, and a run of `/model-comparison` (`--only compare` installs it) for benchmark scores.

**Without them:**
- No comparison file: the plugin still works with catalog prices, limits and capabilities but no scores. Review Studio shows the warning "No benchmark scores: run /model-comparison for benchmark scores."
- No catalog either: model recommendations rely only on what OpenCode reports (prices from the live model list, no scores); gateway usage is billed as "other".

The scores originate from [Artificial Analysis](https://artificialanalysis.ai), fetched on demand by the ai-gateway module under their terms; nothing is copied into this repository. To use a prebuilt db instead, set `PROMPT_REWRITE_BENCHMARKS_FILE` to a JSON file with the same shape the plugin builds (`models`, `aliases`).

---

## Repository Structure

| File | Responsibility |
|---|---|
| `index.js` | Server plugin entry: registers RPC methods (`grill`, `rewrite`, `cancel`, `submit`, `jobs`, `models`) and streams live `progress` events. |
| `rpc.js` | Typed OpenCode RPC method schemas and `events.progress` contract. |
| `core.js` | Prompt engineering templates (`GRILL_SYSTEM`, `REWRITE_SYSTEM`), CLI flag parsing, provider-balanced candidate routing (`maxCandidates = 40`), safe context filtering, robust JSON extraction, and response validation. |
| `gateway.js` | Reads the ai-gateway data contract: env/env-file settings, catalog loading, and data-driven gateway-provider membership. |
| `benchmarks.js` | Pure `buildBenchmarkDb` (catalog + model-comparison snapshot + recommendations -> lookup db), mtime-cached `loadBenchmarks`, lookups, value metrics, the engine's picks per task tier (`engineTierPicks`) and candidate-route selection. |
| `usage.js` | Token/cost accounting from the catalog and live model prices; writes the gateway usage log. |
| `service.js` | Stateful server runtime: per-window concurrency, abort/timeout handling, TTL caches, live progress events, session model-switch guards, and single-use prompt submission. |
| `store.js` | TUI client store: per-window state across session switches, Grill Me answer tracking, server job rehydration, elapsed timer formatting, and footer status summaries. |
| `theme.js` | Defensive resolver for OpenCode V2 nested semantic theme tokens (plus legacy flat fallback tokens and `"none"` background handling). |
| `tui.tsx` | OpenTUI/SolidJS Rewrite Studio modal, clickable buttons/chips, inline editor & diff/compare view, inline model picker, slash commands, and persistent footer status slots. |
| `scripts/install.mjs` | Mirrors the repo into OpenCode's share dir (removing files deleted here), writes loader shims, runs tests there. |
| `test/*.test.js`, `test/fixtures.js` | Unit tests for `core.js`, `service.js`, `store.js`, `theme.js`, `usage.js`, `benchmarks.js`, using small synthetic gateway fixtures. |

---

## Verification

Run the unit test suite (Node 20+ built-in test runner):

```sh
node --test test/*.test.js
```

Note: The automated tests validate pure logic, service state/concurrency/safety guards, store transitions, and theme token resolution using mocked OpenCode server contexts and synthetic gateway data (they never read your real `~/.gateway-cost`); live SolidJS/OpenTUI rendering and actual LLM provider calls require testing inside OpenCode itself.
