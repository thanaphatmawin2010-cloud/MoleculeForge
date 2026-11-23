"""§8 scientific validation reference set, asserted through the real sidecar (as the app runs it).

Each molecule goes SMILES → chem.convertFormat → chem.repairGeometry (GFN2-xTB refinement) →
sim.properties (standard level: B3LYP/def2-SVPD dipole for small molecules). Tolerances are
the specification's: bond lengths ±0.03 Å, angles ±2°, molecular weight exact to 2 decimals,
dipole moments ±0.3 D (exactly symmetric molecules: |μ| < 0.05 D).
"""

from __future__ import annotations

import itertools
import math
from typing import Any

import numpy as np
import pytest

BOND_TOL = 0.03
ANGLE_TOL = 2.0
DIPOLE_TOL = 0.3

# name: (smiles, MW, dipole D or None, bonds {(el1, el2, order): Å}, angles {(el1, centre, el2): deg})
REFERENCE: dict[str, tuple[str, float, float | None, dict[tuple[str, str, str], float], dict[tuple[str, str, str], float]]] = {
    "water": ("O", 18.015, 1.85, {("H", "O", "single"): 0.958}, {("H", "O", "H"): 104.5}),
    "methane": ("C", 16.043, 0.0, {("C", "H", "single"): 1.087}, {("H", "C", "H"): 109.47}),
    "ammonia": ("N", 17.031, 1.47, {("H", "N", "single"): 1.012}, {("H", "N", "H"): 106.7}),
    "benzene": ("c1ccccc1", 78.11, 0.0, {("C", "C", "aromatic"): 1.39, ("C", "H", "single"): 1.09},
                {("C", "C", "C"): 120.0, ("C", "C", "H"): 120.0}),
    "carbon dioxide": ("O=C=O", 44.009, 0.0, {("C", "O", "double"): 1.16}, {("O", "C", "O"): 180.0}),
    "ethene": ("C=C", 28.054, 0.0, {("C", "C", "double"): 1.33}, {}),
    "ethyne": ("C#C", 26.038, 0.0, {("C", "C", "triple"): 1.20}, {("C", "C", "H"): 180.0}),
    "ethane": ("CC", 30.070, 0.0, {("C", "C", "single"): 1.54}, {}),
}


def _geometry(molecule: dict[str, Any]) -> tuple[dict[int, np.ndarray], dict[int, str], list[dict[str, Any]]]:
    pos = {a["i"]: np.array([a["x"], a["y"], a["z"]]) for a in molecule["atoms"]}
    el = {a["i"]: a["el"] for a in molecule["atoms"]}
    return pos, el, molecule["bonds"]


def _bond_lengths(molecule: dict[str, Any], key: tuple[str, str, str]) -> list[float]:
    pos, el, bonds = _geometry(molecule)
    want = (sorted(key[:2]), key[2])
    return [float(np.linalg.norm(pos[b["a"]] - pos[b["b"]])) for b in bonds if (sorted((el[b["a"]], el[b["b"]])), b["order"]) == want]


def _angles(molecule: dict[str, Any], key: tuple[str, str, str]) -> list[float]:
    pos, el, bonds = _geometry(molecule)
    neighbours: dict[int, list[int]] = {i: [] for i in pos}
    for b in bonds:
        neighbours[b["a"]].append(b["b"])
        neighbours[b["b"]].append(b["a"])
    out = []
    for centre, ns in neighbours.items():
        if el[centre] != key[1]:
            continue
        for i, j in itertools.combinations(ns, 2):
            if sorted((el[i], el[j])) != sorted((key[0], key[2])):
                continue
            u, v = pos[i] - pos[centre], pos[j] - pos[centre]
            out.append(math.degrees(math.acos(np.clip(u @ v / (np.linalg.norm(u) * np.linalg.norm(v)), -1.0, 1.0))))
    return out


def _planarity(molecule: dict[str, Any]) -> float:
    """Largest distance of any atom from the best-fit plane (Å)."""
    pts = np.array([[a["x"], a["y"], a["z"]] for a in molecule["atoms"]])
    centred = pts - pts.mean(axis=0)
    normal = np.linalg.svd(centred)[2][-1]
    return float(np.max(np.abs(centred @ normal)))


@pytest.fixture(scope="module")
def results(sidecar: Any) -> dict[str, dict[str, Any]]:
    out = {}
    for name, (smiles, *_rest) in REFERENCE.items():
        molecule = sidecar.molecule(smiles, name)
        repaired = sidecar.call("chem.repairGeometry", {"molecule": molecule})
        props = sidecar.call("sim.properties", {"molecule": repaired["molecule"], "level": "standard"})
        out[name] = {"repair": repaired, "props": props}
    return out


@pytest.mark.parametrize("name", list(REFERENCE))
def test_molecular_weight(results: dict[str, Any], name: str) -> None:
    mw = results[name]["props"]["properties"]["molecularWeight"]
    assert mw["unit"] == "g/mol" and mw["method"]
    assert round(mw["value"], 2) == round(REFERENCE[name][1], 2)


@pytest.mark.parametrize("name", list(REFERENCE))
def test_bond_lengths(results: dict[str, Any], name: str) -> None:
    molecule = results[name]["repair"]["molecule"]
    for key, expected in REFERENCE[name][3].items():
        lengths = _bond_lengths(molecule, key)
        assert lengths, f"no {key} bonds in {name}"
        for d in lengths:
            assert abs(d - expected) <= BOND_TOL, f"{name} {key}: {d:.4f} Å vs {expected} ± {BOND_TOL}"


