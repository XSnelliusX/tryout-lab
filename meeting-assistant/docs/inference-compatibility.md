# PLaMo model-type warning

With the pinned `mlx-lm==0.32.0` and `transformers==5.19.0`, starting the local
PLaMo translator may print a warning that a model of type `plamo3` is being
instantiated as type `""`. The installed source points to a **generic
Transformers configuration used while choosing a tokenizer**, not an attempt
to instantiate the MLX inference architecture as an empty model type. The
warning alone does not establish that the checkpoint was loaded incorrectly,
but it does not establish that translation works, either.

## Source trace

Paths below are relative to `.venv/lib/python3.13/site-packages/` and refer to
the versions above:

1. `meeting_assistant/inference.py` passes the verified local model path to
   `mlx_lm.load`, enabling the custom model and tokenizer code for this fixed
   checkpoint only.
2. `mlx_lm/utils.py:444-482` reads the local `config.json`, imports its
   `model_file` as `custom_model`, then constructs that module's `Model` from
   `ModelArgs`. The pinned config specifies `model_type: plamo3` and
   `model_file: modeling_plamo_mlx.py`. Weight loading is strict by default
   (`mlx_lm/utils.py:410-414,571-575`).
3. Separately, `mlx_lm/utils.py:661-663` and `mlx_lm/tokenizer_utils.py:698-700`
   call `AutoTokenizer.from_pretrained` using that same local directory.
4. `transformers/models/auto/tokenization_auto.py:805-811` first tries
   `AutoConfig.from_pretrained`, then falls back to the generic
   `PreTrainedConfig.from_pretrained` on a `ValueError` or `OSError`. The
   installed `transformers/models/auto/configuration_auto.py` has no `plamo3`
   mapping; the pinned model config has no `AutoConfig` custom-code mapping.
   Therefore the fallback is the applicable path for this checkpoint.
5. `transformers/configuration_utils.py:298,742-763` compares the JSON's
   `plamo3` against the generic class's empty `model_type` and emits the
   warning. This metadata object is used by the tokenizer selection path; it
   is not the MLX model constructed in step 2.
6. The pinned `tokenizer_config.json` maps `AutoTokenizer` to
   `tokenization_plamo.Plamo3Tokenizer` and has no fast tokenizer entry.
   `transformers/models/auto/tokenization_auto.py:820-827,926-948` resolves
   that custom tokenizer when trusted. `mlx_lm` wraps the returned tokenizer.

`LocalModels.load()` checks the model class, its `plamo3` model type, and the
wrapped tokenizer class after loading. If these do not match the expected
classes, loading fails rather than declaring the models ready. The app does not
change the pinned model files or suppress Transformers warnings globally.
The checks complement the existing file hashes and strict weight loading; they
are not a functional or quality test. Model loading, live audio, and translation
were not run as part of this investigation.

# Streaming ASR decode and its fallback

`LocalModels.transcribe` decodes through `Qwen3ASRModel.stream_generate`
(`mlx_audio/stt/models/qwen3_asr/qwen3_asr.py:947-1049` in `mlx-audio==0.5.9`),
which yields raw `(token_id, logprobs)` pairs and stops before EOS. The wrapper
collects the ids, polls `should_cancel` after each one (raising `Cancelled`),
then decodes the whole sequence once with `skip_special_tokens=True` and, in
auto mode, splits the `language X<asr_text>` prefix with the library's own
`extract_language` (`:903-913`). This is the same sequence of calls as the
non-streaming `_generate_single_chunk` (`:1051-1091`), including padding clips
shorter than one second, so the text and token counts match `generate()`.

`generate(stream=True)` (`stream_transcribe`, `:1533-1685`) is deliberately not
used: its `StreamingResult.text` is each token decoded on its own (`:1640`),
the first three tokens are hidden in auto mode (`:1642`), and its final
result's `generation_tokens` excludes them (`:1666`), which would break the
`generation_tokens >= budget` truncation test.

If the streaming path raises anything other than `Cancelled` (missing method,
changed yield shape, `TypeError`, import failure after an upgrade), the wrapper
records only the exception type in `LocalModels.streaming_fallback_reason` and
uses the one-shot `generate()` for that and every later call of the instance.
Recognition still works, but `should_cancel` is then checked only before and
after each decode. Audio encoding and prompt prefill happen before the first
token in both paths and cannot be interrupted.

On 13 November 2026 the streaming path was checked against the pinned models
on the owner's Mac (5 archived 10-second excerpts plus synthetic noise, tone
and silence; no text recorded): streamed and one-shot text and token counts
were identical, the fallback was never triggered, cancellation stopped ASR
after about 0.2 s and translation after about 0.07 s, and noise, a tone and
silence all returned the model's `language None<asr_text>` (no speech) in auto
mode, while forcing Chinese made the model emit two characters for each.
