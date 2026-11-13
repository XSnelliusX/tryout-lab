"""Priority scheduler for the single model worker.

One worker thread owns the models. Jobs wait here ordered by priority, then
by submission order. Previews are optional work: only the newest one is kept
and a running preview is cancelled as soon as recognition that matters
(a final or a speculative pause decode) arrives. Nothing else is ever dropped.
"""

import itertools
import threading
import time

FINAL = 0        # final recognition of an utterance part
SPECULATIVE = 1  # recognition started at a pause, before the end of the turn is confirmed
TRANSLATE = 2    # live translation, manual text, user retranslation
PREVIEW = 3      # provisional caption of the open utterance
FINISH = 4       # session finalisation; lowest, so it runs after all other work

PRIORITY = {"final": FINAL, "speculative": SPECULATIVE, "translate": TRANSLATE, "manual": TRANSLATE,
            "retranslate": TRANSLATE, "preview": PREVIEW, "finish": FINISH}


class Job:
    """A unit of model work. ``cancelled`` is polled by the model through should_cancel."""

    _seq = itertools.count()

    def __init__(self, type, session_id=None, **fields):
        if type not in PRIORITY:
            raise ValueError(f"unknown job type {type!r}")
        self.type = type
        self.priority = PRIORITY[type]
        self.session_id = session_id
        self.seq = next(self._seq)
        self.queued_at = fields.pop("queued_at", None) or time.monotonic()
        self.cancelled = False
        self.state = "new"  # new -> queued -> running -> done
        self.__dict__.update(fields)

    def should_cancel(self):
        return self.cancelled

    def get(self, name, default=None):
        return self.__dict__.get(name, default)

    def __repr__(self):
        return f"<Job {self.type} #{self.seq} p{self.priority} {self.state}{' cancelled' if self.cancelled else ''}>"


class Scheduler:
    def __init__(self):
        self._cond = threading.Condition(threading.Lock())
        self._queued = []
        self._running = None
        self.closed = False

    # -- submission ---------------------------------------------------------
    def submit(self, job):
        with self._cond:
            if job.type == "preview":
                # Coalesce: only the newest preview survives, and an older running
                # preview is not worth finishing.
                for old in [j for j in self._queued if j.type == "preview"]:
                    self._remove(old)
                if self._running is not None and self._running.type == "preview" and self._running.get("key") != job.get("key"):
                    self._running.cancelled = True
            elif job.priority <= SPECULATIVE and self._running is not None and self._running.type == "preview":
                self._running.cancelled = True
            job.state = "queued"
            self._queued.append(job)
            self._cond.notify()
            return job

    def promote(self, job, priority=FINAL):
        """Raise the priority of a queued job (a speculative decode that became final)."""
        with self._cond:
            job.priority = min(job.priority, priority)
            if job.state == "running" and self._running is job:
                return "running"
            return job.state

    def cancel(self, predicate):
        """Cancel matching queued and running jobs; returns the cancelled jobs."""
        with self._cond:
            hit = [j for j in self._queued if predicate(j)]
            for job in hit:
                self._remove(job)
                job.cancelled = True
                job.state = "done"
            if self._running is not None and predicate(self._running):
                self._running.cancelled = True
                hit.append(self._running)
            return hit

    def _remove(self, job):
        self._queued.remove(job)
        job.state = "done"

    # -- worker side --------------------------------------------------------
    def next(self, timeout=None):
        """Block until a job is available; mark it running. None on timeout or close."""
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            while not self._queued and not self.closed:
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return None
                self._cond.wait(remaining)
            if self.closed and not self._queued:
                return None
            job = min(self._queued, key=lambda j: (j.priority, j.seq))
            self._queued.remove(job)
            job.state = "running"
            self._running = job
            return job

    def done(self, job):
        with self._cond:
            job.state = "done"
            if self._running is job:
                self._running = None
            self._cond.notify_all()

    def close(self):
        with self._cond:
            self.closed = True
            self._cond.notify_all()

    def wait_idle(self, timeout=None, include_previews=False):
        """Block until no (non-preview) work is queued or running."""
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            while self._pending(include_previews):
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False
                self._cond.wait(remaining if remaining is not None else 0.5)
            return True

    # -- accounting -----------------------------------------------------------
    def _pending(self, include_previews=False):
        jobs = self._queued + ([self._running] if self._running is not None else [])
        return [j for j in jobs if include_previews or j.type != "preview"]

    @property
    def unfinished_tasks(self):
        """Queued plus running work, previews excluded (they are optional)."""
        with self._cond:
            return len(self._pending())

    def stats(self, now=None):
        """(queue_length, lag_seconds, pending_work) for the UI; previews excluded."""
        now = time.monotonic() if now is None else now
        with self._cond:
            queued = [j for j in self._queued if j.type not in ("preview", "finish")]
            pending = [j for j in self._pending() if j.type != "finish"]
            oldest = min((j.queued_at for j in pending), default=now)
            return len(queued), max(0.0, now - oldest), len(self._pending())

    def snapshot(self):
        with self._cond:
            return list(self._queued), self._running
