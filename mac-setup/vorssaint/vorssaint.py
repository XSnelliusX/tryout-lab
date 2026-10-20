#!/usr/bin/env python3
"""Export or restore Vorssaint settings (com.vorssaint.utils).

  vorssaint.py export <file>   write the portable settings to <file>
  vorssaint.py import <file>   merge <file> into the live settings

Machine-specific and personal keys are left out of the export: feature
availability probes, window sizes, shelf contents, the command-bar habit key and
update/onboarding bookkeeping. Clipboard history and the scratchpad live in
~/Library/Application Support and are never exported.
"""
import plistlib
import subprocess
import sys

DOMAIN = "com.vorssaint.utils"
SKIP_PREFIXES = ("featureAvailable.", "settingsWindow")
SKIP_KEYS = {
    "commandBarQueryHabitKey", "shelfItems", "lastUpdateIntroVersion",
    "supportUpdateIntroVersion", "updateHighlightsSeenVersion",
    "bluetoothSleepRestorePending", "onboardingStep",
}


def live():
    out = subprocess.run(["defaults", "export", DOMAIN, "-"], capture_output=True)
    return plistlib.loads(out.stdout) if out.returncode == 0 and out.stdout else {}


def portable(data):
    return {
        k: v for k, v in data.items()
        if k not in SKIP_KEYS and not k.startswith(SKIP_PREFIXES)
        and not isinstance(v, bytes)
    }


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("export", "import"):
        sys.exit(__doc__)
    mode, path = sys.argv[1:]
    if mode == "export":
        data = portable(live())
        if not data:
            sys.exit("no Vorssaint settings found, launch the app once first")
        with open(path, "wb") as f:
            plistlib.dump(data, f, sort_keys=True)
        print(f"exported {len(data)} settings to {path}")
    else:
        # The app caches its settings, so quit it before writing.
        subprocess.run(["osascript", "-e", 'tell application "Vorssaint" to quit'],
                       capture_output=True)
        merged = live()
        with open(path, "rb") as f:
            merged.update(plistlib.load(f))
        subprocess.run(["defaults", "import", DOMAIN, "-"],
                       input=plistlib.dumps(merged), check=True)
        print(f"imported settings from {path}")


main()
