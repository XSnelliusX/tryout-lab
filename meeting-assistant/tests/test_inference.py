"""Inference wrapper contract tests with fakes shaped like the pinned libraries.

No model is loaded. The fakes follow mlx-audio 0.5.9 (qwen3_asr.py) and
mlx-lm 0.32.0 (generate.py) as read from the installed source and confirmed
once against the real models on the owner's Mac:

* ``Qwen3ASRModel.stream_generate`` yields ``(token_id, logprobs)`` pairs and
  stops before EOS. In auto mode the first generated tokens are the model's own
  ``language X<asr_text>`` prefix; ``<asr_text>`` is not a special token, so it
  survives ``decode(..., skip_special_tokens=True)`` and ``extract_language``
  splits it off. Non-speech yields ``language None<asr_text>`` and nothing else.
* ``generate()`` returns an STTOutput whose ``language`` is a list (one entry per
  chunk) and whose ``generation_tokens`` include the prefix tokens.
* ``generate(stream=True)`` yields StreamingResult objects whose ``text`` is a
  single token decoded on its own, hides the first three auto-mode tokens and
  sets token counts only on the final, empty-text result. The wrapper does not
  use it (see FakeQwen.generate).
* ``mlx_lm.stream_generate`` yields GenerationResponse objects whose ``text`` is
  the incremental segment; the last one carries ``finish_reason``.
"""

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from meeting_assistant import inference
from meeting_assistant.inference import Cancelled, LocalModels, _collapse_repetitions


RATE = 16000
SPECIAL = {"<|im_end|>", "<|endoftext|>"}
EOS = "<|im_end|>"


class FakeTokenizer:
    """Token ids are indexes into a growing vocabulary of string pieces."""

    def __init__(self):
        self.pieces = []

    def ids(self, pieces):
        out = []
        for piece in pieces:
            if piece not in self.pieces:
                self.pieces.append(piece)
            out.append(self.pieces.index(piece))
        return out

    def encode(self, text, return_tensors=None):
        return list(range(len(text)))

    def decode(self, ids, skip_special_tokens=False):
        return "".join(p for p in (self.pieces[i] for i in ids)
                       if not (skip_special_tokens and p in SPECIAL))


def prefixed(language, text_pieces):
    return ["language", f" {language}", "<asr_text>", *text_pieces]


