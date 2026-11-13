"""HTTP: event stream, static files, devices, settings validation and error responses (fake models)."""

import http.client
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from meeting_assistant import server as server_module
from meeting_assistant.audio import clear_probe_cache
from meeting_assistant.events import Client, EventHub, encode
from meeting_assistant.server import make_server

from pipeline_fakes import AppCase, write_helper

TOKEN = "test-token"


class HubTests(unittest.TestCase):
    def test_slow_client_loses_oldest_live_events_first(self):
        client = Client(limit=3)
        client.put("segment", b"s1\n")
        for index in range(5):
            client.put("live", f"l{index}\n".encode())
        self.assertEqual(client.take(0), [b"s1\n", b"l3\n", b"l4\n"])
        self.assertEqual(client.dropped, 3)

    def test_client_far_behind_on_segments_is_told_to_refresh(self):
        client = Client(limit=3)
        for index in range(7):
            client.put("segment", f"s{index}\n".encode())
        items = client.take(0)
        self.assertEqual(items[0], json.dumps({"type": "refresh"}).encode() + b"\n")
        self.assertLessEqual(len(items), 3)
        self.assertGreaterEqual(client.resyncs, 1)

    def test_queued_refreshes_are_coalesced(self):
        hub = EventHub()
        client = hub.subscribe()
        for _ in range(10):
            hub.publish({"type": "refresh"})
        self.assertEqual(len(client.take(0)), 1)

    def test_publish_never_blocks_on_a_stuck_client(self):
        hub = EventHub(client_limit=8)
        hub.subscribe()  # never read
        started = time.monotonic()
        for index in range(10000):
            hub.publish({"type": "live", "n": index})
        self.assertLess(time.monotonic() - started, 2)

    def test_encoding_is_one_line(self):
        self.assertEqual(encode({"type": "segment", "text": "a\nb"}).count(b"\n"), 1)


