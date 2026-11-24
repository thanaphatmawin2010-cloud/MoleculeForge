#!/usr/bin/env python3
"""Build the Linux AppImage with the full offline payload.

Tauri's AppImage bundler runs linuxdeploy over every ELF file in the AppDir. The payload (frozen
sidecar, conda-built engines, llama.cpp) is self-contained, but some of its libraries have
dependencies that only resolve at runtime: OpenMM's plugins find the core library that is already
loaded, and the CUDA, OpenCL and Vulkan back-ends need drivers that exist only on machines with
that hardware. linuxdeploy treats each of these as fatal, so the AppImage is built in three steps:

1. Tauri builds the AppImage while the staged payload is moved aside (linuxdeploy deploys GTK and
   WebKit as usual);
2. the payload staged by scripts/stage_resources.py is added to the AppDir;
3. appimagetool, from the linuxdeploy-plugin-appimage that Tauri downloaded, packs the AppDir again.

Run from the repository root after scripts/stage_resources.py:

    compute/.venv/bin/python scripts/build_appimage.py
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAURI = ROOT / "app-shell" / "src-tauri"
RESOURCES = TAURI / "resources"
BUNDLE = TAURI / "target" / "release" / "bundle" / "appimage"


def product() -> tuple[str, str]:
    conf = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    return conf["productName"], conf["version"]


def add_payload(target: Path) -> int:
    """Hard-link (or copy) the staged resources into the AppDir; returns the number of files."""
    count = 0
    for source in sorted(RESOURCES.rglob("*")):
        relative = source.relative_to(RESOURCES)
        dest = target / relative
        if source.is_symlink():
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.is_symlink() or dest.exists():
                dest.unlink()
            dest.symlink_to(os.readlink(source))
        elif source.is_dir():
            dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                dest.unlink()
            try:
                os.link(source, dest)
            except OSError:
                shutil.copy2(source, dest)
            count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--skip-tauri", action="store_true", help="reuse an AppDir from an earlier lean build")
    opts = parser.parse_args()
    name, version = product()
    env = {**os.environ, "APPIMAGE_EXTRACT_AND_RUN": "1"}  # no FUSE needed (containers, CI)
    if not (RESOURCES / "STAGED.json").exists():
        raise SystemExit("no staged payload: run scripts/stage_resources.py first")
    if not opts.skip_tauri:
        # Tauri assembles the AppDir from an intermediate deb tree that it does not clear between
        # builds; a payload left there by an earlier build would be scanned again.
        shutil.rmtree(BUNDLE, ignore_errors=True)
        shutil.rmtree(BUNDLE.with_name("appimage_deb"), ignore_errors=True)
        aside = RESOURCES.with_name("resources.payload")
        if aside.exists():
            raise SystemExit(f"{aside} exists: a previous run was interrupted; move it back to {RESOURCES.name}/")
        RESOURCES.rename(aside)
        try:
            RESOURCES.mkdir()
            shutil.copy2(aside / "README.txt", RESOURCES / "README.txt")  # Tauri needs one file to bundle
            subprocess.run(["pnpm", "tauri", "build", "--bundles", "appimage"], cwd=ROOT, env=env, check=True)
        finally:
            shutil.rmtree(RESOURCES)
            aside.rename(RESOURCES)
    appdir = BUNDLE / f"{name}.AppDir"
    if not (appdir / "AppRun").exists():
        raise SystemExit(f"{appdir} is missing; the lean Tauri AppImage build did not run")
    files = add_payload(appdir / "usr" / "lib" / name)
    print(f"added {files} payload files to {appdir.relative_to(ROOT)}")

    tool = Path.home() / ".cache" / "tauri" / "linuxdeploy-plugin-appimage.AppImage"
    if not tool.exists():
        raise SystemExit(f"{tool} not found (Tauri downloads it during the lean build)")
    output = BUNDLE / f"{name}_{version}_amd64.AppImage"
    output.unlink(missing_ok=True)
    subprocess.run([str(tool), "--appdir", str(appdir)], cwd=BUNDLE, check=True,
                   env={**env, "ARCH": "x86_64", "OUTPUT": output.name})
    if not output.exists():
        raise SystemExit("appimagetool produced no AppImage")
    print(f"{output.relative_to(ROOT)}: {output.stat().st_size / 2**30:.2f} GiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
