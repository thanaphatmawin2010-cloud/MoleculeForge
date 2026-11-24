#!/usr/bin/env python3
"""Fetch, build and verify the third-party engines that MoleculeForge bundles.

Everything pinned in ``scripts/engines.lock.json`` is materialised under
``engines/<platform>/`` (and the language model under ``data/models/``) so the
packaged application never touches the network at runtime.

Usage::

    python3 scripts/fetch_engines.py                # all components
    python3 scripts/fetch_engines.py --only model   # one component
    python3 scripts/fetch_engines.py --only xtb mopac vina llama
    python3 scripts/fetch_engines.py --only fonts   # report fonts (WOFF -> TTF)

Only the Python standard library is used so this runs before any virtualenv
exists (CI bootstrap, fresh clones).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "scripts" / "engines.lock.json").read_text(encoding="utf-8"))


def platform_key() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    if system == "linux":
        return f"linux-{arch}"
    if system == "darwin":
        return f"macos-{arch}"
    if system == "windows":
        return f"windows-{arch}"
    raise SystemExit(f"unsupported platform: {system}/{machine}")


CONDA_SUBDIR = {
    "linux-x64": "linux-64",
    "linux-arm64": "linux-aarch64",
    "macos-x64": "osx-64",
    "macos-arm64": "osx-arm64",
    "windows-x64": "win-64",
}


def log(msg: str) -> None:
    print(f"[fetch-engines] {msg}", flush=True)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, dest: Path, expected_size: int | None = None, attempts: int = 5) -> None:
    """Resumable download with retries and exponential backoff."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, attempts + 1):
        try:
            have = part.stat().st_size if part.exists() else 0
            request = urllib.request.Request(url, headers={"User-Agent": "moleculeforge-build"})
            if have:
                request.add_header("Range", f"bytes={have}-")
            with urllib.request.urlopen(request, timeout=60) as resp:
                mode = "ab" if have and resp.status == 206 else "wb"
                with part.open(mode) as fh:
                    shutil.copyfileobj(resp, fh, length=1 << 20)
            if expected_size is not None and part.stat().st_size != expected_size:
                raise OSError(f"size mismatch {part.stat().st_size} != {expected_size}")
            part.replace(dest)
            return
        except Exception as exc:
            wait = 2 ** attempt
            log(f"download attempt {attempt} failed ({exc}); retrying in {wait}s")
            time.sleep(wait)
    raise SystemExit(f"failed to download {url}")


def model_spec(plat: str) -> dict[str, object]:
    """The model bundled for a platform: the default, unless engines.lock.json overrides it."""
    return {**LOCK["model"], **LOCK.get("modelByPlatform", {}).get(plat, {})}


def fetch_model(plat: str) -> None:
    spec = model_spec(plat)
    dest = ROOT / "data" / "models" / spec["file"]
    if dest.exists() and dest.stat().st_size == spec["size"] and sha256_of(dest) == spec["sha256"]:
        log(f"model already present and verified: {dest.name}")
        return
    url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{spec['file']}"
    log(f"downloading model {spec['file']} ({spec['size'] / 1e9:.2f} GB)")
    download(url, dest, expected_size=spec["size"])
    actual = sha256_of(dest)
    if actual != spec["sha256"]:
        dest.unlink()
        raise SystemExit(f"model sha256 mismatch: {actual}")
    log("model verified")


