"""Deterministic model-interface and synthetic-audio contract tests; no inference."""

import hashlib
import sys
import tempfile
import threading
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

from meeting_assistant.inference import LocalModels, _hints, _history_pairs, _translation_prompt
from meeting_assistant.refinement import RefinementCancelled, refine_session


RATE = 16000
VOCAB = [
    {"id": 1, "term": "container protection", "translation": "容器保護", "note": "", "enabled": True, "known": False},
    {"id": 2, "term": "phase one", "translation": "第一階段", "note": "", "enabled": True, "known": True},
    {"id": 3, "term": "do not use", "translation": "不要", "enabled": False},
    {"id": 4, "term": "Kubernetes", "translation": "", "enabled": True},
]


class FakeASR:
    def __init__(self, text="content production", tokens=5):
        self.calls = []
        self.text = text
        self.tokens = tokens
        self._tokenizer = types.SimpleNamespace(encode=lambda text: [0] * len(text))

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return types.SimpleNamespace(text=self.text, generation_tokens=self.tokens)


class Converter:
    def convert(self, text):
        return text


class FakeTokenizer:
    def __init__(self, length=None):
        self.prompts = []
        self.length = length

    def encode(self, prompt, add_special_tokens):
        self.prompts.append((prompt, add_special_tokens))
        return [0] * (self.length if self.length is not None else len(prompt))


def loaded():
    model = LocalModels(Path("."))
    model._asr = FakeASR()
    model._converter = Converter()
    model._translator = object()
    model._tokenizer = FakeTokenizer()
    return model


