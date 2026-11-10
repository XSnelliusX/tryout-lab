# Local Mandarin–English Teams assistant: implementation plan

> Superseded historical plan. See [current implementation plan](../plan.md): Qwen ASR + PLaMo translation, Nemotron diarization, and gateway-assisted post-meeting processing.

**Status:** proposed; research complete, implementation and device benchmarks not performed.
**Date:** 2026-11-09.
**Research:** [primary-source report](initial-research.md), researched with GPT-6.1 Terra medium and refined after targeted verification.

## 1. Confirmed requirements

- Personal tool on this base Apple M5 MacBook Pro, 10 CPU cores, 24 GiB unified memory, 1 TB storage, macOS 26.7.1.
- Teams **Mac desktop only**; built-in translation is not available. Do not require Teams in a browser.
- Up to two-hour meetings, 5–15 attendees, Taiwanese Mandarin with intra-sentence English technical terms.
- First priority: useful, near-real-time English **text** captions. Also show Traditional Chinese source. No translated audio or TTS.
- Whole-meeting and per-person English summaries after meetings, with decisions, proposals, action items and unresolved questions distinguished.
- Prefer automatic Teams names; anonymous speakers plus manual naming are acceptable. Unknown attribution is preferable to a wrong name.
- Intermediate-learner vocabulary table: Traditional Chinese, context-sensitive pinyin, English meaning and actual source example.
- Local inference first. Using Teams' own ASR is an optional, clearly labeled hybrid input, not fully on-device transcription.
- No automatic remote-model fallback. Only the existing user-approved gateway and supplied free model aliases may be considered later, with explicit approval of content sent. No gateway access is needed for the initial plan.

## 2. Main decisions

### A. Own the caption/translation pipeline, not necessarily the transcript source

Expose one transcript-event interface with two real candidate adapters:

1. **Local audio adapter:** Teams output plus a separate local microphone track, on-device ASR.
2. **Teams text adapter:** only if a permitted live feed actually works on the desktop client or an authorized Microsoft interface.

Do not let the optional second adapter block the first. A post-meeting VTT importer is independently useful even if no live Teams adapter works.

### B. Separate live and post-meeting work

Run only capture, ASR, text normalization, small translation and the caption UI during the call. Defer large summarization and offline speaker processing. The 24 GiB is shared with Teams and macOS, and fitting weights is not proof of sufficient compute or memory bandwidth.

### C. Select models from the target-machine benchmark

| Task | First candidate | Challenger / fallback | Selection gate |
|---|---|---|---|
| Live ASR | Whisper large-v3-turbo, whisper.cpp with Metal | Qwen3-ASR-1.7B / 0.6B through MLX-Audio and managed rolling windows | Taiwanese Mandarin/code-switch accuracy and end-to-end latency under Teams load |
| Live English translation | Qwen3.5-4B, quantized, text-only inference, thinking explicitly disabled in the supported template | Hy-MT2-1.8B standard Q4 after runtime verification; TranslateGemma 4B if terms accepted | Accurate clauses, numbers and negation; no expanding backlog |
| Final transcript | Qwen3-ASR-1.7B vs Whisper large-v3 | MOSS-Transcribe-Diarize, chunked | Accuracy on retained original audio; no omitted chunks |
| Offline speakers | Variable-speaker pyannote Community-1-style offline pipeline, native conversion where validated | sherpa-onnx; compare MOSS labels | No four-speaker limit; evaluate up to 15 active voices, global reconciliation and overlap |
| Meeting / person summaries | Qwen3.5-9B quantized, bounded hierarchical passes | Qwen3.5-4B | Source-grounded claims, owner/deadline correctness, actual runtime memory |
| Vocabulary candidates | Qwen3.5-2B, short chunks, non-thinking | 4B or already-loaded 9B | Exact occurrence, correct contextual gloss, usefulness to intermediate learner |
| Pinyin | Local dictionary/phrase lookup plus pypinyin and contextual validation | Taiwan-specific licensed reference / manual review | Heteronyms, tones, names and Taiwan variants checked |

