"""Writer role regression tests (python3 -m unittest discover -s herdr-commander/tests -v)."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
HAIKU = "acc-anthropic/claude-5.5-haiku-anthropic"


class WriterTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.config = self.root / "models.json"
        self.state = self.root / "state"
        self.env = dict(os.environ, CC_CONFIG=str(self.config), CC_STATE_DIR=str(self.state),
                        SETUP_BACKUP_DIR=str(self.root / "backups"))
        self.writer = json.loads((ROOT / "config/models.example.json").read_text())["roles"]["writer"]
        self.assertTrue(self.writer["model"].startswith("<provider>/"), "example ships a placeholder like every role")
        self.assertNotIn("pin_model", self.writer)
        self.commander = {"mode": "primary", "model": "other/commander", "variant": "medium"}

    def cli(self, name, *args):
        return subprocess.run([sys.executable, str(ROOT / "bin" / name), *args], env=self.env,
                              capture_output=True, text=True, check=True).stdout

    def set_roles(self, **roles):
        self.config.write_text(json.dumps({"roles": roles, "model_policy": {
            "comparison_file": str(self.root / "comparison.json"),
            "catalog_file": str(self.root / "catalog.json"),
        }}))

    def create_benchmarks(self):
        candidates = [
            ("acc-anthropic", "claude-5.5-haiku-anthropic", "Claude 5.5 Haiku", "Anthropic", 30),
            ("other", "commander", "Commander 1", "Other", 20),
            ("other", "next", "Commander 2", "Other", 60),
        ]
        (self.root / "comparison.json").write_text(json.dumps({"models": [
            {"name": name, "creator": creator, "effort": "medium", "scores": {"intelligence": score},
             "pricing": {"gateway_cost_per_task_usd": 0.05}, "gateway_ids": [model], "gateway_providers": [provider]}
            for provider, model, name, creator, score in candidates
        ]}))
        (self.root / "catalog.json").write_text(json.dumps({"rows": [
            {"provider_id": provider, "model_id": model, "effort_levels": ["medium"], "tools": True}
            for provider, model, *_ in candidates
        ]}))

    def test_registry_launches_primary_writer_with_working_permissions(self):
        self.set_roles(commander=self.commander, writer={**self.writer, "model": HAIKU})
        self.env["HC_SOCKET"] = "/test/herdr.sock"
        dry_run = json.loads(self.cli("cc-agent", "writer", "--cwd", str(self.root), "--dry-run"))
        config = dry_run["OPENCODE_CONFIG_CONTENT"]
        writer = config["agent"]["writer"]
        self.assertEqual(config["default_agent"], "writer")
        self.assertEqual(config["agent"]["build"], writer)
        self.assertEqual((writer["mode"], writer["model"], writer["variant"]), ("primary", HAIKU, "medium"))
        self.assertEqual(writer["prompt"], self.writer["prompt"])
        self.assertEqual(writer["permission"], {"*": "allow"})
        self.assertIn("--auto", dry_run["cmd"])
        self.assertEqual(dry_run["HC_SOCKET"], "/test/herdr.sock")
        self.assertEqual(dry_run["cwd"], str(self.root))
        self.assertTrue(Path(dry_run["XDG_STATE_HOME"]).is_relative_to(self.state))
        self.assertEqual(self.cli("cc-agent", "writer", "--model-label").strip(), "claude-5.5-haiku-anthropic#medium")
        self.assertFalse(self.state.exists(), "dry run must not create role state")

    def test_commander_catalog_does_not_offer_writer_as_subagent(self):
        self.set_roles(commander=self.commander, writer={**self.writer, "model": HAIKU})
        config = json.loads(self.cli("cc-agent", "commander", "--dry-run"))["OPENCODE_CONFIG_CONTENT"]
        self.assertEqual(config["default_agent"], "commander")
        self.assertEqual(config["agent"]["writer"]["mode"], "primary")

    def test_installer_renders_writer_template_without_replacing_existing_registry(self):
        self.set_roles(commander=self.commander)
        before = self.config.read_bytes()
        home = self.root / "home"
        templates = self.root / "templates"
        prefix = self.root / "prefix"
        env = dict(self.env, HOME=str(home), HC_TEMPLATES_DIR=str(templates), PREFIX=str(prefix),
                   SKILLS_DIR=str(self.root / "skills"), HC_CONFIG_FILE=str(self.root / "hc.toml"), TMPDIR=str(self.root))
        for args in ([], ["--uninstall"]):
            subprocess.run(["bash", str(ROOT / "install.sh"), *args], env=env, capture_output=True, text=True, check=True)
            self.assertEqual(self.config.read_bytes(), before)
            path = templates / "cc-writer.md"
            if args:
                self.assertFalse(path.exists())
            else:
                content = path.read_text()
                self.assertIn(f"command: {prefix}/bin/cc-agent writer\n", content)
                self.assertIn("../artifacts/", content)
                self.assertIn("to your parent via `hc send`", content)

    def test_existing_config_without_writer_still_loads(self):
        self.set_roles(commander=self.commander)
        agents = json.loads(self.cli("cc-agent", "commander", "--dry-run"))["OPENCODE_CONFIG_CONTENT"]["agent"]
        self.assertNotIn("writer", agents)
        result = subprocess.run([sys.executable, str(ROOT / "bin/cc-agent"), "writer", "--dry-run"],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Unknown role 'writer'", result.stderr)

    def test_recommend_fills_writer_placeholder_like_other_roles(self):
        self.set_roles(commander=self.commander, writer=self.writer)
        self.create_benchmarks()
        picks = {r["role"]: r["picks"]["balanced"] for r in json.loads(self.cli("cc-models", "recommend", "--json"))["roles"]}
        self.assertEqual(picks["writer"], picks["commander"], "writer uses the same cheap-role rule as commander")
        self.cli("cc-models", "recommend", "--profile", "balanced", "--apply", "--role", "writer", "--yes")
        roles = json.loads(self.config.read_text())["roles"]
        self.assertEqual((roles["writer"]["model"], roles["writer"]["variant"]), (picks["writer"]["model"], "medium"))
        self.assertEqual(roles["commander"], self.commander)
        self.assertEqual({k: v for k, v in roles["writer"].items() if k != "model"},
                         {k: v for k, v in self.writer.items() if k != "model"})
