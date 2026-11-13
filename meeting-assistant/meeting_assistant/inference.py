"""Local-only Qwen ASR and PLaMo translation, for one segment at a time.

The caller owns audio segmentation, voice activity detection, result ordering,
and serialization of requests. This module never downloads models or sends
audio or text anywhere. Model files are installed by scripts/download_models.py.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Callable

# Set before importing either model runtime. The application can also set this
# at process start; never turn offline mode off in the inference process.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

import numpy as np


_ASR_DIR = "qwen3-asr-1.7b-8bit"
_TRANSLATOR_DIR = "plamo-3-translate-0.8b-4bit"

# Hashes from the fixed model revisions. Checking config as well as Python code
# prevents an edited model_file/auto_map from selecting unreviewed code.
_ASR_FILES = {
    "chat_template.json": "75a8cfca24f00de72d796fbfed6858fc9614ef3dabd8696684cc3bc03a9c58ff",
    "config.json": "1b76b3b6c655fc54595da025f7a96474ad9fa86363303fbdd61a7d8483ccfaf7",
    "generation_config.json": "1da527824d81e07118facff437e03f2e24a23311e3bdeb2368973fe77e5f275c",
    "merges.txt": "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
    "model.safetensors.index.json": "0a5d0ec11188602242ff81a9969883d0fdeb98cd5d85cd1413089d897c201af5",
    "model.safetensors": "bf304b009cc7eca79283056f787b44c952d24ac22cec787b39732bba3c23c13c",
    "preprocessor_config.json": "45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d",
    "tokenizer_config.json": "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
    "vocab.json": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
}
_TRANSLATOR_FILES = {
    "config.json": "5175a9cd6ba7bab7eecafc508aa3278e58ece44d8edafa4a175ca067c4ed8c69",
    "generation_config.json": "0410d30499cd9db0a83ecbd59a2811b1c4f63f7c9412126a43e8d2b96ec44a85",
    "chat_template.jinja": "633ae24b5166d2c958d9b0a39523f2cc5bd6832752ec2ab0285793cab6415323",
    "model.safetensors": "4769685905d03c7f5ceaef316cbef245c9099f548f8dea00ecfdf980d698b29f",
    "modeling_plamo_mlx.py": "eb6a576df1c20e9d40653671c8e63ded584661aa3f858ff5bee620357b479367",
    "tokenization_plamo.py": "68b769d516541603857ce9d2813e48193efe41abb64c1091311b973d491724d9",
    "tokenizer.jsonl": "bdce9e430e65931b28c56de2054f52b4cf8ed59b322db125e016d724d06dbb0e",
    "tokenizer_config.json": "5468ed5c68b5cf4cf971bcb34be6bfbfd749fe30cc5bc65ace5835ae3bff65b3",
    "special_tokens_map.json": "1004b03ad5c184693765d25d8d682e831727b43b84e321fc9dc14d9ef3d1466a",
}
_MAX_TOKENS = 256
_MAX_INPUT_CHARS = 5000
_MAX_AUDIO_SECONDS = 30
_MAX_CONTEXT_CHARS = 4000
_MAX_VOCABULARY = 128
_MAX_TERM_CHARS = 200
_MAX_TRANSLATION_TERM_CHARS = 500
_MAX_HISTORY_PAIRS = 8
_MAX_HISTORY_CHARS = 8000
_MAX_ASR_TOKENS = 2048
_ASR_CONTEXT_TOKENS = 65536  # pinned Qwen text_config.max_position_embeddings
_ASR_AUDIO_RESERVE = 2048  # > 30s of audio tokens plus prompt control tokens
# Default ASR output budget is 32 + 16 tokens per second of audio, capped. Fast
# Mandarin is about 5-6 characters (roughly as many tokens) per second, so this
# leaves about 3x headroom while bounding a runaway repetition loop on noise to
# a fraction of a second of decoding per second of audio. 30 s -> 512 tokens.
_ASR_TOKENS_BASE = 32
_ASR_TOKENS_PER_SECOND = 16
_MAX_TOKENS_CAP = 512
# Public language choices -> names in the pinned config's support_languages.
_ASR_LANGUAGES = {"auto": None, "zh": "Chinese", "en": "English"}
# Detected languages accepted as-is in auto mode; anything else (for example a
# Taiwanese Mandarin clip detected as Japanese) is decoded again as Chinese.
_EXPECTED_LANGUAGES = {"chinese", "english", "cantonese"}
_ON_TEXT_INTERVAL = 0.08  # seconds between partial translation callbacks
# A unit of 1-24 characters starting and ending with non-space, followed by at
# least four more copies (five in a row), optionally whitespace separated.
# Both quantifiers are lazy so the shortest repeating unit is tried first.
_REPEAT_RE = re.compile(r"(\S(?:.{0,22}?\S)??)(?:\s*\1){4,}", re.DOTALL)


class Cancelled(Exception):
    """Raised when ``should_cancel`` returned True during model inference."""


def _collapse_repetitions(text: str) -> str:
    """Collapse decoder loops such as a phrase repeated dozens of times.

    A unit (1-24 characters, which covers short word sequences) repeated five or
    more times in a row is reduced to two copies when it is at most two
    characters long ("哈哈", "OK OK") and to one copy otherwise. Units without
    any letter or CJK character (digits, punctuation) are left alone so that
    numbers such as 100000 are never changed. Shorter runs are untouched.
    """
    if not text:
        return text

    def collapse(match):
        unit = match.group(1)
        if not any(ch.isalpha() for ch in unit):
            return match.group(0)
        if len(unit) > 2:
            return unit
        separator = " " if re.search(r"\s", match.group(0)) else ""
        return unit + separator + unit

    for _ in range(3):  # a collapsed inner loop can expose an outer one
        collapsed = _REPEAT_RE.sub(collapse, text)
        if collapsed == text:
            break
        text = collapsed
    return text


def _asr_budget(seconds: float) -> int:
    return min(_MAX_TOKENS_CAP, _ASR_TOKENS_BASE + math.ceil(_ASR_TOKENS_PER_SECOND * max(0.0, seconds)))


def _check_cancel(should_cancel) -> None:
    if should_cancel is not None and should_cancel():
        raise Cancelled("Inference cancelled")


def _checked_text(value, name, limit, *, allow_empty=True):
    """Reject special-token injection before embedding any user-controlled text."""
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if len(value) > limit:
        raise ValueError(f"{name} is too long")
    if not allow_empty and not value.strip():
        raise ValueError(f"{name} must not be empty")
    # Qwen uses chat/audio tokens and <asr_text>; PFML uses <|plamo:...|>.
    if ("<|" in value or "\x00" in value or
            re.search(r"</?(?:asr_text|tts_[a-z0-9_]+|blank\d+|tool_call)>", value, re.IGNORECASE)):
        raise ValueError(f"{name} contains a reserved model token")
    return value


def _hints(context, vocabulary):
    context = _checked_text(context, "context", _MAX_CONTEXT_CHARS)
    if vocabulary is None:
        vocabulary = []
    if not isinstance(vocabulary, (list, tuple)):
        raise TypeError("vocabulary must be a list of objects")
    if len(vocabulary) > _MAX_VOCABULARY:
        raise ValueError("vocabulary exceeds 128 entries")
    hotwords, glossary = [], []
    for entry in vocabulary:
        if not isinstance(entry, dict):
            raise TypeError("vocabulary entries must be objects")
        if entry.get("enabled", False) is not True:
            continue
        term = _checked_text(entry.get("term"), "vocabulary term", _MAX_TERM_CHARS, allow_empty=False)
        translation = _checked_text(entry.get("translation", ""), "vocabulary translation", _MAX_TRANSLATION_TERM_CHARS)
        hotwords.append(term.strip())
        if translation.strip():
            glossary.append((term, translation))
    return context, hotwords, glossary


def _history_pairs(history):
    """Accept source/target pairs or alternating chat messages, oldest first."""
    if history is None:
        return []
    if not isinstance(history, (list, tuple)):
        raise TypeError("history must be a sequence of source/translation pairs")
    if len(history) > _MAX_HISTORY_PAIRS * 2:
        raise ValueError("translation history is too long")
    if history and isinstance(history[0], dict) and "role" in history[0]:
        if len(history) % 2:
            raise ValueError("history must alternate user and assistant messages")
        pairs = []
        for i in range(0, len(history), 2):
            source, target = history[i:i + 2]
            if (not isinstance(source, dict) or not isinstance(target, dict)
                    or source.get("role") != "user" or target.get("role") != "assistant"):
                raise ValueError("history must alternate user and assistant messages")
            pairs.append((source.get("content"), target.get("content")))
    else:
        pairs = []
        for pair in history:
            if isinstance(pair, dict):
                pairs.append((pair.get("source"), pair.get("target")))
            elif isinstance(pair, (list, tuple)) and len(pair) == 2:
                pairs.append(tuple(pair))
            else:
                raise ValueError("history entries must be source/translation pairs")
    if len(pairs) > _MAX_HISTORY_PAIRS:
        raise ValueError("translation history exceeds 8 pairs")
    checked = [(_checked_text(a, "history source", _MAX_INPUT_CHARS, allow_empty=False),
                _checked_text(b, "history translation", _MAX_INPUT_CHARS, allow_empty=False))
               for a, b in pairs]
    if sum(len(a) + len(b) for a, b in checked) > _MAX_HISTORY_CHARS:
        raise ValueError("translation history is too long")
    return checked


# Exact 53 language codes documented in PLaMo 3 Translate 0.8B README + ja-easy alias.
PLAMO_LANGUAGES = (
    ("zh-hant", "Chinese (Traditional)"),
    ("zh-hans", "Chinese (Simplified)"),
    ("en", "English"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("fr", "French"),
    ("de", "German"),
    ("es", "Spanish"),
    ("it", "Italian"),
    ("vi", "Vietnamese"),
    ("th", "Thai"),
    ("id", "Indonesian"),
    ("ms", "Malay"),
    ("nl", "Dutch"),
    ("pl", "Polish"),
    ("ru", "Russian"),
    ("ar", "Arabic"),
    ("hi", "Hindi"),
    ("az", "Azerbaijani"),
    ("be", "Belarusian"),
    ("bg", "Bulgarian"),
    ("bn", "Bengali"),
    ("ca", "Catalan"),
    ("ceb", "Cebuano"),
    ("et", "Estonian"),
    ("eu", "Basque"),
    ("fa", "Persian"),
    ("gu", "Gujarati"),
    ("he", "Hebrew"),
    ("hr", "Croatian"),
    ("hu", "Hungarian"),
    ("hy", "Armenian"),
    ("ja-easy", "Japanese (Easy)"),
    ("jv", "Javanese"),
    ("ka", "Georgian"),
    ("kk", "Kazakh"),
    ("km", "Khmer"),
    ("lt", "Lithuanian"),
    ("lv", "Latvian"),
    ("ml", "Malayalam"),
    ("mr", "Marathi"),
    ("my", "Burmese"),
    ("ne", "Nepali"),
    ("pa", "Punjabi"),
    ("si", "Sinhala"),
    ("sk", "Slovak"),
    ("sl", "Slovenian"),
    ("sr", "Serbian"),
    ("sw", "Swahili"),
    ("ta", "Tamil"),
    ("te", "Telugu"),
    ("tl", "Tagalog"),
    ("ur", "Urdu"),
    ("uz", "Uzbek"),
)
_PLAMO_CODES = {code for code, _ in PLAMO_LANGUAGES}


def supported_languages() -> dict:
    """Return UI-ready source and target language options supported by PLaMo 3 Translate."""
    targets = [{"code": code, "label": label} for code, label in PLAMO_LANGUAGES]
    return {
        "source": [{"code": "auto", "label": "Auto-detect"}, *targets],
        "target": targets,
    }


def validate_language_pair(source_lang: str | None, target_lang: str | None) -> tuple[str | None, str]:
    """Validate and normalize translation language pair against PLaMo 3 Translate."""
    if source_lang is None:
        src = None
    elif not isinstance(source_lang, str):
        raise ValueError("Source language must be a string.")
    else:
        raw_src = source_lang.strip().lower()
        if raw_src == "ja(easy)":
            raw_src = "ja-easy"
        if raw_src in ("", "auto"):
            src = None
        elif raw_src == "zh":
            raise ValueError("Specify Traditional Chinese ('zh-hant') or Simplified Chinese ('zh-hans').")
        elif raw_src not in _PLAMO_CODES:
            raise ValueError(f"Unsupported source language: {source_lang}.")
        else:
            src = raw_src

    if not isinstance(target_lang, str) or not target_lang.strip():
        raise ValueError("Target language is required.")
    raw_tgt = target_lang.strip().lower()
    if raw_tgt == "ja(easy)":
        raw_tgt = "ja-easy"
    if raw_tgt == "auto":
        raise ValueError("Target language cannot be auto-detect.")
    if raw_tgt == "zh":
        raise ValueError("Specify Traditional Chinese ('zh-hant') or Simplified Chinese ('zh-hans').")
    if raw_tgt not in _PLAMO_CODES:
        raise ValueError(f"Unsupported target language: {target_lang}.")

    if src is not None and src == raw_tgt:
        raise ValueError("Source and target languages must be different.")
    return src, raw_tgt


def _translation_prompt(text, context, glossary, history, *, source_lang: str | None = None, target_lang: str = "en"):
    """PFML3 in the order of the hash-pinned PFN chat_template.jinja."""
    src_prefix = (
        f"<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>{source_lang}<|plamo:msg|>"
        if source_lang and source_lang != "auto"
        else "<|plamo:tag|>input<|plamo:msg|>"
    )
    output = f"<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>{target_lang}<|plamo:msg|>"
    prompt = "<|plamo:bos|><|plamo:tag|>dataset<|plamo:msg|>translation"
    if context:
        prompt += "<|plamo:tag|>context<|plamo:msg|>" + context
    for source, target in history:
        prompt += src_prefix + source + output + target
    if glossary:
        prompt += "<|plamo:tag|>glossary"
        for source, target in glossary:
            prompt += "<|plamo:index|>" + source + "<|plamo:item|>" + target
    return prompt + src_prefix + text + output


def _verify_model(path: Path, expected: dict[str, str]) -> None:
    if not path.is_dir():
        raise FileNotFoundError(
            f"Model files missing at {path}. Run scripts/download_models.py first."
        )
    # Both loaders glob for weights, so don't allow extra weight files to override
    # the verified checkpoint. Reject symlinks inside the trusted file set too.
    if {p.name for p in path.glob("*.safetensors")} != {"model.safetensors"}:
        raise RuntimeError(f"Unexpected or missing model weights in {path}")
    # Transformers also looks for these optional tokenizer inputs. The pinned
    # revisions contain none of them; an unverified leftover can silently alter
    # tokenization even when tokenizer_config.json itself matches.
    for name in ("tokenizer.json", "added_tokens.json", "chat_templates"):
        if (path / name).exists():
            raise RuntimeError(f"Unexpected tokenizer file in model directory: {path / name}")
    if "special_tokens_map.json" not in expected and (path / "special_tokens_map.json").exists():
        raise RuntimeError(f"Unexpected tokenizer file in model directory: {path / 'special_tokens_map.json'}")
    for name, digest in expected.items():
        file = path / name
        if not file.is_file() or file.is_symlink():
            raise FileNotFoundError(f"Missing or unsafe model file: {file}")
        hasher = hashlib.sha256()
        with file.open("rb") as stream:
            while chunk := stream.read(8 * 1024 * 1024):
                hasher.update(chunk)
        if hasher.hexdigest() != digest:
            raise RuntimeError(f"Model file failed integrity verification: {file}")


def _install_transformers_tokenizer_compatibility() -> None:
    """Restore the old import name required by the pinned PFN tokenizer.

    Transformers 5.19 renamed tokenization_utils to tokenization_python but
    still exports the same PreTrainedTokenizer base as PythonBackend. The
    reviewed PFN file imports only that class from the old module. The alias
    changes no downloaded files; remove it when PFN updates their pinned code.
    """
    import importlib.util

    name = "transformers.tokenization_utils"
    if name not in sys.modules and importlib.util.find_spec(name) is None:
        import transformers.tokenization_python

        sys.modules[name] = transformers.tokenization_python


class LocalModels:
    """Load the fixed models from ``data_dir/models`` and infer locally."""

    def __init__(
        self, data_dir: Path, status_callback: Callable[[str], None] | None = None
    ) -> None:
        self.data_dir = Path(data_dir).expanduser().resolve()
        self._status_callback = status_callback
        self._lock = threading.RLock()
        self._asr = None
        self._translator = None
        self._tokenizer = None
        self._converter = None
        # Set once the token-streaming ASR path fails; later calls then use the
        # library's one-shot generate() and cannot be cancelled mid-decode.
        self.streaming_fallback_reason: str | None = None
        # Set when meeting_assistant.levels cannot be imported; audio is then
        # decoded at its recorded level.
        self.normalization_unavailable_reason: str | None = None

    def _status(self, message: str) -> None:
        if self._status_callback is not None:
            self._status_callback(message)

    def load(self) -> None:
        """Load both pre-downloaded and verified models; never download on miss."""
        with self._lock:
            if self._asr is not None and self._translator is not None:
                return
            asr_path = self.data_dir / "models" / _ASR_DIR
            translator_path = self.data_dir / "models" / _TRANSLATOR_DIR
            self._status("Verifying local model files")
            _verify_model(asr_path, _ASR_FILES)
            _verify_model(translator_path, _TRANSLATOR_FILES)

            from mlx_audio.stt import load as load_asr
            from mlx_lm import load as load_translator
            from opencc import OpenCC

            self._status("Loading speech recognition model")
            asr = load_asr(asr_path)
            self._status("Loading translation model")
            _install_transformers_tokenizer_compatibility()
            # This is the only trusted custom model: its code, configuration,
            # tokenizer and weights were verified above against fixed hashes.
            translator, tokenizer = load_translator(
                str(translator_path),
                trust_remote_code=True,
                tokenizer_config={"trust_remote_code": True, "local_files_only": True},
            )
            # Transformers may warn while reading generic tokenizer metadata;
            # verify the actual classes MLX returned instead of silencing it.
            # See docs/inference-compatibility.md for the pinned loader path.
            model_class = type(translator)
            tokenizer_class = type(tokenizer._tokenizer)
            if (
                model_class.__module__ != "custom_model"
                or model_class.__name__ != "Model"
                or getattr(translator, "model_type", None) != "plamo3"
                or tokenizer_class.__module__.split(".")[-1] != "tokenization_plamo"
                or tokenizer_class.__name__ != "Plamo3Tokenizer"
            ):
                raise RuntimeError("Unexpected local PLaMo model or tokenizer class")
            tokenizer.add_eos_token("<|plamo:tag|>")
            converter = OpenCC("s2twp")
            self._asr, self._translator = asr, translator
            self._tokenizer, self._converter = tokenizer, converter
            self._status("Local models ready")

    def _normalize(self, samples: np.ndarray, speech_db) -> tuple[np.ndarray, float]:
        try:
            from .levels import normalize_for_asr
        except ImportError:
            self.normalization_unavailable_reason = "meeting_assistant.levels is not available"
            return samples, 0.0
        normalized, gain_db = normalize_for_asr(samples, speech_db=speech_db)
        normalized = np.asarray(normalized)
        if (normalized.shape != samples.shape or normalized.dtype.kind != "f"
                or not np.isfinite(normalized).all()):
            raise RuntimeError("Level normalization returned an invalid waveform")
        gain_db = float(gain_db)
        if not math.isfinite(gain_db):
            raise RuntimeError("Level normalization returned an invalid gain")
        return np.ascontiguousarray(normalized, dtype=np.float32), gain_db

    def _decode_streaming(self, samples, language, context, hotwords, budget, should_cancel):
        """Token-by-token decode reproducing mlx-audio's _generate_single_chunk.

        ``generate(stream=True)`` is not used: its StreamingResult text is each
        token decoded on its own (split UTF-8 characters become U+FFFD), and in
        auto mode it hides the first three tokens from text and counts. Model
        ``stream_generate`` yields raw token ids instead, so the whole sequence
        is decoded once, exactly as the non-streaming path does.
        """
        from mlx_audio.lm.sample_utils import make_sampler
        from mlx_audio.stt.utils import merge_hotwords

        model = self._asr
        system_prompt = merge_hotwords(context or None, hotwords or None)
        # split_audio_into_chunks pads clips shorter than 1 s with zeros; our
        # clips never exceed one 1200 s chunk.
        if samples.size < 16000:
            samples = np.pad(samples, (0, 16000 - samples.size))
        sampler = make_sampler(0.0, 1.0, 0.0, min_tokens_to_keep=1, top_k=0)
        token_ids = []
        stream = model.stream_generate(
            samples, max_tokens=budget, sampler=sampler, language=language,
            verbose=False, system_prompt=system_prompt,
        )
        try:
            for item in stream:
                token, _ = item
                token_ids.append(int(token))
                if len(token_ids) > budget:
                    raise RuntimeError("streaming ASR exceeded its token budget")
                _check_cancel(should_cancel)
        finally:
            close = getattr(stream, "close", None)
            if close is not None:
                close()
        text = model._tokenizer.decode(token_ids, skip_special_tokens=True)
        if not isinstance(text, str):
            raise TypeError("ASR tokenizer returned non-text")
        detected = language
        if language is None:
            parsed = model.extract_language(text)
            if (not isinstance(parsed, tuple) or len(parsed) != 2
                    or not all(isinstance(part, str) for part in parsed)):
                raise TypeError("unexpected extract_language result")
            detected, text = parsed
        prompt_tokens = 0
        try:  # Counted as the library does; informational only.
            _, _, audio_tokens = model._preprocess_audio(samples)
            prompt_tokens = int(model._build_prompt(audio_tokens, language, system_prompt).shape[1])
        except Exception:
            prompt_tokens = 0
        return text, detected, prompt_tokens, len(token_ids)

    def _decode_generate(self, samples, language, context, hotwords, budget):
        result = self._asr.generate(
            audio=samples, language=language, max_tokens=budget,
            temperature=0.0, verbose=False,
            system_prompt=context or None, hotwords=hotwords or None,
        )
        # STTOutput.language is a list with one entry per audio chunk; our
        # clips are one chunk. A missing value means "unknown", not no speech.
        detected = getattr(result, "language", None)
        if isinstance(detected, (list, tuple)):
            detected = detected[0] if detected else None
        if detected is None:
            detected = language
        text = result.text
        if not isinstance(text, str):
            raise TypeError("ASR returned non-text")
        return (text, detected if isinstance(detected, str) else None,
                int(getattr(result, "prompt_tokens", 0) or 0),
                int(getattr(result, "generation_tokens", 0) or 0))

    def _decode(self, samples, language, context, hotwords, budget, should_cancel):
        """Return (text, language, prompt_tokens, generation_tokens) for one decode."""
        _check_cancel(should_cancel)
        if self.streaming_fallback_reason is None:
            try:
                return self._decode_streaming(samples, language, context, hotwords, budget, should_cancel)
            except Cancelled:
                raise
            except Exception as exc:
                # Only the exception type: messages could quote model output.
                self.streaming_fallback_reason = f"{type(exc).__name__} in streaming ASR decode"
        decoded = self._decode_generate(samples, language, context, hotwords, budget)
        _check_cancel(should_cancel)
        return decoded

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000, *,
                   context: str = "", vocabulary=None, max_tokens=None,
                   language: str = "auto", normalize: bool = True, speech_db=None,
                   should_cancel: Callable[[], bool] | None = None) -> dict:
        """Return ASR text, an OpenCC Taiwan Traditional rendering and metadata.

        ``audio`` is a mono floating-point waveform; sample rates other than
        16 kHz are resampled. An almost-zero energy guard suppresses pure
        silence; it is not a substitute for upstream VAD. ``language`` is
        "auto", "zh" or "en". With ``normalize`` the waveform is brought to a
        speech level suited to the recognizer (``speech_db`` is the caller's
        speech-level estimate, if any). ``should_cancel`` is polled between
        generated tokens and raises :class:`Cancelled`. Reaching the token
        budget does not raise: the text is returned with ``truncated`` set.
        ``raw_text`` is the model text after collapsing runaway repetitions.
        """
        if not isinstance(language, str) or language not in _ASR_LANGUAGES:
            raise ValueError("language must be 'auto', 'zh' or 'en'")
        if should_cancel is not None and not callable(should_cancel):
            raise TypeError("should_cancel must be callable")
        with self._lock:
            started = time.monotonic()
            if self._asr is None or self._converter is None:
                raise RuntimeError("Local models are not loaded")
            context, hotwords, _ = _hints(context, vocabulary)
            if max_tokens is not None and (isinstance(max_tokens, bool) or not isinstance(max_tokens, int)
                                           or not 1 <= max_tokens <= _MAX_ASR_TOKENS):
                raise ValueError("max_tokens must be an integer between 1 and 2048")
            if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
                raise ValueError("sample_rate must be a positive integer")
            samples = np.asarray(audio)
            if samples.ndim != 1 or samples.dtype.kind != "f":
                raise ValueError("audio must be a mono floating-point waveform")
            if samples.size > sample_rate * _MAX_AUDIO_SECONDS:
                raise ValueError("audio segment exceeds 30 seconds")
            if not np.isfinite(samples).all():
                raise ValueError("audio contains non-finite values")
            budget = _asr_budget(samples.size / sample_rate) if max_tokens is None else max_tokens
            result = {
                "raw_text": "", "traditional_text": "", "language": None,
                "no_speech": True, "truncated": False, "redecoded": False,
                "gain_db": 0.0, "asr_ms": 0, "prompt_tokens": 0, "generation_tokens": 0,
            }
            if samples.size == 0 or np.max(np.abs(samples)) < 1e-5:
                result["asr_ms"] = int(round((time.monotonic() - started) * 1000))
                return result
            if sample_rate != 16000:
                from scipy.signal import resample_poly
                from math import gcd

                divisor = gcd(sample_rate, 16000)
                samples = resample_poly(samples, 16000 // divisor, sample_rate // divisor)
            samples = np.ascontiguousarray(samples, dtype=np.float32)
            if normalize:
                samples, result["gain_db"] = self._normalize(samples, speech_db)
            # mlx-audio's merge_hotwords joins these exact terms into the system
            # prompt. Count them with the pinned model tokenizer; reserve more
            # than the 30-second audio encoding and the requested output budget.
            if context or hotwords:
                hint_text = context + ("\n" if context and hotwords else "") + ", ".join(hotwords)
                hint_tokens = self._asr._tokenizer.encode(hint_text)
                if len(hint_tokens) + _ASR_AUDIO_RESERVE + budget > _ASR_CONTEXT_TOKENS:
                    raise ValueError("ASR hints exceed the model context limit")
            forced = _ASR_LANGUAGES[language]
            text, detected, prompt_tokens, generation_tokens = self._decode(
                samples, forced, context, hotwords, budget, should_cancel)
            if forced is None and isinstance(detected, str):
                key = detected.strip().lower()
                if key in ("", "none"):
                    # The model's own no-speech answer: "language None<asr_text>".
                    text, detected = "", None
                elif key not in _EXPECTED_LANGUAGES and text.strip():
                    text, detected, prompt_tokens, generation_tokens = self._decode(
                        samples, "Chinese", context, hotwords, budget, should_cancel)
                    result["redecoded"] = True
            raw_text = _collapse_repetitions(text)
            result.update(
                raw_text=raw_text,
                traditional_text=self._converter.convert(raw_text),
                language=detected,
                no_speech=not raw_text.strip(),
                truncated=generation_tokens >= budget,
                prompt_tokens=prompt_tokens,
                generation_tokens=generation_tokens,
                asr_ms=int(round((time.monotonic() - started) * 1000)),
            )
            return result

    def translate(self, text: str, *, context: str = "", vocabulary=None, history=None,
                  source_lang: str | None = None, target_lang: str = "en",
                  on_text: Callable[[str], None] | None = None,
                  should_cancel: Callable[[], bool] | None = None) -> str:
        """Translate between supported PLaMo languages; optional history is never retained.

        ``on_text`` receives the cumulative translation as it grows (at most
        about every 80 ms) and once more with the final text; its exceptions
        are swallowed and stop further calls. ``should_cancel`` is polled
        between generated tokens and raises :class:`Cancelled`.
        """
        if on_text is not None and not callable(on_text):
            raise TypeError("on_text must be callable")
        if should_cancel is not None and not callable(should_cancel):
            raise TypeError("should_cancel must be callable")
        src_lang, tgt_lang = validate_language_pair(source_lang, target_lang)
        with self._lock:
            if self._translator is None or self._tokenizer is None:
                raise RuntimeError("Local models are not loaded")
            _checked_text(text, "translation source", _MAX_INPUT_CHARS)
            context, _, glossary = _hints(context, vocabulary)
            pairs = _history_pairs(history)
            if not text.strip():
                return ""
            prompt = _translation_prompt(text, context, glossary, pairs,
                                         source_lang=src_lang, target_lang=tgt_lang)
            from mlx_lm import stream_generate
            from mlx_lm.sample_utils import make_sampler

            # Manual PFML3 already contains BOS; no duplicate tokenizer BOS.
            tokens = self._tokenizer.encode(prompt, add_special_tokens=False)
            budget = min(1024, max(_MAX_TOKENS, len(text) * 2))
            if len(tokens) + budget > 32768:
                raise ValueError("translation prompt exceeds the model context limit")
            callback = on_text
            last_sent = None
            last_time = 0.0

            def emit(value, final=False):
                nonlocal callback, last_sent, last_time
                if callback is None or (not final and value == last_sent):
                    return
                now = time.monotonic()
                if not final and now - last_time < _ON_TEXT_INTERVAL:
                    return
                try:
                    callback(value)
                except Exception:
                    callback = None  # A broken display must not break translation.
                    return
                last_sent, last_time = value, now

            _check_cancel(should_cancel)
            parts = []
            finish_reason = None
            stream = stream_generate(
                self._translator, self._tokenizer, tokens,
                max_tokens=budget, sampler=make_sampler(temp=0.0),
            )
            try:
                for response in stream:
                    parts.append(response.text)
                    if response.finish_reason is not None:
                        finish_reason = response.finish_reason
                    _check_cancel(should_cancel)
                    if callback is not None and finish_reason is None:
                        emit(_clean_translation("".join(parts)).strip())
            finally:
                close = getattr(stream, "close", None)
                if close is not None:
                    close()
            if finish_reason == "length":
                raise RuntimeError("Translation reached its token limit; split the source clause")
            translation = _clean_translation("".join(parts)).strip()
            emit(translation, final=True)
            return translation


def _clean_translation(translation: str) -> str:
    # The two documented stops are also added as EOS in load(). Defensive
    # handling in case a future detokenizer includes a stop in text.
    for stop in ("<|plamo:tag|>", "<|plamo:bos|>"):
        translation = translation.split(stop, 1)[0]
    return translation
