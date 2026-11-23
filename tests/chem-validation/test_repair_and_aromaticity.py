"""§9.3: idempotent one-click repair (§7.4) and aromaticity perception."""

from __future__ import annotations

from typing import Any

import pytest

DRUGLIKE = {
    "aspirin": "CC(=O)Oc1ccccc1C(=O)O",
    "caffeine": "Cn1cnc2c1c(=O)n(C)c(=O)n2C",
    "(S)-ibuprofen": "CC(C)Cc1ccc(cc1)[C@H](C)C(=O)O",
    "pyridine": "c1ccncc1",
    "acetic acid": "CC(=O)O",
}


@pytest.mark.parametrize("name", list(DRUGLIKE))
def test_repair_is_idempotent(sidecar: Any, name: str) -> None:
    first = sidecar.call("chem.repairGeometry", {"molecule": sidecar.molecule(DRUGLIKE[name], name)})
    assert first["status"] in ("repaired", "already-optimal")
    assert not [i for i in first["finalIssues"] if i["severity"] == "error"]
    second = sidecar.call("chem.repairGeometry", {"molecule": first["molecule"]})
    assert second["status"] == "already-optimal", f"re-running repair on {name} changed it (rmsd {second['rmsd']})"
    assert not second["fixesApplied"]


def test_repair_fixes_a_broken_structure_and_reports_every_change(sidecar: Any) -> None:
    # Pentavalent carbon drawn by hand: one bond too many.
    methane = sidecar.molecule("C", "methane")
    atoms = [a for a in methane["atoms"]]
    atoms.append({"i": len(atoms), "el": "H", "x": 0.0, "y": 0.0, "z": -1.1, "charge": 0, "isotope": None, "hCount": None})
    broken = {**methane, "atoms": atoms, "bonds": [*methane["bonds"], {"a": 0, "b": len(atoms) - 1, "order": "single", "stereo": "none"}]}
    report = sidecar.call("chem.repairGeometry", {"molecule": broken})
    assert report["status"] == "repaired"
    assert any(i["code"] == "VALENCE_EXCEEDED" for i in report["issuesFound"])
    assert report["fixesApplied"], "the valence fix is listed"
    assert all(f["fix"]["description"] and f["reason"] for f in report["fixesApplied"])
    carbons = [a for a in report["molecule"]["atoms"] if a["el"] == "C"]
    assert len(carbons) == 1
    assert report["methods"], "every stage names its method"
    assert report["geometryCheck"]["bondTable"]


@pytest.mark.parametrize(
    ("smiles", "aromatic_bonds"),
    [("c1ccccc1", 6), ("c1ccncc1", 6), ("c1cc[nH]c1", 5), ("c1ccoc1", 5), ("c1ccc2ccccc2c1", 11), ("C1=CC=CC=C1", 6)],
)
def test_aromaticity_perception(sidecar: Any, smiles: str, aromatic_bonds: int) -> None:
    molecule = sidecar.molecule(smiles)
    assert sum(1 for b in molecule["bonds"] if b["order"] == "aromatic") == aromatic_bonds


def test_cyclooctatetraene_is_not_aromatic(sidecar: Any) -> None:
    molecule = sidecar.molecule("C1=CC=CC=CC=C1")
    assert not any(b["order"] == "aromatic" for b in molecule["bonds"])


def _ring_marked_aromatic(sidecar: Any, drop_ch2_hydrogen: bool) -> dict[str, Any]:
    """Cyclopentadiene with every ring bond drawn as aromatic; optionally make all five carbons CH."""
    m = sidecar.molecule("C1=CC=CC1")
    hydrogens: dict[int, list[int]] = {}
    for b in m["bonds"]:
        for x, y in ((b["a"], b["b"]), (b["b"], b["a"])):
            if m["atoms"][x]["el"] == "C" and m["atoms"][y]["el"] == "H":
                hydrogens.setdefault(x, []).append(y)
    drop = {hydrogens[next(c for c, hs in hydrogens.items() if len(hs) == 2)][0]} if drop_ch2_hydrogen else set()
    atoms = [a for a in m["atoms"] if a["i"] not in drop]
    remap = {a["i"]: n for n, a in enumerate(atoms)}
    atoms = [{**a, "i": remap[a["i"]]} for a in atoms]
    bonds = [{**b, "a": remap[b["a"]], "b": remap[b["b"]]} for b in m["bonds"] if not drop & {b["a"], b["b"]}]
    for b in bonds:
        if atoms[b["a"]]["el"] == "C" and atoms[b["b"]]["el"] == "C":
            b["order"] = "aromatic"
    return {**m, "atoms": atoms, "bonds": bonds}


def test_impossible_aromatic_ring_is_reported(sidecar: Any) -> None:
    """Five CH carbons drawn aromatic: no Kekulé structure exists (5 π centres, odd)."""
    molecule = _ring_marked_aromatic(sidecar, drop_ch2_hydrogen=True)
    result = sidecar.call("chem.validateBonds", {"molecule": molecule, "focusAtoms": [], "focusBonds": [], "autoFix": False})
    assert result["status"] == "invalid"
    assert any(i["code"] == "AROMATIC_INVALID" for i in result["issues"])


def test_aromatic_drawing_with_a_valid_kekule_form_is_accepted(sidecar: Any) -> None:
    """Cyclopentadiene drawn with 'aromatic' bonds still has a Kekulé structure (the CH2 stays sp3)."""
    molecule = _ring_marked_aromatic(sidecar, drop_ch2_hydrogen=False)
    result = sidecar.call("chem.validateBonds", {"molecule": molecule, "focusAtoms": [], "focusBonds": [], "autoFix": False})
    assert result["status"] == "valid"