def woff_to_ttf(woff: bytes) -> bytes:
    """Convert a WOFF 1.0 font to a plain sfnt (TTF) using only the standard library."""
    signature, flavor, _length, num_tables = struct.unpack(">4sIIH", woff[:14])
    if signature != b"wOFF":
        raise ValueError("not a WOFF 1.0 font")
    tables = []
    for i in range(num_tables):
        tag, offset, comp_len, orig_len, checksum = struct.unpack(">4sIIII", woff[44 + 20 * i: 64 + 20 * i])
        raw = woff[offset: offset + comp_len]
        data = zlib.decompress(raw) if comp_len < orig_len else raw
        if len(data) != orig_len:
            raise ValueError(f"table {tag!r} has the wrong length")
        tables.append((tag, checksum, data))
    tables.sort(key=lambda t: t[0])
    entry_selector = max(0, num_tables.bit_length() - 1)
    search_range = (1 << entry_selector) * 16
    header = struct.pack(">IHHHH", flavor, num_tables, search_range, entry_selector, num_tables * 16 - search_range)
    offset = 12 + 16 * num_tables
    directory, body, head_offset = b"", b"", None
    for tag, checksum, data in tables:
        if tag == b"head":
            head_offset = offset + 8  # checkSumAdjustment
        directory += struct.pack(">4sIII", tag, checksum, offset, len(data))
        padded = data + b"\0" * (-len(data) % 4)
        body += padded
        offset += len(padded)
    font = bytearray(header + directory + body)
    if head_offset is not None:
        font[head_offset:head_offset + 4] = b"\0\0\0\0"
        total = sum(struct.unpack(f">{len(font) // 4}I", bytes(font))) & 0xFFFFFFFF
        font[head_offset:head_offset + 4] = struct.pack(">I", (0xB1B0AFBA - total) & 0xFFFFFFFF)
    return bytes(font)


def fetch_fonts() -> None:
    """PDF report fonts: IBM Plex Sans Thai covers Latin and Thai in one face (OFL-1.1)."""
    spec = LOCK["fonts"]
    dest = ROOT / "data" / "fonts"
    if all((dest / name).exists() for name in spec["files"]) and (dest / "OFL.txt").exists():
        log("fonts already present")
        return
    with tempfile.TemporaryDirectory() as tmp:
        tarball = Path(tmp) / "fonts.tgz"
        download(spec["tarball"], tarball)
        actual = sha256_of(tarball)
        if actual != spec["sha256"]:
            raise SystemExit(f"font package sha256 mismatch: {actual}")
        dest.mkdir(parents=True, exist_ok=True)
        with tarfile.open(tarball) as tar:
            for ttf_name, member in spec["files"].items():
                extracted = tar.extractfile(member)
                if extracted is None:
                    raise SystemExit(f"{member} missing from font package")
                (dest / ttf_name).write_bytes(woff_to_ttf(extracted.read()))
            license_file = tar.extractfile(spec["licenseFile"])
            if license_file is None:
                raise SystemExit("font licence missing from package")
            (dest / "OFL.txt").write_bytes(license_file.read())
    log(f"fonts written to {dest.relative_to(ROOT)}")


def micromamba(plat: str) -> Path:
    tools = ROOT / "engines" / ".tools"
    exe = tools / ("micromamba.exe" if plat.startswith("windows") else "micromamba")
    if exe.exists():
        return exe
    subdir = CONDA_SUBDIR[plat]
    url = LOCK["micromamba"]["source"].format(subdir=subdir)
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "micromamba.tar.bz2"
        download(url, archive)
        with tarfile.open(archive) as tar:
            member_name = "Library/bin/micromamba.exe" if plat.startswith("windows") else "bin/micromamba"
            member = tar.getmember(member_name)
            member.name = exe.name
            tools.mkdir(parents=True, exist_ok=True)
            tar.extract(member, tools, filter="data")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe


def fetch_conda_engine(plat: str, name: str) -> None:
    """Materialise a conda-forge packaged engine (xtb, mopac) into engines/<plat>/<name>."""
    spec = LOCK[name]
    prefix = ROOT / "engines" / plat / name
    marker = prefix / "conda-meta"
    exe = micromamba(plat)
    env = dict(os.environ, MAMBA_ROOT_PREFIX=str(ROOT / "engines" / ".mamba-root"))
    if marker.exists() and any(p.name.startswith(f"{name}-") for p in marker.iterdir()):
        log(f"{name} prefix already present")
    else:
        pins = LOCK.get("conda_pins", {}).get("specs", [])
        cmd = [str(exe), "create", "--yes", "--prefix", str(prefix), "--override-channels",
               "--channel", spec["channel"], spec["conda_spec"], *pins, "--platform", CONDA_SUBDIR[plat]]
        log(f"creating {name} prefix: " + " ".join(cmd[1:]))
        subprocess.run(cmd, check=True, env=env)
        # Trim headers, static archives, import libraries and docs that are never used at runtime
        # (Windows prefixes keep them under Library/).
        for base in (prefix, prefix / "Library"):
            for sub in ("include", "lib/cmake", "lib/pkgconfig", "share/man", "share/doc", "share/info"):
                target = base / sub
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
        history = prefix / "conda-meta" / "history"
        if history.is_file():
            history.unlink()
        for pattern in ("*.a", "*.lib") if plat.startswith("windows") else ("*.a",):
            for static in prefix.rglob(pattern):
                static.unlink()
    bundle_conda_licences(exe, prefix, env)


