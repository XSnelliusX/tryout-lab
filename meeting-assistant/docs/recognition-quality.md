# Context-aware recognition and offline refinement

This is an implementation of the existing local models, not a demonstrated
accuracy improvement. No model inference, meeting audio, or private transcript
was used to test it. The first consented live test still needs to assess
recognition, translation, latency and memory on this Mac.

## Hints, not corrections

- Qwen3-ASR is still the pinned 1.7B MLX model. The installed
  `mlx-audio==0.5.9` implementation takes `system_prompt` and `hotwords` in
  `qwen3_asr.py:generate`; `merge_hotwords` appends the terms to the prompt.
  The meeting context is reference text in `system_prompt`; enabled vocabulary
  terms are passed as hotwords. `language=None` retains automatic detection;
  it does not force Chinese or exclude English code-switching.
- For example, a software-engineering meeting could include “container
  protection” and “phase one” as hints. Hints are bias, not proof; the model
  can still hear “content production” or “VOne”. There are **no global
  replacements** and no fixed mapping of those ambiguous phrases. The original
  recognition remains evidence; OpenCC is a separate display rendering.
- PLaMo remains the pinned 0.8B translation model. The hash-verified PFN
  `chat_template.jinja` places context after `dataset`, optional earlier
  source/translation pairs next, glossary pairs immediately before the current
  input, and an English output marker last. The direct PFML3 builder follows
  this format; it does not invent a chatbot system instruction or force a source
  language. Only enabled entries with a nonempty translation enter the
  glossary; `note`, `known`, and `id` are not sent to either model.
- Context is limited to 4,000 characters, vocabulary to 128 entries, terms to
  200 and glossary targets to 500 characters. History is optional,
  caller-supplied, up to eight pairs / 8,000 characters total; it is never
  implicitly retained or populated from unreviewed refinement outputs. Source,
  context, enabled terms, translations and history reject reserved control
  tokens. Qwen hint tokens plus conservative audio and output reserves are
  checked against the pinned model's 65,536-position context. PLaMo prompt
  plus generation is checked against 32,768 tokens, and truncation raises an
  error. Both generation limits are bounded; long offline
  recognition uses 1,024 tokens, with a raised translation budget for longer
  inputs. Limits do not guarantee sufficient output for every passage.

An oversized prompt raises an error rather than silently dropping glossary
entries. Model file hashes, trusted-code class checks, and the existing
unsuppressed tokenizer warning are unchanged.

## Refinement behavior and evidence

`refine_session` reads only `audio.wav` as uncompressed mono 16-bit 16 kHz PCM,
up to 12 hours, in bounded windows. It scans 100 ms RMS frames using the live
capture threshold (0.008), skips low-energy windows, adds 0.2 s pre-roll and
uses up to 24 s of audio. Where possible it cuts on 0.6 s of quiet in the last
six seconds; otherwise successive windows overlap by 1.5 s. An overlap-only
silent tail is not retranscribed. This is an energy heuristic, **not VAD**: quiet
speech can be lost and non-speech can trigger the model. Errors fail the pass
instead of pretending a partial result is complete; cancellation is checked
between operations but cannot interrupt an in-flight inference call.

Each returned `segments` entry is a **whole-window review candidate** containing
new raw and Traditional text, English, coarse window start/end, and anonymous
speaker. It has no exact mapping to original transcript segments and is not a
replacement proposal. Nothing edits the archive or reference transcript. Exact
normalized whole-window matches between overlapping windows are flagged as
possible duplicates, not removed; genuine repeated speech cannot be distinguished
without alignment. Partial overlaps can still duplicate words and different
recognitions of an overlap remain unmerged. Neither word timestamps nor speaker
identity are inferred. Review candidates against original audio before copying
any text into a versioned edit. Applying a whole pass would require a separately
designed, explicitly reviewed workflow that preserves original evidence.

Provenance reports the detector, boundaries, overlap and token budget; limitations
are returned with the proposals. `progress` receives a dictionary containing
`stage`, `processed_seconds`, `total_seconds`, and `percent`. A true
`cancelled()` raises `RefinementCancelled` with no partial result. Unit tests use
synthetic WAV files and fake models; they test orchestration, not quality.

## Sources

- [Qwen3-ASR-1.7B model card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B),
  including automatic language detection, generation budget and separate forced
  aligner for timestamps.
- Installed `mlx_audio/stt/models/qwen3_asr/qwen3_asr.py` and
  `mlx_audio/stt/utils.py` from the pinned environment, for actual hint wiring.
- [PFN PLaMo 3 Translate MLX model card at the pinned revision](https://huggingface.co/pfnet/plamo-3-translate-0.8b-MLX-4bit/blob/1f9227818908350380fa576794c01f5fbcbf8569/README.md)
  and its [reviewed template](https://huggingface.co/pfnet/plamo-3-translate-0.8b-MLX-4bit/blob/1f9227818908350380fa576794c01f5fbcbf8569/chat_template.jinja).
