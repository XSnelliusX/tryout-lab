# Implementation plan

**Updated:** 2026-11-10. **Status:** live-caption and post-meeting workbench prototypes implemented; local model assets and environment prepared, including pinned Metal diarization assets. Synthetic tests pass. No live inference or actual gateway calls were run for this update; quality and performance are unverified.

## Current implementation boundary

Implemented: session library and legacy import, persistent technical context and
enabled vocabulary hints, opt-in vocabulary from direct transcript edits, immutable
raw ASR and revision history, stale translation rejection, local clip replay,
longer offline recognition candidates, optional local eight-voice diarization and
manual names/overflow flag, evidence-checked text-only gateway proposals and draft
notes, Chinese study items with local pinyin support checks, known-term tracking,
and Markdown/JSON/Anki exports. Ninety-seven synthetic tests currently pass.

Still open: measured end-to-end recognition/translation/diarization quality and
two-hour resource/latency validation; accurate word alignment and automated
reconciliation/adoption of longer refinement windows; global reconciliation of
cross-chunk decisions/reversals; simultaneous mic+output capture; production
native always-on-top shell; complete phrase-dictionary/Taiwan reading validation;
and real gateway compatibility/authorization/configuration. These are not hidden
behind a claim that the entire planned production system is finished.

## Immediate live-test slice

The immediate slice covers local Teams/system-output or microphone capture, bounded audio segmentation, Qwen Mandarin/English transcription, Traditional Chinese display, PLaMo English translation, and a private local recovery archive. Microphone capture uses AVFoundation separately from ScreenCaptureKit; the user selects one source at a time, with no mixed capture. A loopback browser caption window replaces the planned native caption shell for this time-boxed version. It is not an always-on-top overlay.

Setup may install dependencies and download the selected pinned models. Launching the UI must not start recording or request microphone permission: the user selects an audio source, confirms consent, and explicitly starts capture. Teams/system capture requires Screen & System Audio Recording permission; microphone requires Microphone permission and uses the macOS default input. The user's meeting is the first live validation; latency, quality, capture permissions, and sustained operation remain unverified. See [the first live-test guide](live-test.md).

The workbench extends this slice with session browsing and legacy journal import, context and opt-in vocabulary hints, versioned direct edits, offline refinement candidates, a local diarization adapter, gateway review/summary/learning and exports. These additions are implemented with synthetic verification, not model-quality verification. Diarization assets are installed locally; gateway tasks still require explicit endpoint/model configuration and send confirmation. Refinement candidates require manual comparison/copying because their audio windows do not map exactly to live segments. Summaries are chunk-grounded drafts, not a globally reconciled final account. Verified participant identity, mixed microphone and output capture, precise word alignment, and complete two-hour hardening remain open. Audio chunk bounds are coarse timing evidence. Teams output captures remote audio rather than the local microphone; microphone capture can pick up nearby voices and noise but does not directly capture remote Teams audio.

See [workbench](workbench.md), [recognition quality](recognition-quality.md), [gateway](gateway.md), [diarization](diarization.md) and [exports](exports.md) for operation and limitations. The detailed sections below include design goals and verification criteria, not assertions that every target is complete.

This plan supersedes the [initial local-only plan](archive/initial-plan.md). The user has selected the live ASR, translator and offline diarizer, and now permits the existing free API gateway for post-meeting text processing. Do not reopen a broad model search unless a selected model fails its compatibility or quality gate.

## Requirements

- Personal tool for a base Apple M5 MacBook Pro, 10 CPU cores, 24 GiB unified memory, 1 TB storage, macOS 26.7.1.
- Teams **Mac desktop only**; no browser extension or meeting bot requirement. Built-in Teams translation is unavailable.
- Taiwanese Mandarin with English code-switching. Display source in Traditional Chinese and translate into English text; no TTS.
- Sessions up to two hours. Typical meetings may have 5–15 attendees; **up to 8 distinct speaking voices is accepted for prototype diarization**. Additional voices are out of scope, not automatically supported by resetting the model.
- Near-real-time understandable English is the priority. Initial targets, not measured promises: 2–5 s median from phrase end to useful English and p95 below 8 s. Also measure phrase-onset delay and maximum gaps during uninterrupted speech.
- Prefer automatic names where available; otherwise editable Speaker 1–8/unknown labels. Voice diarization alone does not identify Teams participants.
- English meeting/per-person summaries and intermediate-level Chinese vocabulary with pinyin, contextual translation and source examples.