def bundle_conda_licences(exe: Path, prefix: Path, env: dict[str, str]) -> None:
    """Copy each installed package's licence files into <prefix>/share/licenses/conda/<package>/.

    conda keeps them in the package's info/licenses, which is not part of an installed prefix, so
    each package is fetched again (verified against the sha256 recorded in conda-meta) and only its
    info/ directory is read. This is what puts the OpenBLAS, LAPACK and GCC runtime licences next to
    the libraries that ship with the engine.
    """
    for record_path in sorted((prefix / "conda-meta").glob("*.json")):
        record = json.loads(record_path.read_text(encoding="utf-8"))
        dest = prefix / "share" / "licenses" / "conda" / record["name"]
        if dest.is_dir():
            continue
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / record["url"].rsplit("/", 1)[-1]
            download(record["url"], archive)
            if sha256_of(archive) != record["sha256"]:
                raise SystemExit(f"checksum mismatch for {archive.name}")
            unpacked = Path(tmp) / "unpacked"
            subprocess.run([str(exe), "package", "extract", str(archive), str(unpacked)], check=True, env=env,
                           stdout=subprocess.DEVNULL)
            licences = unpacked / "info" / "licenses"
            dest.mkdir(parents=True)
            if licences.is_dir():
                shutil.copytree(licences, dest, dirs_exist_ok=True)
        shipped = sum(1 for p in dest.rglob("*") if p.is_file())
        note = f"{shipped} file(s)" if shipped else "none in the package; collect_licenses.py adds the SPDX text"
        log(f"licences for {record['name']} {record['version']} ({record.get('license', '?')}): {note}")


def fetch_vina(plat: str) -> None:
    url = LOCK["vina"]["assets"].get(plat)
    if url is None:
        log(f"no prebuilt Vina for {plat}; docking will report as unavailable on this platform")
        return
    dest = ROOT / "engines" / plat / "vina" / ("vina.exe" if plat.startswith("windows") else "vina")
    if dest.exists():
        log("vina already present")
        return
    download(url, dest)
    dest.chmod(dest.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    log(f"vina downloaded to {dest}")


def fetch_llama(plat: str, jobs: int) -> None:
    spec = LOCK["llama_cpp"]
    out = ROOT / "engines" / plat / "llama"
    server = out / ("llama-server.exe" if plat.startswith("windows") else "llama-server")
    if server.exists():
        log("llama-server already built")
        return
    src = ROOT / "engines" / ".src" / f"llama.cpp-{spec['tag']}"
    if not src.exists():
        src.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "-c", "core.longpaths=true", "clone", "--depth", "1", "--branch", spec["tag"],
                        spec["repo"], str(src)], check=True)
    # MF_LLAMA_BUILD_DIR puts the build tree on a short path (Windows MSBuild paths are limited).
    build = Path(os.environ.get("MF_LLAMA_BUILD_DIR") or src / "build")
    extra = [a.replace("{src}", src.as_posix()) for a in spec["cmake_platform"].get(plat, [])]
    args = ["cmake", "-S", str(src), "-B", str(build), *spec["cmake_common"], *extra]
    if os.environ.get("MF_LLAMA_CPU_ONLY") == "1":
        args = [a for a in args if "VULKAN" not in a and "METAL=ON" not in a]
    log("configuring llama.cpp: " + " ".join(args[1:]))
    subprocess.run(args, check=True)
    subprocess.run(["cmake", "--build", str(build), "--config", "Release", "--target", "llama-server", "-j", str(jobs)], check=True)
    out.mkdir(parents=True, exist_ok=True)
    bin_dir = build / "bin"
    if (bin_dir / "Release").is_dir():
        bin_dir = bin_dir / "Release"
    patterns = ("llama-server", "llama-server.exe", "*.so", "*.dylib", "*.dll", "*.metal", "*.metallib")
    copied = 0
    for pattern in patterns:
        for item in bin_dir.glob(pattern):
            target = out / item.name
            if target.exists() or target.is_symlink():
                target.unlink()
            shutil.copy2(item, target, follow_symlinks=False)  # keep soname symlinks as symlinks
            copied += 1
    for lib in build.rglob("*.so*"):
        target = out / lib.name
        if not target.exists() and not target.is_symlink():
            shutil.copy2(lib, target, follow_symlinks=False)
    if not server.exists():
        raise SystemExit("llama-server binary not produced")
    if plat.startswith("windows"):
        copied += copy_vc_runtime(out)
    log(f"llama.cpp built ({copied} files copied to {out})")


