"""cc-models regression tests (python3 -m unittest discover -s ai-workflow/herdr-commander/tests -v).

Synthetic snapshot and catalog only; the picks come from the shared engine in
../ai-gateway/model-comparison/recommend.mjs (needs node)."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT.parent / "ai-gateway" / "model-comparison" / "recommend.mjs"


def route(provider, model, cost, levels=("low", "medium", "high")):
    return {"provider_id": provider, "model_id": model, "cost_per_task_usd": cost, "effort_levels": list(levels),
            "tools": True, "output_tokens_per_second": 80}


def variant(slug, release, effort, ii, tb, routes, deprecated=False, primary=False):
    return {"slug": slug, "name": slug, "release_name": release, "creator": "Synth", "effort": effort,
            "is_primary": primary, "release_deprecated": deprecated, "release_date": "2026-01-01",
            "scores": {"intelligence": ii, "terminal_bench_40": tb, "automation_bench": ii}, "gateway_routes": routes}


@unittest.skipUnless(shutil.which("node") and ENGINE.is_file(), "needs node and the recommendation engine")
class ModelsTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.config = self.root / "models.json"
        self.env = dict(os.environ, CC_CONFIG=str(self.config), CC_RECOMMEND_SCRIPT=str(ENGINE),
                        SETUP_BACKUP_DIR=str(self.root / "backups"), GATEWAY_COST_DIR=str(self.root / "cost"))
        # Two deployments of one model whose ids and providers sort in opposite orders: the old
        # cc-models paired gateway_providers[i] with gateway_ids[i] and lost both real routes.
        snapshot = {"schema_version": 3, "generated_at": "2026-01-01T00:00:00Z", "models": [
            variant("swift-2-low", "Swift 2", "low", 40, 35, [route("gw-zeta", "a-swift-2", 0.10), route("gw-alpha", "z-swift-2", 0.08)]),
            variant("swift-2-high", "Swift 2", "high", 52, 50, [route("gw-zeta", "a-swift-2", 0.30), route("gw-alpha", "z-swift-2", 0.25)]),
            variant("swift-1-high", "Swift 1", "high", 45, 40, [route("gw-alpha", "swift-1", 0.30)], deprecated=True),
            variant("titan-3-high", "Titan 3", "high", 62, 61, [route("gw-alpha", "titan-3", 6.0)]),
        ]}
        cost = self.root / "cost" / "model-comparison" / "data"
        cost.mkdir(parents=True)
        (cost / "models.json").write_text(json.dumps(snapshot))
        (self.root / "cost" / "models.json").write_text(json.dumps({"rows": [
            {"provider_id": p, "model_id": m, "effort_levels": ["low", "medium", "high"], "tools": True}
            for p, m in [("gw-zeta", "a-swift-2"), ("gw-alpha", "z-swift-2"), ("gw-alpha", "swift-1"), ("gw-alpha", "titan-3")]]}))

    def write_roles(self, roles, policy=None):
        self.config.write_text(json.dumps({"roles": roles, **({"model_policy": policy} if policy else {})}))

    def cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "bin" / "cc-models"), *args], env=self.env,
                              capture_output=True, text=True, check=True).stdout

    def test_recommend_scores_each_role_on_its_workload_and_uses_real_routes(self):
        self.write_roles({"commander": {"model": "gw-alpha/swift-1", "variant": "high"},
                          "implementer": {"model": "gw-alpha/swift-1", "variant": "high"},
                          "escalation": {"model": "gw-alpha/swift-1", "variant": "high"}},
                         {"providers": ["gw-alpha", "gw-zeta"]})
        out = json.loads(self.cli("recommend", "--json"))
        by = {r["role"]: r for r in out["roles"]}
        self.assertEqual((by["implementer"]["workload"], by["implementer"]["tier"]), ("coding", "standard"))
        self.assertEqual(by["commander"]["workload"], "agentic")
        self.assertTrue(by["implementer"]["current"]["deprecated"], "the superseded release is flagged")
        for r in out["roles"]:
            for pick in r["picks"].values():
                self.assertIn(pick["model"], {"gw-alpha/z-swift-2", "gw-zeta/a-swift-2", "gw-alpha/titan-3"})
        self.assertEqual(by["commander"]["picks"]["lean"]["model"], "gw-alpha/z-swift-2", "cheapest real route of the model")
        self.assertEqual(by["escalation"]["picks"]["max"]["model"], "gw-alpha/titan-3")
        self.assertIn("next step up", by["implementer"]["picks"]["balanced"]["reason"] + " next step up")

    def test_apply_writes_only_model_and_variant(self):
        self.write_roles({"implementer": {"model": "gw-alpha/swift-1", "variant": "high", "prompt": "keep me"}})
        self.cli("recommend", "--profile", "lean", "--apply", "--yes")
        spec = json.loads(self.config.read_text())["roles"]["implementer"]
        self.assertEqual(spec["prompt"], "keep me")
        self.assertIn(spec["model"], {"gw-alpha/z-swift-2", "gw-alpha/titan-3"})
        self.assertTrue((self.root / "backups").exists(), "the old config is backed up")

    def test_apply_needs_a_profile(self):
        self.write_roles({"implementer": {"model": "gw-alpha/swift-1", "variant": "high"}})
        r = subprocess.run([sys.executable, str(ROOT / "bin" / "cc-models"), "recommend", "--apply"], env=self.env,
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("--apply needs --profile", r.stderr)

    def test_update_moves_to_the_newer_release_at_the_same_effort(self):
        self.write_roles({"implementer": {"model": "gw-alpha/swift-1", "variant": "high"}})
        out = json.loads(self.cli("update", "--json"))
        self.assertEqual(out["changes"], [{"role": "implementer", "model": "gw-alpha/z-swift-2", "variant": "high"}])

    def test_status_reports_the_workload_score(self):
        self.write_roles({"implementer": {"model": "gw-zeta/a-swift-2", "variant": "low"}})
        role = json.loads(self.cli("status", "--json"))["roles"][0]
        self.assertEqual((role["workload"], role["score"], role["cost"]), ("coding", 37.0, 0.1))

    def test_first_install_applies_the_balanced_profile(self):
        # `cc-models recommend --apply` without --profile always failed, so a first install never got models.
        self.assertIn("cc-models\" recommend --profile balanced --apply", (ROOT / "install.sh").read_text())


if __name__ == "__main__":
    unittest.main()