class FakeQwen:
    """Mimics Qwen3ASRModel: script maps the prompt language to output pieces."""

    def __init__(self, script, *, stream_error=None, endless=None):
        self._tokenizer = FakeTokenizer()
        self.script = script  # {None | "Chinese" | ...: [pieces]} (auto pieces include prefix)
        self.endless = endless  # piece repeated forever after the script (runaway loop)
        self.stream_error = stream_error
        self.stream_calls = []
        self.generate_calls = []
        self.closed = 0
        self.yielded = 0

    def _pieces(self, language):
        pieces = list(self.script[language])
        if self.endless is None:
            pieces.append(EOS)
        return pieces

    def _tokens(self, language, max_tokens):
        pieces = self._pieces(language)
        count = 0
        while count != max_tokens:  # mlx_audio.lm.generate.generate_step
            piece = pieces[count] if count < len(pieces) else self.endless
            token = self._tokenizer.ids([piece])[0]
            if piece == EOS:  # Qwen3ASRModel.stream_generate breaks on EOS
                return
            yield token, None
            count += 1

    def stream_generate(self, audio, *, max_tokens=8192, sampler=None, logits_processors=None,
                        language=None, prefill_step_size=2048, verbose=False, system_prompt=None):
        self.stream_calls.append({"audio": np.array(audio), "max_tokens": max_tokens,
                                  "language": language, "system_prompt": system_prompt})
        if self.stream_error is not None:
            raise self.stream_error
        try:
            for item in self._tokens(language, max_tokens):
                self.yielded += 1
                yield item
        finally:
            self.closed += 1

    def extract_language(self, text):  # copy of the library's parsing rule
        if "<asr_text>" in text and text.startswith("language "):
            return (text[len("language "):text.find("<asr_text>")].strip(),
                    text[text.find("<asr_text>") + len("<asr_text>"):])
        return "English", text

    def _preprocess_audio(self, audio):
        return None, None, max(1, len(audio) // 1280)

    def _build_prompt(self, num_audio_tokens, language=None, system_prompt=None):
        prefix = 0 if language is None else 3
        return np.zeros((1, 9 + num_audio_tokens + prefix + len(system_prompt or "")))

    def generate(self, audio, *, max_tokens=8192, language=None, temperature=0.0, verbose=False,
                 stream=False, system_prompt=None, hotwords=None, **kwargs):
        self.generate_calls.append({"audio": np.array(audio), "max_tokens": max_tokens,
                                    "language": language, "stream": stream,
                                    "system_prompt": system_prompt, "hotwords": hotwords})
        merged = ", ".join(hotwords) if hotwords else None
        if system_prompt and merged:
            merged = system_prompt + "\n" + merged
        merged = merged or system_prompt
        ids = [token for token, _ in self._tokens(language, max_tokens)]
        if stream:
            return self._stream_results(ids, language)
        text = self._tokenizer.decode(ids, skip_special_tokens=True)
        detected = language
        if language is None:
            detected, text = self.extract_language(text)
        return types.SimpleNamespace(
            text=text, segments=[{"text": text, "language": detected}], language=[detected],
            prompt_tokens=self._build_prompt(len(audio) // 1280, language, merged).shape[1],
            generation_tokens=len(ids))

    def _stream_results(self, ids, language):
        accumulator, count = "", 0
        for i, token in enumerate(ids):
            piece = self._tokenizer.decode([token])
            if language is None and i <= 2:
                accumulator += piece
                if "<asr_text>" in accumulator:
                    language, _ = self.extract_language(accumulator)
                continue
            count += 1
            yield types.SimpleNamespace(text=piece, is_final=False, language=language,
                                        prompt_tokens=0, generation_tokens=0)
        yield types.SimpleNamespace(text="", is_final=True, language=language,
                                    prompt_tokens=1, generation_tokens=count)


class Converter:
    def convert(self, text):
        return text.replace("们", "們").replace("这", "這").replace("样", "樣")


class TranslatorTokenizer:
    def __init__(self):
        self.prompts = []

    def encode(self, prompt, add_special_tokens=True):
        self.prompts.append(prompt)
        return [0] * 10


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def fake_mlx_lm(pieces, *, finish="stop", clock=None, step=0.03, record=None):
    """mlx_lm.stream_generate: incremental text, finish_reason only on the last."""
    module = types.ModuleType("mlx_lm")

    def stream_generate(model, tokenizer, prompt, max_tokens=256, **kwargs):
        if record is not None:
            record.append({"max_tokens": max_tokens, **kwargs})
        try:
            for piece in pieces:
                if clock is not None:
                    clock.now += step
                if record is not None:
                    record.append("yield")
                yield types.SimpleNamespace(text=piece, finish_reason=None)
            yield types.SimpleNamespace(text="", finish_reason=finish)
        finally:
            if record is not None:
                record.append("closed")

    module.stream_generate = stream_generate
    sample_utils = types.ModuleType("mlx_lm.sample_utils")
    sample_utils.make_sampler = lambda **kwargs: None
    return {"mlx_lm": module, "mlx_lm.sample_utils": sample_utils}


class InferenceTestCase(unittest.TestCase):
    def setUp(self):
        self.normalize_calls = []

        def normalize_for_asr(samples, *, speech_db=None, target_db=-23.0, max_gain_db=20.0,
                              peak_limit_db=-1.0):
            self.normalize_calls.append({"size": samples.size, "speech_db": speech_db})
            return (np.asarray(samples) * 2.0).astype(np.float32), 6.0

        levels = types.ModuleType("meeting_assistant.levels")
        levels.normalize_for_asr = normalize_for_asr
        audio = types.ModuleType("mlx_audio")
        lm = types.ModuleType("mlx_audio.lm")
        sample_utils = types.ModuleType("mlx_audio.lm.sample_utils")
        sample_utils.make_sampler = lambda *args, **kwargs: "greedy"
        stt = types.ModuleType("mlx_audio.stt")
        utils = types.ModuleType("mlx_audio.stt.utils")

        def merge_hotwords(base, hotwords):
            if not hotwords:
                return base
            joined = ", ".join(hotwords)
            return f"{base}\n{joined}" if base else joined

        utils.merge_hotwords = merge_hotwords
        stubs = {"meeting_assistant.levels": levels, "mlx_audio": audio, "mlx_audio.lm": lm,
                 "mlx_audio.lm.sample_utils": sample_utils, "mlx_audio.stt": stt,
                 "mlx_audio.stt.utils": utils}
        # Replace only these keys and restore exactly those, so lazily imported
        # real modules (scipy.signal) stay loaded.
        saved = {name: sys.modules.get(name) for name in stubs}
        sys.modules.update(stubs)

        def restore():
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
        self.addCleanup(restore)

    def models(self, asr=None):
        model = LocalModels(Path("."))
        model._asr = asr or FakeQwen({None: prefixed("Chinese", ["我们", "这样"]),
                                      "Chinese": ["我们", "这样"], "English": ["we ", "do"]})
        model._converter = Converter()
        model._translator = object()
        model._tokenizer = TranslatorTokenizer()
        return model


def speech(seconds=1.0, rate=RATE):
    return (np.sin(np.arange(int(seconds * rate)) / 7.0) * 0.05).astype(np.float32)


KEYS = {"raw_text", "traditional_text", "language", "no_speech", "truncated", "redecoded",
        "gain_db", "asr_ms", "prompt_tokens", "generation_tokens"}


class TranscribeTests(InferenceTestCase):
    def test_return_keys_and_auto_language(self):
        model = self.models()
        result = model.transcribe(speech())
        self.assertEqual(set(result), KEYS)
        self.assertEqual(result["raw_text"], "我们这样")
        self.assertEqual(result["traditional_text"], "我們這樣")
        self.assertEqual(result["language"], "Chinese")
        self.assertFalse(result["no_speech"] or result["truncated"] or result["redecoded"])
        # Generation tokens include the model's 3-token language prefix, as
        # generate() counts them (stream_transcribe's final result does not).
        self.assertEqual(result["generation_tokens"], 5)
        self.assertGreater(result["prompt_tokens"], 0)
        self.assertIsInstance(result["asr_ms"], int)
        self.assertIsNone(model._asr.stream_calls[0]["language"])
        self.assertFalse(model._asr.generate_calls)
        self.assertIsNone(model.streaming_fallback_reason)

    def test_streaming_text_equals_non_streaming_text(self):
        model = self.models()
        streamed = model.transcribe(speech(), normalize=False)
        model.streaming_fallback_reason = "test"
        generated = model.transcribe(speech(), normalize=False)
        for key in ("raw_text", "language", "generation_tokens", "prompt_tokens"):
            self.assertEqual(streamed[key], generated[key], key)

    def test_language_mapping_and_rejection(self):
        model = self.models()
        for public, name in (("zh", "Chinese"), ("en", "English"), ("auto", None)):
            result = model.transcribe(speech(), language=public)
            self.assertEqual(model._asr.stream_calls[-1]["language"], name)
            if name:
                self.assertEqual(result["language"], name)
        self.assertEqual(model.transcribe(speech(), language="en")["raw_text"], "we do")
        for bad in ("fr", "Chinese", "ZH", "", None, 1):
            with self.subTest(language=bad), self.assertRaises(ValueError):
                model.transcribe(speech(), language=bad)

    def test_no_speech_in_auto_mode(self):
        for pieces in (["language", " None", "<asr_text>"],
                       ["language", " None", "<asr_text>", "嗯"]):  # official parser: empty
            with self.subTest(pieces=pieces):
                model = self.models(FakeQwen({None: pieces}))
                result = model.transcribe(speech())
                self.assertTrue(result["no_speech"])
                self.assertEqual((result["raw_text"], result["traditional_text"]), ("", ""))
                self.assertIsNone(result["language"])
                self.assertFalse(result["redecoded"])
                self.assertEqual(len(model._asr.stream_calls), 1)

    def test_forced_language_has_no_escape_but_empty_text_is_no_speech(self):
        model = self.models(FakeQwen({"Chinese": []}))
        result = model.transcribe(speech(), language="zh")
        self.assertTrue(result["no_speech"])
        self.assertEqual(result["language"], "Chinese")

    def test_digital_silence_skips_the_model(self):
        model = self.models()
        result = model.transcribe(np.zeros(RATE, dtype=np.float32))
        self.assertEqual(set(result), KEYS)
        self.assertTrue(result["no_speech"])
        self.assertFalse(model._asr.stream_calls or self.normalize_calls)

    def test_unexpected_language_is_decoded_again_as_chinese(self):
        asr = FakeQwen({None: prefixed("Japanese", ["わたし"]), "Chinese": ["我们"]})
        result = self.models(asr).transcribe(speech())
        self.assertEqual([c["language"] for c in asr.stream_calls], [None, "Chinese"])
        self.assertEqual((result["raw_text"], result["language"], result["redecoded"]),
                         ("我们", "Chinese", True))
        for language in ("Cantonese", "English", "Chinese"):
            asr = FakeQwen({None: prefixed(language, ["x"])})
            result = self.models(asr).transcribe(speech())
            self.assertEqual((result["language"], result["redecoded"]), (language, False))
            self.assertEqual(len(asr.stream_calls), 1)

    def test_duration_based_budget(self):
        self.assertEqual(inference._asr_budget(0.5), 40)
        self.assertEqual(inference._asr_budget(1), 48)
        self.assertEqual(inference._asr_budget(10), 192)
        self.assertEqual(inference._asr_budget(29), 496)
        self.assertEqual(inference._asr_budget(30), inference._MAX_TOKENS_CAP)
        self.assertEqual(inference._MAX_TOKENS_CAP, 512)
        model = self.models()
        model.transcribe(speech(10))
        self.assertEqual(model._asr.stream_calls[-1]["max_tokens"], 192)
        model.transcribe(speech(10, rate=48000), sample_rate=48000)  # seconds, not samples
        self.assertEqual(model._asr.stream_calls[-1]["max_tokens"], 192)
        model.transcribe(speech(10), max_tokens=1024)
        self.assertEqual(model._asr.stream_calls[-1]["max_tokens"], 1024)

    def test_runaway_loop_is_truncated_and_collapsed_not_raised(self):
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                asr = FakeQwen({None: prefixed("Chinese", ["好的，"])}, endless="对不起")
                model = self.models(asr)
                if fallback:
                    model.streaming_fallback_reason = "test"
                result = model.transcribe(speech(1))
                self.assertTrue(result["truncated"])
                self.assertEqual(result["generation_tokens"], 48)
                self.assertEqual(result["raw_text"], "好的，对不起")
                self.assertFalse(result["no_speech"])

    def test_exactly_reaching_budget_is_truncated(self):
        asr = FakeQwen({"Chinese": ["一", "二", "三"]})
        result = self.models(asr).transcribe(speech(), language="zh", max_tokens=3)
        self.assertTrue(result["truncated"])
        result = self.models(asr).transcribe(speech(), language="zh", max_tokens=4)
        self.assertFalse(result["truncated"])

    def test_cancellation_mid_stream(self):
        asr = FakeQwen({None: prefixed("Chinese", ["一"] * 30)})
        model = self.models(asr)
        checks = []

        def should_cancel():
            checks.append(1)
            return len(checks) > 4

        with self.assertRaises(Cancelled):
            model.transcribe(speech(), should_cancel=should_cancel)
        self.assertEqual(asr.yielded, 4)  # one check before decoding, then per token
        self.assertEqual(asr.closed, 1)
        self.assertIsNone(model.streaming_fallback_reason)
        self.assertFalse(asr.generate_calls)
        with self.assertRaises(Cancelled):
            model.transcribe(speech(), should_cancel=lambda: True)
        self.assertEqual(len(asr.stream_calls), 1)  # cancelled before any decode
        self.assertTrue(issubclass(Cancelled, Exception))

    def test_streaming_failure_falls_back_permanently(self):
        asr = FakeQwen({None: prefixed("Chinese", ["我们"])}, stream_error=TypeError("secret 我们"))
        model = self.models(asr)
        result = model.transcribe(speech(), vocabulary=[{"term": "Kubernetes", "enabled": True}],
                                  context="meeting")
        self.assertEqual((result["raw_text"], result["language"]), ("我们", "Chinese"))
        self.assertEqual(result["generation_tokens"], 4)
        self.assertEqual(model.streaming_fallback_reason, "TypeError in streaming ASR decode")
        self.assertNotIn("secret", model.streaming_fallback_reason)
        call = asr.generate_calls[-1]
        self.assertEqual((call["system_prompt"], call["hotwords"], call["stream"]),
                         ("meeting", ["Kubernetes"], False))
        model.transcribe(speech())
        self.assertEqual(len(asr.stream_calls), 1)
        self.assertEqual(len(asr.generate_calls), 2)
        # Without streaming, cancellation is honoured only before and after.
        with self.assertRaises(Cancelled):
            model.transcribe(speech(), should_cancel=lambda: True)
        self.assertEqual(len(asr.generate_calls), 2)

    def test_unexpected_stream_shape_falls_back(self):
        asr = FakeQwen({None: prefixed("Chinese", ["我们"])})
        model = self.models(asr)

        def results_not_tuples(audio, **kwargs):
            asr.stream_calls.append(kwargs)
            yield types.SimpleNamespace(text="我", is_final=False)

        asr.stream_generate = results_not_tuples
        self.assertEqual(model.transcribe(speech())["raw_text"], "我们")
        self.assertIn("streaming ASR decode", model.streaming_fallback_reason)

    def test_missing_stream_generate_falls_back(self):
        asr = FakeQwen({None: prefixed("Chinese", ["我们"])})
        model = self.models(asr)
        model._asr = types.SimpleNamespace(
            _tokenizer=asr._tokenizer, generate=asr.generate)
        self.assertEqual(model.transcribe(speech())["raw_text"], "我们")
        self.assertEqual(model.streaming_fallback_reason, "AttributeError in streaming ASR decode")

    def test_library_stream_results_are_not_used(self):
        """Documents generate(stream=True): per-token text, hidden prefix, undercount."""
        asr = FakeQwen({None: prefixed("Chinese", ["我们", "这样"])})
        items = list(asr.generate(speech(), language=None, max_tokens=50, stream=True))
        self.assertEqual("".join(r.text for r in items), "我们这样")
        self.assertEqual([r.is_final for r in items], [False, False, True])
        self.assertEqual(items[-1].generation_tokens, 2)  # the real count is 5
        self.assertEqual(items[0].generation_tokens, 0)
        model = self.models(asr)
        model.transcribe(speech())
        self.assertEqual(len(asr.generate_calls), 1)  # only the call above

    def test_short_clip_is_padded_to_one_second_like_the_library(self):
        model = self.models()
        model.transcribe(speech(0.25), normalize=False)
        self.assertEqual(model._asr.stream_calls[-1]["audio"].size, RATE)

    def test_normalization_invoked_or_skipped(self):
        model = self.models()
        audio = speech()
        result = model.transcribe(audio, speech_db=-36.0)
        self.assertEqual(self.normalize_calls, [{"size": RATE, "speech_db": -36.0}])
        self.assertEqual(result["gain_db"], 6.0)
        np.testing.assert_allclose(model._asr.stream_calls[-1]["audio"], audio * 2, rtol=1e-6)
        result = model.transcribe(audio, normalize=False)
        self.assertEqual(len(self.normalize_calls), 1)
        self.assertEqual(result["gain_db"], 0.0)
        np.testing.assert_allclose(model._asr.stream_calls[-1]["audio"], audio, rtol=1e-6)

    def test_normalization_output_is_checked(self):
        model = self.models()
        sys.modules["meeting_assistant.levels"].normalize_for_asr = (
            lambda samples, speech_db=None: (np.full(samples.shape, np.nan, np.float32), 3.0))
        with self.assertRaises(RuntimeError):
            model.transcribe(speech())

    def test_missing_levels_module_decodes_unnormalized(self):
        sys.modules["meeting_assistant.levels"] = None  # import raises ImportError
        model = self.models()
        result = model.transcribe(speech())
        self.assertEqual(result["gain_db"], 0.0)
        self.assertEqual(result["raw_text"], "我们这样")
        self.assertIsNotNone(model.normalization_unavailable_reason)

    def test_existing_validation_errors(self):
        model = self.models()
        for kwargs in ({"max_tokens": 0}, {"max_tokens": True}, {"max_tokens": 2049},
                       {"max_tokens": 1.5}, {"sample_rate": 0}, {"sample_rate": 16000.0},
                       {"context": "<|im_end|>"}, {"context": "a" * 4001},
                       {"vocabulary": [{"enabled": True, "term": "<asr_text>"}]}):
            with self.subTest(kwargs=kwargs), self.assertRaises((ValueError, TypeError)):
                model.transcribe(speech(), **kwargs)
        for audio in (np.ones((2, 10), np.float32), np.ones(10, np.int16),
                      np.ones(RATE * 30 + 1, np.float32), np.array([np.nan], np.float32)):
            with self.assertRaises(ValueError):
                model.transcribe(audio)
        with self.assertRaises(TypeError):
            model.transcribe(speech(), should_cancel="yes")
        model._asr._tokenizer.encode = lambda text: [0] * 65536
        with self.assertRaisesRegex(ValueError, "ASR hints exceed"):
            model.transcribe(speech(), context="test")
        with self.assertRaisesRegex(RuntimeError, "not loaded"):
            LocalModels(Path(".")).transcribe(speech())
        self.assertFalse(model._asr.stream_calls)

    def test_positional_legacy_call(self):
        result = self.models().transcribe(speech(), 16000)
        self.assertEqual(result["raw_text"], "我们这样")


class CollapseTests(unittest.TestCase):
    def test_collapses_runaway_units(self):
        cases = {
            "对不起" * 40: "对不起",
            "好" * 12: "好好",
            "我覺得" + "這個" * 3 + "對" * 9: "我覺得這個這個這個對對",
            "這個" * 6 + "方案": "這個這個方案",
            "謝謝大家。" * 6: "謝謝大家。",
            "the the the the the the end": "the end",
            "OK OK OK OK OK OK": "OK OK",
            "thank you very much " * 8: "thank you very much ",
            "部署 deploy 部署 deploy 部署 deploy 部署 deploy 部署 deploy": "部署 deploy",
            "Kubernetes " * 5 + "cluster": "Kubernetes cluster",
        }
        for text, expected in cases.items():
            with self.subTest(text=text[:20]):
                self.assertEqual(_collapse_repetitions(text), expected)

    def test_leaves_normal_text_alone(self):
        for text in ("好好好", "哈哈哈哈", "對對對對，我們再看一下", "100000", "2000000 users",
                     "1111-1111", "......", "no no no no", "謝謝謝謝", "",
                     "Bye bye.", "第一階段 phase one 和第二階段 phase two",
                     "這個 API 的 API key 要放在 API gateway 的 API 設定裡"):
            with self.subTest(text=text):
                self.assertEqual(_collapse_repetitions(text), text)


class TranslateTests(InferenceTestCase):
    def test_on_text_throttled_and_final(self):
        clock = FakeClock()
        calls = []
        model = self.models()
        pieces = ["We ", "will ", "deploy ", "phase ", "one ", "next ", "week", ".<|plamo:tag|>x"]
        with mock.patch.dict(sys.modules, fake_mlx_lm(pieces, clock=clock)), \
                mock.patch.object(inference, "time", types.SimpleNamespace(monotonic=clock)):
            result = model.translate("下週部署第一階段", on_text=lambda s: calls.append((clock.now, s)))
        self.assertEqual(result, "We will deploy phase one next week.")
        self.assertEqual(calls[-1][1], result)
        partial_times = [t for t, _ in calls[:-1]]
        self.assertTrue(all(b - a >= 0.08 - 1e-9 for a, b in zip(partial_times, partial_times[1:])))
        self.assertLess(len(calls), len(pieces) + 1)
        self.assertGreaterEqual(len(calls), 3)
        for (_, earlier), (_, later) in zip(calls, calls[1:]):
            self.assertTrue(later.startswith(earlier))
            self.assertNotIn("<|plamo", later)

    def test_on_text_exception_is_isolated(self):
        calls = []

        def broken(text):
            calls.append(text)
            raise RuntimeError("display gone")

        model = self.models()
        with mock.patch.dict(sys.modules, fake_mlx_lm(["Hello", " world"])):
            self.assertEqual(model.translate("你好世界", on_text=broken), "Hello world")
        self.assertEqual(len(calls), 1)

    def test_cancellation_between_tokens(self):
        record = []
        checks = []
        model = self.models()

        def should_cancel():
            checks.append(1)
            return len(checks) > 3

        with mock.patch.dict(sys.modules, fake_mlx_lm(["a", "b", "c", "d", "e"], record=record)):
            with self.assertRaises(Cancelled):
                model.translate("你好", should_cancel=should_cancel, on_text=lambda s: None)
            self.assertEqual(record.count("yield"), 3)
            self.assertEqual(record[-1], "closed")
            record.clear()
            with self.assertRaises(Cancelled):
                model.translate("你好", should_cancel=lambda: True)
            self.assertEqual(record, [])

    def test_unchanged_stop_length_and_budget_handling(self):
        record = []
        model = self.models()
        with mock.patch.dict(sys.modules, fake_mlx_lm(["ok<|plamo:tag|>junk"], record=record)):
            self.assertEqual(model.translate("目前進度"), "ok")
            self.assertEqual(record[0]["max_tokens"], 256)
            self.assertEqual(model.translate("   "), "")
        with mock.patch.dict(sys.modules, fake_mlx_lm(["partial"], finish="length")):
            calls = []
            with self.assertRaisesRegex(RuntimeError, "token limit"):
                model.translate("很長的句子", on_text=calls.append)
            self.assertEqual(calls, ["partial"])  # no final call after an error
        for kwargs in ({"text": "<|plamo:tag|>"}, {"text": "ok", "on_text": "print"},
                       {"text": "ok", "should_cancel": 1}):
            with self.subTest(kwargs=kwargs), self.assertRaises((ValueError, TypeError)):
                model.translate(**kwargs)


if __name__ == "__main__":
    unittest.main()
