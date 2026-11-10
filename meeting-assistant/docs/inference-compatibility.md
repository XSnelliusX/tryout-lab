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
