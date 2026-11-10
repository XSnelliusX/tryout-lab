import io
import json
import unittest
import urllib.error
from types import SimpleNamespace
from unittest.mock import patch

from meeting_assistant import learning, postprocess


def completion(data, finish="stop"):
    return {"choices": [{"finish_reason": finish, "message": {"content": json.dumps(data, ensure_ascii=False)}}]}


def segment(sid, text, speaker="unknown"):
    return {"id": sid, "traditional_text": text, "speaker": speaker, "raw_text": "private raw", "english": "private translation", "revision": 9}


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.client = postprocess.GatewayClient("https://gateway.example/v1", "example-model", "secret")

    def test_endpoint_validation_and_normalization(self):
        self.assertEqual(self.client.endpoint, "https://gateway.example/v1/chat/completions")
        self.assertEqual(postprocess.GatewayClient("https://gateway.example/v1/chat/completions/", "m").endpoint,
                         "https://gateway.example/v1/chat/completions")
        for url in ("http://gateway.example", "https://user:pass@gateway.example", "https://gateway.example?x=1",
                    "https://gateway.example#", "https://localhost", "https://127.0.0.1", "https://[::1]",
                    "https://10.2.3.4", "https://169.254.169.254", "https://0x7f.0.0.1",
                    "https://evil.example\\@host.example", "https://host.example:999999"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                postprocess.GatewayClient(url, "m")
        self.assertEqual(postprocess.GatewayClient("https://corp.internal/v1", "m").endpoint,
                         "https://corp.internal/v1/chat/completions")

    def test_dns_mixed_private_results_rejected(self):
        answers = [(2, 1, 6, "", ("8.8.8.8", 443)), (2, 1, 6, "", ("10.0.0.1", 443))]
        with patch.object(postprocess.socket, "getaddrinfo", return_value=answers):
            with self.assertRaises(postprocess.GatewayError):
                postprocess._addresses("corp.example", 443)

    def test_no_proxy_no_redirect_size_cap_and_sanitized_error(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b"x" * limit

        opener = SimpleNamespace(open=lambda *args, **kwargs: Response())
        with patch.object(postprocess, "_addresses", return_value=["8.8.8.8"]), \
             patch.object(postprocess.urllib.request, "build_opener", return_value=opener) as build:
            with self.assertRaisesRegex(postprocess.GatewayError, "size limit"):
                postprocess._transport(self.client.endpoint, {}, "secret")
            handlers = build.call_args.args
            self.assertTrue(any(isinstance(x, postprocess._NoRedirect) for x in handlers))
            self.assertEqual(next(x for x in handlers if isinstance(x, postprocess.urllib.request.ProxyHandler)).proxies, {})
            self.assertIsNone(postprocess._NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere"))

        def fail(*args, **kwargs):
            raise urllib.error.HTTPError("https://sensitive", 403, "secret", {}, io.BytesIO(b"private transcript"))

        with patch.object(postprocess, "_addresses", return_value=["8.8.8.8"]), \
             patch.object(postprocess.urllib.request, "build_opener", return_value=SimpleNamespace(open=fail)):
            with self.assertRaises(postprocess.GatewayError) as error:
                postprocess._transport(self.client.endpoint, {}, "secret")
            self.assertEqual(str(error.exception), "Gateway returned HTTP 403")

    def test_validated_address_is_used_for_tls_connection(self):
        handler = None
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'{}'
        def make_opener(*handlers):
            nonlocal handler
            handler = next(h for h in handlers if type(h).__name__ == "PinnedHandler")
            return SimpleNamespace(open=lambda *a, **kw: Response())
        with patch.object(postprocess, "_addresses", return_value=["8.8.8.8"]), \
             patch.object(postprocess.urllib.request, "build_opener", side_effect=make_opener):
            postprocess._transport(self.client.endpoint, {}, "")
        context = SimpleNamespace(wrap_socket=lambda sock, server_hostname: (sock, server_hostname))
        socket_object = SimpleNamespace(close=lambda: None)
        def do_open(connection_cls, request, **kwargs):
            conn = connection_cls("gateway.example", timeout=30, context=context)
            conn.connect()
            self.assertEqual(conn.sock, (socket_object, "gateway.example"))
        handler.do_open = do_open
        with patch.object(postprocess.socket, "create_connection", return_value=socket_object) as connect:
            handler.https_open(None)
            connect.assert_called_once_with(("8.8.8.8", 443), 30)

    def test_review_exact_whole_original_and_quote(self):
        items = [
            {"segment_id": 1, "original": "原文 測試", "replacement": "原文測試", "reason": "spacing", "uncertainty": "low", "quote": "測試"},
            {"segment_id": 1, "original": "測試", "replacement": "替換", "reason": "x", "uncertainty": "high", "quote": "測試"},
            {"segment_id": 1, "original": "原文 測試", "replacement": "替換", "reason": "x", "uncertainty": "high", "quote": "不存在"},
            {"segment_id": True, "original": "原文 測試", "replacement": "x", "reason": "x", "uncertainty": "high", "quote": "原文"},
        ]
        with patch.object(postprocess, "_transport", return_value=completion({"proposals": items})) as send:
            result = self.client.analyze([segment(1, "原文 測試", "S1")], task="review", context="work")
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["proposals"], items[:1])
        self.assertIn("Rejected 3", " ".join(result["limitations"]))
        payload = send.call_args.args[1]
        self.assertIn("untrusted data", payload["messages"][0]["content"])
        source = json.loads(payload["messages"][1]["content"])
        self.assertEqual(source["segments"], [{"id": 1, "text": "原文 測試", "speaker": "S1"}])
        self.assertNotIn("secret", json.dumps(payload))

    def test_summary_evidence_speaker_owner_deadline_and_acceptance(self):
        evidence = [{"segment_id": 1, "quote": "Alice Friday"}]
        data = {"overview": [{"text": "ok", "evidence": evidence}, {"text": "bad", "evidence": [{"segment_id": 1, "quote": "imagined"}]}],
                "decisions": [], "actions": [
                    {"text": "do it", "owner": "Alice", "deadline": "Friday", "status": "accepted", "evidence": evidence},
                    {"text": "other", "owner": "Bob", "deadline": "tomorrow", "status": "proposed", "evidence": evidence}],
                "people": [{"speaker": "Alice", "summary": "said it", "evidence": evidence},
                           {"speaker": "Bob", "summary": "no", "evidence": evidence}], "limitations": ["Ambiguous"]}
        with patch.object(postprocess, "_transport", return_value=completion(data)):
            result = self.client.analyze([segment(1, "Alice Friday", "s1")], task="summary", speaker_names={"s1": "Alice", "s2": "Bob"})
        self.assertEqual(len(result["overview"]), 1)
        self.assertEqual(len(result["people"]), 1)
        self.assertEqual(result["actions"][0]["status"], "proposed")
        self.assertEqual(result["actions"][0]["owner"], "Alice")
        self.assertEqual(result["actions"][0]["deadline"], "Friday")
        self.assertIsNone(result["actions"][1]["owner"])
        self.assertIsNone(result["actions"][1]["deadline"])
        self.assertIn("Ambiguous", result["limitations"])
        self.assertIn("later reversals", " ".join(result["limitations"]))

    def test_context_limit_matches_storage(self):
        with patch.object(postprocess, "_transport", return_value=completion({"proposals": []})):
            self.assertEqual(self.client.analyze([segment(1, "x")], task="review", context="a" * 4000)["status"], "ready")
            with self.assertRaises(ValueError):
                self.client.analyze([segment(1, "x")], task="review", context="a" * 4001)

    def test_chunk_coverage_overlap_and_no_cross_chunk_fabrication(self):
        source = [segment(i, f"start{i} " + "中" * 3000 + f" end{i}") for i in range(3)]
        seen = []
        def respond(endpoint, payload, key):
            chunk = json.loads(payload["messages"][1]["content"])["segments"]
            seen.append(chunk)
            return completion({"overview": [{"text": "supported", "evidence": [{"segment_id": chunk[0]["id"], "quote": chunk[0]["text"][:6]}]},
                                           {"text": "wrong chunk", "evidence": [{"segment_id": 999, "quote": "fake"}]}],
                               "decisions": [], "actions": [], "people": [], "limitations": []})
        with patch.object(postprocess, "_transport", side_effect=respond):
            result = self.client.analyze(source, task="summary")
        self.assertEqual({s["id"] for chunk in seen for s in chunk}, {0, 1, 2})
        self.assertEqual(seen[1][0]["id"], 0)
        self.assertEqual(seen[1][0]["text"], source[0]["traditional_text"][-200:])
        self.assertEqual(result["status"], "ready")
        self.assertTrue(all(x["text"] == "supported" for x in result["overview"]))
        self.assertIn("Rejected 3", " ".join(result["limitations"]))

    def test_long_segment_split_and_review_pending(self):
        source = [segment(1, "中" * 8000 + "終")]
        captured = []
        def respond(endpoint, payload, key):
            captured.extend(json.loads(payload["messages"][1]["content"])["segments"])
            return completion({"overview": [], "decisions": [], "actions": [], "people": []})
        with patch.object(postprocess, "_transport", side_effect=respond) as send:
            result = self.client.analyze(source, task="summary")
            before = send.call_count
            review = self.client.analyze(source, task="review")
        self.assertEqual(result["status"], "ready")
        self.assertTrue(captured[-1]["text"].endswith("終"))
        self.assertGreater(len(captured), 1)
        self.assertEqual(before, send.call_count)
        self.assertEqual(review["status"], "pending")

    def test_review_cannot_propose_whole_segment_from_overlap_excerpt(self):
        first = "a" * 3000
        proposal = {"segment_id": 1, "original": first, "replacement": "x", "reason": "x", "uncertainty": "high", "quote": "a"}
        responses = [completion({"proposals": []}), completion({"proposals": [proposal]})]
        with patch.object(postprocess, "_transport", side_effect=responses):
            result = self.client.analyze([segment(1, first), segment(2, "b" * 3000)], task="review")
        self.assertEqual(result["proposals"], [])
        self.assertIn("Rejected 1", " ".join(result["limitations"]))

    def test_retry_cancel_incomplete_and_malformed(self):
        source = [segment(1, "中文")]
        success = completion({"proposals": []})
        with patch.object(postprocess, "_transport", side_effect=[postprocess._Retryable("429"), success]) as send, \
             patch.object(postprocess.time, "sleep"):
            self.assertEqual(self.client.analyze(source, task="review")["status"], "ready")
            self.assertEqual(send.call_count, 2)
        with patch.object(postprocess, "_transport", side_effect=postprocess._Retryable("500")) as send, \
             patch.object(postprocess.time, "sleep"):
            self.assertEqual(self.client.analyze(source, task="review")["status"], "pending")
            self.assertEqual(send.call_count, 3)
        with patch.object(postprocess, "_transport", return_value=success) as send:
            self.assertEqual(self.client.analyze(source, task="review", cancelled=lambda: True)["status"], "cancelled")
            send.assert_not_called()
        for response in (completion({"proposals": []}, "length"), completion({"proposals": {}}), {"choices": []}):
            with self.subTest(response=response), patch.object(postprocess, "_transport", return_value=response):
                self.assertEqual(self.client.analyze(source, task="review")["status"], "pending")

    def test_partial_cancel_and_empty_input(self):
        with patch.object(postprocess, "_transport", return_value=completion({"proposals": []})) as send:
            self.assertEqual(self.client.analyze([], task="review")["status"], "ready")
            send.assert_not_called()
            calls = iter([False, False, True])
            result = self.client.analyze([segment(1, "a" * 3000), segment(2, "b" * 3000)], task="review", cancelled=lambda: next(calls))
            self.assertEqual(result["status"], "cancelled")
            self.assertEqual(send.call_count, 1)

    def test_progress_callback_receives_one_structured_value(self):
        updates = []
        with patch.object(postprocess, "_transport", return_value=completion({"proposals": []})):
            result = self.client.analyze([segment(1, "text")], task="review", progress=updates.append)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(updates, [{"stage": "review", "completed_chunks": 0, "total_chunks": 1},
                                   {"stage": "review", "completed_chunks": 1, "total_chunks": 1}])

    def test_gateway_echo_in_any_response_field_is_discarded(self):
        proposal = {"segment_id": 1, "original": "example", "replacement": "Example",
                    "reason": "secret", "uncertainty": "low", "quote": "example"}
        summary = {"overview": [{"text": "secret", "evidence": [{"segment_id": 1, "quote": "example"}]}],
                   "decisions": [], "actions": [], "people": [], "limitations": []}
        samples = [
            ("review", completion({"proposals": [proposal]})),
            ("review", completion({"proposals": [], "limitations": ["secret"]})),
            ("summary", completion(summary)),
            ("review", completion({"proposals": [], "nested": [{"secret": "ignored"}]})),
            ("review", {**completion({"proposals": []}), "error": {"message": "secret"}}),
            # Escaped characters are visible only after decoding the inner JSON.
            ("review", {"choices": [{"finish_reason": "stop", "message": {
                "content": '{"proposals":[],"limitations":["\\u0073ecret"]}'}}]}),
        ]
        for task, response in samples:
            with self.subTest(task=task, response=response), patch.object(postprocess, "_transport", return_value=response):
                result = self.client.analyze([segment(1, "example")], task=task)
            self.assertEqual(result["status"], "pending")
            self.assertIn("Gateway echoed credentials; response discarded", result["limitations"])
            self.assertNotIn("secret", json.dumps(result))
            self.assertFalse(result.get("proposals", result.get("overview")))

    def test_credential_preflight_checks_selected_source_and_configuration(self):
        cases = [
            ([segment(1, "before secret after")], "", {}),
            ([segment(1, "ordinary")], "secret", {}),
            ([segment(1, "ordinary", "secret")], "", {}),
            ([segment(1, "ordinary", "s1")], "", {"s1": "secret"}),
        ]
        with patch.object(postprocess, "_transport") as send:
            for segments, context, names in cases:
                with self.subTest(segments=segments, context=context, names=names):
                    result = self.client.analyze(segments, task="review", context=context, speaker_names=names)
                    self.assertEqual(result["status"], "pending")
                    self.assertNotIn("secret", json.dumps(result))
            send.assert_not_called()

    def test_partial_results_preserved_and_gateway_errors_redacted(self):
        proposal = {"segment_id": 1, "original": "a" * 3000, "replacement": "a",
                    "reason": "spacing", "uncertainty": "high", "quote": "a"}
        with patch.object(postprocess, "_transport", side_effect=[completion({"proposals": [proposal]}),
                                                                  completion({"proposals": [], "limitations": ["secret"]})]):
            result = self.client.analyze([segment(1, "a" * 3000), segment(2, "b" * 3000)], task="review")
        self.assertEqual(result["status"], "pending")
        self.assertEqual(result["proposals"], [proposal])
        self.assertNotIn("secret", json.dumps(result))
        with patch.object(postprocess, "_transport", side_effect=postprocess.GatewayError("secret in error")):
            result = self.client.analyze([segment(1, "example")], task="review")
        self.assertEqual(result["status"], "pending")
        self.assertNotIn("secret", json.dumps(result))

    def test_no_key_and_short_key_are_not_silently_ignored(self):
        data = completion({"proposals": [], "limitations": ["z"]})
        with patch.object(postprocess, "_transport", return_value=data):
            no_key = postprocess.GatewayClient("https://gateway.example", "m")
            self.assertEqual(no_key.analyze([segment(1, "example")], task="review")["status"], "ready")
            short_key = postprocess.GatewayClient("https://gateway.example", "m", "z")
            result = short_key.analyze([segment(1, "ordinary")], task="review")
        self.assertEqual(result["status"], "pending")
        self.assertNotIn("z", json.dumps(result))

    def test_credential_matching_schema_key_fails_without_leaking(self):
        client = postprocess.GatewayClient("https://gateway.example", "m", "status")
        with patch.object(postprocess, "_transport", return_value=completion({"proposals": []})):
            with self.assertRaises(postprocess.GatewayError) as error:
                client.analyze([segment(1, "ordinary")], task="review")
        self.assertNotIn("status", str(error.exception))


class LearningTests(unittest.TestCase):
    def test_missing_dictionary_and_source_checks(self):
        items = [{"term": "學習", "pinyin": "xué xí", "meaning": "learn", "segment_id": 1, "quote": "學習中文", "validation_status": "validated", "dictionary_meanings": ["made up"]},
                 {"term": "虛構", "pinyin": "xū gòu", "meaning": "fiction", "segment_id": 1, "quote": "學習中文"}]
        with patch.object(learning, "_local_dictionary", return_value=None):
            result = learning.validate_learning({"items": items}, [segment(1, "學習中文")])
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["validation_status"], "needs_review")
        self.assertNotIn("dictionary_meanings", result["items"][0])
        self.assertEqual(result["items"][0]["meaning"], "learn")
        self.assertIn("Rejected 1", " ".join(result["limitations"]))

    def test_dictionary_supported_heteronyms_and_wrong_tones(self):
        entries = {"學": [["xue2"]], "習": [["xi2"]], "行": [["xing2", "hang2"]]}
        dictionary = SimpleNamespace(Style=SimpleNamespace(TONE3=1), pinyin=lambda c, **kwargs: entries[c])
        convert = lambda s, **kwargs: s
        items = [{"term": term, "pinyin": reading, "meaning": "context", "segment_id": 1, "quote": "學習行"}
                 for term, reading in [("學習", "xue2 xi2"), ("學習", "xue3 xi2"), ("行", "xing2")]]
        with patch.object(learning, "_local_dictionary", return_value=(dictionary, convert, "test")):
            result = learning.validate_learning({"items": items}, [segment(1, "學習行")])
        self.assertEqual([x["validation_status"] for x in result["items"]], ["dictionary_supported", "needs_review", "needs_review"])
        self.assertIn("pypinyin test", result["items"][0]["dictionary_provenance"])
        self.assertIn("taiwan_usage_review_required", result["items"][0]["validation_flags"])
        self.assertIn("context_review_required", result["items"][0]["validation_flags"])
        self.assertIn("heteronym_review_required", result["items"][2]["validation_flags"])

    def test_gateway_learning_speaker_is_derived(self):
        item = {"term": "學習", "pinyin": "xue2 xi2", "meaning": "learn", "quote": "學習", "segment_id": 1, "speaker": "Invented"}
        with patch.object(postprocess, "_transport", return_value=completion({"items": [item], "limitations": []})), \
             patch.object(learning, "_local_dictionary", return_value=None):
            result = postprocess.GatewayClient("https://example.com", "m").analyze([segment(1, "學習", "s1")], task="learning", speaker_names={"s1": "Alice"})
        self.assertEqual(result["items"][0]["speaker"], "Alice")
        self.assertEqual(result["items"][0]["validation_status"], "needs_review")

    @unittest.skipIf(learning._local_dictionary() is None, "optional local pypinyin is not installed")
    def test_installed_pypinyin_tone_marks_and_heteronyms(self):
        quote = "國行"
        items = [{"term": term, "pinyin": reading, "meaning": "context", "quote": quote, "segment_id": 1}
                 for term, reading in [("國", "guó"), ("國", "guo2"), ("國", "guo3"), ("行", "háng")]]
        result = learning.validate_learning({"items": items}, [segment(1, quote)])
        self.assertEqual([x["validation_status"] for x in result["items"]],
                         ["dictionary_supported", "dictionary_supported", "needs_review", "needs_review"])
        self.assertIn("heteronym_review_required", result["items"][-1]["validation_flags"])


if __name__ == "__main__":
    unittest.main()