## Selected models and execution

| Task | Selection | Required verification |
|---|---|---|
| Live and initial final ASR | **Qwen3-ASR-1.7B**, local MLX | Pin checkpoint/conversion/runtime; verify Mandarin–English switches, window stitching, timings and memory |
| Live translation | **PLaMo 3 Translate 0.8B MLX 4-bit** | Clear intended-use license; review bundled remote code; validate PFML3, Traditional Chinese and mixed input |
| Offline speaker diarization | **NVIDIA Nemotron-3-Diarization**, NeMo-Speech.cpp V3, max 8 voices | Pin actual V3 artifact and Metal/CPU build; verify cache/state and two-hour coverage |
| Transcript correction/review | Existing gateway free text model | Keep raw ASR; proposed edits must be traceable, reversible and uncertainty-aware |
| Meeting and person summaries | Same gateway | Source-grounded claims, reviewed identity, owners/deadlines only where supported |
| Vocabulary extraction | Same gateway | Exact source occurrence and context; local dictionary/phrase validation of pinyin |

Gateway candidates: `deepseek-flash-gmi` (user reports `deepseek-v4.1-flash-1017`) and `nemotron-3.5-lightning-30b-a3b-spc` (user reports `nemotron-3.5-lightning-30b-a3b`). Do not assume their capabilities from aliases. Choose a configured default and compare on non-sensitive or explicitly approved samples; do not send each meeting to both by default. Endpoint, authentication, context limits, structured-output behavior, quotas and retention remain unconfigured/unverified.

The [selected-model research](selected-model-research.md) records source-level evidence and open compatibility questions. No M5 performance has been measured yet.

### PLaMo licensing

