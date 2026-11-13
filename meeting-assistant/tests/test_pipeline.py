"""Live caption pipeline: scheduler, speculative decoding, previews, timing. Fake models only."""

import json
import threading
import time
import unittest

import numpy as np

from meeting_assistant.scheduler import FINAL, Job, Scheduler
from meeting_assistant.server import latency_summary

from pipeline_fakes import AppCase, FakeModel, event


class SchedulerTests(unittest.TestCase):
    def test_priority_order_final_spec_translate_preview_finish(self):
        jobs = Scheduler()
        for kind in ("finish", "preview", "translate", "retranslate", "speculative", "final", "manual"):
            jobs.submit(Job(kind))
        order = []
        while (job := jobs.next(timeout=0)) is not None:
            order.append(job.type)
            jobs.done(job)
        self.assertEqual(order, ["final", "speculative", "translate", "retranslate", "manual", "preview", "finish"])

    def test_previews_are_coalesced_to_the_newest(self):
        jobs = Scheduler()
        first = jobs.submit(Job("preview", key=(1, 0)))
        jobs.submit(Job("preview", key=(1, 0)))
        newest = jobs.submit(Job("preview", key=(1, 0)))
        queued, _ = jobs.snapshot()
        self.assertEqual(queued, [newest])
        self.assertEqual(first.state, "done")
        self.assertEqual(jobs.unfinished_tasks, 0)  # previews are optional work
        self.assertEqual(jobs.stats()[0], 0)

    def test_final_or_pause_cancels_running_preview_only(self):
        jobs = Scheduler()
        jobs.submit(Job("preview", key=(1, 0)))
        running = jobs.next(timeout=0)
        jobs.submit(Job("translate"))
        self.assertFalse(running.cancelled)  # translation does not preempt
        jobs.submit(Job("speculative", key=(1, 0)))
        self.assertTrue(running.cancelled)
        jobs.done(running)
        jobs.submit(Job("translate"))
        translation = jobs.next(timeout=0)
        jobs.submit(Job("final"))
        self.assertFalse(translation.cancelled)

    def test_promote_moves_queued_speculative_ahead_of_translation(self):
        jobs = Scheduler()
        jobs.submit(Job("translate"))
        spec = jobs.submit(Job("speculative"))
        jobs.submit(Job("final"))
        jobs.promote(spec, FINAL)
        first = jobs.next(timeout=0)
        jobs.done(first)
        second = jobs.next(timeout=0)
        self.assertEqual({first.type, second.type}, {"final", "speculative"})

    def test_stats_report_backlog_without_dropping(self):
        jobs = Scheduler()
        for _ in range(500):
            jobs.submit(Job("final", queued_at=time.monotonic() - 30))
        length, lag, pending = jobs.stats()
        self.assertEqual((length, pending), (500, 500))
        self.assertGreaterEqual(lag, 30)