class InferenceTests(unittest.TestCase):
    def test_asr_hints_and_no_global_substitution(self):
        model = loaded()
        data = np.ones(RATE, dtype=np.float32) * 0.1
        output = model.transcribe(data, context="software engineering meeting", vocabulary=VOCAB, max_tokens=1024)
        self.assertEqual(output["raw_text"], "content production")
        call = model._asr.calls[-1]
        self.assertEqual(call["system_prompt"], "software engineering meeting")
        self.assertEqual(call["hotwords"], ["container protection", "phase one", "Kubernetes"])
        self.assertIsNone(call["language"])
        self.assertEqual(call["max_tokens"], 1024)
        model._asr.text = "VOne"
        self.assertEqual(model.transcribe(data, vocabulary=VOCAB)["raw_text"], "VOne")
        self.assertEqual(model._asr.calls[-1]["max_tokens"], 48)  # duration-based default for 1 s

    def test_limits_and_control_tokens(self):
        model = loaded()
        samples = np.zeros(10, dtype=np.float32)
        for kwargs in ({"context": "a" * 4001}, {"vocabulary": VOCAB * 32 + [VOCAB[0]]},
                       {"context": "<|im_end|>"}, {"context": "<asr_text>"},
                       {"vocabulary": [{"enabled": True, "term": "<blank1>"}]},
                       {"max_tokens": 0}, {"max_tokens": True}, {"max_tokens": 2049}):
            with self.subTest(kwargs=kwargs), self.assertRaises((ValueError, TypeError)):
                model.transcribe(samples, **kwargs)
        silent = model.transcribe(samples)
        self.assertEqual({k: silent[k] for k in ("raw_text", "traditional_text")},
                         {"raw_text": "", "traditional_text": ""})
        self.assertEqual(len(_hints("", [VOCAB[0]] * 128)[1]), 128)
        model._asr._tokenizer = types.SimpleNamespace(encode=lambda text: [0] * 65536)
        with self.assertRaisesRegex(ValueError, "ASR hints exceed"):
            model.transcribe(np.ones(5, dtype=np.float32), context="test")
        model._asr.tokens = 256
        clipped = model.transcribe(np.ones(5, dtype=np.float32))
        self.assertIs(clipped["truncated"], True)
        self.assertEqual(clipped["raw_text"], "content production")

    def test_translation_pfml_order_and_legacy_api(self):
        model = loaded()
        mlx = types.ModuleType("mlx_lm")
        mlx.stream_generate = lambda *args, **kwargs: iter([types.SimpleNamespace(text="ok<|plamo:tag|>junk", finish_reason="stop")])
        sampler = types.ModuleType("mlx_lm.sample_utils")
        sampler.make_sampler = lambda **kwargs: None
        with patch.dict(sys.modules, {"mlx_lm": mlx, "mlx_lm.sample_utils": sampler}):
            result = model.translate("目前進度", context="engineering", vocabulary=VOCAB,
                                     history=[("上一句", "Previous."), {"source": "下一句", "target": "Next."}])
            self.assertEqual(result, "ok")
            prompt, add_special = model._tokenizer.prompts[-1]
            self.assertFalse(add_special)
            self.assertEqual(prompt, (
                "<|plamo:bos|><|plamo:tag|>dataset<|plamo:msg|>translation"
                "<|plamo:tag|>context<|plamo:msg|>engineering"
                "<|plamo:tag|>input<|plamo:msg|>上一句"
                "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Previous."
                "<|plamo:tag|>input<|plamo:msg|>下一句"
                "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Next."
                "<|plamo:tag|>glossary<|plamo:index|>container protection<|plamo:item|>容器保護"
                "<|plamo:index|>phase one<|plamo:item|>第一階段"
                "<|plamo:tag|>input<|plamo:msg|>目前進度"
                "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>"))
            self.assertEqual(model.translate("hello"), "ok")
            model._tokenizer.length = 32768
            with self.assertRaises(ValueError):
                model.translate("hello")

    def test_translation_validation_and_history(self):
        model = loaded()
        for kwargs in ({"text": "<|plamo:tag|>"}, {"text": "ok", "context": "<|plamo:bos|>"},
                       {"text": "ok", "vocabulary": [{"term": "x", "translation": "<|plamo:index|>", "enabled": True}]},
                       {"text": "ok", "history": [("x", "<|plamo:tag|>")]},
                       {"text": "ok", "history": [("x", "y")] * 9},
                       {"text": "ok", "history": [{"role": "assistant", "content": "a"}, {"role": "user", "content": "b"}]}):
            with self.subTest(kwargs=kwargs), self.assertRaises((ValueError, TypeError)):
                model.translate(**kwargs)

    def test_translation_length_limit_is_not_returned_as_complete(self):
        model = loaded()
        mlx = types.ModuleType("mlx_lm")
        mlx.stream_generate = lambda *args, **kwargs: iter([types.SimpleNamespace(text="partial", finish_reason="length")])
        sampler = types.ModuleType("mlx_lm.sample_utils")
        sampler.make_sampler = lambda **kwargs: None
        with patch.dict(sys.modules, {"mlx_lm": mlx, "mlx_lm.sample_utils": sampler}):
            with self.assertRaisesRegex(RuntimeError, "token limit"):
                model.translate("測試")

    def test_prompt_matches_pfn_template(self):
        # Compare against the pinned source template if installed. This renders
        # Jinja only; it does not load weights, tokenizer code or meeting data.
        template_path = (Path.home() / "Library/Application Support/Meeting Assistant/models"
                         / "plamo-3-translate-0.8b-4bit/chat_template.jinja")
        if not template_path.exists():
            self.skipTest("pinned model template is not installed")
        template = template_path.read_bytes()
        expected_hash = "633ae24b5166d2c958d9b0a39523f2cc5bd6832752ec2ab0285793cab6415323"
        self.assertEqual(hashlib.sha256(template).hexdigest(), expected_hash)
        from jinja2 import Environment
        env = Environment()
        env.globals["raise_exception"] = lambda message: self.fail(message)
        history = [("上一句", "Previous."), ("下一句", "Next.")]
        messages = []
        for source, target in history:
            messages.extend([{"role": "user", "content": source}, {"role": "assistant", "content": target}])
        messages.append({"role": "user", "content": "目前進度"})
        context, _, glossary = _hints("engineering", VOCAB)
        result = env.from_string(template.decode()).render(
            messages=messages, target_lang="en", add_generation_prompt=True,
            context=context, glossary=[{"source": a, "target": b} for a, b in glossary],
            bos_token="<|plamo:bos|>", tools=None, documents=None)
        self.assertEqual(result, _translation_prompt("目前進度", context, glossary, _history_pairs(history)))


class FakeModels:
    def __init__(self, texts=None):
        self.texts = iter(texts or [])
        self.calls = []
        self.translations = []

    def transcribe(self, samples, **kwargs):
        self.calls.append((samples.copy(), kwargs))
        text = next(self.texts, "一句話")
        return {"raw_text": text, "traditional_text": text}

    def translate(self, text, **kwargs):
        self.translations.append((text, kwargs))
        return "translated: " + text


def speechlike(seconds, amplitude=8000):
    """Harmonic tone with a 4 Hz syllable envelope: the detector hears speech, not a steady tone."""
    t = np.arange(int(seconds * RATE)) / RATE
    tone = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 25))
    return (amplitude * np.abs(np.sin(np.pi * 4 * t)) * tone / np.max(np.abs(tone))).astype(np.int16)