These are candidates, not claims of a measured winner. Prefer an already-loaded larger offline model over loading 2B solely to satisfy a model-size preference if 2B shows no practical benefit.

Important exclusions and cautions from the research:

- Whisper turbo is not trained for translation; use it for transcription, not its `translate` flag.
- The documented Qwen streaming implementation is vLLM-only; community MLX support must be tested separately. Do not install CUDA packages expecting Metal execution.
- VibeVoice streaming is an optional later experiment: its released checkpoint has an eight-minute supported recording limit. A two-hour session needs resets, overlap and separate global speaker reconciliation.
- Do not pick four-speaker streaming Sortformer for this workload.
- Hy-MT2's standard GGUF card contains a blanket STQ kernel warning. Inspect the exact artifact and confirm Metal execution; autogenerated hub commands are not proof. Its Q4 candidate remains gated.
- HY-MT1.5 has a territory-restricted license, including exclusions for EU/UK/South Korea. It is not the unconditional fallback.
- No public model benchmark proves the required M5 / Taiwanese Teams behavior.

## 3. Architecture

```text
Teams desktop output + separate microphone
    -> capture / recording / clock alignment
    -> VAD + bounded overlapping ASR windows ----+
                                               |
Optional permitted Teams live transcript -------+-> transcript events
                                                   -> clause stabilization
                                                   -> local English translator
                                                   -> bilingual caption window
                                                   -> local meeting store

After meeting:
  audio second pass OR authorized Teams VTT import
    -> final source transcript + global speaker timeline
    -> identity review / reconciliation
    -> source-evidenced meeting + person summaries
    -> vocabulary discovery / ranking / dictionary-backed readings
    -> review and explicit export
```

### Proposed implementation shape

- **Native macOS shell and capture:** Swift/SwiftUI with an always-on-top, non-focus-stealing caption window; ScreenCaptureKit/system-audio route after validation; separate microphone capture. Prefer an app-filtered Teams track to system-wide capture where supported. Do not silently record notification sounds or unrelated apps.
- **Model workers:** isolated local processes for whisper.cpp/Metal, MLX-Audio experiments and an appropriate local Qwen runtime. Select one proven text runtime rather than carrying several indefinitely. Avoid Docker for the native Metal path.
- **Orchestration:** Python for the experimental pipeline and offline jobs; the native shell should not know model-specific prompt and retry details. Use authenticated local IPC or a permission-restricted Unix socket; any HTTP server is loopback-only with request authentication and origin checks.
- **Storage:** SQLite for meeting metadata, revisions, identity mappings, evidence and known vocabulary; audio stored in recoverable chunks with a timestamp manifest. No cloud database, Kafka, vector database or meeting bot in the initial personal version.
- **Scope:** a separate new project, not code inside the currently open endpoint-health service. Do not create the project or install/download models as part of the research-only task.

### Small module interfaces

- `MeetingSession`: start, stop, state/events; hides capture permissions, recording chunks and source adapters.
- `LiveCaptions`: consume versioned source events, emit versioned bilingual captions; hides stabilization, model scheduling, cancellation and glossary use.
- `MeetingArchive`: persist/read revisions and evidence; maintains immutable source provenance, atomic updates and deletion.
- `MeetingReview`: finalize transcript/speakers and generate/review derived notes/vocabulary; hides batch orchestration and validation.

Keep model adapters private to these modules until actual alternate implementations justify a public seam.

## 4. Transcript and evidence contracts

Each source event carries:

```text
meeting_id, source_kind, source_segment_id, revision,
start_ms, end_ms, track_id, text_raw, text_traditional,
speaker_cluster_id?, participant_id?, participant_display_name?,
attribution_source, review_status, provisional_or_committed,
model_id, model_revision, timing_precision, text_quality_flags
```