class PipelineTests(AppCase, unittest.TestCase):
    def setUp(self):
        self.make_app()
        self.begin()

    def published(self):
        client = self.app.hub.subscribe()
        return client

    def test_preview_is_provisional_with_final_id_and_final_replaces_it(self):
        app = self.app
        app._on_segment(event("preview", value=0.1))
        self.drain()
        self.assertEqual(app.live_preview["status"], "provisional")
        self.assertEqual(app.live_preview["id"], 1)
        self.assertEqual(self.saved(), [])
        self.assertEqual(self.model.mt_calls(), [])
        app._on_segment(event("final", value=0.2))
        self.drain()
        self.assertIsNone(app.live_preview)
        segment = self.saved()[0]
        self.assertEqual((segment["id"], segment["traditional_text"], segment["english"], segment["status"]),
                         (1, "文字200", "translated", "complete"))

    def test_speculative_pause_decode_is_reused_by_same_as_pause_final(self):
        app = self.app
        app._on_segment(event("pause", value=0.3))
        app._on_segment(event("final", value=0.3, same_as_pause=True))
        ran = self.drain()
        self.assertEqual(len(self.model.asr_calls()), 1)
        self.assertEqual(ran[0], "speculative")
        self.assertEqual(self.saved()[0]["traditional_text"], "文字300")
        self.assertEqual(app.pipeline_stats["spec_reused"], 1)

    def test_completed_speculative_result_is_reused_without_decoding_again(self):
        app = self.app
        app._on_segment(event("pause", value=0.3))
        self.drain()
        self.assertEqual(app.live_preview["traditional_text"], "文字300")  # shown while unconfirmed
        app._on_segment(event("final", value=0.3, same_as_pause=True))
        self.drain()
        self.assertEqual(len(self.model.asr_calls()), 1)
        self.assertEqual(self.saved()[0]["traditional_text"], "文字300")

    def test_resumed_speech_cancels_inflight_speculative_and_discards_it(self):
        app = self.app
        self.model.asr_gate = threading.Event()
        app._on_segment(event("pause", value=0.3))
        spec = app.jobs.next(timeout=0)
        worker = threading.Thread(target=app.run_job, args=(spec,))
        worker.start()
        self.assertTrue(self.model.asr_started.wait(2))
        started = time.monotonic()
        app._on_segment(event("preview", value=0.4))  # speech went on
        worker.join(timeout=2)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(spec.cancelled)
        self.assertIsNone(spec.get("result"))
        self.model.asr_gate = None
        app._on_segment(event("final", value=0.5))
        self.drain()
        self.assertEqual([s["traditional_text"] for s in self.saved()], ["文字500"])
        self.assertEqual(app.pipeline_stats["spec_cancelled"], 1)

    def test_final_with_different_audio_cancels_queued_speculative(self):
        app = self.app
        app._on_segment(event("pause", value=0.3))
        app._on_segment(event("final", value=0.6, cut="valley"))
        self.drain()
        self.assertEqual([c[1] for c in self.model.asr_calls()], [16000])
        self.assertEqual(self.saved()[0]["traditional_text"], "文字600")

    def test_final_arriving_during_speculative_decode_promotes_it(self):
        app = self.app
        self.model.asr_gate = threading.Event()
        app._on_segment(event("pause", value=0.3))
        spec = app.jobs.next(timeout=0)
        worker = threading.Thread(target=app.run_job, args=(spec,))
        worker.start()
        self.assertTrue(self.model.asr_started.wait(2))
        app._on_segment(event("final", value=0.3, same_as_pause=True))
        self.model.asr_gate.set()
        worker.join(timeout=2)
        self.drain()
        self.assertEqual(len(self.model.asr_calls()), 1)
        self.assertEqual(self.saved()[0]["traditional_text"], "文字300")
        self.assertEqual(self.saved()[0]["english"], "translated")

    def test_failed_speculative_decode_falls_back_to_a_final_decode(self):
        app = self.app
        self.model.fail_asr, self.model.fail_asr_times = "boom", 1  # a transient failure
        app._on_segment(event("pause", value=0.3))
        app._on_segment(event("final", value=0.3, same_as_pause=True))
        self.drain()
        self.assertEqual(self.saved()[0]["traditional_text"], "文字300")
        self.assertEqual(len(self.model.asr_calls()), 2)

    def test_fallback_after_failed_promoted_decode_keeps_segment_order(self):
        # Review r10: the retry used to be queued behind later finals and published out of order.
        app = self.app
        client = app.hub.subscribe()
        app._on_segment(event("pause", utterance=1, value=0.1))
        app._on_segment(event("final", utterance=1, value=0.1, same_as_pause=True))  # promotes the spec
        app._on_segment(event("final", utterance=2, start=1, end=2, value=0.2))
        self.model.fail_asr, self.model.fail_asr_times = "transient MLX error", 1
        self.drain()
        self.assertEqual([s["id"] for s in app.segments], [1, 2])
        published = [json.loads(line)["segment"]["id"] for line in client.take(0) if b'"segment"' in line]
        self.assertEqual(published[0], 1)
        self.assertEqual(self.saved()[0]["traditional_text"], "文字100")

    def test_early_resume_detection_cancels_speculative_before_next_event(self):
        app = self.app
        app._on_segment(event("pause", value=0.3))

        class Detector:
            speaking = True

        class Segmenter:
            open = True
            utterance = 1

        class Capture:
            detector, segmenter, samples = Detector(), Segmenter(), 16000

        app._on_block(Capture(), time.monotonic())
        self.assertEqual(app.pipeline_stats["spec_cancelled"], 1)
        self.assertEqual(self.drain(), [])

    def test_final_cancels_running_preview_within_cancellation_latency(self):
        app = self.app
        self.model.asr_gate = threading.Event()
        app._on_segment(event("preview", value=0.1))
        preview = app.jobs.next(timeout=0)
        worker = threading.Thread(target=app.run_job, args=(preview,))
        worker.start()
        self.assertTrue(self.model.asr_started.wait(2))
        started = time.monotonic()
        app._on_segment(event("final", value=0.2))
        worker.join(timeout=2)
        self.assertLess(time.monotonic() - started, 0.2)
        self.assertTrue(preview.cancelled)
        self.model.asr_gate = None
        self.drain()
        self.assertIsNone(app.live_preview)  # the stale preview never appeared
        self.assertEqual(self.saved()[0]["traditional_text"], "文字200")

    def test_preview_never_shown_for_finalised_audio(self):
        app = self.app
        app._on_segment(event("preview", value=0.1))
        stale = app.jobs.next(timeout=0)
        app._on_segment(event("final", value=0.2))
        app.run_job(stale)  # it was cancelled, and would be refused anyway
        self.assertIsNone(app.live_preview)
        self.drain()
        self.assertIsNone(app.live_preview)

    def test_previous_preview_survives_until_its_final_is_published(self):
        app = self.app
        app._on_segment(event("preview", utterance=1, value=0.1))
        self.drain()
        self.assertEqual(app.live_preview["id"], 1)
        app._on_segment(event("final", utterance=1, value=0.2))
        app._on_segment(event("preview", utterance=2, start=1.0, end=2.0, value=0.3))
        self.assertEqual(app.live_preview["id"], 1)  # not cleared while segment 1 is in flight
        final = app.jobs.next(timeout=0)
        self.assertEqual(final.type, "final")
        app.run_job(final)
        self.assertIsNone(app.live_preview)
        self.assertEqual(self.saved()[0]["traditional_text"], "文字200")
        self.drain()
        self.assertEqual(app.live_preview["id"], 2)
        self.assertEqual(app.live_preview["traditional_text"], "文字300")

    def test_utterance_without_final_clears_its_preview(self):
        app = self.app
        app._on_segment(event("preview", utterance=1, value=0.1))
        self.drain()
        app._on_segment(event("pause", utterance=2, value=0.3))
        self.assertIsNone(app.live_preview)

    def test_no_speech_final_is_not_saved_but_journaled_with_times_only(self):
        app = self.app
        app._on_segment(event("final", value=0.0, start=2.0, end=3.0))
        self.drain()
        self.assertEqual(self.saved(), [])
        record = [e for e in app.archive.events if e["type"] == "no_speech"]
        self.assertEqual(record, [{"type": "no_speech", "id": 1, "start": 2.0, "end": 3.0}])

    def test_no_final_is_dropped_under_backlog(self):
        app = self.app
        for index in range(1, 201):
            app._on_segment(event("preview", utterance=index, start=index, end=index + 1, value=0.1))
            app._on_segment(event("final", utterance=index, start=index, end=index + 1, value=0.1))
        length, lag, pending = app.jobs.stats()
        self.assertEqual(length, 200)
        app._check_lag(25.0)
        self.assertIn("behind", app.notice)
        self.drain()
        segments = self.saved()
        self.assertEqual(len(segments), 200)
        self.assertEqual([s["id"] for s in segments], list(range(1, 201)))
        self.assertTrue(all(s["status"] == "complete" for s in segments))
        self.assertEqual(app.state()["discarded_bursts"], 0)  # nothing counted as noise or skipped

    def test_timing_fields_present_and_monotonic(self):
        app = self.app
        app._on_segment(event("pause", value=0.3, speech_end_at=time.monotonic() - 0.4))
        app._on_segment(event("final", value=0.3, same_as_pause=True, speech_end_at=time.monotonic() - 0.4))
        self.drain()
        timing = self.saved()[0]["timing"]
        self.assertEqual(set(timing), {"endpoint_ms", "asr_ms", "translate_ms", "speech_end_to_source_ms",
                                       "speech_end_to_english_ms"})
        self.assertTrue(all(isinstance(v, int) for v in timing.values()), timing)
        self.assertEqual(timing["asr_ms"], 7)
        self.assertGreaterEqual(timing["endpoint_ms"], 390)
        self.assertLessEqual(timing["endpoint_ms"], timing["speech_end_to_source_ms"])
        self.assertLessEqual(timing["speech_end_to_source_ms"], timing["speech_end_to_english_ms"])
        self.assertEqual(app.segments[0]["timing"], timing)
        state = app.state()
        self.assertEqual(state["latency"]["count"], 1)
        self.assertEqual(state["latency"]["last"], timing)

    def test_latency_aggregation(self):
        segments = [{"timing": {"endpoint_ms": v, "asr_ms": v, "translate_ms": None,
                                "speech_end_to_source_ms": v, "speech_end_to_english_ms": v}} for v in range(1, 11)]
        segments.append({"id": 99})
        summary = latency_summary(segments)
        self.assertEqual(summary["count"], 10)
        self.assertEqual(summary["last"]["endpoint_ms"], 10)
        self.assertEqual(summary["median"]["asr_ms"], 5)
        self.assertEqual(summary["p90"]["speech_end_to_english_ms"], 9)
        self.assertIsNone(summary["median"]["translate_ms"])
        self.assertIsNone(latency_summary([{"id": 1}]))

    def test_recognition_options_reach_the_model(self):
        app = self.app
        app._on_segment(event("final", value=0.2))
        self.drain()
        asr = self.model.asr_calls()[0][2]
        self.assertEqual(asr["language"], "zh")
        self.assertFalse(asr["normalize"])
        self.assertIn("speech_db", asr)
        self.assertEqual(asr["context"], "Container security")
        mt = self.model.mt_calls()[0][2]
        self.assertEqual(mt["context"], "Container security")
        self.assertEqual(mt["vocabulary"], [{"term": "容器"}])

    def test_streaming_translation_publishes_partials_without_saving_them(self):
        app = self.app
        client = app.hub.subscribe()
        self.model.partials = ["Good", "Good morn", "Good morning", "Good morning all"]
        self.model.partial_delay = 0.06
        seen_in_library = []
        original = self.model.translate

        def translate(text, **kwargs):
            on_text = kwargs["on_text"]

            def spy(partial):
                seen_in_library.append(self.saved()[0]["english"])
                on_text(partial)
            return original(text, **dict(kwargs, on_text=spy))
        self.model.translate = translate
        app._on_segment(event("final", value=0.2))
        self.drain()
        lines = [line for line in client.take(0) if b'"segment"' in line]
        import json
        segments = [json.loads(line)["segment"] for line in lines]
        partial = [s for s in segments if s["status"] == "translating" and s["english"]]
        self.assertTrue(1 <= len(partial) < 4, partial)  # throttled to about 10 per second
        self.assertEqual(segments[0]["status"], "translating")
        self.assertEqual(segments[0]["english"], "")
        self.assertEqual(segments[-1]["status"], "complete")
        self.assertEqual(set(seen_in_library), {""})
        self.assertEqual(self.saved()[0]["english"], "translated")

    def test_translation_history_uses_three_completed_pairs_from_memory(self):
        app = self.app
        for index in range(1, 6):
            app._on_segment(event("final", utterance=index, start=index, end=index + 1, value=0.1 * index))
            self.drain()
        history = self.model.mt_calls()[-1][2]["history"]
        self.assertEqual([pair[0] for pair in history], ["文字200", "文字300", "文字400"])
        app.library.get_session = None  # must not be read for the selected session
        self.assertEqual(len(app._translation_history("fixture", 6)), 3)

    def test_history_excludes_user_edited_pending_segments(self):
        app = self.app
        app._on_segment(event("final", utterance=1, value=0.1))
        self.drain()
        app.segment_edit({"id": 1, "text": "改正", "expected_revision": 1, "session_id": "fixture"})
        app.jobs.cancel(lambda job: job.type == "retranslate")
        app._on_segment(event("final", utterance=2, start=2, end=3, value=0.2))
        self.drain()
        self.assertNotIn("history", self.model.mt_calls()[-1][2])

    def test_live_translation_cannot_overwrite_intervening_user_edit(self):
        app = self.app
        self.model.before_translation = lambda: app.library.edit_segment("fixture", 1, "container protection", 1)
        app._on_segment(event("final", value=0.2))
        self.drain()
        segment = self.saved()[0]
        self.assertEqual(segment["raw_text"], "文字200")
        self.assertEqual(segment["traditional_text"], "container protection")
        self.assertEqual(segment["english"], "")
        self.assertEqual(segment["revision"], 2)
        self.assertEqual(app.segments[0]["revision"], 2)

    def test_user_edit_during_live_translation_cancels_it(self):
        app = self.app
        self.model.mt_gate = threading.Event()
        app._on_segment(event("final", value=0.2))
        app.run_job(app.jobs.next(timeout=0))  # recognition
        translation = app.jobs.next(timeout=0)
        worker = threading.Thread(target=app.run_job, args=(translation,))
        worker.start()
        self.assertTrue(self.model.mt_started.wait(2))
        app.segment_edit({"id": 1, "text": "改正", "expected_revision": 1, "session_id": "fixture"})
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.saved()[0]["traditional_text"], "改正")
        self.assertEqual(self.saved()[0]["raw_text"], "文字200")

    def test_retranslation_cannot_overwrite_newer_revision(self):
        app = self.app
        app.library.upsert_segment("fixture", {"id": 1, "raw_text": "wrong", "traditional_text": "wrong"})
        app.library.edit_segment("fixture", 1, "first fix", 1)
        self.model.before_translation = lambda: app.library.edit_segment("fixture", 1, "new fix", 2)
        app.jobs.submit(Job("retranslate", "fixture", id=1, revision=2, text="first fix", profile={}))
        self.drain()
        segment = self.saved()[0]
        self.assertEqual(segment["traditional_text"], "new fix")
        self.assertEqual(segment["english"], "")

    def test_failed_final_is_saved_as_error_and_not_translated(self):
        app = self.app
        app._on_segment(event("preview", value=0.1))
        self.drain()
        self.model.fail_asr = "test failure"
        app._on_segment(event("final", value=0.2))
        self.drain()
        self.assertIsNone(app.live_preview)
        self.assertEqual(self.saved()[0]["status"], "error")
        self.assertEqual(self.model.mt_calls(), [])

    def test_manual_text_is_translated_through_the_scheduler(self):
        app = self.app
        app.recording_state = "idle"
        app.manual("早安")
        self.drain()
        segment = self.saved()[-1]
        self.assertEqual((segment["kind"], segment["english"]), ("manual", "translated"))

    def test_finish_runs_after_all_session_work_and_is_exception_safe(self):
        app = self.app
        app._on_segment(event("final", value=0.2))
        app._capture_done(None)
        self.assertEqual(app.recording_state, "draining")

        def broken(*args, **kwargs):
            raise OSError("disk full")
        app.library.set_session_status = broken
        ran = self.drain()
        self.assertEqual(ran, ["final", "translate", "finish"])
        self.assertEqual(app.recording_state, "idle")
        self.assertIsNone(app.capture)
        self.assertIn("final session status", app.notice)
        self.assertEqual(app.archive, None)

    def test_finish_resets_state_even_when_the_journal_fails(self):
        app = self.app

        def broken(status):
            raise RuntimeError("journal")
        app.archive.close = broken
        app._capture_done("Capture failed.")
        self.drain()
        self.assertEqual(app.recording_state, "idle")
        self.assertIn("journal", app.notice)

    def test_capture_done_cancels_previews_and_orphan_speculation(self):
        app = self.app
        app._on_segment(event("preview", utterance=1, value=0.1))
        app._on_segment(event("pause", utterance=1, value=0.3))
        app._capture_done(None)
        self.assertEqual(self.drain(), ["finish"])

    def test_long_context_sets_a_one_time_notice(self):
        app = self.app
        app.update_settings({"meeting_context": "x" * 700})
        self.assertIn("slows every caption", app.notice)
        app.notice = ""
        app.update_settings({"meeting_context": "y" * 800})
        self.assertEqual(app.notice, "")

    def test_audio_settings_apply_to_the_next_recognition(self):
        app = self.app
        app.update_settings({"audio": {"language": "en"}})
        self.assertEqual(app.capture_audio["language"], "en")
        app._on_segment(event("final", value=0.2))
        self.drain()
        self.assertEqual(self.model.asr_calls()[0][2]["language"], "en")

    def test_state_does_not_read_the_library_under_the_lock(self):
        app = self.app
        app._on_segment(event("final", value=0.2))
        self.drain()
        holder = {}

        def watch(original):
            def wrapped(*args, **kwargs):
                holder.setdefault("locked", []).append(app.lock._is_owned())
                return original(*args, **kwargs)
            return wrapped
        app.library.get_session = watch(app.library.get_session)
        app.library.list_sessions = watch(app.library.list_sessions)
        app.library.get_settings = watch(app.library.get_settings)
        state = app.state()
        self.assertEqual(holder["locked"], [False, False, False])
        self.assertEqual(state["segments"][0]["id"], 1)
        self.assertEqual(state["audio"]["device"], None)
        self.assertIn("helper_protocol", state["capabilities"])


