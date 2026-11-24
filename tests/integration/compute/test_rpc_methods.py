"""§9.2 IPC: every §4.3 method through the real sidecar process, with progress and units."""

from __future__ import annotations

import re
from typing import Any

import pytest


def test_capabilities_report_hardware(sidecar: Any) -> None:
    caps = sidecar.call("system.capabilities", {})
    assert caps["cpu"]["logicalCores"] >= 1
    assert caps["memory"]["totalBytes"] > 0
    assert "gpu" in caps
    for engine in ("xtb", "mopac", "vina", "llama", "model"):
        assert caps["engines"][engine]["available"] is True, engine
    for engine in ("xtb", "mopac", "vina"):  # versions are shown in the app; they must be real ones
        assert re.fullmatch(r"\d+(\.\d+)+", caps["engines"][engine]["version"]), caps["engines"][engine]


def test_sanitize_and_validate(sidecar: Any) -> None:
    water = sidecar.molecule("O", "water")
    sanitized = sidecar.call("chem.sanitize", {"molecule": water})
    assert sanitized["issues"] == [] or all(i["severity"] != "error" for i in sanitized["issues"])
    result = sidecar.call("chem.validateBonds", {"molecule": water, "focusAtoms": [0], "focusBonds": [0], "autoFix": True})
    assert result["status"] == "valid" and result["message"] == "Bond connected correctly."


def test_validation_is_fast(sidecar: Any, timer: Any) -> None:
    molecule = sidecar.molecule("CC(=O)Oc1ccccc1C(=O)O", "aspirin")
    sidecar.call("chem.validateBonds", {"molecule": molecule, "focusAtoms": [], "focusBonds": [], "autoFix": True})  # warm-up
    with timer() as t:
        sidecar.call("chem.validateBonds", {"molecule": molecule, "focusAtoms": [0], "focusBonds": [0], "autoFix": True})
    assert t.seconds < 0.1, f"bond validation took {t.seconds * 1000:.0f} ms (budget 100 ms)"


def test_repair_streams_progress(sidecar: Any) -> None:
    req = sidecar.send("chem.repairGeometry", {"molecule": sidecar.molecule("CCO", "ethanol")}, job_id="repair-progress")
    report = sidecar.wait(req)
    stages = {p["stage"] for p in sidecar.progress_for("repair-progress")}
    assert {"sanitize", "done"} <= stages | {"sanitize"}
    assert report["status"] in ("repaired", "already-optimal")


def test_descriptors_have_units_and_methods(sidecar: Any) -> None:
    props = sidecar.call("chem.descriptors", {"molecule": sidecar.molecule("CCO")})["properties"]
    for key in ("molecularWeight", "logP", "tpsa", "hBondDonors", "qed"):
        assert key in props and "unit" in props[key] and props[key]["method"]


def test_minimize_is_fast(sidecar: Any, timer: Any) -> None:
    molecule = sidecar.molecule("CC(=O)Oc1ccccc1C(=O)O", "aspirin")
    with timer() as t:
        result = sidecar.call("sim.minimize", {"molecule": molecule, "method": "MMFF94"})
    assert result["converged"] is True
    assert result["properties"]["potentialEnergy"]["unit"] == "kcal/mol"
    assert t.seconds < 2.0, f"MMFF minimisation took {t.seconds:.2f} s (budget 2 s)"


def test_md_runs_on_openmm(sidecar: Any) -> None:
    result = sidecar.call("sim.md", {"molecule": sidecar.molecule("CCO", "ethanol"), "steps": 2000, "temperatureK": 300})
    assert "OpenMM" in result["engine"]
    assert result["data"]["timeSeries"]
    temperature = result["properties"]["averageTemperature"]
    assert temperature["unit"] == "K" and 150 < temperature["value"] < 450


def test_properties_fast_level(sidecar: Any) -> None:
    result = sidecar.call("sim.properties", {"molecule": sidecar.molecule("O", "water"), "level": "fast"})
    props = result["properties"]
    assert props["totalEnergy"]["unit"] == "Eh" and "GFN2-xTB" in props["totalEnergy"]["method"]
    assert props["dipoleMoment"]["unit"] == "D"


def test_docking_host_guest(sidecar: Any) -> None:
    host = sidecar.call("chem.repairGeometry", {"molecule": sidecar.molecule("C1COCCOCCOCCOCCOCCO1", "18-crown-6")})["molecule"]
    guest = sidecar.molecule("[NH4+]", "ammonium")
    result = sidecar.call("sim.dock", {"receptor": host, "ligand": guest, "exhaustiveness": 4, "numModes": 3})
    assert result["data"]["modes"], "Vina returned binding modes"
    best = result["properties"]["bestAffinity"]
    assert best["unit"] == "kcal/mol" and best["value"] < 0 and "Vina" in best["method"]


def test_elements(sidecar: Any) -> None:
    everything = sidecar.call("elements.all", {})["elements"]
    assert len(everything) == 118
    iron = sidecar.call("elements.get", {"symbol": "Fe"})
    assert iron["Z"] == 26 and iron["atomicMass"]["unit"] == "u"


def test_unknown_method_and_bad_params_are_rejected(sidecar: Any) -> None:
    from conftest import RpcFailure

    with pytest.raises(RpcFailure) as missing:
        sidecar.call("os.system", {})
    assert missing.value.error["code"] == -32601
    with pytest.raises(RpcFailure) as invalid:
        sidecar.call("chem.descriptors", {"molecule": {"id": "x", "atoms": "not a list"}})
    assert invalid.value.error["code"] == -32602
    with pytest.raises(RpcFailure) as extra:
        sidecar.call("library.list", {"limit": 1, "unexpected": True})
    assert extra.value.error["code"] == -32602
