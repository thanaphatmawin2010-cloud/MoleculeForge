#!/usr/bin/env python3
"""Assemble the installer payload in app-shell/src-tauri/resources/ (Tauri bundles it verbatim).

    resources/
      compute/        frozen sidecar (PyInstaller one-folder build: compute/dist/compute)
      engines/<plat>/ xtb, MOPAC, Vina, llama-server (scripts/fetch_engines.py)
      data/           elements.json, molecules/library.json, knowledge/, fonts/, models/<gguf>
      LICENSES/       third-party licence texts (scripts/collect_licenses.py)

Files are hard-linked where possible so staging a 3 GB payload is instant. Run after building
the sidecar and fetching engines; pass --without-model for quick local test bundles.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "app-shell" / "src-tauri" / "resources"
LOCK = json.loads((ROOT / "scripts" / "engines.lock.json").read_text(encoding="utf-8"))
sys.path.insert(0, str(ROOT / "scripts"))
from fetch_engines import model_spec, platform_key  # noqa: E402


def link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_symlink():
        os.symlink(os.readlink(src), dst)
        return
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def stage_tree(src: Path, dst: Path) -> int:
    if not src.is_dir():
        raise SystemExit(f"missing {src.relative_to(ROOT)}: build or fetch it first")
    count = 0
    for path in sorted(src.rglob("*")):
        if path.is_dir() and not path.is_symlink():
            continue
        if "__pycache__" in path.parts:
            continue
        link_or_copy(path, dst / path.relative_to(src))
        count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--platform", default=None)
    parser.add_argument("--without-model", action="store_true", help="omit the language model (test bundles only)")
    opts = parser.parse_args()
    plat = opts.platform or platform_key()
    for child in DEST.glob("*"):
        if child.name != "README.txt":
            shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
    counts = {
        "compute": stage_tree(ROOT / "compute" / "dist" / "compute", DEST / "compute"),
        "engines": stage_tree(ROOT / "engines" / plat, DEST / "engines" / plat),
        "knowledge": stage_tree(ROOT / "data" / "knowledge", DEST / "data" / "knowledge"),
        "fonts": stage_tree(ROOT / "data" / "fonts", DEST / "data" / "fonts"),
        "licenses": stage_tree(ROOT / "LICENSES", DEST / "LICENSES"),
    }
    for name in ("elements.json", "molecules/library.json"):
        link_or_copy(ROOT / "data" / name, DEST / "data" / name)
    if not opts.without_model:
        spec = model_spec(plat)
        model = ROOT / "data" / "models" / str(spec["file"])
        if not model.exists() or model.stat().st_size != spec["size"]:
            raise SystemExit("language model missing or incomplete: run scripts/fetch_engines.py --only model")
        link_or_copy(model, DEST / "data" / "models" / model.name)
    total = sum(p.stat().st_size for p in DEST.rglob("*") if p.is_file() and not p.is_symlink())
    manifest = {"platform": plat, "files": counts, "model": not opts.without_model, "bytes": total}
    (DEST / "STAGED.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
