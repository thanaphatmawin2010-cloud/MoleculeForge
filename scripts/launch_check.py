"""Launch check for an installed MoleculeForge build (§9.5 offline rule, §10 cold start).

Starts the desktop binary with a fresh data directory, waits until the UI is interactive (the shell
prints the time when MF_STARTUP_PROBE is set), then inspects every socket owned by the whole process
tree: the shell, its web view processes, the compute sidecar and the engines it started. Anything
other than a Unix socket or a loopback address fails the check. Optionally saves a screenshot of the
display (requires ImageMagick's ``import``).

Run it on a desktop session or under Xvfb, for example:

    xvfb-run -a -s "-screen 0 1440x900x24" python scripts/launch_check.py --binary /usr/bin/molecule-forge
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import psutil

LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
PROBE = re.compile(r"interactive after (\d+) ms")


def tree(root: psutil.Process) -> list[psutil.Process]:
    try:
        return [root, *root.children(recursive=True)]
    except psutil.NoSuchProcess:
        return []


def foreign_sockets(procs: list[psutil.Process]) -> list[str]:
    found: list[str] = []
    for proc in procs:
        try:
            for conn in proc.net_connections(kind="inet"):
                for address in (conn.laddr, conn.raddr):
                    if address and address.ip not in LOOPBACK:
                        found.append(f"{proc.name()} (pid {proc.pid}): {conn.laddr} -> {conn.raddr} [{conn.status}]")
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--binary", default="/usr/bin/molecule-forge")
    parser.add_argument("--timeout", type=float, default=90.0, help="seconds to wait for the UI")
    parser.add_argument("--settle", type=float, default=20.0, help="seconds to watch sockets after start")
    parser.add_argument("--screenshot", type=Path, help="save a PNG of the display once interactive")
    parser.add_argument("--json", type=Path, help="write the measurements as JSON")
    args = parser.parse_args()

    data_dir = Path(tempfile.mkdtemp(prefix="moleculeforge-launch-"))
    env = {**os.environ, "MF_STARTUP_PROBE": "1", "MF_DATA_DIR": str(data_dir)}
    started = time.monotonic()
    app = subprocess.Popen([args.binary], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    interactive_ms: list[int] = []
    log: list[str] = []

    def read_stderr() -> None:
        assert app.stderr is not None
        for line in app.stderr:
            log.append(line.rstrip())
            match = PROBE.search(line)
            if match and not interactive_ms:
                interactive_ms.append(int(match.group(1)))

    threading.Thread(target=read_stderr, daemon=True).start()
    root = psutil.Process(app.pid)
    seen: dict[int, str] = {}
    problems: list[str] = []
    try:
        deadline = started + args.timeout
        while not interactive_ms and time.monotonic() < deadline and app.poll() is None:
            problems += foreign_sockets(tree(root))
            time.sleep(0.2)
        if not interactive_ms:
            print("FAIL: the app did not become interactive", file=sys.stderr)
            print("\n".join(log[-40:]), file=sys.stderr)
            return 1
        print(f"interactive after {interactive_ms[0]} ms (shell measurement)")
        if args.screenshot and shutil.which("import"):
            time.sleep(2.0)
            subprocess.run(["import", "-window", "root", str(args.screenshot)], check=False)
            print(f"screenshot: {args.screenshot}")
        settle_end = time.monotonic() + args.settle
        while time.monotonic() < settle_end and app.poll() is None:
            procs = tree(root)
            for proc in procs:
                try:
                    seen.setdefault(proc.pid, proc.name())
                except psutil.NoSuchProcess:
                    continue
            problems += foreign_sockets(procs)
            time.sleep(0.5)
        if app.poll() is not None:
            print(f"FAIL: the app exited early with code {app.returncode}", file=sys.stderr)
            print("\n".join(log[-40:]), file=sys.stderr)
            return 1
    finally:
        for proc in reversed(tree(root)):
            try:
                proc.terminate()
            except psutil.NoSuchProcess:
                continue
        try:
            app.wait(timeout=10)
        except subprocess.TimeoutExpired:
            app.kill()
        shutil.rmtree(data_dir, ignore_errors=True)

    print(f"processes observed: {sorted(set(seen.values()))}")
    unique = sorted(set(problems))
    if args.json:
        args.json.write_text(json.dumps({
            "interactiveMs": interactive_ms[0],
            "processes": sorted(set(seen.values())),
            "nonLoopbackSockets": unique,
        }, indent=2) + "\n", encoding="utf-8")
    if unique:
        print("FAIL: non-loopback sockets:\n  " + "\n  ".join(unique), file=sys.stderr)
        return 1
    print("offline check: only loopback and Unix sockets in the whole process tree")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
