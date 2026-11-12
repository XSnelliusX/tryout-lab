# OpenCode Prompt Rewrite

**v0.1 · experimental prototype**

An opt-in OpenCode V2 terminal plugin that rewrites a draft prompt and suggests a working model before you send it. Use it from the start screen or inside a session; ordinary prompts are never automatically rewritten. Review the entire proposal before sending.

## How it works

1. Run `/rw` with a draft, or open its multiline editor.
2. A stateless request to the rewrite model returns a rewritten prompt and a separate model recommendation.
3. Review the proposal, then choose to send it, edit it, send the original, explicitly apply the suggested model, or cancel. A recommendation never switches the model on its own.

On the start screen, previewing or canceling creates no session. Accepting creates one in the current location and sends the chosen prompt as its first message. Within a session, the side call does not enter conversation history unless accepted.

The server and TUI plugin uses OpenCode's experimental generation API. It does not implement a desktop GUI or `opencode mini` interface.

## Requirements

- OpenCode V2 with the experimental `ctx.experimental.generate.text` plugin API. The API contract was checked against v2.2.7; this version of the plugin has not yet been tested end-to-end in a live TUI.
- An available text model and a connected provider in OpenCode. The model must follow the JSON output instructions; not all models will do so reliably.
- Node.js 20+ for local tests. No install or build step is needed for the included plugin sources.

## Install and configure

Connect a provider using `/connect` and check its available models with `/models`. In your existing `~/.config/opencode/opencode.json(c)`, add the absolute path to the plugin to the existing `plugins` array. For a dedicated rewrite model, use the object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/to/opencode-prompt-rewrite",
    "options": { "model": "example/coder#medium" },
  }],
}
```

Replace the path and model with actual values from your installation. The format is `provider/model` or `provider/model#variant`; model IDs may themselves contain `/`. Omit `options.model` to use the current session model, or the selected start-screen model. An explicit model or variant that is unavailable fails rather than silently falling back. The plugin does not change the working model unless you approve a recommendation.

OpenCode also supports environment substitution, for example `"model": "{env:REWRITE_MODEL}"` in the plugin's options. Set the variable in the **OpenCode server's environment**; an unset variable expands to an empty string and is rejected. For changing the model, editing the plugin option is usually simpler than managing a server environment variable.

Set credentials, provider packages, and custom endpoints in OpenCode, not in this plugin. For example, an OpenAI-compatible service can be registered separately:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
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

Replace the endpoint and model ID with a compatible service. Merge this provider configuration with your existing configuration; do not duplicate top-level keys or commit credentials. See [OpenCode provider configuration](https://opencode.ai/docs/providers#custom).

An OpenAI ChatGPT Plus/Pro connection is documented by OpenCode through `/connect` → OpenAI → **Sign in with ChatGPT**, with usage against the plan. Whether the specific one-shot call works with your account must be verified. OpenAI API keys have separate billing. For Claude, use a supported API-key or cloud provider connection; do not assume a Claude subscription permits third-party use. Details and sources are in [model configuration research](docs/model-configuration-research.md).

OpenCode automatically discovers plugins in its global `plugins/` directory. Do not load a second copy of this plugin if one is already installed there. Use `/reload` if needed and `/plugins` to check the plugin status.

## Usage

```text
/rw fix the failing tests but do not change production code
/rewrite
/rw --model example/coder#medium clarify this request without changing its intent
/rw-last
/rw-cancel
```

- `/rewrite` without text opens a multiline editor; **Ctrl+S** continues and Enter inserts a newline.
- `--model provider/model#variant` overrides the rewrite model for one request; it does not change the working session model. The variant is optional.
- `/rw-last` reopens the latest proposal for the current session or start-screen location. It can also recover the draft after a failed request. Recovery is memory-only and does not survive a TUI reload or exit.
- `/rw-cancel` cancels pending work. Cancellation or network loss cannot guarantee that the provider did not charge for work already done.

### Review controls

| Key | Action |
| --- | --- |
| Enter | Send the rewrite with the current working model |
| E | Edit the rewrite; Ctrl+S sends the edited text with the current model |
| O | Send the retained original with the current model |
| Ctrl+R | Confirm the recommended model and send the unchanged rewrite |
| Esc | Dismiss without sending |
| Up/Down, Page Up/Down, End | Scroll the rewritten prompt |

Applying a recommendation changes the session model for subsequent turns. The plugin blocks that choice if the session is busy, the selected model changed during review, or the rewrite was edited. Sending without a model change queues the prompt when the session is busy.

## Selection, context, and cost

The server includes the draft, up to six bounded recent conversation messages, current model, and a deterministic shortlist of up to 24 enabled text models from OpenCode. The shortlist is not a benchmark or ranking and may not include every available model. Recommendations do not select reasoning variants; “keep current” is also allowed. Invalid output is rejected, but structural validation cannot prove semantic equivalence.

The stateless generation API returns text only, not token usage, cost, or finish reason. The review box therefore shows **cost unavailable**; this does not mean the request was free. Consult your provider's billing or subscription usage. The plugin does not record per-request cost or add the side call to session totals.

## Limitations

- Text only: the command does not transfer composer images, files, editor selections, or selected skills.
- Context excludes tools, reasoning, files, and skill bodies and is capped at 10,000 characters; important information may be omitted.
- The stateless API uses a single prompt, not a separately enforced system message or structured-output mode. Some models may ignore its instructions. It does not expose a completion budget or finish reason, so truncation is detected only if the output is invalid.
- The generation API is experimental and uses the server's base configuration; model validation occurs in the plugin's location. Verify availability and access in your OpenCode setup, especially for project-specific providers.
- Requests time out after 45 seconds. OpenCode or providers may retry requests according to their own policies. Errors never submit a prompt automatically.
- Session model switching and submission are separate API operations, not a transaction. If submission fails after switching, the model remains changed. Failed first-message submissions retain the created session ID for a retry.
- Proposals expire after 30 minutes and are not durable. The TUI allows one active rewrite request at a time.

## Development and tests

```sh
npm test
```

Tests mock OpenCode generation and session methods. They cover model selection, parsing, cancellation, submission, and start-screen behavior, but not live provider authentication, rewrite quality, billing, or end-to-end UI behavior.

| Path | Purpose |
| --- | --- |
| `core.js` | Rewrite instructions, validation, model references, and candidates |
| `service.js` | Generation, proposal lifecycle, and safe submission |
| `rpc.js` / `index.js` | RPC contract and server plugin entry |
| `tui.tsx` | Slash commands, input, and review dialog |
| `test/` | Mocked regression tests |
| `docs/model-configuration-research.md` | Design rationale and primary sources |