The [official model card](https://huggingface.co/pfnet/plamo-3-translate-0.8b-MLX-4bit) links the [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-en). Can be used for this personal usecase.

## Data flow

```text
One selected source: Teams output / system output / default microphone
  -> timestamped local audio chunks + recovery manifest
  -> VAD / rolling windows -> Qwen3-ASR-1.7B (MLX)
  -> versioned source clauses -> PLaMo translation (MLX)
  -> Traditional Chinese + English caption window
  -> local meeting archive

After meeting:
  retained audio -> Qwen second pass where needed
  retained audio -> Nemotron offline speaker timeline (<=8 voices)
  transcript + timeline -> speaker/name review
  approved text -> existing gateway -> proposed transcript edits
  reviewed source -> existing gateway -> meeting/person notes + vocabulary
  vocabulary -> local dictionary/pinyin validation -> review/export
```

Keep live processing independent of the gateway. Gateway failure, quota exhaustion or missing credentials leave the local archive and captions usable; mark post-processing pending and allow retry. Do not substitute another provider automatically.

## Local application shape

- Native macOS capture and a planned caption shell, with an always-on-top non-focus-stealing window. ScreenCaptureKit/app-specific Teams audio capture is the initial output route to validate; AVFoundation microphone capture has a separate permission and is an alternative source, not a simultaneous track in this slice. Avoid recording unrelated system audio where app filtering works.
- Isolated MLX model workers and a local orchestration layer. One proven ASR runtime and one translation runtime; bound concurrency and queue lengths. Never run unreviewed checkpoint code merely because its example requires `trust_remote_code`.
- A local, authenticated IPC interface; any HTTP listener stays loopback-only with request/origin checks.
- SQLite for versioned transcript/evidence/job metadata and chunked local audio with absolute offsets. Recover incomplete sessions after worker crashes. Runtime meeting storage lives outside this Git tree and outside cloud-sync folders.
- No large local summarizer is required for this selected prototype. Offline diarization follows the call, rather than competing with ASR/translation.
- Visible recording state, required notice/consent, an explicit retention policy and app-owned data deletion apply even when processing is local. Do not log transcript bodies or credentials; account for backups and user-exported copies separately from app deletion.

## Live ASR and translation behavior

1. Evaluate the documented `mlx-audio` Qwen `stream_transcribe` path explicitly with 1.7B; its example uses 0.6B, and text deltas do not inherently have timestamps. A third-party stateful `mlx-qwen3-asr` implementation is also documented. Verify the chosen runtime's actual behavior; otherwise implement overlapping rolling-window ASR, stable-prefix/segment reconciliation and final flush. Qwen's official vLLM streaming limitation does not rule out these third-party MLX implementations. Do not use CUDA examples as Mac setup instructions. Include VAD/silence safeguards so noise or silence cannot repeatedly generate invented speech.
2. Preserve raw Chinese/English ASR, then apply conservative OpenCC conversion for Traditional display. Keep code identifiers, proper names, raw offsets and conversion provenance.
3. Translate coherent stable clauses with bounded history/context and a small approved glossary. Flush on long turns without waiting indefinitely for silence. English output can be provisional and revised when Chinese word order/context changes.
4. Use PLaMo's documented PFML3/chat-template options, target `en`, and explicit generation/stop limits; do not treat a specialized translator like an arbitrary instruction chatbot. Its Traditional Chinese code is `zh-hant` (Simplified: `zh-hans`). Test autodetection versus explicit language selection on mixed utterances. Apply the template's reserved-token protections to transcript/glossary text, especially if constructing PFML3 directly; do not concatenate untrusted special tokens into control syntax.
5. Caption translations are keyed to source segment ID and revision. Replace revised output, reject stale results and deduplicate overlapping ASR windows. Keep provisional/final status visible.
6. Prioritize capture and ASR; coalesce obsolete translation requests and show falling-behind/feed-loss state. Preserve recording for recovery rather than silently losing speech. No cloud fallback for live inference.
7. Test sustained two-hour Teams calls with screen sharing; measure full unified-memory pressure, swap and call quality. Model file size is not a runtime-memory estimate.

## Offline speaker processing

- Use Nemotron-3-Diarization locally, initially in its offline-style chunked configuration. Input-buffer latency is not processing time and does not constrain post-meeting use.
- Prefer the official NeMo-Speech.cpp V3 path: documentation distinguishes the eight-speaker model from its older four-speaker V2 and lists Apple Silicon Metal and CPU distributions. Pin and test it rather than assuming NVIDIA NeMo's CUDA instructions apply to this Mac. Use the stateful chunked / `v3-offline` preset, **not** the separate full-attention `--offline` path, whose positional table limits it to roughly 6.6 minutes. Do not let a missing indexed model silently trigger runtime downloads.
- The model's eight outputs represent **up to eight distinct voices in the processed session**, not eight simultaneous speakers with unlimited identities over time. Do not recycle labels to claim support for a ninth voice.
- Keep state within a continuous chunked session where the runtime supports it. Independent file calls may reset labels; if used, reconcile global identity explicitly rather than assuming same-number labels match.
- More than eight active voices are unsupported. Let the user flag this; do not claim the model can reliably detect overflow. Mark attribution and per-person notes unreliable and offer anonymous/unattributed meeting notes or manual correction.
- Preserve overlap. Segment-level ASR crossing a speaker change is not necessarily assignable to one person; split only with adequate timing evidence, otherwise mark ambiguous.
- Qwen word alignment is a separate capability to verify; do not invent precise timestamps from text. Speaker identity and timing corrections must invalidate affected derived notes.
- Anonymous cluster labels become person names only after manual review or a validated optional Teams transcript mapping. Do not infer names from semantic content or maintain cross-meeting voiceprints by default.

## Gateway transcript review, summaries and vocabulary

### Send policy

The user has approved **the existing gateway and the supplied free model choices for these post-meeting tasks**. This is a change from the archived local-only plan, not permission to add other providers or upload raw audio. Each post-processing job requires explicit send confirmation. Do not send live audio, whole recordings, unrelated files or unnecessary meeting metadata.

Configure endpoint/model intentionally; provide a key via `MEETING_ASSISTANT_GATEWAY_KEY` or UI memory. Keys are not persisted. Each gateway job requires explicit confirmation and sends text only, never audio. No endpoint is inferred from model aliases. Review company authorization, retention/residency and gateway terms before real meeting text is sent. Free access is not a privacy guarantee.

### Transcript edits

- A text-only model can fix punctuation, consistency and likely terminology; it cannot establish what the audio contained or recover missing speech with certainty.
- Store immutable original ASR plus per-span proposed edits, reason and uncertainty. For consequential substitutions, preserve the original and require review or audio recheck. Never silently rewrite names, numbers, negations, dates, technical identifiers or speaker identity.
- Exact-span validation and schema checks prevent invalid references, not semantic hallucination. Flag suggested repairs of unclear speech rather than accepting fluent guesses.
- Accepted edits create a new transcript version. If text changes invalidate alignment, keep original evidence timings and realign affected spans if needed; do not pretend replacement words have verified timestamps.

### Meeting and per-person summaries

- Analyze final Traditional Chinese/English source text, not only live English translations. Chunk coherently with overlap and reduce evidence-linked claims across the full two hours.
- Each claim includes transcript version, source span IDs, exact quotation and speaker/unknown. Distinguish proposals, accepted decisions, rejected options and later reversals.
- Actions store owner/unknown, explicit deadline/null and proposed/accepted status. A mention or request is not an accepted commitment.
- Validate support against the source; require review for consequential items and before sharing. Regenerate affected claims after source/name corrections.

### Vocabulary

- Extract roughly 15–30 useful intermediate-level terms/phrases per meeting, adjustable; rank workplace usefulness, technical relevance and unknown-to-user status over frequency alone.
- Table: Traditional term, tone-mark/numbered pinyin, contextual English, exact source quote, timestamp, speaker/unknown, dictionary provenance, validation status and known-word status.
- Gateway output proposes vocabulary and contextual senses; local dictionary/phrase validation checks pinyin, heteronyms and Taiwan variants. Unsupported readings stay review-needed. Do not require a local Qwen vocabulary model in this version.

## Teams transcript remains optional

Local Qwen ASR is the selected default; do not block on Teams live-text extraction. An authorized downloaded VTT can later assist names or compare transcripts. If added, retain its source separately and align carefully rather than replacing local evidence wholesale. Standard Graph post-meeting retrieval is not a live stream; Work IQ is a separate authorized service integration, not a prerequisite.

## Milestones and exit criteria

Implementation is underway across these milestones; none of the live, model-quality, gateway or two-hour exit criteria below has been established by this update. Prepared local models and environment do not establish diarization backend readiness or inference quality.

| Milestone | Scope | Exit criterion |
|---|---|---|
| 0. Compatibility | Pin/review runtime assets; verify Qwen MLX and exact Nemotron Mac backend | All selected local models can be loaded safely on this Mac; no false CUDA/Metal assumptions |
| 1. Replay benchmark | Qwen → PLaMo on permitted Mandarin/English clips; Nemotron on <=8-voice sample | Measured latency, code-switch quality, silence behavior, attribution and memory; no truncated outputs |
| 2. Live MVP | Capture, bilingual captions, revisions, final flush and local journal | Useful captions in a short Teams desktop pilot; clear lag and privacy state |
| 3. Gateway batch prototype | Explicit send, existing gateway only, versioned edits, evidence-linked notes and vocabulary | Works on approved sample; no silent factual rewrites; failures retry without losing local data |
| 4. Speaker/name workflow | Nemotron offline, overlap handling, editable mapping, out-of-scope warning | Reviewed <=8-speaker attribution and honest ambiguity/overflow behavior |
| 5. Two-hour hardening | Teams screen sharing, audio-device changes, feed loss, crash/restart, queue limits | No unbounded backlog/memory growth, no unnoticed recording gaps; correct full-session coverage |

## Verification and remaining inputs

- Deterministic tests: stale-result rejection, source revisions, deduplication, clock offsets, final flush, source-claim validation, prompt data isolation, gateway endpoint allowlisting, retries/cancellation, meeting deletion and correction invalidation.
- Model tests: Mandarin CER/English WER on a held-out representative sample; bilingual semantic review including numbers/negation; p50/p95 end-to-end caption timing, longest gaps and revisions. Never select from fluent English alone.
- Diarization: 2/4/8 voices, speaker return after long silence, overlap, chunk boundaries and a labeled >8-voice negative case. Report clustering and real-name accuracy separately.
- Egress: local workers must work on cached assets without network; gateway text transfers are explicit and auditable without content/secrets in logs. The Teams call itself remains networked.
- Still needed for validation and operation: diarization backend/model setup, headset/audio routing, notice/consent/retention policy, acceptable latency, and explicit gateway configuration and authorization.

The November 10 implementation request authorizes dependency installation and selected-model downloads for the first live test. Actual meeting recording still requires the user's explicit Start action and required consent. Setup and live captions do not authorize gateway calls; each remote job requires explicit confirmation.
