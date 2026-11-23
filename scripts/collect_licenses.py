#!/usr/bin/env python3
"""Collect the licence texts of everything MoleculeForge ships into LICENSES/.

Sources (build time only; the application never fetches anything at runtime):

* Python runtime dependencies of the compute sidecar (from the virtualenv's dist-info), plus
  the CPython interpreter and the PyInstaller bootloader that the frozen sidecar contains;
* npm production dependencies of the UI (from node_modules);
* Rust crates linked into the desktop shell (from ``cargo metadata`` and the registry sources);
* bundled engines, fonts and the language model (texts fetched from their pinned release tags).

Output: ``LICENSES/<group>/<name>-<version>/<files>`` and ``LICENSES/THIRD_PARTY_NOTICES.md``, an
index with name, version, SPDX licence and where the text came from. Run from the repository root:

    compute/.venv/bin/python scripts/collect_licenses.py
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "LICENSES"
LICENSE_NAME = re.compile(r"^(licen[cs]e|copying|notice|copyright|authors|unlicense)([._-].*)?$", re.I)

# Engines, fonts and the model: licence texts at the exact pinned versions (see engines.lock.json).
FETCHED = [
    ("engines", "xtb", "6.8.0", "LGPL-3.0-or-later", [
        "https://raw.githubusercontent.com/grimme-lab/xtb/v6.8.0/COPYING",
        "https://raw.githubusercontent.com/grimme-lab/xtb/v6.8.0/COPYING.LESSER"]),
    ("engines", "mopac", "23.2.5", "Apache-2.0", [
        "https://raw.githubusercontent.com/openmopac/mopac/v23.2.5/LICENSE"]),
    ("engines", "autodock-vina", "1.2.7", "Apache-2.0", [
        "https://raw.githubusercontent.com/ccsb-scripps/AutoDock-Vina/v1.2.7/LICENSE"]),
    ("engines", "llama.cpp", "b12650", "MIT", [
        "https://raw.githubusercontent.com/ggml-org/llama.cpp/b12650/LICENSE"]),
    ("models", "Qwen3-4B-Instruct-2507", "2507", "Apache-2.0", [
        "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/raw/main/LICENSE"]),
]
# The OpenMM wheel ships no licence file; these are the texts in its source tree at the pinned tag.
PYTHON_EXTRA = {
    "openmm": ["https://raw.githubusercontent.com/openmm/openmm/8.6.1/docs-source/licenses/Licenses.txt",
               "https://raw.githubusercontent.com/openmm/openmm/8.6.1/docs-source/licenses/LGPL.txt"],
}
# Canonical texts for SPDX ids used by components that do not ship their own licence file.
SPDX_TEXT = "https://raw.githubusercontent.com/spdx/license-list-data/v3.26.0/text/{id}.txt"


def fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            dest.write_bytes(response.read())


@dataclass
class Entry:
    group: str
    name: str
    version: str
    license: str
    files: list[str] = field(default_factory=list)
    source: str = ""


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._+-]+", "_", name)


def copy_texts(entry: Entry, paths: list[Path]) -> None:
    target = OUT / entry.group / f"{safe(entry.name)}-{safe(entry.version)}"
    for path in paths:
        if path.is_file() and path.stat().st_size < 2_000_000:
            target.mkdir(parents=True, exist_ok=True)
            dest = target / path.name
            if not dest.exists():
                shutil.copyfile(path, dest)
            entry.files.append(str(dest.relative_to(OUT)))


def python_entries() -> list[Entry]:
    """Runtime requirements of moleculeforge-compute, resolved recursively."""
    seen: dict[str, metadata.Distribution] = {}
    queue = ["moleculeforge-compute"]
    while queue:
        name = queue.pop()
        key = re.sub(r"[-_.]+", "-", name).lower()
        if key in seen:
            continue
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        seen[key] = dist
        for requirement in dist.requires or []:
            if "extra ==" in requirement:
                continue
            queue.append(re.split(r"[ ;<>=!~\[(]", requirement, maxsplit=1)[0])
    seen.pop("moleculeforge-compute", None)
    entries = []
    for dist in sorted(seen.values(), key=lambda d: d.metadata["Name"].lower()):
        lic = dist.metadata.get("License-Expression") or dist.metadata.get("License") or ""
        if not lic or len(lic) > 80:
            classifiers = [c.split("::")[-1].strip() for c in dist.metadata.get_all("Classifier") or [] if c.startswith("License ::")]
            lic = " / ".join(classifiers) or (lic[:80] + "…" if lic else "see text")
        entry = Entry("python", dist.metadata["Name"], dist.version, lic, source=f"{dist.metadata['Name']} {dist.version} (PyPI)")
        files = [Path(str(dist.locate_file(f))) for f in dist.files or [] if LICENSE_NAME.match(Path(str(f)).name)]
        copy_texts(entry, files)
        for url in PYTHON_EXTRA.get(dist.metadata["Name"].lower(), []):
            dest = OUT / "python" / f"{safe(entry.name)}-{safe(entry.version)}" / url.rsplit("/", 1)[-1]
            fetch(url, dest)
            entry.files.append(str(dest.relative_to(OUT)))
            entry.license = "MIT AND LGPL-2.1 (CUDA/OpenCL platforms)" if dist.metadata["Name"].lower() == "openmm" else entry.license
        entries.append(entry)
    # The interpreter and the PyInstaller bootloader are part of the frozen sidecar.
    python_license = Path(sys.base_prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "LICENSE.txt"
    py = Entry("python", "CPython", sys.version.split()[0], "PSF-2.0", source="python.org")
    copy_texts(py, [python_license])
    entries.append(py)
    try:
        pyi = metadata.distribution("pyinstaller")
        entry = Entry("python", "PyInstaller-bootloader", pyi.version, "GPL-2.0-or-later WITH Bootloader-exception",
                      source="PyInstaller (only the bootloader is shipped; its exception permits this)")
        copy_texts(entry, [Path(str(pyi.locate_file(f))) for f in pyi.files or [] if LICENSE_NAME.match(Path(str(f)).name)])
        entries.append(entry)
    except metadata.PackageNotFoundError:
        pass
    return entries


def npm_entries() -> list[Entry]:
    out = subprocess.run(["pnpm", "--dir", str(ROOT / "ui"), "list", "--prod", "--json", "--depth", "Infinity"],
                         capture_output=True, text=True, check=True).stdout
    tree = json.loads(out)
    found: dict[tuple[str, str], Path] = {}

    def walk(deps: dict) -> None:
        for name, info in (deps or {}).items():
            key = (name, info.get("version", ""))
            if key not in found and info.get("path"):
                found[key] = Path(info["path"])
                walk(info.get("dependencies", {}))

    for project in tree:
        walk(project.get("dependencies", {}))
    entries = []
    for (name, version), path in sorted(found.items()):
        pkg = json.loads((path / "package.json").read_text(encoding="utf-8")) if (path / "package.json").exists() else {}
        lic = pkg.get("license") if isinstance(pkg.get("license"), str) else (pkg.get("license") or {}).get("type", "see text")
        entry = Entry("npm", name, version, lic or "see text", source=f"npm {name}@{version}")
        copy_texts(entry, [p for p in path.iterdir() if LICENSE_NAME.match(p.name)])
        entries.append(entry)
    return entries


def cargo_entries() -> list[Entry]:
    manifest = ROOT / "app-shell" / "src-tauri" / "Cargo.toml"
    meta = json.loads(subprocess.run(["cargo", "metadata", "--format-version", "1", "--manifest-path", str(manifest)],
                                     capture_output=True, text=True, check=True).stdout)
    entries = []
    for package in sorted(meta["packages"], key=lambda p: (p["name"], p["version"])):
        if package["source"] is None:  # the shell itself
            continue
        entry = Entry("rust", package["name"], package["version"], package.get("license") or "see text",
                      source=f"crates.io {package['name']} {package['version']}")
        crate_dir = Path(package["manifest_path"]).parent
        copy_texts(entry, [p for p in crate_dir.iterdir() if LICENSE_NAME.match(p.name)])
        entries.append(entry)
    return entries


def fetched_entries() -> list[Entry]:
    entries = []
    for group, name, version, lic, urls in FETCHED:
        entry = Entry(group, name, version, lic, source=", ".join(urls))
        target = OUT / group / f"{safe(name)}-{safe(version)}"
        target.mkdir(parents=True, exist_ok=True)
        for url in urls:
            dest = target / url.rsplit("/", 1)[-1]
            fetch(url, dest)
            entry.files.append(str(dest.relative_to(OUT)))
        entries.append(entry)
    # Dependency licences that ship inside the conda-built engines.
    for engine in ("xtb", "mopac"):
        base = ROOT / "engines" / "linux-x64" / engine / "share" / "licenses"
        for sub in sorted(p for p in base.glob("*") if p.is_dir()):
            entry = Entry("engines", f"{engine}-dependency-{sub.name}", "bundled", "see text", source=f"conda-forge ({engine})")
            copy_texts(entry, sorted(sub.iterdir()))
            entries.append(entry)
    fonts = ROOT / "data" / "fonts" / "OFL.txt"
    font = Entry("fonts", "IBM-Plex-Sans-Thai", "1.1.0", "OFL-1.1", source="@ibm/plex-sans-thai 1.1.0 (PDF reports)")
    copy_texts(font, [fonts])
    entries.append(font)
    return entries


def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    groups = [("Compute sidecar (Python)", python_entries()), ("User interface (npm)", npm_entries()),
              ("Desktop shell (Rust)", cargo_entries()), ("Engines, model and fonts", fetched_entries())]
    lines = ["# Third-party notices", "",
             "MoleculeForge bundles the components below. Each directory holds the licence text(s) as",
             "published by the project at the shipped version. GPL-licensed code is not linked into any",
             "MoleculeForge binary; LGPL components (xtb, Meeko) run as separate processes or ship as",
             "replaceable files.", ""]
    # Components without their own file: attach the canonical SPDX text of every licence they name.
    for _, entries in groups:
        for e in entries:
            if e.files:
                continue
            for spdx in sorted(set(re.findall(r"[A-Za-z0-9.-]+", e.license.replace("/", " OR ")))):
                if spdx.upper() in ("OR", "AND", "WITH"):
                    continue
                dest = OUT / "common" / f"{spdx}.txt"
                try:
                    fetch(SPDX_TEXT.format(id=spdx), dest)
                    e.files.append(str(dest.relative_to(OUT)))
                except OSError:
                    pass
    missing = 0
    for title, entries in groups:
        lines += [f"## {title}", "", "| Component | Version | Licence | Text |", "|---|---|---|---|"]
        for e in entries:
            text = "<br>".join(e.files) if e.files else "not shipped by the project; see its source"
            missing += 0 if e.files else 1
            lines.append(f"| {e.name} | {e.version} | {e.license.replace('|', '/')} | {text} |")
        lines.append("")
    (OUT / "THIRD_PARTY_NOTICES.md").write_text("\n".join(lines), encoding="utf-8")
    total = sum(len(e) for _, e in groups)
    print(f"{total} components, {total - missing} with licence text files, {missing} without (listed by SPDX id)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
