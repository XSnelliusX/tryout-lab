# Post-meeting text gateway

The gateway is **not** used during capture or automatically. The caller must
obtain the necessary consent and explicitly approve each send. Review gateway
authorization, retention and residency before sending real meeting text. Audio,
translations, raw ASR, segment timings, session IDs and other metadata are not
sent. Only selected current Traditional transcript text, segment IDs, speaker
cluster labels, optional meeting context, and reviewed names for speakers in each
chunk are sent. Context and names are optional; omit them if unnecessary. All
of these values are untrusted data, not instructions. Text may contain sensitive
information even after this minimization.

## Configuration and transport

`GatewayClient(endpoint, model, api_key="")` requires an explicit HTTPS URL and
model. No endpoint or model is selected automatically. The candidate aliases
`deepseek-flash-gmi` and `nemotron-3.5-lightning-30b-a3b-spc` are examples, not
endpoint mappings or verified compatibility claims. Select one configured model;
the client never tries another provider or model.

Supply either a full chat completions URL, such as
`https://gateway.example/v1/chat/completions`, or an API base, such as
`https://gateway.example/v1`, to which `/chat/completions` is appended. A host
without a path is likewise a base. Credentials in URLs, query strings,
fragments, malformed hosts, private/non-global IP literals and localhost are
rejected. Public IP literals and explicitly approved corporate hostnames are
accepted only when **all** DNS results are globally routable. Connections are
pinned to a checked DNS address while TLS still verifies the original hostname;
only the first resolved address is tried per attempt. Proxies and redirects are disabled.
Consequently a private-address corporate
gateway is not supported by this implementation. DNS, TLS and network access
are still observable by the network and gateway. DNS resolution itself is
subject to the system resolver's timeout behavior.

Pass the API key in memory, e.g. from a protected environment variable; never
put it in a URL, settings file, artifact, log or UI state. HTTPS authorization
uses a bearer header. The client imposes a 30-second socket timeout, 1 MiB
response cap, 4096 output tokens, and at most three attempts for HTTP 429/5xx
only. No error response bodies or request/response contents are logged or
returned in errors. Retries may send a chunk more than once. Cancellation is
checked before chunks and attempts, not during an in-flight request, DNS lookup
or short retry delay.

The browser's explicit send confirmation is bound server-side to the selected
session ID, current transcript version, and exact saved endpoint/model settings.
If another tab changes any of those, the job is rejected before constructing a
gateway client or sending text. Manual pasted translation inputs are excluded.

## Calling and results

`client.analyze(segments, task="review" | "summary" | "learning", context="",
speaker_names={}, progress=None, cancelled=None)` accepts the shared segment
records. `progress({stage, completed_chunks, total_chunks})` is called before each
chunk and on completion;
`cancelled()` returns a boolean. The caller captures the session version before
sending and stores the returned `data` in an artifact with that `source_version`;
an output is stale if the source version changed. No proposal is applied by
this module. Do not store a `pending` or `cancelled` result as ready or treat
its partial data as full-meeting coverage. Retry explicitly after resolving the
problem; it may resend previously processed chunks.

Chunks are bounded to approximately 6000 input characters, with a short excerpt
of the previous segment as overlap where a whole segment does not fit. Long segments are split with character overlap for summary and
learning; review requires the full original segment and marks an oversized
segment pending instead of silently splitting an edit. No claim is made that
these character bounds match any particular model's context window. Gateway
token-limit/incomplete finishes, malformed outputs and transport failures mark
the job pending instead of accepting a truncated result. A retry may require a
different model or locally shorter segments. Partial results include a `status`
and limitations. Empty input causes no request.

Result fields follow the shared schema: `review.proposals` contain
`segment_id`, exact full `original`, `replacement`, `reason`, `uncertainty` and
`quote`; `summary` contains `overview`, `decisions`, `actions`, `people`, and
`limitations`; `learning` contains `items` and `limitations`. Every summary
claim has exact `evidence` segment IDs and quotes. Every learning term must
occur in its quote. Unknown owners/deadlines are null; an owner must also be a
reviewed name and occur exactly in evidence. Exact quotation alone does not
prove an action was accepted, so all gateway actions remain `proposed`. Person
summaries require evidence from the corresponding reviewed speaker cluster.
Learning speakers are derived from the reviewed mapping, otherwise `unknown`.
Invalid claims are dropped and counted. Literal evidence validation does not
prove a claim, correction, owner, deadline, or contextual interpretation is
true; human review is essential. Chunk results are aggregated and exact
duplicates removed, not synthesized into a single global narrative, so
the result is a chunk-grounded draft, not final notes. Cross-chunk
contradictions, reversals, final decisions and duplicate paraphrases require
human reconciliation.

## Local Chinese learning validation

`validate_learning(data, segments)` uses optional local `pypinyin` if installed;
otherwise it marks all readings `needs_review`. It does not download anything.
For the optional dependency use a reviewed pinned version, for example
`pypinyin==0.55.0`; installing it is separate from a gateway call. The model's
`meaning` remains the proposed contextual sense and is not a dictionary
definition. `dictionary_supported` means the proposed tone-marked or numbered
reading matches local character readings and no character has a heteronym in
that dictionary. It does **not** establish contextual meaning, a phrase reading,
or Taiwan-specific usage. Each item's `validation_flags` require context and
Taiwan-usage review; detected heteronyms add a further review flag. Ambiguous,
unrecognized or unsupported readings remain `needs_review`. The
`dictionary_provenance` field identifies the local library and version. A
human should review even dictionary-supported readings and all meanings.