def write_wav(path, samples, rate=RATE, channels=1):
    with wave.open(str(path / "audio.wav"), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(np.asarray(samples, dtype="<i2").tobytes())


class RefinementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_silence_and_read_only(self):
        write_wav(self.path, np.zeros(RATE * 27, dtype=np.int16))
        (self.path / "events.jsonl").write_text("original\n")
        before = {p.name: hashlib.sha256(p.read_bytes()).digest() for p in self.path.iterdir()}
        model = FakeModels()
        progress = []
        result = refine_session(self.path, model, progress=progress.append)
        self.assertEqual(result["segments"], [])
        self.assertEqual(model.calls, [])
        self.assertEqual(progress[-1]["percent"], 100.0)
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).digest() for p in self.path.iterdir()})

    def test_long_windows_overlap_flag_and_hints(self):
        write_wav(self.path, speechlike(50))
        model = FakeModels(["Same phrase", "same  phrase", "Last"])
        result = refine_session(self.path, model, context="software engineering", vocabulary=VOCAB)
        segments = result["segments"]
        self.assertEqual(len(segments), 3)
        self.assertEqual([(s["start"], s["end"]) for s in segments], [(0, 24), (22.5, 46.5), (45, 50)])
        self.assertEqual(segments[1]["possible_overlap_duplicate_of"], 1)
        self.assertEqual(segments[1]["raw_text"], "same  phrase")
        self.assertEqual(result["mapping"], "no_exact_original_segment_mapping")
        self.assertEqual(model.calls[0][1]["max_tokens"], 1024)
        self.assertEqual(model.calls[0][1]["vocabulary"], VOCAB)
        self.assertEqual(model.translations[0][1]["context"], "software engineering")
        self.assertTrue(all(len(samples) <= RATE * 24 for samples, _ in model.calls))

    def test_failing_window_is_skipped_and_marked_incomplete(self):
        write_wav(self.path, speechlike(50))
        class Flaky(FakeModels):
            def transcribe(self, samples, **kwargs):
                if len(self.calls) == 1:
                    self.calls.append((samples.copy(), kwargs))
                    raise RuntimeError("x" * 300)
                return super().transcribe(samples, **kwargs)
        result = refine_session(self.path, Flaky(["one", "two", "three"]))
        self.assertEqual(len(result["segments"]), 2)
        self.assertEqual(result["status"], "pending")
        note = result["limitations"][-1]
        self.assertIn("1 window failed and was skipped", note)
        self.assertLessEqual(len(note), 260)
        class Cancelling(FakeModels):
            def transcribe(self, samples, **kwargs):
                raise RefinementCancelled("stop")
        with self.assertRaises(RefinementCancelled):
            refine_session(self.path, Cancelling())

    def test_silent_tail_of_overlap_not_retranscribed(self):
        samples = np.zeros(40 * RATE, dtype=np.int16)
        samples[:24 * RATE] = speechlike(24, 9000)
        write_wav(self.path, samples)
        model = FakeModels()
        self.assertEqual(len(refine_session(self.path, model)["segments"]), 1)

    def test_pause_and_multiple_separated_speech_regions(self):
        samples = np.zeros(54 * RATE, dtype=np.int16)
        samples[RATE:20 * RATE] = speechlike(19, 9000)
        samples[21 * RATE:32 * RATE] = speechlike(11, 9000)
        samples[50 * RATE:51 * RATE] = speechlike(1, 9000)
        write_wav(self.path, samples)
        model = FakeModels()
        segments = refine_session(self.path, model)["segments"]
        self.assertGreaterEqual(len(segments), 2)
        # Pre-roll reaches back before the speech that starts at 1.0 s.
        self.assertTrue(0.7 <= segments[0]["start"] < 1.0, segments[0]["start"])
        self.assertTrue(any(s["start"] <= 50 and s["end"] >= 51 for s in segments))

    def test_bad_audio_and_cancellation(self):
        write_wav(self.path, np.ones(RATE, dtype=np.int16), rate=8000)
        with self.assertRaises(ValueError):
            refine_session(self.path, FakeModels())
        write_wav(self.path, speechlike(25, 9000))
        flag = threading.Event()
        model = FakeModels()
        def progress(event):
            if event["processed_seconds"] > 0:
                flag.set()
        with self.assertRaises(RefinementCancelled):
            refine_session(self.path, model, progress=progress, cancelled=flag.is_set)
        self.assertEqual(len(model.calls), 1)

    def test_corrupt_short_wav_fails(self):
        write_wav(self.path, np.full(RATE, 9000, dtype=np.int16))
        audio = self.path / "audio.wav"
        audio.write_bytes(audio.read_bytes()[:-100])
        with self.assertRaises(ValueError):
            refine_session(self.path, FakeModels())

    def test_model_failure_is_recorded_not_raised(self):
        write_wav(self.path, speechlike(1, 9000))
        class FailsTranslation(FakeModels):
            def translate(self, text, **kwargs):
                raise RuntimeError("translation failed")
        result = refine_session(self.path, FailsTranslation())
        self.assertEqual((result["segments"], result["status"]), ([], "pending"))
        self.assertIn("translation failed", result["limitations"][-1])


if __name__ == "__main__":
    unittest.main()