@pytest.mark.parametrize("name", [n for n in REFERENCE if REFERENCE[n][4]])
def test_bond_angles(results: dict[str, Any], name: str) -> None:
    molecule = results[name]["repair"]["molecule"]
    for key, expected in REFERENCE[name][4].items():
        angles = _angles(molecule, key)
        assert angles, f"no {key} angles in {name}"
        for a in angles:
            assert abs(a - expected) <= ANGLE_TOL, f"{name} {key}: {a:.2f}° vs {expected} ± {ANGLE_TOL}"


@pytest.mark.parametrize("name", list(REFERENCE))
def test_dipole_moment(results: dict[str, Any], name: str) -> None:
    dipole = results[name]["props"]["properties"]["dipoleMoment"]
    assert dipole["unit"] == "D" and dipole["method"]
    expected = REFERENCE[name][2]
    if expected == 0.0:
        assert dipole["value"] < 0.05, f"{name} should be non-polar, got {dipole['value']} D"
    else:
        assert abs(dipole["value"] - expected) <= DIPOLE_TOL, f"{name}: {dipole['value']} D vs {expected} ± {DIPOLE_TOL}"
        assert "B3LYP" in dipole["method"], "small polar molecules use the DFT dipole"


@pytest.mark.parametrize("name", ["benzene", "ethene", "water", "carbon dioxide", "ethyne"])
def test_planar_molecules_are_planar(results: dict[str, Any], name: str) -> None:
    assert _planarity(results[name]["repair"]["molecule"]) < 0.02


def test_methane_is_tetrahedral_and_ammonia_pyramidal(results: dict[str, Any]) -> None:
    assert _planarity(results["ammonia"]["repair"]["molecule"]) > 0.2
    angles = _angles(results["methane"]["repair"]["molecule"], ("H", "C", "H"))
    assert len(angles) == 6 and max(angles) - min(angles) < 0.5


def test_benzene_is_aromatic(sidecar: Any) -> None:
    benzene = sidecar.molecule("c1ccccc1", "benzene")
    assert sum(1 for b in benzene["bonds"] if b["order"] == "aromatic") == 6
    kekule = sidecar.molecule("C1=CC=CC=C1", "benzene (Kekulé input)")
    assert sum(1 for b in kekule["bonds"] if b["order"] == "aromatic") == 6, "Kekulé input is perceived aromatic"
    descriptors = sidecar.call("chem.descriptors", {"molecule": benzene})["properties"]
    assert descriptors["aromaticRingCount"]["value"] == 1


@pytest.mark.parametrize(("smiles", "mw", "donors", "acceptors"), [("CO", 32.042, 1, 1), ("CCO", 46.069, 1, 1)])
def test_alcohols(sidecar: Any, smiles: str, mw: float, donors: int, acceptors: int) -> None:
    props = sidecar.call("chem.descriptors", {"molecule": sidecar.molecule(smiles)})["properties"]
    assert round(props["molecularWeight"]["value"], 2) == round(mw, 2)
    assert props["hBondDonors"]["value"] == donors
    assert props["hBondAcceptors"]["value"] == acceptors


def test_methanol_is_polar(sidecar: Any) -> None:
    repaired = sidecar.call("chem.repairGeometry", {"molecule": sidecar.molecule("CO", "methanol")})
    dipole = sidecar.call("sim.properties", {"molecule": repaired["molecule"], "level": "standard"})["properties"]["dipoleMoment"]
    assert 1.3 <= dipole["value"] <= 2.0, dipole  # experiment 1.70 D


def test_ethanol_logp(sidecar: Any) -> None:
    logp = sidecar.call("chem.descriptors", {"molecule": sidecar.molecule("CCO")})["properties"]["logP"]
    assert abs(logp["value"] - (-0.14)) <= 0.3, logp  # Crippen estimate vs ~-0.14 (experiment -0.31)
    assert "Crippen" in logp["method"]


def test_lipinski_caffeine_passes_large_peptide_fails(sidecar: Any) -> None:
    caffeine = sidecar.call("chem.descriptors", {"molecule": sidecar.molecule("Cn1cnc2c1c(=O)n(C)c(=O)n2C", "caffeine")})
    assert caffeine["properties"]["lipinski"]["value"]["passes"] is True
    # Leuprolide-sized oligopeptide (deca-alanine): MW > 500, many donors/acceptors.
    peptide = sidecar.molecule("C[C@H](N)C(=O)" + "N[C@@H](C)C(=O)" * 8 + "N[C@@H](C)C(=O)O", "deca-alanine")
    result = sidecar.call("chem.descriptors", {"molecule": peptide})["properties"]["lipinski"]["value"]
    assert result["passes"] is False and result["violations"] >= 2


def test_results_are_reproducible(sidecar: Any) -> None:
    """Same input → identical geometry and energy (fixed seeds, deterministic engines)."""
    first = sidecar.call("chem.repairGeometry", {"molecule": sidecar.molecule("CCO", "ethanol")})
    second = sidecar.call("chem.repairGeometry", {"molecule": sidecar.molecule("CCO", "ethanol")})
    assert first["residualEnergy"]["value"] == pytest.approx(second["residualEnergy"]["value"], abs=1e-6)
    a = np.array([[p["x"], p["y"], p["z"]] for p in first["molecule"]["atoms"]])
    b = np.array([[p["x"], p["y"], p["z"]] for p in second["molecule"]["atoms"]])
    assert np.max(np.abs(a - b)) < 1e-4
