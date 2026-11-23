#!/usr/bin/env python3
"""Fetch, build and verify the third-party engines that MoleculeForge bundles.

Everything pinned in ``scripts/engines.lock.json`` is materialised under
``engines/<platform>/`` (and the language model under ``data/models/``) so the
packaged application never touches the network at runtime.

Usage::

    python3 scripts/fetch_engines.py                # all components
    python3 scripts/fetch_engines.py --only model   # one component
    python3 scripts/fetch_engines.py --only xtb mopac vina llama

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
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
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
        except Exception as exc:  # noqa: BLE001 - retry any transport failure
            wait = 2 ** attempt
            log(f"download attempt {attempt} failed ({exc}); retrying in {wait}s")
            time.sleep(wait)
    raise SystemExit(f"failed to download {url}")


def fetch_model() -> None:
    spec = LOCK["model"]
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
    if marker.exists() and any(p.name.startswith(f"{name}-") for p in marker.iterdir()):
        log(f"{name} prefix already present")
        return
    exe = micromamba(plat)
    env = dict(os.environ, MAMBA_ROOT_PREFIX=str(ROOT / "engines" / ".mamba-root"))
    cmd = [str(exe), "create", "--yes", "--prefix", str(prefix), "--override-channels",
           "--channel", spec["channel"], spec["conda_spec"], "--platform", CONDA_SUBDIR[plat]]
    log(f"creating {name} prefix: " + " ".join(cmd[1:]))
    subprocess.run(cmd, check=True, env=env)
    # Trim headers, static archives and docs that are never used at runtime.
    for sub in ("include", "share/man", "share/doc", "share/info", "conda-meta/history"):
        target = prefix / sub
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
    for static in prefix.rglob("*.a"):
        static.unlink()


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
        subprocess.run(["git", "clone", "--depth", "1", "--branch", spec["tag"], spec["repo"], str(src)], check=True)
    build = src / "build"
    args = ["cmake", "-S", str(src), "-B", str(build), *spec["cmake_common"], *spec["cmake_gpu"].get(plat, [])]
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
    log(f"llama.cpp built ({copied} files copied to {out})")


def write_manifest(plat: str) -> None:
    manifest = {
        "platform": plat,
        "xtb": LOCK["xtb"]["version"],
        "mopac": LOCK["mopac"]["version"],
        "vina": LOCK["vina"]["version"],
        "llama_cpp": LOCK["llama_cpp"]["tag"],
        "model": {k: LOCK["model"][k] for k in ("name", "quantization", "file", "sha256", "license")},
    }
    target = ROOT / "engines" / plat / "manifest.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", nargs="*", choices=["model", "xtb", "mopac", "vina", "llama"], default=None)
    parser.add_argument("--platform", default=None, help="override platform key (e.g. linux-x64)")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    opts = parser.parse_args()
    plat = opts.platform or platform_key()
    wanted = set(opts.only or ["model", "xtb", "mopac", "vina", "llama"])
    for conda_engine in ("xtb", "mopac"):
        if conda_engine in wanted:
            fetch_conda_engine(plat, conda_engine)
    if "vina" in wanted:
        fetch_vina(plat)
    if "llama" in wanted:
        fetch_llama(plat, opts.jobs)
    if "model" in wanted:
        fetch_model()
    write_manifest(plat)
    log("done")


if __name__ == "__main__":
    sys.exit(main())
