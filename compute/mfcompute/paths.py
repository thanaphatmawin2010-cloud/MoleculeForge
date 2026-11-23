"""Resolution of bundled read-only resources and per-user writable state.

Layout (identical in a source checkout and in an installed application)::

    <resource root>/
        engines/<platform-key>/{xtb,mopac,vina,llama}/...
        data/{elements.json, molecules/, knowledge/, models/}

The desktop shell exports ``MF_RESOURCE_DIR`` (Tauri resource directory) and
``MF_DATA_DIR`` (per-user application data directory) before spawning the
sidecar.  When they are absent (developer checkout, tests) the repository root
is used for resources and a user-level directory for state.
"""

from __future__ import annotations

import os
import platform
import sys
from functools import lru_cache
from pathlib import Path


def platform_key() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    if system == "darwin":
        return f"macos-{arch}"
    if system == "windows":
        return f"windows-{arch}"
    return f"linux-{arch}"


@lru_cache(maxsize=1)
def resource_root() -> Path:
    override = os.environ.get("MF_RESOURCE_DIR")
    if override:
        return Path(override).resolve()
    if getattr(sys, "frozen", False):
        # PyInstaller one-folder layout: <root>/compute/moleculeforge-compute[.exe]
        return Path(sys.executable).resolve().parent.parent
    return Path(__file__).resolve().parents[2]


def data_dir() -> Path:
    return resource_root() / "data"


def engines_dir() -> Path:
    return resource_root() / "engines" / platform_key()


def models_dir() -> Path:
    override = os.environ.get("MF_MODELS_DIR")
    return Path(override).resolve() if override else data_dir() / "models"


@lru_cache(maxsize=1)
def user_dir() -> Path:
    override = os.environ.get("MF_DATA_DIR")
    if override:
        base = Path(override)
    elif platform.system() == "Windows":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "MoleculeForge"
    elif platform.system() == "Darwin":
        base = Path.home() / "Library" / "Application Support" / "MoleculeForge"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "moleculeforge"
    base.mkdir(parents=True, exist_ok=True)
    return base


def scratch_dir() -> Path:
    path = user_dir() / "scratch"
    path.mkdir(parents=True, exist_ok=True)
    return path


def executable(engine: str, name: str) -> Path | None:
    """Return the path to a bundled engine executable, or ``None`` if not bundled."""
    suffix = ".exe" if platform.system() == "Windows" else ""
    root = engines_dir() / engine
    candidates = [
        root / "bin" / f"{name}{suffix}",
        root / "Library" / "bin" / f"{name}{suffix}",  # conda layout on Windows
        root / f"{name}{suffix}",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None