- A display name is not a unique participant ID. Unknown IDs remain null; never infer identity from what someone says.
- Translation keys include source segment ID and revision. Replace revised captions in place and reject out-of-date worker results; do not append translations of overlapping hypotheses as new speech.
- Timing precision is honest: segment timings remain segment timings unless word-level alignment is actually available. Never invent word timestamps or calibrated confidence values.
- Keep raw and display-normalized Chinese separate. Use conservative OpenCC conversion; protect proper names and code identifiers. Taiwan phrase localization is an optional labeled view, not a silent change to verbatim source.
- Keep live hypotheses, final second-pass transcript and human corrections as distinct versions. Final corrections invalidate dependent translations, claims and vocabulary, which can be regenerated.
- Imported Teams transcript and local audio are distinct evidence sources. Alignment can propose mappings, but never overwrite one with the other as ground truth.

Each summary claim stores transcript revision, evidence segment IDs, exact quotations, speaker/unknown, and interpretation/status. Action items additionally have owner/unknown, explicit deadline/null and proposed/accepted status. Schema validation and exact quote matching are necessary but do not prove factual entailment; semantic and human checks remain required.

## 5. Live behavior and resource management

- Warm models before the meeting. User explicitly starts capture after required notice/consent and can pause/stop visibly.
- Replay/pilot sweep: source windows around 2, 4 and 6 seconds of new audio with overlap and bounded history; tune rather than assume the shortest wins.
- Translate stable clauses with a short recent context and approved glossary. Also flush periodically on continuous speech; do not wait forever for silence or punctuation.
- Do not commit the first few words of an unfinished Chinese clause as irrevocable English. Source and target may reorder; provisional English is visually distinct and revisable at clause scope.
- Preserve already-spoken English, acronyms and names; test intra-sentence code-switching rather than forcing the whole session to one language.
- Translation prompts delimit transcript as data, never instructions. Workers have no tools and cannot execute meeting text. Bound input/output and validate schema.
- Prioritize capture and ASR. Coalesce obsolete translation jobs, bound queues and retain original audio for later recovery. Warn when behind; never silently discard speech or label delayed output live.
- On overload: reduce speculative updates and context, stop optional jobs, try the validated smaller model. Any skipped live region is explicitly marked; no remote fallback.
- Measure full-process resident/unified memory and system pressure, not model file size alone. Target several GiB of headroom and no growing swap pressure while Teams shares the screen. Hard budgets follow observed measurements.
- Post-meeting: unload live models, run transcript and diarization sequentially where needed, then load the 9B summarizer. Start with bounded 8–16K-token offline inputs, lower if necessary; do not rely on advertised maximum context fitting 24 GiB.

## 6. Teams transcript feasibility gate

The user has no built-in translation and wants desktop only. Therefore:

1. **Small authorized Accessibility experiment:** inspect whether the visible transcript pane exposes current text, speaker names and updates. Check revisions, virtualized/removed rows, repeated text, reconnects, focus changes and minimization. No private endpoint reverse engineering, content-protection bypass or hidden background interception.
2. **Pass only with evidence:** capture every permitted visible update in a short test, then verify a sustained session; detect missing/duplicate ranges and disconnected feeds. It is an experimental display adapter, not an official Teams transcript API.
3. **Supported live integration:** Work IQ is a conditional alternative only if the organization already enables/approves it. Verify developer access, actual raw transcript delivery, timing, signed-in-user permissions, cost and policy. Microsoft documents tenant billing/admin prerequisites; do not turn this into a required provisioning project.
4. **Fail/stop gate:** if the desktop text is inaccessible, disallowed or brittle, select local audio immediately. The project must still work without Microsoft API permissions.
5. **Independent batch feature:** import a manually downloaded, authorized Teams VTT after the meeting. Reuse names/timestamps when present; handle hidden identities and room accounts. Manual import avoids API setup but not meeting access/download policy.

Standard Graph transcript retrieval is documented for post-meeting use, not as a live incremental feed. Caption-only mode is not equivalent to a stored transcript. Teams ASR is cloud processing; local translation on its output is labeled **Teams-source / local-processing**, not fully offline.

