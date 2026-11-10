"""Static browser contracts without starting the app or accessing a meeting."""

import re
import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class Elements(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.scripts = []
        self.events = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "script":
            self.scripts.append(attrs)
        self.events.extend(k for k in attrs if k.startswith("on"))


class UIContractTests(unittest.TestCase):
    def test_static_ids_are_present_and_unique(self):
        parser = Elements()
        parser.feed((ROOT / "meeting_assistant/static/index.html").read_text())
        self.assertEqual(len(parser.ids), len(set(parser.ids)))
        script = (ROOT / "meeting_assistant/static/app.js").read_text()
        dynamic = {"segments-empty"}
        required = set(re.findall(r'\$\("([^"\n]+)"\)', script)) - dynamic
        self.assertFalse(required - set(parser.ids), required - set(parser.ids))
        self.assertFalse(parser.events, "CSP requires external scripts, not inline event handlers")
        self.assertTrue(all(script.get("src") == "/app.js" for script in parser.scripts))

    def test_no_remote_scripts_or_sensitive_dom_rendering(self):
        script = (ROOT / "meeting_assistant/static/app.js").read_text()
        self.assertNotIn("innerHTML", script)
        self.assertNotIn("localStorage", script)
        self.assertNotRegex(script, r'sessionStorage\.setItem\([^\n]*(?:api_key|gateway-key)')
        self.assertIn("Authorization:", script)


if __name__ == "__main__":
    unittest.main()
