# Selected-model verification

**Research date:** 2026-11-09. Scope: the selected stack on an M5 Mac with 24 GiB unified memory, not a survey of alternatives. Sources are model authors' cards, license texts, or runtime maintainers' documentation. Runtime compatibility is documented, not tested on this Mac. No model weights were downloaded, software installed, meeting captured, or gateway contacted.

## Qwen3-ASR-1.7B on MLX

- [Qwen's model card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) identifies
  the checkpoint as Apache-2.0, supports recognition and language detection
  for 30 languages plus 22 Chinese dialects, and describes offline and streaming.
- **Backend qualification:** the card says its own `qwen-asr` package currently
  offers streaming only through vLLM, with neither batching nor timestamps in
  streaming mode. This is a limitation of that implementation, not proof that
  every MLX implementation lacks streaming.
- [mlx-audio's Qwen implementation](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/stt/models/qwen3_asr/README.md)
  documents MLX transcription and `stream_transcribe`; text deltas lack
  timestamps, while empty-text events provide coarse chunk extents. A separate
  forced aligner is documented for text-level timestamps. The example uses
  0.6B for streaming, while the same documentation lists 1.7B as supported;
  actual 1.7B streaming and timestamps on this M5 still need validation.
- Another runtime maintainer's [mlx-qwen3-asr](https://github.com/moona3k/mlx-qwen3-asr)
  documents both 1.7B and stateful streaming with bounded window re-decode and
  prefix rollback, including partial versus stable text. It is a third-party
  MLX reimplementation, not Qwen's official package. Its streaming example
  defaults to 0.6B unless a model is explicitly selected.
- An **illustrative candidate**, not a quantization decision, is
  [mlx-community/Qwen3-ASR-1.7B-8bit](https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit):
  its publisher says it converted Qwen's official 1.7B using mlx-audio 0.3.1;
  the publisher is `mlx-community`, not Qwen. Observed model revision:
  `a8379a2e2f9e313c9292cdf1af4055ab56d50d55`.
- Pin and review the chosen runtime, dependency versions, model revision,
  tokenizer and conversion provenance before future use. Benchmark quality,
  throughput, partial revisions and peak memory for the actual 1.7B variant;
  do not transfer M4 or NVIDIA results to this M5/24 GiB machine.
- **Timing integration:** a diarized transcript needs an explicit alignment
  strategy between recognized text and speaker-activity intervals. Do not
  promise word-speaker timestamps from untimed streaming text alone.

## PLaMo 3 Translate 0.8B MLX 4-bit

- The [PFN model card](https://huggingface.co/pfnet/plamo-3-translate-0.8b-MLX-4bit)
  specifies this exact PFN-published 4-bit model for Apple Silicon with
  `mlx-lm`; this establishes documented compatibility, not measured speed,
  quality, or simultaneous ASR/translation memory usage on the target Mac.
- Explicit language codes include `en`, `ja`, `zh-hans` (Simplified Chinese)
  and `zh-hant` (Traditional Chinese). Do not replace `zh-hant` with generic
  `zh` when Traditional Chinese is the intended output.
- A `target_lang` is required; `source_lang` is optional. Context and glossary
  entries are separate translation options, not a system message. The glossary
  uses source/target pairs; `form` is `plain` or `polite` only for Japanese.
- Previous source/translation pairs may be supplied as alternating user and
  assistant messages followed by the current source. History is not stored
  automatically; language direction is shared for the request. Context spans
  the request, while glossary and form apply to the current translation.
- PFN recommends direct **PFML3** prompts for application integration:
  `dataset=translation`, optional context, previous input/output pairs, optional
  glossary, current input, and an empty target-language output marker. Use the
  specified special tokens and stop sequences; validate/escape reserved tokens
  in untrusted transcript text instead of blindly concatenating it. The
  [published template](https://huggingface.co/pfnet/plamo-3-translate-0.8b-MLX-4bit/blob/1f9227818908350380fa576794c01f5fbcbf8569/chat_template.jinja)
  rejects reserved `<|plamo:` text. If generating direct prompts, reproduce
  equivalent protections and test output handling.
- PFN states a combined input/output training limit of 32,768 tokens; the
  bundled server rejects input tokens plus requested generation over that limit.
  Trim old history, bound output and concurrency, and test for truncation.
- PFN's documented loader requires `trust_remote_code=True` for both model and
  tokenizer. This executes repository code: review the bundled model,
  tokenizer and server code, pin and verify model revision and dependencies,
  and run with least privilege before any later installation. Observed model
  revision: `1f9227818908350380fa576794c01f5fbcbf8569`.

## Nemotron 3 Diarization: offline prototype

- [NVIDIA's model card](https://huggingface.co/nvidia/Nemotron-3-Diarization)
  documents offline and streaming operation, 16 kHz mono input and a `[T, 8]`
  per-speaker activity tensor. Eight channels are ordered by first arrival;
  they are anonymous labels, not verified identities. Plan for at most eight
  distinct voices for a recording/session, not merely eight concurrent voices.
  Overflow behavior and automatic detection of a ninth voice are not specified;
  do not claim a reliable warning. Accept the limit explicitly in prototype UX.
- **Important:** the card's 30.4-second “offline” configuration is *input
  buffer latency*, `(340 + 40) × 80 ms`, excluding compute and all other
  stages. It is not an end-to-end processing time or a realtime guarantee.
  Offline here means diarize a completed recording, even if internally chunked.
- NVIDIA's [official NeMo-Speech.cpp README](https://github.com/NVIDIA/NeMo-Speech.cpp)
  explicitly lists **Nemotron 3 Diarization**, separately from the older
  4-speaker V2, for standalone diarization. The
  [ASR model guide](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/asr/models.md#sortformer-speaker-diarization)
  calls V3 eight-speaker/10 ms, and the
  [CLI guide](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/cli.md#diarize-audio)
  confirms V3 support and standalone output. Select and verify V3 explicitly,
  rather than assuming the runtime's indexed default is the desired checkpoint.
- The [installer documentation](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/install.md)
  describes Apple Silicon Metal and CPU archives; CPU is a documented backend,
  not evidence of an automatic per-operation fallback. PyTorch MPS support for
  this exact model has not been established; do not promise it. Exact build,
  Metal execution, CPU fallback behavior, accuracy and performance remain to
  be tested on the actual Mac.
- In the CLI, a stateful chunked pass is the default for long recordings;
  `v3-offline` uses larger chunks/caches and is **not full attention**.
  The separate `--offline` full-attention path is limited to roughly 6.6
  minutes by the positional table. Configure and verify the effective preset;
  do not assume every runtime's defaults equal the card's 30.4 s configuration.
- The [conversion guide](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/model-conversion.md)
  explicitly supports conversion of the selected NVIDIA checkpoint to GGUF;
  choose and pin a supported runtime and artifact with known provenance.
  Existing local GGUF paths work without network, but missing indexed models
  can otherwise be downloaded automatically. Block unintended downloads.

## Authorized gateway text processing: engineering recommendations

- The user has authorized the existing free gateway's text models for transcript review/correction, overall and per-person summaries, and vocabulary. User-provided aliases are `deepseek-flash-gmi`
  (`deepseek-v4.1-flash-1017`) and `nemotron-3.5-lightning-30b-a3b-spc`
  (`nemotron-3.5-lightning-30b-a3b`); these mappings are user-provided, not
  independently verified. No endpoint, authentication, retention policy,
  model capability, or API format is known: do not infer or contact one.
- Local ASR, translation and offline diarization do not make this optional gateway stage local: sending transcript text crosses a network boundary.
  Before enabling it, confirm endpoint, approved data classification,
  participant consent, retention and provider policy; minimize disclosed text.
- Preserve raw ASR with timestamps and separate suggested corrections, with
  provenance and review. A text-only model cannot establish what was actually
  spoken or repair an unsupported attribution; retain uncertainty and source
  spans. Summaries and per-person views must not silently convert anonymous,
  ambiguous, overlapping or mistaken speaker labels into verified identities.
- Treat extracted vocabulary as proposals for user review, not ground truth; only approved entries should enter ASR context or the translation glossary.
  Future evaluation should use consented representative multilingual meeting
  samples and measure quality, diarization errors, latency and peak memory.
