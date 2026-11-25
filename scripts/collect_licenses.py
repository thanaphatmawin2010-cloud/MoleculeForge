#!/usr/bin/env python3
"""Collect the licence texts of everything MoleculeForge ships into LICENSES/.

Sources (build time only; the application never fetches anything at runtime):

* Python runtime dependencies of the compute sidecar (from the virtualenv's dist-info), plus
  the CPython interpreter and the PyInstaller bootloader that the frozen sidecar contains;
* npm production dependencies of the UI (from node_modules);
* Rust crates linked into the desktop shell (from ``cargo metadata`` and the registry sources);
* bundled engines, fonts and the language model (texts fetched from their pinned release tags);
* the Android app's runtime libraries (android/app/gradle.lockfile; licences from their Maven POMs).

Output: ``LICENSES/<group>/<name>-<version>/<files>`` and ``LICENSES/THIRD_PARTY_NOTICES.md``, an
index with name, version, SPDX licence and where the text came from, plus
``LICENSES/lite/THIRD_PARTY_LICENSES.txt``: every licence text of what MoleculeForge Lite (the web
trial and the Android app) ships, in one file the app shows. Run from the repository root:

    compute/.venv/bin/python scripts/collect_licenses.py
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Any

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
]
# The OpenMM wheel ships no licence file; these are the texts in its source tree at the pinned tag.
PYTHON_EXTRA = {
    "openmm": ["https://raw.githubusercontent.com/openmm/openmm/8.6.1/docs-source/licenses/Licenses.txt",
               "https://raw.githubusercontent.com/openmm/openmm/8.6.1/docs-source/licenses/LGPL.txt"],
}
# RDKit's WebAssembly build (MoleculeForge Lite) ships no licence file in its npm package; it is
# built from the RDKit release of the same version, whose licence carries the copyright notice.
NPM_EXTRA = {
    "@rdkit/rdkit": ["https://raw.githubusercontent.com/rdkit/rdkit/Release_{major}_{minor:02d}_{patch}/license.txt"],
}
# Canonical texts for SPDX ids used by components that do not ship their own licence file.
SPDX_TEXT = "https://raw.githubusercontent.com/spdx/license-list-data/v3.26.0/text/{id}.txt"
# conda-forge's libgcc package also carries libquadmath, which upstream GCC licenses under the LGPL
# (shipped as a replaceable shared library).
CONDA_EXTRA_LICENCE = {"libgcc": " AND LGPL-2.1-or-later (libquadmath)"}


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
    # The interpreter and the PyInstaller bootloader are part of the frozen sidecar. The licence file
    # sits in lib/pythonX.Y/ on Linux and macOS and at the top of the installation on Windows.
    base = Path(sys.base_prefix)
    version_dir = f"python{sys.version_info.major}.{sys.version_info.minor}"
    py = Entry("python", "CPython", sys.version.split()[0], "PSF-2.0", source="python.org")
    copy_texts(py, [next((c for c in (base / "lib" / version_dir / "LICENSE.txt", base / "LICENSE.txt",
                                      base / "Lib" / "LICENSE.txt") if c.is_file()), base / "LICENSE.txt")])
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
    # shutil.which finds pnpm.cmd on Windows, which CreateProcess will not resolve from a bare name.
    pnpm = shutil.which("pnpm") or "pnpm"
    out = subprocess.run([pnpm, "--dir", str(ROOT / "ui"), "list", "--prod", "--json", "--depth", "Infinity"],
                         capture_output=True, text=True, encoding="utf-8", check=True).stdout
    tree = json.loads(out)
    found: dict[tuple[str, str], Path] = {}

    def walk(deps: dict[str, Any]) -> None:
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
        if not entry.files and name in NPM_EXTRA:
            major, minor, patch = (int(x) for x in version.split(".")[:3])
            for url in NPM_EXTRA[name]:
                dest = OUT / "npm" / f"{safe(name)}-{safe(version)}" / url.rsplit("/", 1)[1]
                fetch(url.format(major=major, minor=minor, patch=patch), dest)
                entry.files.append(str(dest.relative_to(OUT)))
        entries.append(entry)
    return entries


MAVEN_REPOS = ["https://dl.google.com/dl/android/maven2", "https://repo.maven.apache.org/maven2"]
SPDX_BY_NAME = [
    (re.compile(r"apache.*2\.0|apache-2\.0", re.I), "Apache-2.0"),
    (re.compile(r"^mit\b|mit license", re.I), "MIT"),
    (re.compile(r"bsd.*3|3-clause", re.I), "BSD-3-Clause"),
]


def maven_pom(group: str, artifact: str, version: str) -> str:
    path = f"{group.replace('.', '/')}/{artifact}/{version}/{artifact}-{version}.pom"
    for repo in MAVEN_REPOS:
        for attempt in range(4):
            try:
                with urllib.request.urlopen(f"{repo}/{path}", timeout=60) as response:
                    return str(response.read().decode("utf-8", errors="replace"))
            except urllib.error.HTTPError as err:
                if err.code == 404:
                    break
                time.sleep(2 * (attempt + 1))  # 429/5xx: back off and retry
            except OSError:
                time.sleep(2 * (attempt + 1))
    raise OSError(f"no POM for {group}:{artifact}:{version}")


def maven_licences(group: str, artifact: str, version: str, depth: int = 0) -> list[str]:
    """Licence names from the POM, or from its parent POMs when the artifact inherits them."""
    pom = maven_pom(group, artifact, version)
    names = re.findall(r"<license>\s*<name>\s*([^<]+?)\s*</name>", pom, re.S)
    if names or depth >= 3:
        return names
    parent = re.search(r"<parent>(.*?)</parent>", pom, re.S)
    if not parent:
        return names
    block = parent.group(1)

    def field_of(tag: str) -> str:
        found = re.search(rf"<{tag}>\s*([^<]+?)\s*</{tag}>", block)
        return found.group(1) if found else ""

    return maven_licences(field_of("groupId"), field_of("artifactId"), field_of("version"), depth + 1)


def android_entries() -> list[Entry]:
    """Libraries inside the Android APK: the release runtime classpath pinned in gradle.lockfile."""
    lockfile = ROOT / "android" / "app" / "gradle.lockfile"
    entries = []
    for line in lockfile.read_text(encoding="utf-8").splitlines():
        coordinate, _, configurations = line.partition("=")
        if "releaseRuntimeClasspath" not in configurations.split(","):
            continue
        group, artifact, version = coordinate.split(":")
        names = maven_licences(group, artifact, version)
        spdx = []
        for name in names:
            spdx.append(next((sid for pattern, sid in SPDX_BY_NAME if pattern.search(name)), name))
        entries.append(Entry("android", f"{group}:{artifact}", version, " AND ".join(dict.fromkeys(spdx)) or "see source",
                             source=f"Maven {coordinate}"))
    return entries


def lite_licences(npm: list[Entry], android: list[Entry]) -> str:
    """One plain-text file with the full licence text of every component MoleculeForge Lite ships."""
    out = ["MoleculeForge Lite: third-party licences", "=" * 40, "",
           "MoleculeForge Lite (the web trial and the Android app) includes the open-source components",
           "below. The web build contains the user-interface packages (npm), among them RDKit's",
           "WebAssembly build (@rdkit/rdkit) and OpenChemLib (openchemlib); the Android app contains the",
           "same build plus the Android libraries listed last. Each component's licence text follows.", ""]
    shared: dict[str, list[str]] = {}
    for title, entries in (("User interface and chemistry engine (npm)", npm), ("Android app (Maven)", android)):
        out += [title, "-" * len(title), ""]
        for e in entries:
            out.append(f"{e.name} {e.version} ({e.license})")
            for rel in e.files:
                if rel.startswith("common/"):
                    shared.setdefault(rel, []).append(f"{e.name} {e.version}")
        out.append("")
    for title, entries in (("Licence texts: npm packages", npm), ("Licence texts: Android libraries", android)):
        own = [e for e in entries if any(not f.startswith("common/") for f in e.files)]
        if not own:
            continue
        out += ["", title, "=" * len(title)]
        for e in own:
            for rel in e.files:
                if rel.startswith("common/"):
                    continue
                out += ["", f"----- {e.name} {e.version}: {Path(rel).name} -----", "",
                        (OUT / rel).read_text(encoding="utf-8", errors="replace").strip()]
    for rel, users in sorted(shared.items()):
        out += ["", f"===== {Path(rel).stem} (canonical text) =====", "", "Applies to: " + ", ".join(users), "",
                (OUT / rel).read_text(encoding="utf-8", errors="replace").strip()]
    return "\n".join(out) + "\n"


def cargo_entries() -> list[Entry]:
    manifest = ROOT / "app-shell" / "src-tauri" / "Cargo.toml"
    meta = json.loads(subprocess.run(["cargo", "metadata", "--format-version", "1", "--manifest-path", str(manifest)],
                                     capture_output=True, text=True, encoding="utf-8", check=True).stdout)
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


def model_entry() -> tuple[str, str, str, str, list[str]]:
    """The language model bundled for this platform (engines.lock.json, modelByPlatform)."""
    sys.path.insert(0, str(ROOT / "scripts"))
    from fetch_engines import model_spec, platform_key

    spec = model_spec(platform_key())
    return ("models", str(spec["name"]), f"{spec['quantization']} {str(spec['revision'])[:12]}", str(spec["license"]),
            [str(spec["licenseUrl"])])


def fetched_entries() -> list[Entry]:
    entries = []
    for group, name, version, lic, urls in [*FETCHED, model_entry()]:
        entry = Entry(group, name, version, lic, source=", ".join(urls))
        target = OUT / group / f"{safe(name)}-{safe(version)}"
        target.mkdir(parents=True, exist_ok=True)
        for url in urls:
            dest = target / url.rsplit("/", 1)[-1]
            fetch(url, dest)
            entry.files.append(str(dest.relative_to(OUT)))
        entries.append(entry)
    # Every conda package inside the conda-built engines, runtime libraries included, with the
    # licence files from its package metadata (fetch_engines.bundle_conda_licences puts them there).
    # Packages that ship no file get the canonical SPDX texts in main().
    for prefix in sorted(p for p in (ROOT / "engines").glob("*/*") if (p / "conda-meta").is_dir()):
        for record_path in sorted((prefix / "conda-meta").glob("*.json")):
            record = json.loads(record_path.read_text(encoding="utf-8"))
            if record["name"] == prefix.name:
                continue  # the engine itself is listed above, with the texts from its release tag
            lic = record.get("license") or "see text"
            lic += CONDA_EXTRA_LICENCE.get(record["name"], "")
            entry = Entry("engines", f"{prefix.name}/{record['name']}", record["version"], lic,
                          source=f"conda-forge {record['name']} {record['version']} {record.get('build', '')}".strip())
            texts = prefix / "share" / "licenses" / "conda" / record["name"]
            target = OUT / "engines" / safe(prefix.name) / f"{safe(record['name'])}-{safe(record['version'])}"
            for path in sorted(p for p in texts.rglob("*") if p.is_file()):
                dest = target / path.relative_to(texts)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, dest)
                entry.files.append(str(dest.relative_to(OUT)))
            entries.append(entry)
    # Windows: the Visual C++ runtime deployed next to llama-server (fetch_engines.copy_vc_runtime).
    # It is the same Microsoft redistributable that conda-forge ships as vc14_runtime, whose licence
    # text the conda-built engines already carry.
    for llama in sorted((ROOT / "engines").glob("windows-*/llama")):
        dlls = sorted(p.name for p in llama.glob("*.dll") if p.name.lower().startswith(("vcruntime", "msvcp", "vcomp", "concrt", "vccorlib")))
        if not dlls:
            continue
        entry = Entry("engines", "llama/Microsoft-Visual-C++-runtime", "14.x", "LicenseRef-MicrosoftVisualCpp2015-2022Runtime",
                      source="Visual Studio redistributable files, app-local next to llama-server: " + ", ".join(dlls))
        texts = sorted(p for p in (ROOT / "engines").glob(f"{llama.parent.name}/*/share/licenses/conda/vc14_runtime/**/*") if p.is_file())
        target = OUT / "engines" / "llama" / "Microsoft-Visual-C++-runtime"
        for path in texts[:5]:
            dest = target / path.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, dest)
            entry.files.append(str(dest.relative_to(OUT)))
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
    npm = npm_entries()
    android = android_entries()
    groups = [("Compute sidecar (Python)", python_entries()), ("User interface (npm)", npm),
              ("Desktop shell (Rust)", cargo_entries()), ("Engines, model and fonts", fetched_entries()),
              ("Android app (Maven)", android)]
    lines = ["# Third-party notices", "",
             "MoleculeForge bundles the components below. Each directory holds the licence text(s) as",
             "published by the project at the shipped version; where a package ships none, the canonical",
             "SPDX text is in `common/`. GPL-licensed code is not linked into any MoleculeForge binary:",
             "the GCC runtime libraries used by the engines carry the GCC Runtime Library Exception and",
             "the PyInstaller bootloader its own exception. LGPL components (xtb with dftd4, s-dftd3 and",
             "tblite; Meeko; libquadmath; OpenMM's GPU platforms) run as separate processes or ship as",
             "replaceable files: Meeko as plain Python source in the sidecar's `_internal/meeko/`.", ""]
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
    (OUT / "lite").mkdir(exist_ok=True)
    (OUT / "lite" / "THIRD_PARTY_LICENSES.txt").write_text(lite_licences(npm, android), encoding="utf-8")
    total = sum(len(e) for _, e in groups)
    print(f"{total} components, {total - missing} with licence text files, {missing} without (listed by SPDX id)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
