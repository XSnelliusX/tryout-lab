---
name: herdr-model-router
description: >-
  Cost- and token-efficiency model routing policy for choosing which model tier
  runs planning, coding, report drafting, meeting prep, and test verification in the Herdr +
  OpenCode Command Center, including the monthly budget guardrail.
---

# Command Center Model & Test Routing Policy

All role-to-model bindings live in `~/.config/command-center/models.json` (override: `$CC_CONFIG`) and are launched with `cc-agent <role>`. The concrete model ids are the user's choice; this policy only talks about **tiers**.

The monthly cap (`budget.monthly_cap_usd`) is tracked by `cc-budget` from the cost log (`budget.usage_file`, written by the optional ai-gateway plugin). Without a cost log or a cap, `cc-budget` reports `status: unknown` and **nothing is ever downgraded**.

> **Core cost principle:** total task cost depends on **output/reasoning verbosity and context cache behavior**, not just the per-token price. A cheap but verbose model can cost more per task than a mid-tier model that answers crisply. Keep short-lived sessions under your provider's cache/price-tier thresholds, and prefer reusing a warm worker over spawning a new one.

## Tiers

| Role (`cc-agent <role>`) | Tier | Reasoning | Use for |
|---|---:|---|---|
| *(plain shell)* `hc run` | 0 | none, no LLM cost | Running tests, linters, builds, `git diff`. **Always run tests in the shell first before spawning an LLM verifier.** |
| `explore` (OpenCode subagent) | 1 | cheapest, medium | Read-only file/symbol search, log scanning, repo mapping. |
| `writer` (`cc-writer` worker) | 1 | cheap, medium | Substantive reports, meeting prep, and other audience-facing drafts. |
| `commander` | 0/1 | cheap, low | Central dispatcher; short crisp answers, keeps its context small. |
| `verifier-fast` | 1 | cheap, low | Triaging unit/lint failures, checking schemas, summarizing logs. |
| `implementer` | 2 | mid, medium | Default coding agent for single-repo bugfixes and standard features. |
| `reviewer` (OpenCode subagent) | 2 | mid, high | Thorough read-only diff review before reporting done. |
| `implementer-pro` | 2 | strong, medium | Multi-file refactors, tricky concurrency/state bugs, API boundary work. |
| `architect` (`cc-architect`) | 3 | strong, high | Architectural specs, boundary contracts, hard root-cause diagnosis. |
| `architect` as planner (`cc-planner`) | 3 | strong, high | The plan in `TASK.md` before implementation: steps with a role each, verification, open questions. Every task beyond a small fix (see `herdr-commander`). |
| `verifier-deep` | 3 | strong, high | Security review, flaky integration tests, multi-service regression verification. |
| `escalation` | 3 | most capable, high | Last resort when the strong tier is stuck. Has `fallback_role` (`architect` by default): downgraded automatically once spend reaches `budget.auto_cap_tier3_pct`. |

Run `cc-agent <role> --dry-run` to see the exact model and variant a role resolves to. Roles are user-editable; the table describes the default role set.

## Keeping models current (`cc-models`)

The user chooses the models; `cc-models` helps. Its picks come from the model comparison's recommendation engine (the same one behind the comparison dashboard's "Models per role" panel): each role is scored on its own workload (coding roles on agentic coding, you on tool use, the architect on planning), at the gateway's cost per task.
- Which models are in use: `cc-models status` (model per role, its workload score, $ per task, superseded or not).
- When the user asks about new models: run `cc-models update --refresh`. It only proposes newer versions of the model lines already in use, at the same effort. Show its table, and apply **only after the user agrees**: `cc-models update --yes`.
- When the user asks for suggestions: `cc-models recommend --profile balanced` shows one table, the current models next to the lean, balanced and max picks (workload score, $ per task, a summary row), plus one line per role on why. Apply only the roles the user agrees to: `cc-models recommend --profile <p> --apply --role <a,b> --yes`.
- New workers use new models at once; you need `cc-commander --restart` for your own model (only when the user asks; it ends this conversation). Never edit `models.json` by hand for this.

## Writing delegation

For substantive reports, meeting prep, and other audience-facing drafts, launch `cc-writer` like any other worker (see `herdr-commander`). Brief it with the audience, purpose, format, tone, source facts/paths, and a draft path under `artifacts/`. It is a primary worker, not an OpenCode subagent: never invoke it as `@writer`. If the template is missing (`hc templates`), use `-- cc-agent writer --prompt "..."`.

## Decision Rules for Tests and Verification

1. **Always try Tier-0 (`hc run` shell, no LLM cost) first.** Only attach an LLM verifier if test setup/interpretation requires judgment or fixing failures.
2. **Tier-1 (`verifier-fast`)**: unit tests, typechecks, linters, straightforward test fixes, log triage.
3. **Tier-2 (`implementer`)**: writing new behavioral tests alongside feature code; fixing multi-file test regressions.
4. **Tier-3 (`verifier-deep`)**: cross-repo integration/end-to-end verification, security-sensitive paths (auth, encryption, permissions), or failures that resisted two Tier-1/2 attempts.
5. **Budget check**
   - Run `cc-budget --short` before launching Tier-3 agents. Output looks like `$41.20/$250 (16%) proj $190 [ok]` (spent/cap, share used, projected month-end spend, status).
   - If `status == "warn"` (>= `soft_warn_pct`) or the projection exceeds the cap: prefer Tier-1/2 roles, cap parallel LLM workers at 2, and require explicit justification for Tier-3.
   - If `status == "cap_tier3"` (>= `auto_cap_tier3_pct`) or `exceeded`: `cc-agent escalation` auto-downgrades to its `fallback_role`; avoid Tier-3 unless the user explicitly asks (`--force`).
   - If `status == "unknown"`: budget tracking is not configured; route by tier only.