def copy_vc_runtime(dest: Path) -> int:
    """Put the Visual C++ runtime (and its OpenMP library) next to binaries built with MSVC.

    llama-server and the ggml back-ends link vcruntime140, msvcp140 and vcomp140 dynamically. These
    are Microsoft's redistributable files, deployed app-locally from the same Visual Studio
    installation that compiled the binaries, so the app runs on PCs without the VC++ redistributable.
    """
    program_files = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    vswhere = Path(program_files) / "Microsoft Visual Studio" / "Installer" / "vswhere.exe"
    install = subprocess.run([str(vswhere), "-latest", "-products", "*", "-requires",
                              "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
                             capture_output=True, text=True, check=True).stdout.strip()

    def version_key(path: Path) -> tuple[int, ...]:
        parts = path.parent.name.split(".")
        return tuple(int(p) for p in parts) if all(p.isdigit() for p in parts) else (0,)

    crt_dirs = sorted((Path(install) / "VC" / "Redist" / "MSVC").glob("*/x64/Microsoft.VC14*.CRT"),
                      key=lambda p: version_key(p.parent))
    if not crt_dirs:
        raise SystemExit(f"no Visual C++ redistributable found under {install}")
    crt = crt_dirs[-1]
    dlls = [*crt.glob("*.dll"), *crt.parent.glob("Microsoft.VC14*.OpenMP/*.dll")]
    for dll in dlls:
        shutil.copy2(dll, dest / dll.name)
    log(f"Visual C++ runtime {crt.parent.parent.name}: {', '.join(sorted(d.name for d in dlls))}")
    return len(dlls)


def write_manifest(plat: str) -> None:
    manifest = {
        "platform": plat,
        "xtb": LOCK["xtb"]["version"],
        "mopac": LOCK["mopac"]["version"],
        "vina": LOCK["vina"]["version"],
        "llama_cpp": LOCK["llama_cpp"]["tag"],
        "model": {k: model_spec(plat)[k] for k in ("name", "quantization", "file", "sha256", "license")},
    }
    target = ROOT / "engines" / plat / "manifest.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", nargs="*", choices=["model", "xtb", "mopac", "vina", "llama", "fonts"], default=None)
    parser.add_argument("--platform", default=None, help="override platform key (e.g. linux-x64)")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    opts = parser.parse_args()
    plat = opts.platform or platform_key()
    wanted = set(opts.only or ["model", "xtb", "mopac", "vina", "llama", "fonts"])
    for conda_engine in ("xtb", "mopac"):
        if conda_engine in wanted:
            fetch_conda_engine(plat, conda_engine)
    if "vina" in wanted:
        fetch_vina(plat)
    if "llama" in wanted:
        fetch_llama(plat, opts.jobs)
    if "model" in wanted:
        fetch_model(plat)
    if "fonts" in wanted:
        fetch_fonts()
    write_manifest(plat)
    log("done")


if __name__ == "__main__":
    sys.exit(main())