class ReviewRegressionTests(AppCase, unittest.TestCase):
    """Findings of the independent pipeline review; each failed before its fix."""

    def setUp(self):
        self.make_app()
        self.begin()

    def discard(self, utterance=1, part=0, reason="short"):
        return {"kind": "discard", "audio": np.zeros(0, np.float32), "start": 0.0, "end": 0.5,
                "utterance": utterance, "part": part, "speech_end": 0.3, "speech_end_at": time.monotonic(),
                "cut": "silence", "reason": reason}

    def test_discard_clears_ghost_caption_and_cancels_speculation(self):
        app = self.app
        app._on_segment(event("pause", value=0.3))
        self.drain()  # the speculative result is shown as provisional
        self.assertEqual(app.live_preview["status"], "provisional")
        app._on_segment(self.discard())
        self.assertIsNone(app.live_preview)
        self.assertEqual(app.discarded_bursts, 1)
        app._on_segment(event("pause", utterance=2, value=0.3))
        app._on_segment(self.discard(utterance=2, reason="silent"))
        self.assertEqual(self.drain(), [])  # the queued speculative decode was cancelled
        self.assertEqual(app.discarded_bursts, 1)  # a silent last part is not a noise burst
        self.assertIsNone(app.live_preview)
        self.assertEqual(self.saved(), [])

    def test_short_noise_burst_through_the_real_segmenter_leaves_nothing(self):
        # Review r1: a click under min_voiced used to emit a pause, start a speculative decode
        # and leave a provisional caption that never cleared.
        from meeting_assistant.vad import Segmenter

        rng = np.random.default_rng(0)
        noise = lambda seconds: (rng.standard_normal(int(seconds * 16000)) * 0.002).astype(np.float32)
        t = np.arange(int(0.15 * 16000)) / 16000
        burst = (0.3 * np.sin(2 * np.pi * 900 * t)).astype(np.float32) + noise(0.15)
        stream = np.concatenate([noise(2.0), burst, noise(3.0)])
        self.model.text = "嗯"
        segmenter = Segmenter(self.app._on_segment)
        for offset in range(0, len(stream), 1600):
            segmenter.process(stream[offset:offset + 1600], time.monotonic())
        self.assertEqual(self.drain(), [])
        self.assertIsNone(self.app.live_preview)
        self.assertEqual(self.app.discarded_bursts, 1)

    def test_no_speech_result_counts_as_discarded_burst(self):
        self.app._on_segment(event("final", value=0.0))
        self.drain()
        self.assertEqual(self.app.state()["discarded_bursts"], 1)
        self.assertNotIn("dropped", self.app.live_payload())

    def test_library_write_failure_still_publishes_and_translates(self):
        # Review r8: the caption was never published or translated and the preview stayed.
        import sqlite3

        app = self.app
        client = app.hub.subscribe()
        app._on_segment(event("preview", value=0.2))
        self.drain()

        def full(*args, **kwargs):
            raise sqlite3.OperationalError("database or disk is full")
        app.library.upsert_segment = full
        app._on_segment(event("final", value=0.2))
        ran = self.drain()
        self.assertEqual(ran, ["final", "translate"])
        self.assertIsNone(app.live_preview)
        published = [json.loads(line)["segment"] for line in client.take(0) if b'"segment"' in line]
        self.assertEqual(published[0]["status"], "error")
        self.assertIn("Not saved", published[0]["error"])
        self.assertEqual(published[-1]["english"], "translated")
        self.assertIn("could not be saved", app.notice)
        self.assertEqual(app.segments[0]["traditional_text"], "文字200")
        self.assertEqual([e["type"] for e in app.archive.events][-2:], ["source_segment", "segment"])

    def test_cancelled_translation_records_no_translation_latency(self):
        # Review r9: a translation cancelled by an edit still counted as a latency sample.
        app = self.app
        self.model.mt_gate = threading.Event()
        app._on_segment(event("final", value=0.2))
        app.run_job(app.jobs.next(timeout=0))
        translation = app.jobs.next(timeout=0)
        worker = threading.Thread(target=app.run_job, args=(translation,))
        worker.start()
        self.assertTrue(self.model.mt_started.wait(2))
        app.segment_edit({"id": 1, "text": "改正", "expected_revision": 1, "session_id": "fixture"})
        worker.join(timeout=2)
        timing = self.saved()[0]["timing"]
        self.assertIsNone(timing["translate_ms"])
        self.assertIsNone(timing["speech_end_to_english_ms"])
        self.assertIsNotNone(timing["asr_ms"])
        self.assertIsNone(app.live_payload()["latency"]["median"]["speech_end_to_english_ms"])

    def test_partial_translation_is_checked_and_published_under_the_edit_lock(self):
        # Review: a partial checked before an edit could be published after it.
        app = self.app
        self.model.partials = ["Good", "Good morning"]
        self.model.partial_delay = 0.11
        owned = []
        original = app._publish_segment

        def spy(segment, session_id):
            if segment.get("status") == "translating" and segment.get("english"):
                owned.append(app.lock._is_owned())
            return original(segment, session_id)
        app._publish_segment = spy
        app._on_segment(event("final", value=0.2))
        self.drain()
        self.assertTrue(owned)
        self.assertTrue(all(owned))

    def test_latency_summary_is_cached_until_timing_changes(self):
        from unittest import mock
        from meeting_assistant import server

        app = self.app
        app._on_segment(event("final", value=0.2))
        self.drain()
        with mock.patch.object(server, "latency_summary", wraps=server.latency_summary) as summary:
            for _ in range(50):
                app.live_payload()
            self.assertLessEqual(summary.call_count, 1)
            app._on_segment(event("final", utterance=2, start=2, end=3, value=0.3))
            self.drain()
            before = summary.call_count
            self.assertEqual(app.live_payload()["latency"]["count"], 2)
            self.assertEqual(summary.call_count, before + 1)

    def test_no_signal_advice_waits_for_30_seconds_without_speech(self):
        app = self.app

        class Meter:
            def snapshot(self):
                return {"rms_db": -120.0, "peak_db": -120.0, "clipped_recent": 0, "clipped_total": 0}

        class Detector:
            noise_db = speech_db = threshold_db = None
            speaking = False

        class Capture:
            meter, detector, samples = Meter(), Detector(), 10 * 16000

        app.capture = Capture()
        app.last_speech_seconds = None
        self.assertEqual(app.audio_state()["advice"], "")  # 10 s of digital silence: normal on Teams
        Capture.samples = 40 * 16000
        self.assertIn("No audio signal", app.audio_state()["advice"])
        app.last_speech_seconds = 25.0  # speech 15 s ago
        self.assertEqual(app.audio_state()["advice"], "")
        app.capture = None

    def test_archive_close_releases_the_journal_when_the_last_write_fails(self):
        from meeting_assistant.storage import Archive

        archive = Archive(self.root / "archive-test", "teams")
        archive.close_audio()

        def broken(event):
            raise OSError("disk full")
        archive.log = broken
        with self.assertRaises(OSError):
            archive.close("complete")
        self.assertTrue(archive.journal.closed)


