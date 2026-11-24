"""Protocol behaviour (cancellation, transport fields), the shell allowlist, and the offline rule."""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any

import psutil
import pytest

ROOT = Path(__file__).resolve().parents[3]


def test_cancelling_a_running_job(sidecar: Any) -> None:
    from conftest import RpcFailure

    req = sidecar.send("sim.md", {"molecule": sidecar.molecule("CCCCCCCC", "octane"), "steps": 2_000_000}, job_id="cancel-me")
    deadline = time.time() + 60
    while not sidecar.progress_for("cancel-me") and time.time() < deadline:
        time.sleep(0.1)
    started = time.time()
    assert sidecar.call("job.cancel", {"jobId": "cancel-me"})["cancelled"] is True
    with pytest.raises(RpcFailure) as cancelled:
        sidecar.wait(req, timeout=60)
    assert cancelled.value.error["code"] == -32000
    assert time.time() - started < 5


def test_transport_job_id_is_accepted_everywhere(sidecar: Any) -> None:
    assert sidecar.call("library.list", {"limit": 1}, job_id="ui-123")["items"]
    assert sidecar.call("elements.get", {"symbol": "C"}, job_id="ui-124")["symbol"] == "C"


def test_shell_allowlist_matches_the_sidecar_methods() -> None:
    from mfcompute import handlers  # noqa: F401 - registers methods
    from mfcompute.registry import METHODS

    source = (ROOT / "app-shell" / "src-tauri" / "src" / "sidecar.rs").read_text(encoding="utf-8")
    block = source[source.index("ALLOWED_METHODS"):source.index("];", source.index("ALLOWED_METHODS"))]
    allowed = set(re.findall(r'"([a-zA-Z0-9.]+)"', block))
    assert allowed == set(METHODS) - {"system.shutdown"}, "only the shell may shut the engine down"


def test_no_non_loopback_sockets(sidecar: Any) -> None:
    """Offline rule (§9.5): after exercising the engines and the local model, every socket of the
    sidecar process tree is loopback-only."""
    sidecar.call("sim.properties", {"molecule": sidecar.molecule("CO", "methanol"), "level": "fast"})
    procs = [psutil.Process(sidecar.proc.pid), *psutil.Process(sidecar.proc.pid).children(recursive=True)]
    for proc in procs:
        try:
            connections = proc.net_connections(kind="inet")
        except psutil.NoSuchProcess:
            continue
        for conn in connections:
            for address in (conn.laddr, conn.raddr):
                if address:
                    assert address.ip in ("127.0.0.1", "::1"), f"{proc.name()} uses non-loopback socket {conn}"


def test_model_choice_is_validated_applied_and_reset(sidecar: Any, tmp_path: Path) -> None:
    """Assistant > Language model: only real GGUF files are accepted; the bundled model can be restored."""
    from conftest import RpcFailure

    assert sidecar.call("ai.status", {})["model"]["bundled"] is True
    impostor = tmp_path / "impostor.gguf"
    impostor.write_bytes(b"MZ\x90\x00" + bytes(64))
    with pytest.raises(RpcFailure):
        sidecar.call("ai.configure", {"modelPath": str(impostor)})
    with pytest.raises(RpcFailure):
        sidecar.call("ai.configure", {"modelPath": str(tmp_path / "missing.gguf")})
    chosen = tmp_path / "tiny-model.gguf"
    chosen.write_bytes(b"GGUF" + bytes(64))
    status = sidecar.call("ai.configure", {"modelPath": str(chosen)})
    assert status["model"]["name"] == "tiny-model" and status["model"]["bundled"] is False
    assert sidecar.call("ai.status", {})["model"]["name"] == "tiny-model"
    status = sidecar.call("ai.configure", {"useDefault": True})
    assert status["model"]["bundled"] is True and status["model"]["name"] == status["bundledModel"]


def test_cancelling_a_repair_stops_its_engine_process(sidecar: Any) -> None:
    """§7.4: repair runs with progress and can be cancelled; its DFT worker process is terminated."""
    from conftest import RpcFailure

    def dft_workers() -> list[psutil.Process]:
        # The spawned PySCF worker; Python's long-lived multiprocessing resource tracker is not one.
        out = []
        for child in psutil.Process(sidecar.proc.pid).children(recursive=True):
            try:
                if "spawn_main" in " ".join(child.cmdline()) and child.status() != psutil.STATUS_ZOMBIE:
                    out.append(child)
            except psutil.NoSuchProcess:
                continue
        return out

    water = sidecar.molecule("O", "water")
    bent = {**water, "atoms": [{**a, "x": a["x"] * 1.25, "y": a["y"] * 0.7} for a in water["atoms"]]}
    req = sidecar.send("chem.repairGeometry", {"molecule": bent}, job_id="cancel-repair")
    deadline = time.time() + 60
    while not dft_workers() and time.time() < deadline:
        time.sleep(0.05)
    assert dft_workers(), "the B3LYP refinement started in its worker process"
    assert sidecar.progress_for("cancel-repair"), "progress was reported"
    assert sidecar.call("job.cancel", {"jobId": "cancel-repair"})["cancelled"] is True
    with pytest.raises(RpcFailure) as cancelled:
        sidecar.wait(req, timeout=60)
    assert cancelled.value.error["code"] == -32000
    deadline = time.time() + 10
    while dft_workers() and time.time() < deadline:
        time.sleep(0.1)
    assert not dft_workers(), "the worker was terminated"