## 7. Post-meeting summaries and vocabulary

### Transcript and speakers

- Reprocess original audio with the best validated quality model; use bounded chunks, record their coverage and reconcile overlap without dropping the last part of a long meeting.
- Run global variable-speaker clustering or reconcile chunk-local speaker IDs over the full meeting using overlap and ephemeral voice-derived embeddings where permitted. Do not assume Speaker 1 in two chunks is the same person.
- Preserve overlapping/uncertain speech. An exclusive timeline may assist alignment but is not evidence that nobody overlapped.
- Offer an audio snippet per speaker and manual name mapping, with split/merge corrections. Do not retain cross-meeting voiceprints by default.
- A permitted Teams VTT can suggest name/time mappings; review alignment, hidden speakers, room participants and similar names. Human corrections must propagate to the derived notes.

### Summaries

- Analyze the final Chinese/English **source transcript**, not only translated English, to avoid compounding translation errors.
- Extract evidence-linked facts from coherent chunks, then consolidate across topics and speakers. Include later reversals, cancelled proposals and negations.
- Outputs: overview, decisions, proposed options, open questions, explicit action items, and per-person contributions/commitments. Unknown owner and unstated deadline stay unknown/null.
- Validate claims against their source and flag uncertainty. A fluent 9B answer is not verification. Require review before sharing or exporting.

### Vocabulary

- Default to roughly 15–30 useful terms/phrases per meeting, adjustable. Rank intermediate-level workplace usefulness, domain relevance and unknown-to-user status rather than raw frequency alone.
- Qwen3.5-2B proposes exact source spans and short context-specific meanings. Dictionary lookup supplies candidate readings; contextual selection and checks resolve heteronyms and Taiwan variants.
- Store Traditional term, tone-mark and numbered pinyin, contextual English meaning, exact quote, timestamp, speaker, dictionary/version, verification status and known-word status.
- A pronunciation without adequate support is marked for review, not confidently invented. Use lexical citation tones by default; spoken sandhi is an optional later feature.
- Use the larger already-loaded model for difficult senses or failed 2B outputs, then still validate. API use is not necessary merely because 2B fails.
- Support copy/export after review; build a simple known-word list before introducing spaced repetition integrations.

## 8. Ordered milestones and exit criteria

| Milestone | Work | Exit criterion |
|---|---|---|
| 0 — policy and inputs | Confirm consent, retention, headset route; time-box desktop live-text access; obtain a permitted sample VTT/audio clip | Chosen live input route with a clear fallback; no dependency on unavailable translation licensing |
| 1 — replay benchmark | Small local harness comparing Whisper turbo and Qwen ASR; Qwen 4B translation baseline and gated specialist challenger | Full Mandarin→English latency and quality measured on identical input; all chosen models load locally |
| 2 — useful live MVP | Capture or permitted Teams text, bilingual caption window, provisional/committed updates, local journal and lag indicator | Short live pilot understandable and recoverable; no duplication, missing final flush or unexpected egress |
| 3 — two-hour reliability | Sustained Teams + screen sharing test; audio-device changes, sleep/reconnect, crashes, queue pressure and recovery | No unbounded delay/memory growth or unnoticed gaps; recording coverage reconciles to session duration |
| 4 — final transcript and people | Second pass, variable-speaker diarization, global chunk identity, manual mapping and optional VTT reconciliation | Reviewed speaker timeline; uncertain identity remains unknown; 5/10/15-speaker cases evaluated |
| 5 — summaries and learning | Local 9B/4B grounded notes, 2B vocabulary comparison, dictionary-backed pinyin, known-word tracking and review | Every released claim/row resolves to source evidence; attribution and pronunciation audit passes |
| 6 — personal packaging | Stable model manifest, permissions/help, offline runtime check, explicit retention/delete/export, safe updates | Repeatable startup on this Mac; no dependency downloads during meetings; clean removal of a meeting and its derivatives |