class RestartRecoveryTests(unittest.TestCase):
    """Review r4/r7: journals of app-recorded sessions and interrupted sessions across restarts."""

    def setUp(self):
        import tempfile
        from pathlib import Path

        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve() / "data"

    def tearDown(self):
        self.temp.cleanup()

    def app(self, model=None):
        from meeting_assistant.server import Application

        app = Application(self.root, model=model or FakeModel(), start_threads=False)
        self.addCleanup(app.instance_lock.close)
        self.addCleanup(app.close)
        return app

    def record(self, app):
        from meeting_assistant.storage import Archive

        archive = Archive(self.root / "sessions", "teams")
        app.library.register_session(archive.id, "teams")
        app.session_id = app.capture_session = archive.id
        app.archive = archive
        app.capture_profile = {"context": "", "vocabulary": []}
        app.capture_audio = {"language": "zh", "normalize": False}
        app.recording_state = "recording"
        return archive

    @staticmethod
    def drain(app):
        while (job := app.jobs.next(timeout=0)) is not None:
            app.run_job(job)

    def test_retranslation_survives_restart_and_is_journaled(self):
        app = self.app()
        archive = self.record(app)

        def failing(text, **kwargs):
            raise RuntimeError("translation backend hiccup")
        app.model.translate = failing
        app._on_segment(event("final", value=0.2))
        self.drain(app)
        app._capture_done(None)
        self.drain(app)
        del app.model.translate
        app.model.translation = "Good morning everyone"
        app.segment_retranslate(1, archive.id)
        self.drain(app)
        self.assertEqual(app.library.get_session(archive.id)["segments"][0]["english"], "Good morning everyone")
        journal = (self.root / "sessions" / archive.id / "events.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(journal[-1])["english"], "Good morning everyone")
        app.close()
        app.instance_lock.close()
        again = self.app()
        segment = again.library.get_session(archive.id)["segments"][0]
        self.assertEqual((segment["status"], segment["english"]), ("complete", "Good morning everyone"))
        self.assertEqual(again.library.get_session(archive.id)["status"], "complete")

    def test_crash_mid_session_keeps_and_restores_captions_and_marks_interrupted(self):
        app = self.app()
        archive = self.record(app)
        app._on_segment(event("final", value=0.2))
        self.drain(app)  # segment 1 saved and translated
        # Segment 2: journaled, but the library write never happened (crash or disk full).
        archive.log({"type": "source_segment", "id": 2, "start": 3.0, "end": 4.0, "kind": "audio",
                     "raw_text": "b", "traditional_text": "b", "english": "", "revision": 1,
                     "status": "translating", "speaker": "unknown"})
        app.instance_lock.close()  # process killed before the finish job
        again = self.app()
        session = again.library.get_session(archive.id)
        self.assertEqual(session["status"], "interrupted")
        self.assertEqual([(s["id"], s["status"]) for s in session["segments"]], [(1, "complete"), (2, "pending")])
        self.assertEqual(session["segments"][0]["english"], "translated")
        self.assertEqual(again.library.get_session(archive.id)["status"], "interrupted")


class WorkerThreadTests(AppCase, unittest.TestCase):
    threads = True

    def setUp(self):
        self.make_app()
        self.begin()

    def test_worker_thread_processes_a_spoken_turn(self):
        app = self.app
        app._on_segment(event("preview", value=0.1))
        app._on_segment(event("pause", value=0.3))
        app._on_segment(event("final", value=0.3, same_as_pause=True))
        self.wait_for(lambda: self.saved() and self.saved()[0]["status"] == "complete", message="segment")
        self.assertTrue(app.jobs.wait_idle(timeout=2))
        self.assertEqual(self.saved()[0]["traditional_text"], "文字300")


if __name__ == "__main__":
    unittest.main()