class HttpCase(AppCase):
    threads = True

    def setUp(self):
        self.make_app()
        self.app.library.register_session("fixture", "teams")
        self.httpd = make_server(self.app, TOKEN, 0)
        self.port = self.httpd.server_port
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def request(self, method, path, body=None, token=TOKEN, headers=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        send = {"Host": f"127.0.0.1:{self.port}"}
        if token:
            send["Authorization"] = f"Bearer {token}"
        if method == "POST":
            send["Origin"] = f"http://127.0.0.1:{self.port}"
            send["Content-Type"] = "application/json"
        send.update(headers or {})
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        connection.request(method, path, body=payload, headers=send)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response, data

    def json(self, method, path, body=None, **kwargs):
        response, data = self.request(method, path, body, **kwargs)
        return response.status, json.loads(data)


class Stream:
    """Raw-socket NDJSON reader with timeouts that do not break the connection."""

    def __init__(self, sock):
        self.sock, self.buffer = sock, b""

    def _fill(self, timeout):
        import select

        ready, _, _ = select.select([self.sock], [], [], max(0.0, timeout))
        if not ready:
            return False
        data = self.sock.recv(65536)
        if not data:
            raise EOFError
        self.buffer += data
        return True

    def readline(self, timeout=3.0):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buffer:
            if not self._fill(deadline - time.monotonic()):
                raise AssertionError("no line before timeout")
        line, _, self.buffer = self.buffer.partition(b"\n")
        return line + b"\n"

    def headers(self):
        status = self.readline()
        headers = {}
        while (line := self.readline()) != b"\r\n":
            name, _, value = line.decode().partition(":")
            headers[name.strip().lower()] = value.strip()
        return status, headers

    def event(self, timeout=3.0):
        return json.loads(self.readline(timeout))

    def collect(self, seconds):
        events = []
        deadline = time.monotonic() + seconds
        while True:
            while b"\n" in self.buffer:
                line, _, self.buffer = self.buffer.partition(b"\n")
                events.append(json.loads(line))
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not self._fill(remaining):
                return events


class EventStreamTests(HttpCase, unittest.TestCase):
    def open_stream(self, token=TOKEN):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.addCleanup(sock.close)
        auth = f"Authorization: Bearer {token}\r\n" if token else ""
        sock.sendall(f"GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n{auth}\r\n".encode())
        stream = Stream(sock)
        status, headers = stream.headers()
        return status, headers, stream, sock

    def read_event(self, stream, wanted, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = stream.event(deadline - time.monotonic())
            if event["type"] == wanted:
                return event
        raise AssertionError(f"no {wanted} event")

    def test_requires_token(self):
        status, _, _, _ = self.open_stream(token=None)
        self.assertIn(b" 403 ", status)
        status, _, _, _ = self.open_stream(token="wrong")
        self.assertIn(b" 403 ", status)
        self.assertEqual(self.app.hub.client_count, 0)

    def test_ndjson_framing_and_segment_events(self):
        status, headers, stream, _ = self.open_stream()
        self.assertIn(b" 200 ", status)
        self.assertEqual(headers["content-type"], "application/x-ndjson; charset=utf-8")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertNotIn("content-length", headers)
        self.assertEqual(stream.event(), {"type": "ping"})
        self.app.session_id = "fixture"
        self.app._publish_segment({"id": 3, "traditional_text": "早安\n第二行", "status": "complete"}, "fixture")
        event = self.read_event(stream, "segment")
        self.assertEqual((event["session_id"], event["segment"]["id"]), ("fixture", 3))
        self.assertEqual(event["segment"]["traditional_text"], "早安\n第二行")

    def test_segment_events_only_for_the_selected_session(self):
        _, _, stream, _ = self.open_stream()
        stream.event()
        self.app.session_id = "fixture"
        self.app._publish_segment({"id": 1, "status": "complete"}, "other")
        self.assertEqual([e for e in stream.collect(0.3) if e["type"] == "segment"], [])

    def test_ping_interval(self):
        self.app.hub.ping_seconds = 0.2
        _, _, stream, _ = self.open_stream()
        stream.event()  # initial ping
        started = time.monotonic()
        self.read_event(stream, "ping")
        self.assertLess(time.monotonic() - started, 1.5)

    def test_refresh_bursts_are_coalesced(self):
        _, _, stream, _ = self.open_stream()
        stream.collect(0.6)  # start-up events
        for _ in range(50):
            self.app._request_refresh()
        refreshes = [e for e in stream.collect(0.8) if e["type"] == "refresh"]
        self.assertTrue(1 <= len(refreshes) <= 2, refreshes)

    def test_post_triggers_refresh_and_live_reflects_notice(self):
        _, _, stream, _ = self.open_stream()
        stream.collect(0.4)
        status, _ = self.json("POST", "/api/settings", {"meeting_context": "Quarterly planning"})
        self.assertEqual(status, 200)
        self.read_event(stream, "refresh")
        self.app._set_notice("hello")
        event = self.read_event(stream, "live")
        while event["notice"] != "hello":
            event = self.read_event(stream, "live")
        self.assertIn("audio", event)
        self.assertIn("preview", event)
        self.assertIn("latency", event)

    def test_job_state_change_triggers_refresh(self):
        _, _, stream, _ = self.open_stream()
        stream.collect(0.4)
        with self.app.lock:
            self.app.background_job = {"id": "x", "status": "running", "progress": "Starting…"}
        self.read_event(stream, "refresh")

    def test_disconnect_is_cleaned_up(self):
        _, _, stream, sock = self.open_stream()
        stream.event()
        self.assertEqual(self.app.hub.client_count, 1)
        sock.close()
        self.app.hub.ping_seconds = 0.05
        for _ in range(5):
            self.app.hub.publish({"type": "refresh"})
            time.sleep(0.05)
        self.wait_for(lambda: self.app.hub.client_count == 0, 3, "client cleanup")

    def test_live_events_are_rate_limited(self):
        _, _, stream, _ = self.open_stream()
        stream.collect(0.3)
        self.app.recording_state = "recording"
        self.app.started_at = time.monotonic()
        stop = time.monotonic() + 1.0
        counter = 0
        while time.monotonic() < stop:  # a change every 5 ms
            counter += 1
            self.app.audio_seconds = counter / 10
            self.app._live_dirty.set()
            time.sleep(0.005)
        live = [e for e in stream.collect(0.15) if e["type"] == "live"]
        self.app.recording_state = "idle"
        self.assertTrue(7 <= len(live) <= 12, len(live))


class StaticFileTests(HttpCase, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.static = Path(tempfile.mkdtemp(dir=self.root))
        (self.static / "index.html").write_text("<!doctype html>")
        (self.static / "app.js").write_text("export {};")
        (self.static / "panel-audio.js").write_text("export {};")
        (self.static / "style.css").write_text("body{}")
        (self.static / "icon.svg").write_text("<svg/>")
        (self.static / "notes.txt").write_text("no")
        (self.static / "dir.js").mkdir()
        outside = self.root / "secret.js"
        outside.write_text("secret")
        (self.static / "link.js").symlink_to(outside)
        patcher = mock.patch.object(server_module, "STATIC", self.static)
        patcher.start()
        self.addCleanup(patcher.stop)

    def get(self, path, cookie=True):
        headers = {"Cookie": f"meeting_session={TOKEN}"} if cookie else {}
        return self.request("GET", path, token=None, headers=headers)

    def test_bootstrap_sets_cookie_and_serves_index(self):
        response, body = self.get(f"/?token={TOKEN}", cookie=False)
        self.assertEqual(response.status, 200)
        self.assertIn("meeting_session=", response.getheader("Set-Cookie"))
        self.assertEqual(response.getheader("Content-Type"), "text/html; charset=utf-8")
        self.assertIn("frame-ancestors 'none'", response.getheader("Content-Security-Policy"))
        self.assertEqual(body, b"<!doctype html>")

    def test_any_matching_file_with_cookie_and_correct_type(self):
        for path, kind in (("/app.js", "text/javascript"), ("/panel-audio.js", "text/javascript"),
                           ("/style.css", "text/css"), ("/icon.svg", "image/svg+xml"), ("/", "text/html")):
            response, _ = self.get(path)
            self.assertEqual(response.status, 200, path)
            self.assertTrue(response.getheader("Content-Type").startswith(kind), path)
            self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")

    def test_rejections(self):
        for path in ("/notes.txt", "/link.js", "/dir.js", "/../secret.js", "/%2e%2e/secret.js", "/App.js",
                     "/.hidden.js", "/sub/app.js", "/missing.js", "/app.js/", "/app.js%00.html"):
            response, body = self.get(path)
            self.assertEqual(response.status, 403, path)
            self.assertEqual(json.loads(body), {"error": "Forbidden"})
        response, _ = self.get("/app.js", cookie=False)
        self.assertEqual(response.status, 403)
        response, _ = self.get("/app.js?token=" + TOKEN, cookie=False)  # bootstrap only at /
        self.assertEqual(response.status, 403)


class ApiTests(HttpCase, unittest.TestCase):
    def test_devices_with_protocol_2_and_1_helpers(self):
        clear_probe_cache()
        self.app.helper = write_helper(self.root, 2)
        status, body = self.json("GET", "/api/devices")
        self.assertEqual(status, 200)
        self.assertTrue(body["supported"])
        self.assertEqual(body["devices"][0]["name"], "MacBook Pro Microphone")
        self.assertEqual(self.json("GET", "/api/state")[1]["capabilities"]["helper_protocol"], 2)
        self.app.helper = write_helper(self.root, 1)
        self.assertEqual(self.json("GET", "/api/devices"), (200, {"supported": False, "devices": []}))
        self.assertEqual(self.json("GET", "/api/state")[1]["capabilities"]["helper_protocol"], 1)
        self.assertEqual(self.request("GET", "/api/devices", token=None)[0].status, 403)

    def test_helper_stale_capability(self):
        helper = write_helper(self.root, 2)
        source = self.root / "CaptureAudio.swift"
        source.write_text("// newer")
        os.utime(helper, (time.time() - 100, time.time() - 100))
        self.app.helper = helper
        with mock.patch.object(server_module, "HELPER_SOURCE", source):
            self.assertTrue(self.json("GET", "/api/state")[1]["capabilities"]["helper_stale"])

    def test_audio_settings_validation_and_partial_updates(self):
        status, body = self.json("POST", "/api/settings", {"audio": {"language": "en"}})
        self.assertEqual(status, 200)
        self.assertEqual(body["settings"]["audio"], {"device_uid": "", "language": "en", "normalize": True})
        status, body = self.json("POST", "/api/settings", {"audio": {"device_uid": "BuiltIn", "normalize": False}})
        self.assertEqual(body["settings"]["audio"], {"device_uid": "BuiltIn", "language": "en", "normalize": False})
        for bad in ({"language": "fr"}, {"language": ["zh"]}, {"normalize": "yes"}, {"device_uid": "x" * 301},
                    {"device_uid": 5}, {"device_uid": "--source"}, {"gain": 3}, ["language"]):
            status, body = self.json("POST", "/api/settings", {"audio": bad})
            self.assertEqual(status, 400, bad)
            self.assertIn("error", body)
        self.assertEqual(self.app.library.get_settings()["audio"]["device_uid"], "BuiltIn")

    def test_session_context_route(self):
        self.app.session_id = "fixture"
        status, body = self.json("POST", "/api/session/context", {"session_id": "fixture", "context": "Budget review"})
        self.assertEqual(status, 200)
        self.assertEqual(body["session"]["context"], "Budget review")
        self.assertEqual(body["session"]["version"], 2)
        status, body = self.json("POST", "/api/session/context", {"session_id": "other", "context": "x"})
        self.assertEqual(status, 400)

    def test_bad_input_is_400_json(self):
        self.app.session_id = "fixture"
        cases = [("/api/job/start", {"task": []}), ("/api/job/start", {"task": {"a": 1}}),
                 ("/api/start", {"source": ["teams"], "consent": True}), ("/api/manual", {"text": 5}),
                 ("/api/segment/edit", {"session_id": "fixture", "id": "1", "text": []}),
                 ("/api/session/open", {"session_id": {"x": 1}}), ("/api/export", {"format": []}),
                 ("/api/speakers", {"names": "x", "session_id": "fixture"})]
        for path, body in cases:
            status, reply = self.json("POST", path, body)
            self.assertEqual(status, 400, (path, reply))
            self.assertIsInstance(reply["error"], str)
        for raw in (b"{not json", b"[1, 2]", b"\xff\xfe"):
            response, data = self.request("POST", "/api/settings", raw=raw)
            self.assertEqual(response.status, 400)
            self.assertIn("error", json.loads(data))
        response, data = self.request("GET", "/api/history?segment_id=abc&session_id=fixture")
        self.assertEqual(response.status, 400)

    def test_unexpected_failure_is_generic_500_json(self):
        def explode():
            raise RuntimeError("secret transcript text")
        self.app.save = explode
        status, body = self.json("POST", "/api/save", {})
        self.assertEqual(status, 500)
        self.assertNotIn("secret", body["error"])
        self.app.state = explode
        status, body = self.json("GET", "/api/state")
        self.assertEqual(status, 500)
        self.assertNotIn("secret", body["error"])

    def test_auth_and_unknown_routes(self):
        self.assertEqual(self.request("GET", "/api/state", token=None)[0].status, 403)
        self.assertEqual(self.request("GET", "/api/nope")[0].status, 404)
        self.assertEqual(self.request("POST", "/api/nope", {})[0].status, 404)
        response, _ = self.request("POST", "/api/settings", {}, headers={"Origin": "http://evil.example"})
        self.assertEqual(response.status, 403)


if __name__ == "__main__":
    unittest.main()
