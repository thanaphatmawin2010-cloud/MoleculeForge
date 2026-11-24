"""§9.2 format round-trips (MOL/SDF/SMILES/InChI/XYZ/PDB) and library save/load."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

ASPIRIN = "CC(=O)Oc1ccccc1C(=O)O"
ALANINE = "C[C@H](N)C(=O)O"


def _key(sidecar: Any, molecule: dict[str, Any]) -> str:
    return sidecar.call("chem.convertFormat", {"source": "molecule", "target": "inchi", "molecule": molecule})["data"].splitlines()[0]


@pytest.mark.parametrize("fmt", ["sdf", "mol", "smiles", "inchi"])
def test_identity_round_trips(sidecar: Any, fmt: str) -> None:
    for smiles in (ASPIRIN, ALANINE):
        molecule = sidecar.molecule(smiles)
        text = sidecar.call("chem.convertFormat", {"source": "molecule", "target": fmt, "molecule": molecule})["data"]
        back = sidecar.call("chem.convertFormat", {"source": fmt, "target": "molecule", "data": text})["molecules"][0]
        assert _key(sidecar, back) == _key(sidecar, molecule), f"{fmt} lost identity or stereo for {smiles}"


@pytest.mark.parametrize("fmt", ["sdf", "mol", "xyz", "pdb"])
def test_coordinates_round_trip(sidecar: Any, fmt: str) -> None:
    molecule = sidecar.molecule(ASPIRIN, "aspirin")
    text = sidecar.call("chem.convertFormat", {"source": "molecule", "target": fmt, "molecule": molecule})["data"]
    back = sidecar.call("chem.convertFormat", {"source": fmt, "target": "molecule", "data": text, "embed3d": False})["molecules"][0]
    assert len(back["atoms"]) == len(molecule["atoms"])
    tolerance = 1e-3 if fmt in ("pdb",) else 1e-4
    for a, b in zip(molecule["atoms"], back["atoms"], strict=True):
        assert a["el"] == b["el"]
        assert abs(a["x"] - b["x"]) <= tolerance and abs(a["y"] - b["y"]) <= tolerance and abs(a["z"] - b["z"]) <= tolerance


def test_untrusted_input_is_rejected_cleanly(sidecar: Any) -> None:
    from conftest import RpcFailure

    for fmt, data in [("smiles", "C1CC(("), ("sdf", "not a molfile"), ("inchi", "InChI=garbage"), ("xyz", "3\nbad\nX 0 0")]:
        with pytest.raises(RpcFailure):
            sidecar.call("chem.convertFormat", {"source": fmt, "target": "molecule", "data": data})


def test_library_save_load_search_and_delete(sidecar: Any) -> None:
    listing = sidecar.call("library.list", {"limit": 500})
    assert listing["total"] >= 100, "at least 100 prebuilt molecules"
    molecule = sidecar.call("chem.repairGeometry", {"molecule": sidecar.molecule("OCC(O)CO", "my glycerol")})["molecule"]
    saved = sidecar.call("library.save", {"molecule": molecule, "layout2d": None})
    if not saved["saved"]:  # glycerol is prebuilt: the duplicate is reported, then saved on request
        assert saved["duplicateOf"]["name"]
        saved = sidecar.call("library.save", {"molecule": molecule, "layout2d": None, "overwrite": True})
    assert saved["saved"] and saved["category"]
    loaded = sidecar.call("library.load", {"id": saved["id"]})
    assert loaded["name"] == "my glycerol" and len(loaded["molecule"]["atoms"]) == len(molecule["atoms"])
    found = sidecar.call("library.list", {"query": "glycerol", "source": "user"})
    assert any(item["id"] == saved["id"] for item in found["items"])
    sidecar.call("library.favorite", {"id": saved["id"], "favorite": True})
    assert sidecar.call("library.list", {"favoritesOnly": True})["total"] >= 1
    exported = sidecar.call("library.export", {"format": "sdf", "ids": [saved["id"]]})
    assert exported["count"] == 1 and "M  END" in exported["data"]
    assert sidecar.call("library.delete", {"id": saved["id"]})["deleted"] is True


def test_library_categories_cover_the_prebuilt_set(sidecar: Any) -> None:
    categories = sidecar.call("library.categories", {})["categories"]
    assert sum(c["count"] for c in categories) >= 100
    assert all(c["row"] and c["col"] for c in categories)


def test_library_persists_across_restarts(tmp_path: Path) -> None:
    """§7.7: a saved molecule is still there after the engine (and so the app) restarts."""
    from conftest import Sidecar

    first = Sidecar(tmp_path)
    try:
        molecule = first.molecule("CCOC(=O)C", "persisted ester")
        saved = first.call("library.save", {"molecule": molecule, "layout2d": None})
        if not saved["saved"]:
            saved = first.call("library.save", {"molecule": molecule, "layout2d": None, "overwrite": True})
    finally:
        first.close()
    second = Sidecar(tmp_path)
    try:
        assert second.call("library.load", {"id": saved["id"]})["name"] == "persisted ester"
    finally:
        second.close()


def test_property_results_are_cached_by_inchikey_and_method(sidecar: Any) -> None:
    """§7.8: an identical second run is served from the cache, and says so."""
    molecule = sidecar.molecule("CC(C)O", "isopropanol")
    first = sidecar.call("sim.properties", {"molecule": molecule, "level": "fast"}, timeout=600)
    second = sidecar.call("sim.properties", {"molecule": molecule, "level": "fast"}, timeout=600)
    assert "cached" not in [w["code"] for w in first["warningCodes"]]
    assert "cached" in [w["code"] for w in second["warningCodes"]]
    assert second["properties"]["molecularWeight"] == first["properties"]["molecularWeight"]