Do not commit to calendar estimates before milestones 0–1 establish the input path and actual inference performance.

## 9. Verification and acceptance

**Proposed product targets, not measured capabilities:**

- Median phrase-end to useful English around **2–5 seconds**; initial p95 goal **under 8 seconds**, subject to user agreement and measured feasibility.
- Also measure first/stable English, delay from phrase onset, longest caption gap and revision rate. A good phrase-end score must not hide waiting through a 30-second uninterrupted turn.
- No growing caption queue across two hours while Teams is active, including representative screen sharing. No material call/audio degradation.
- No unexplained missing audio/transcript intervals; no uncontrolled memory growth. Explicit lag/gap state on failure.
- No meeting-content network egress from local inference workers after assets are downloaded. Teams itself remains networked for the call; test the assistant separately and also replay recordings with networking disabled.
- Summary/vocabulary release checks: all evidence references and exact quotes resolve; consequential claims, names, numbers, negation, owners and deadlines manually audited; unsupported items withheld.

**Model evaluation:** hand-correct a representative permitted subset spanning Taiwan accents, Chinese/English switches, jargon, silence, overlap, quiet voices, long turns, negations, names and numbers. Keep a holdout separate from prompt/glossary tuning. Report normalized and raw Chinese CER, English WER, terminology/number accuracy and bilingual adequacy review. Score source-to-English correctness, not English fluency alone.

**Speaker evaluation:** DER/JER with documented overlap/collar policy, speaker-attributed transcript error and identity accuracy separately. Include returning speakers after chunk resets, short interjections, duplicate display names and multiple people using one room device. Attendee count is not active-speaker count.

**Deterministic tests:** source revision replacement, stale translation rejection, overlapping chunk deduplication, final flush, drift/clock offsets, timestamp precision, Unicode/script normalization, missing speaker handling, source revision invalidation, deletion of audio/database/cache/exports under app control, JSON/quote validation and transcript-as-data prompt handling.

**Integration / end-to-end:** real capture permissions and routing; device switching; process crash/restart; partially written recordings; two-hour replay; Teams Accessibility updates if selected; local model-only operation; persistent journal recovery and explicit source-feed loss.

## 10. Privacy, licenses and remaining decisions

- No recording, UI inspection of meetings or gateway calls occurred during research. Do not open a live meeting or change tenant settings without permission.
- Get legally and organizationally required notice/consent before capture; local inference does not remove recording-policy obligations. Respect sensitivity labels and transcript copying/download restrictions.
- Store meeting data in an explicitly chosen, access-controlled, non-cloud-synced local location. Check Time Machine/other backups and encryption; FileVault protects storage at rest but is not a substitute for correct live access controls.
- User-approved retention and visible recording state; retain only needed audio/voice-derived data. Deletion is logical cleanup of app-owned data, not a promise of forensic erasure on SSDs or removal from external backups/Teams.
- Pin asset hashes, model revisions, runtime versions and licenses; do not execute model-supplied remote code without review. Some diarization downloads are gated even though offline inference is possible afterward.
- Account for CC-CEDICT data obligations separately from the pypinyin code license. Check model licensing before use or redistribution.
- Optional gateway mode remains disabled, with no automatic failover. Only allow the user-supplied existing gateway and exact approved aliases; obtain endpoint configuration securely later, not from unrelated repository secrets.
- Still to confirm before building: headset/speaker use, consent/retention policy, acceptable p95 delay, whether both local and remote speech need captions, permission to download gated models, and whether any Teams API integration is already authorized. Defaults above permit the local-audio design without API setup.

## Recommendation

Proceed with a **small desktop-transcript feasibility spike, then a local audio fallback that does not depend on it**. Build the model replay benchmark before the full UI. Start with Whisper turbo/Metal versus Qwen ASR/MLX, a quantized Qwen3.5-4B translator, a larger offline Qwen for grounded summaries, and dictionary-validated vocabulary. Only promote a specialist translator or native-streaming ASR after it wins on this Mac and this language mix.
