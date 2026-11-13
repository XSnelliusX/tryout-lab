"""static/store.js event/snapshot ordering, run under Node with a stubbed api.js (skipped without node)."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")

STUB = """
export const pending = [];
export function api(path) { return new Promise((resolve) => pending.push(resolve)); }
export function getToken() { return "token"; }
"""

SCRIPT = r"""
import { store } from "./store.js";
import { pending } from "./api.js";
const out = {};
const seg = (english, revision = 1, status = "complete") => ({ id: 1, revision, status, english });
const snapshot = (seq, english) => {
  const state = { session: { id: "s", segments: [seg(english, 1, "translating")] }, segments: [seg(english, 1, "translating")],
                  live_preview: null, notice: "old" };
  if (seq !== undefined) state.seq = seq;
  return state;
};

// 1. Events that arrive while /api/state is in flight survive the older snapshot.
let refreshing = store.refresh();
store.handle({ type: "segment", seq: 101, session_id: "s", segment: seg("new") });
store.handle({ type: "live", seq: 102, notice: "newer notice" });
pending.shift()(snapshot(100, ""));
await refreshing;
out.reapplied = store.state.session.segments[0].english;
out.notice = store.state.notice;

// 2. Events already contained in the snapshot are ignored.
store.handle({ type: "segment", seq: 99, session_id: "s", segment: seg("stale") });
out.ignored = store.state.session.segments[0].english;

// 3. A partial of an older revision never replaces a newer revision.
store.handle({ type: "segment", seq: 103, session_id: "s", segment: seg("edited", 2, "pending") });
store.handle({ type: "segment", seq: 104, session_id: "s", segment: seg("partial of old text", 1, "translating") });
out.revision = [store.state.session.segments[0].revision, store.state.session.segments[0].english];

// 4. A server without seq: the snapshot wins, as before.
refreshing = store.refresh();
store.handle({ type: "segment", session_id: "s", segment: seg("streamed") });
pending.shift()(snapshot(undefined, "snapshot"));
await refreshing;
out.noSeq = store.state.session.segments[0].english;
store.handle({ type: "segment", session_id: "s", segment: seg("after", 1) });
out.noSeqAfter = store.state.session.segments[0].english;
console.log(JSON.stringify(out));
process.exit(0);
"""


@unittest.skipUnless(NODE, "node is not installed")
class StoreOrderingTests(unittest.TestCase):
    def test_events_snapshot_ordering_and_revisions(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            source = (ROOT / "meeting_assistant" / "static" / "store.js").read_text(encoding="utf-8")
            self.assertIn('from "/api.js"', source)
            (temp / "store.js").write_text(source.replace('from "/api.js"', 'from "./api.js"'), encoding="utf-8")
            (temp / "api.js").write_text(STUB, encoding="utf-8")
            (temp / "test.mjs").write_text(SCRIPT, encoding="utf-8")
            (temp / "package.json").write_text('{"type": "module"}', encoding="utf-8")
            done = subprocess.run([NODE, str(temp / "test.mjs")], capture_output=True, text=True, timeout=30, cwd=temp)
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout.strip().splitlines()[-1])
        self.assertEqual(result["reapplied"], "new")
        self.assertEqual(result["notice"], "newer notice")
        self.assertEqual(result["ignored"], "new")
        self.assertEqual(result["revision"], [2, "edited"])
        self.assertEqual(result["noSeq"], "snapshot")
        self.assertEqual(result["noSeqAfter"], "after")


if __name__ == "__main__":
    unittest.main()
