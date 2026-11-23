"""Hardware and engine capability detection (``system.capabilities``).

Detection is local only: CPU flags, RAM, GPU adapters and the engines bundled with
the application. Results are cached for the life of the process; the shell can
request a refresh.
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import psutil

from . import __version__, paths

_LOCK = threading.Lock()
_CACHE: dict[str, Any] | None = None


def _run(args: list[str], timeout: float = 6.0) -> str:
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout, creationflags=flags, check=False)
        return (out.stdout or "") + (out.stderr or "")
    except (OSError, subprocess.SubprocessError):
        return ""


def cpu_features() -> dict[str, bool]:
    wanted = ("SSE42", "AVX", "AVX2", "FMA3", "AVX512F", "AVX512_SKX", "NEON", "ASIMD")
    try:
        from numpy._core._multiarray_umath import __cpu_features__ as feats  # type: ignore[attr-defined]

        return {name.lower(): bool(feats.get(name, False)) for name in wanted if name in feats}
    except ImportError:
        pass
    flags: set[str] = set()
    if platform.system() == "Linux" and Path("/proc/cpuinfo").exists():
        for line in Path("/proc/cpuinfo").read_text(errors="ignore").splitlines():
            if line.startswith(("flags", "Features")):
                flags.update(line.split(":", 1)[1].split())
                break
    return {
        "avx": "avx" in flags,
        "avx2": "avx2" in flags,
        "fma3": "fma" in flags,
        "avx512f": "avx512f" in flags,
        "neon": "asimd" in flags or platform.machine().lower() in ("arm64", "aarch64"),
    }


def cpu_model() -> str:
    system = platform.system()
    if system == "Linux" and Path("/proc/cpuinfo").exists():
        for line in Path("/proc/cpuinfo").read_text(errors="ignore").splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    if system == "Darwin":
        return _run(["sysctl", "-n", "machdep.cpu.brand_string"]).strip() or platform.processor()
    return platform.processor() or platform.machine()


def _linux_gpus() -> list[dict[str, Any]]:
    vendors = {"0x10de": "NVIDIA", "0x1002": "AMD", "0x8086": "Intel", "0x1af4": "Virtio"}
    found: list[dict[str, Any]] = []
    root = Path("/sys/bus/pci/devices")
    if not root.exists():
        return found
    for dev in root.iterdir():
        try:
            cls = (dev / "class").read_text().strip()
            if not cls.startswith("0x03"):
                continue
            vendor = (dev / "vendor").read_text().strip()
            found.append({"name": f"{vendors.get(vendor, vendor)} display controller", "vendor": vendors.get(vendor, vendor)})
        except OSError:
            continue
    return found


def gpu_adapters() -> list[dict[str, Any]]:
    adapters: list[dict[str, Any]] = []
    if shutil.which("nvidia-smi"):
        text = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        for line in text.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 2 and parts[1].isdigit():
                adapters.append({"name": parts[0], "vendor": "NVIDIA", "vramBytes": int(parts[1]) * 1024 * 1024})
    system = platform.system()
    if system == "Darwin":
        text = _run(["system_profiler", "SPDisplaysDataType", "-json"], timeout=10)
        try:
            for item in json.loads(text).get("SPDisplaysDataType", []):
                adapters.append({"name": item.get("sppci_model", "Apple GPU"), "vendor": "Apple", "metal": True})
        except json.JSONDecodeError:
            if platform.machine() == "arm64":
                adapters.append({"name": "Apple GPU", "vendor": "Apple", "metal": True})
    elif system == "Windows":
        text = _run(["powershell", "-NoProfile", "-Command",
                     "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json"], timeout=10)
        try:
            data = json.loads(text) if text.strip() else []
            for item in data if isinstance(data, list) else [data]:
                if item.get("Name") and not any(a["name"] == item["Name"] for a in adapters):
                    adapters.append({"name": item["Name"], "vendor": item["Name"].split()[0], "vramBytes": item.get("AdapterRAM")})
        except json.JSONDecodeError:
            pass
    elif system == "Linux" and not adapters:
        adapters.extend(_linux_gpus())
    return adapters


def openmm_platforms() -> list[dict[str, Any]]:
    try:
        import openmm
    except ImportError:
        return []
    found = []
    for i in range(openmm.Platform.getNumPlatforms()):
        plat = openmm.Platform.getPlatform(i)
        found.append({"name": plat.getName(), "speed": plat.getSpeed()})
    return sorted(found, key=lambda p: -float(p["speed"]))


@lru_cache(maxsize=1)
def llama_devices() -> list[str]:
    exe = paths.executable("llama", "llama-server")
    if exe is None:
        return []
    text = _run([str(exe), "--list-devices"], timeout=20)
    devices = []
    for line in text.splitlines():
        match = re.match(r"\s*(Vulkan\d+|CUDA\d+|Metal|MTL\d+|ROCm\d+|HIP\d+|SYCL\d+):\s*(.+)", line)
        if match:
            devices.append(f"{match.group(1)}: {match.group(2).strip()}")
    return devices


def _engine_version(engine: str, exe_name: str, args: list[str], pattern: str) -> dict[str, Any]:
    exe = paths.executable(engine, exe_name)
    if exe is None:
        return {"available": False}
    env = engine_env(engine)
    try:
        out = subprocess.run([str(exe), *args], capture_output=True, text=True, timeout=20, env=env,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
                             cwd=str(paths.scratch_dir()))
        text = (out.stdout or "") + (out.stderr or "")
    except (OSError, subprocess.SubprocessError):
        return {"available": False}
    match = re.search(pattern, text)
    return {"available": True, "version": match.group(1) if match else "unknown", "path": str(exe)}


def engine_env(engine: str) -> dict[str, str]:
    """Environment for running a bundled engine (library paths, parameter files, threads)."""
    env = dict(os.environ)
    root = paths.engines_dir() / engine
    libdirs = [str(root / "lib"), str(root / "Library" / "bin"), str(root)]
    if platform.system() == "Windows":
        env["PATH"] = os.pathsep.join([str(root / "Library" / "bin"), str(root / "bin"), env.get("PATH", "")])
    elif platform.system() == "Darwin":
        env["DYLD_FALLBACK_LIBRARY_PATH"] = os.pathsep.join([*libdirs, env.get("DYLD_FALLBACK_LIBRARY_PATH", "")])
    else:
        env["LD_LIBRARY_PATH"] = os.pathsep.join([*libdirs, env.get("LD_LIBRARY_PATH", "")])
    if engine == "xtb":
        share = root / "share" / "xtb"
        if not share.exists():
            share = root / "Library" / "share" / "xtb"
        env["XTBPATH"] = str(share)
        env.setdefault("OMP_STACKSIZE", "512M")
    if engine == "mopac":
        env["MOPAC_LICENSE"] = str(root)
    threads = str(recommended_threads())
    env["OMP_NUM_THREADS"] = threads
    env["OPENBLAS_NUM_THREADS"] = threads
    env["MKL_NUM_THREADS"] = threads
    return env


def recommended_threads() -> int:
    physical = psutil.cpu_count(logical=False) or os.cpu_count() or 2
    # Leave one core for the UI thread and rendering.
    return max(1, physical - 1)


def model_info() -> dict[str, Any]:
    lock_path = paths.resource_root() / "scripts" / "engines.lock.json"
    manifest = paths.engines_dir() / "manifest.json"
    spec: dict[str, Any] = {}
    for candidate in (manifest, lock_path):
        if candidate.exists():
            data = json.loads(candidate.read_text(encoding="utf-8"))
            spec = data.get("model", {})
            if spec:
                break
    file_name = spec.get("file")
    path = paths.models_dir() / file_name if file_name else None
    available = bool(path and path.exists())
    return {
        "available": available,
        "name": spec.get("name"),
        "quantization": spec.get("quantization"),
        "license": spec.get("license"),
        "path": str(path) if path else None,
        "sizeBytes": path.stat().st_size if available and path else None,
    }


def detect(refresh: bool = False) -> dict[str, Any]:
    global _CACHE
    with _LOCK:
        if _CACHE is not None and not refresh:
            return _CACHE
        vm = psutil.virtual_memory()
        try:
            import openmm
            import pyscf
            import rdkit

            libs = {"rdkit": rdkit.__version__, "openmm": openmm.__version__, "pyscf": pyscf.__version__}
        except ImportError as exc:  # pragma: no cover - packaging error
            libs = {"error": str(exc)}
        gpus = gpu_adapters()
        mm_platforms = openmm_platforms()
        llm_devices = llama_devices()
        best_mm = mm_platforms[0]["name"] if mm_platforms else None
        caps: dict[str, Any] = {
            "app": {"computeVersion": __version__, "platform": paths.platform_key()},
            "os": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
            "cpu": {
                "model": cpu_model(),
                "physicalCores": psutil.cpu_count(logical=False) or os.cpu_count(),
                "logicalCores": psutil.cpu_count(logical=True) or os.cpu_count(),
                "features": cpu_features(),
                "recommendedThreads": recommended_threads(),
            },
            "memory": {"totalBytes": vm.total, "availableBytes": vm.available},
            "gpu": {
                "adapters": gpus,
                "openmmPlatforms": mm_platforms,
                "llmDevices": llm_devices,
                "accelerated": bool(llm_devices) or (best_mm not in (None, "Reference", "CPU")),
            },
            "engines": {
                "libraries": libs,
                "xtb": _engine_version("xtb", "xtb", ["--version"], r"xtb version ([\d.]+)"),
                "mopac": _engine_version("mopac", "mopac", ["--version"], r"MOPAC\s*v?([\w.]+)"),
                "vina": _engine_version("vina", "vina", ["--version"], r"Vina v([\d.]+)"),
                "llama": {"available": paths.executable("llama", "llama-server") is not None, "devices": llm_devices},
                "model": model_info(),
            },
            "selected": {
                "openmmPlatform": best_mm,
                "threads": recommended_threads(),
                "llmOffload": "gpu" if llm_devices else "cpu",
            },
        }
        _CACHE = caps
        return caps
