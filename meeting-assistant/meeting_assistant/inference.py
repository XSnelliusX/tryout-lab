"""Local-only Qwen ASR and PLaMo translation, for one segment at a time.

The caller owns audio segmentation, voice activity detection, result ordering,
and serialization of requests. This module never downloads models or sends
audio or text anywhere. Model files are installed by scripts/download_models.py.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import threading
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


def _translation_prompt(text, context, glossary, history):
    """PFML3 in the order of the hash-pinned PFN chat_template.jinja."""
    output = "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>"
    prompt = "<|plamo:bos|><|plamo:tag|>dataset<|plamo:msg|>translation"
    if context:
        prompt += "<|plamo:tag|>context<|plamo:msg|>" + context
    for source, target in history:
        prompt += "<|plamo:tag|>input<|plamo:msg|>" + source + output + target
    if glossary:
        prompt += "<|plamo:tag|>glossary"
        for source, target in glossary:
            prompt += "<|plamo:index|>" + source + "<|plamo:item|>" + target
    return prompt + "<|plamo:tag|>input<|plamo:msg|>" + text + output


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

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000, *,
                   context: str = "", vocabulary=None, max_tokens=None) -> dict:
        """Return untouched ASR text and an OpenCC Taiwan Traditional rendering.

        ``audio`` is a mono, normalized floating-point waveform; sample rates
        other than 16 kHz are resampled. An almost-zero energy guard suppresses
        pure silence; it is not a substitute for upstream VAD.
        """
        with self._lock:
            if self._asr is None or self._converter is None:
                raise RuntimeError("Local models are not loaded")
            context, hotwords, _ = _hints(context, vocabulary)
            budget = _MAX_TOKENS if max_tokens is None else max_tokens
            if isinstance(budget, bool) or not isinstance(budget, int) or not 1 <= budget <= _MAX_ASR_TOKENS:
                raise ValueError("max_tokens must be an integer between 1 and 2048")
            if not isinstance(sample_rate, int) or sample_rate <= 0:
                raise ValueError("sample_rate must be a positive integer")
            samples = np.asarray(audio)
            if samples.ndim != 1 or samples.dtype.kind != "f":
                raise ValueError("audio must be a mono floating-point waveform")
            if samples.size > sample_rate * _MAX_AUDIO_SECONDS:
                raise ValueError("audio segment exceeds 30 seconds")
            if not np.isfinite(samples).all():
                raise ValueError("audio contains non-finite values")
            if samples.size == 0 or np.max(np.abs(samples)) < 1e-5:
                return {"raw_text": "", "traditional_text": ""}
            if sample_rate != 16000:
                from scipy.signal import resample_poly
                from math import gcd

                divisor = gcd(sample_rate, 16000)
                samples = resample_poly(samples, 16000 // divisor, sample_rate // divisor)
            samples = np.ascontiguousarray(samples, dtype=np.float32)
            # mlx-audio's merge_hotwords joins these exact terms into the system
            # prompt. Count them with the pinned model tokenizer; reserve more
            # than the 30-second audio encoding and the requested output budget.
            if context or hotwords:
                hint_text = context + ("\n" if context and hotwords else "") + ", ".join(hotwords)
                hint_tokens = self._asr._tokenizer.encode(hint_text)
                if len(hint_tokens) + _ASR_AUDIO_RESERVE + budget > _ASR_CONTEXT_TOKENS:
                    raise ValueError("ASR hints exceed the model context limit")
            result = self._asr.generate(
                audio=samples, language=None, max_tokens=budget,
                temperature=0.0, verbose=False,
                system_prompt=context or None, hotwords=hotwords or None,
            )
            if result.generation_tokens >= budget:
                raise RuntimeError("ASR reached its token limit; use a shorter audio segment")
            raw_text = result.text
            return {
                "raw_text": raw_text,
                "traditional_text": self._converter.convert(raw_text),
            }

    def translate(self, text: str, *, context: str = "", vocabulary=None, history=None) -> str:
        """Translate into English; optional history is caller-supplied, never retained."""
        with self._lock:
            if self._translator is None or self._tokenizer is None:
                raise RuntimeError("Local models are not loaded")
            _checked_text(text, "translation source", _MAX_INPUT_CHARS)
            context, _, glossary = _hints(context, vocabulary)
            pairs = _history_pairs(history)
            if not text.strip():
                return ""
            prompt = _translation_prompt(text, context, glossary, pairs)
            from mlx_lm import stream_generate
            from mlx_lm.sample_utils import make_sampler

            # Manual PFML3 already contains BOS; no duplicate tokenizer BOS.
            tokens = self._tokenizer.encode(prompt, add_special_tokens=False)
            budget = min(1024, max(_MAX_TOKENS, len(text) * 2))
            if len(tokens) + budget > 32768:
                raise ValueError("translation prompt exceeds the model context limit")
            parts = []
            finish_reason = None
            for response in stream_generate(
                self._translator, self._tokenizer, tokens,
                max_tokens=budget, sampler=make_sampler(temp=0.0),
            ):
                parts.append(response.text)
                if response.finish_reason is not None:
                    finish_reason = response.finish_reason
            if finish_reason == "length":
                raise RuntimeError("Translation reached its token limit; split the source clause")
            translation = "".join(parts)
            # The two documented stops are also added as EOS above. Defensive
            # handling in case a future detokenizer includes a stop in text.
            for stop in ("<|plamo:tag|>", "<|plamo:bos|>"):
                translation = translation.split(stop, 1)[0]
            return translation.strip()
