# Model configuration research

Researched 2026-11-12. The recommended generation path and `options.model` are implemented; live provider validation is outstanding.

## Project facts

- This is an OpenCode V2 server-and-TUI plugin. The locally installed CLI reports `v2.2.7`; its generation API contract matches the published contract, but the changed plugin has not been exercised end-to-end. The package does not pin an OpenCode dependency. [`package.json`](../package.json), [`README.md`](../README.md), [`index.js`](../index.js), [`rpc.js`](../rpc.js)
- The plugin uses OpenCode's stateless generation service, with an optional model reference and a one-request override. The side request is separate from session submission. [`core.js`](../core.js), [`service.js`](../service.js), [`rpc.js`](../rpc.js), [`tui.tsx`](../tui.tsx)
- The server plugin already receives an OpenCode client-like context; embedding a second host with `@opencode/sdk` is unnecessary for this design. The SDK is intended for hosting OpenCode within a separate application. [Plugin context](https://opencode.ai/docs/build/plugins/server#context), [embedded SDK](https://opencode.ai/docs/build/sdk)

## Recommended approach

1. **Select a model independently of the working session.** The plugin accepts `model: "provider/model#variant"` in `ctx.options`. OpenCode supports options on a plugin entry and documents this reference format; model IDs may themselves contain `/`. The plugin validates the provider, model and optional variant against `ctx.model.list()` for the relevant location and fails without silently switching providers. When not configured, it uses the current session or start-screen selection; on the start screen it falls back to `ctx.model.default()` if needed. [Plugin options](https://opencode.ai/docs/build/plugins/server#options), [model references and variants](https://opencode.ai/docs/models#references)
2. **Keep connection details in OpenCode, not the plugin.** Use OpenCode's provider ID and model catalog for provider, endpoint, credentials, API protocol, model aliases and variants. `providers.<id>.settings.baseURL` is provider-package-specific; a model map key is the selectable ID, while `modelID` can be the upstream ID. Configure secrets using `/connect` or environment substitution, not committed plugin options. Catalog/model availability is location-scoped. [Providers](https://opencode.ai/docs/providers#custom), [models](https://opencode.ai/docs/models#options), [provider accounts](https://opencode.ai/docs/cli/providers)
3. **Prefer testing OpenCode's stateless generation path** over implementing multiple provider transports: `ctx.experimental.generate.text({ model: { providerID, id, variant }, prompt })` runs without a session, tools or history. Repackage the existing system instructions and labeled input into its single prompt and continue validating the returned JSON locally; prompt-requested JSON is not a structured-output guarantee. This API is experimental. The current published [OpenAPI contract](https://opencode.ai/docs/openapi.json) accepts only `prompt` and optional `model`, and returns only `data.text`: no separate system message, output-token setting, structured-output mode, finish reason, or per-call usage/cost. Test cancellation, selected variant, actual endpoint/auth behavior, truncation handling, and location/config scope on V2.2.7 before claiming compatibility; current docs may describe a newer contract. [Server plugin API](https://opencode.ai/docs/build/plugins/server#generate-experimental), [API reference](https://opencode.ai/docs/api)
4. **Make the accounting trade-off explicit.** With the published stateless response, the plugin displays per-call cost/usage as unavailable rather than zero or a fabricated estimate. `ctx.session.generate` is documented to return tokens and cost, but requires a session and session context; it is not a drop-in replacement for a start-screen, history-independent request. Do not create or mutate sessions merely to recover accounting without a separate privacy/lifecycle design. [Session API](https://opencode.ai/docs/build/plugins/server#sessions)
5. **Generalize all dependent surfaces together.** The plugin accepts a one-request override and derives a bounded shortlist from available models without claiming unmeasured performance. It preserves explicit confirmation, cancellation, draft recovery and no-automatic-submit behavior. Future improvements could include a model chooser and configurable candidates.

Illustrative OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/to/opencode-prompt-rewrite",
    "options": { "model": "example/coder" },
  }],
  "providers": {
    "example": {
      "name": "Example provider",
      "env": ["EXAMPLE_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://api.example.com/v1" },
      "models": { "coder": { "modelID": "actual-model-id" } },
    },
  },
}
```

Replace the placeholder endpoint and model with an actual compatible service. The example configures the endpoint in OpenCode; it does not imply that every compatible service supports the same response format or reasoning controls. [Provider configuration](https://opencode.ai/docs/providers#custom), [model compatibility](https://opencode.ai/docs/models#compatibility)

## Subscription and billing boundaries

- **OpenAI / Codex:** OpenCode documents `/connect` → **OpenAI** → **Sign in with ChatGPT** (or legacy Codex sign-in), followed by `/models`, for ChatGPT Plus or Pro; it says usage counts against the plan. OpenAI documents plan usage in participating apps as subject to eligibility, permissions, feature availability, limits and applicable credits. Use the OpenCode-managed sign-in path rather than copying subscription tokens into a direct Chat Completions request. Whether this plugin's exact one-shot call is accepted and counted correctly must be tested, not assumed. [OpenCode ChatGPT setup](https://opencode.ai/docs/providers#chatgpt), [OpenAI third-party plan usage](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
- **OpenAI API key:** API usage has separate billing from ChatGPT/Codex plan usage. Eligible subscriptions can claim a separate API credit benefit in a linked API organization; that does not make an API key use the Codex allowance, and eligibility and activation apply. [OpenAI billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform), [API credit benefit](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)
- **Claude:** For a third-party plugin, recommend an Anthropic Console API key or supported cloud provider, not a Claude subscription OAuth token. Anthropic's current developer guidance prohibits third-party developers from offering Claude.ai login or routing requests on behalf of users using Free/Pro/Max/Ultra credentials; it also forbids collecting or intermediating those credentials. Anthropic describes a separate unmodified Claude Code path; that does not establish permission or compatibility for this plugin. Its Agent SDK help page describes a paused billing change, but that is not a blanket authorization for a new third-party integration. Confirm uncertain cases with Anthropic. [Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use), [Claude account guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [Agent SDK plan usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- **Claude API billing:** Console API use is separate from Claude plan usage. Eligible Max, Ultra and Team plans can claim monthly API credits into a linked Console organization; these credits are separate from subscription limits and do not cover cloud-provider charges. Check current eligibility and balance. [Claude API billing](https://support.claude.com/en/articles/9876003-why-is-claude-api-usage-billed-separately-from-my-paid-claude-plan), [monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)

## Verification

Use mocked contract tests first, then explicitly authorized live tests for an API-key provider, a custom endpoint, and OpenAI plan sign-in. Cover unavailable models/variants, unsupported JSON, interrupted or truncated output, cancellation, server-side credential environment, location isolation, and missing cost data. Confirm no session is created before acceptance and no hidden paid fallback occurs. No live inference or subscription test was performed for this research.
