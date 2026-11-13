"""Static browser contracts without starting the app or accessing a meeting."""

import re
import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "meeting_assistant/static"
# Modules written by the app shell and panels; the gallery/glass files are the component library.
APP_MODULES = ["app", "api", "store", "ui", "transcript", "recorder", "sidebar", "panel-audio",
               "panel-context", "panel-speakers", "panel-review", "panel-export"]


class Elements(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.scripts = []
        self.events = []
        self.styles = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "script":
            self.scripts.append(attrs)
        if tag == "link":
            self.links.append(attrs)
        if "style" in attrs:
            self.styles.append(tag)
        self.events.extend(k for k in attrs if k.startswith("on"))


def source(name):
    return (STATIC / f"{name}.js").read_text()


class UIContractTests(unittest.TestCase):
    def test_static_ids_are_present_and_unique(self):
        parser = Elements()
        parser.feed((STATIC / "index.html").read_text())
        self.assertEqual(len(parser.ids), len(set(parser.ids)))
        required = set()
        for name in ("app", "transcript", "sidebar"):
            required |= set(re.findall(r'\$\("([^"\n]+)"\)', source(name)))
        self.assertFalse(required - set(parser.ids), required - set(parser.ids))
        for tab in ("audio", "context", "speakers", "review", "export"):
            self.assertIn(f"pane-{tab}", parser.ids)
            self.assertIn(f"tab-{tab}", parser.ids)

    def test_page_is_csp_clean(self):
        parser = Elements()
        parser.feed((STATIC / "index.html").read_text())
        self.assertFalse(parser.events, "CSP requires external scripts, not inline event handlers")
        self.assertFalse(parser.styles, "CSP forbids inline style attributes")
        self.assertEqual([s.get("src") for s in parser.scripts], ["/app.js"])
        self.assertTrue(all(s.get("type") == "module" for s in parser.scripts))
        self.assertTrue(all(l["href"].startswith("/") and "//" not in l["href"] for l in parser.links))
        self.assertIn("/panels.css", [l["href"] for l in parser.links])

    def test_module_imports_resolve_to_same_origin_files(self):
        for name in APP_MODULES:
            text = source(name)
            for target in re.findall(r'from "(/[^"]+)"', text):
                self.assertTrue((STATIC / target.lstrip("/")).is_file(), f"{name}: {target}")
            self.assertNotRegex(text, r'(?:from\s|import\(|fetch\()\s*["\'`]https?://', name)
            self.assertNotRegex(text, r'\beval\s*\(|new Function', name)
            self.assertNotRegex(text, r'setAttribute\(\s*["\']style["\']', name)

    def test_no_sensitive_or_unsafe_dom_rendering(self):
        for name in APP_MODULES:
            text = source(name)
            for forbidden in ("innerHTML", "outerHTML", "insertAdjacentHTML", "localStorage"):
                self.assertNotIn(forbidden, text, f"{name}: {forbidden}")
            self.assertNotRegex(text, r'sessionStorage\.setItem\([^\n]*(?:api_key|gateway-key|apiKey)', name)

    def test_authorization_header_and_consent(self):
        api = source("api")
        self.assertIn("Authorization:", api)
        self.assertIn("Bearer", api)
        self.assertIn("sessionStorage", api)
        # consent is sent from the consent sheet only
        for name in APP_MODULES:
            if name != "recorder":
                self.assertNotRegex(source(name), r'consent\s*:\s*true', name)
        self.assertRegex(source("recorder"), r'consent:\s*true')

    def test_old_stylesheet_is_gone(self):
        self.assertFalse((STATIC / "style.css").exists())


if __name__ == "__main__":
    unittest.main()
