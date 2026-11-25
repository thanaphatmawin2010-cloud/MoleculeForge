"""Report why the Android emulator test failed, as GitHub Actions annotations.

Annotations are part of the check run, so they can be read wherever the logs cannot. Reports the
instrumented tests' failure messages (JUnit XML from Gradle) and the device log lines that explain
them: the WebView's console output, crashes and the test runner.

    python3 scripts/android_ci_report.py --results android/app/build/outputs/androidTest-results --logcat android-logcat.txt
"""

from __future__ import annotations

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

RELEVANT = re.compile(
    r"chromium|Console|AndroidRuntime|FATAL|TestRunner|cr_|WebView|moleculeforge|System\.err|ANR|not responding|WindowFocus|keyguard",
    re.IGNORECASE,
)
# Package-manager and system-service chatter about installing and removing the test packages.
NOISE = re.compile(
    r"WifiService|WifiConfigManager|PasspointManager|ShortcutService|MediaProvider|MediaGrants|Blockstore|AppWidgetService|"
    r"CarrierSvcBindHelper|AppsFilter|ProximityAuth|ProcessStats|ApkAssets|Telecom|Icing|LauncherApps|SQLiteLog|"
    r"ConditionProviders|PersistedStorage|RollbackManager|StorageManagerService|ziparchive|nativeloader|TestRunner:\s+at |TestRunner:\s+\.\.\."
)
MAX_ANNOTATIONS = 9
CHUNK = 6000


def escape(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def annotate(title: str, message: str) -> None:
    print(f"::error title={escape(title)[:200]}::{escape(message)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--logcat", type=Path, required=True)
    opts = parser.parse_args()
    used = 0
    for xml_file in sorted(opts.results.rglob("*.xml")):
        try:
            root = ET.parse(xml_file).getroot()
        except ET.ParseError:
            continue
        for case in root.iter("testcase"):
            for failure in list(case.iter("failure")) + list(case.iter("error")):
                text = (failure.get("message") or "") + "\n" + (failure.text or "")
                annotate(f"Instrumented test failed: {case.get('name')}", text.strip()[:CHUNK])
                used += 1
    if used == 0:
        annotate("No instrumented test results", f"nothing under {opts.results}: the test did not run to completion")
        used += 1
    if opts.logcat.exists():
        lines = [line for line in opts.logcat.read_text(encoding="utf-8", errors="replace").splitlines()
                 if RELEVANT.search(line) and not NOISE.search(line)]
        # The start of the run (launch, page load) and its end (failure, focus) explain most failures.
        picked = lines if len(lines) <= 240 else [*lines[:120], "[...]", *lines[-120:]]
        chunks, current = [], ""
        for line in picked:
            if len(current) + len(line) + 1 > CHUNK:
                chunks.append(current)
                current = ""
            current += line + "\n"
        if current:
            chunks.append(current)
        keep = MAX_ANNOTATIONS - used
        if len(chunks) > keep:
            chunks = [*chunks[: keep // 2], *chunks[-(keep - keep // 2):]]
        for index, chunk in enumerate(chunks):
            annotate(f"Device log ({index + 1})", chunk)
    else:
        annotate("No device log", f"{opts.logcat} was not written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
