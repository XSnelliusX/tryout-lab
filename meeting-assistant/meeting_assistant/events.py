"""Fan-out of server events to /api/events NDJSON clients.

Publishing never blocks: each client has a bounded queue. A slow client loses
its oldest ``live`` events first (they are snapshots; the newest one wins); if
it falls further behind, its queue is replaced by one ``refresh`` so it
re-fetches the full state.
"""

import collections
import json
import threading
import time

PING_SECONDS = 10.0
_REFRESH = json.dumps({"type": "refresh"}).encode() + b"\n"
_PING = json.dumps({"type": "ping"}).encode() + b"\n"


def encode(event):
    return json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"


class Client:
    def __init__(self, limit):
        self.limit = limit
        self.items = collections.deque()  # (kind, bytes)
        self.cond = threading.Condition(threading.Lock())
        self.closed = False
        self.dropped = 0
        self.resyncs = 0

    def put(self, kind, data):
        with self.cond:
            if self.closed:
                return
            if len(self.items) >= self.limit:
                live = next((i for i, item in enumerate(self.items) if item[0] == "live"), None)
                if live is not None:
                    del self.items[live]
                    self.dropped += 1
                else:
                    # Far behind on segment events: resync through the full state.
                    self.items.clear()
                    self.resyncs += 1
                    self.items.append(("refresh", _REFRESH))
                    self.cond.notify()
                    if kind in ("refresh", "ping"):
                        return
            if kind == "refresh" and any(item[0] == "refresh" for item in self.items):
                return
            self.items.append((kind, data))
            self.cond.notify()

    def take(self, timeout):
        """Wait up to timeout for events; return a list of encoded lines (maybe empty)."""
        with self.cond:
            if not self.items and not self.closed:
                self.cond.wait(timeout)
            items = [data for _, data in self.items]
            self.items.clear()
            return items

    def close(self):
        with self.cond:
            self.closed = True
            self.cond.notify_all()


class EventHub:
    def __init__(self, client_limit=256, ping_seconds=PING_SECONDS):
        self._lock = threading.Lock()
        self._clients = set()
        self.client_limit = client_limit
        self.ping_seconds = ping_seconds
        self.closed = False

    def subscribe(self):
        client = Client(self.client_limit)
        with self._lock:
            if self.closed:
                client.close()
            self._clients.add(client)
        return client

    def unsubscribe(self, client):
        with self._lock:
            self._clients.discard(client)
        client.close()

    @property
    def client_count(self):
        with self._lock:
            return len(self._clients)

    def publish(self, event):
        kind = event.get("type", "live")
        data = _REFRESH if kind == "refresh" else encode(event)
        with self._lock:
            clients = list(self._clients)
        for client in clients:
            client.put(kind, data)

    def close(self):
        with self._lock:
            self.closed = True
            clients = list(self._clients)
        for client in clients:
            client.close()

    def stream(self, client, write):
        """Serve one client until it disconnects or the hub closes.

        ``write(bytes)`` must raise OSError on a broken connection.
        """
        next_ping = time.monotonic() + self.ping_seconds
        try:
            while not client.closed and not self.closed:
                lines = client.take(max(0.0, next_ping - time.monotonic()))
                if lines:
                    write(b"".join(lines))
                if time.monotonic() >= next_ping:
                    write(_PING)
                    next_ping = time.monotonic() + self.ping_seconds
        except (OSError, ValueError):
            pass  # Client went away; ValueError: write to a closed file.
        finally:
            self.unsubscribe(client)
