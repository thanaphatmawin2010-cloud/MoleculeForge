#!/usr/bin/env python3
"""Generate docs/VALIDATION_REPORT.md from the real compute sidecar (spec §8 / §13 D6).

Every number in the report is computed here, through the same JSON-RPC calls the desktop app
makes: SMILES → chem.convertFormat → chem.repairGeometry → sim.properties (standard level).
Each molecule is computed twice in fresh processes to demonstrate reproducibility.

    compute/.venv/bin/python scripts/validation_report.py
"""

from __future__ import annotations

import itertools
import math
import platform
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from conftest import Sidecar  # noqa: E402

BOND_TOL, ANGLE_TOL, DIPOLE_TOL = 0.03, 2.0, 0.3
# name, SMILES, MW, dipole (D), bonds {(a, b, order): Å}, angles {(a, centre, b): °}
REFERENCE = [
    ("Water", "O", 18.015, 1.85, {("H", "O", "single"): 0.958}, {("H", "O", "H"): 104.5}),
    ("Methane", "C", 16.043, 0.0, {("C", "H", "single"): 1.087}, {("H", "C", "H"): 109.47}),
    ("Ammonia", "N", 17.031, 1.47, {("H", "N", "single"): 1.012}, {("H", "N", "H"): 106.7}),
    ("Benzene", "c1ccccc1", 78.11, 0.0, {("C", "C", "aromatic"): 1.39, ("C", "H", "single"): 1.09},
     {("C", "C", "C"): 120.0, ("C", "C", "H"): 120.0}),
    ("Carbon dioxide", "O=C=O", 44.009, 0.0, {("C", "O", "double"): 1.16}, {("O", "C", "O"): 180.0}),
    ("Ethene", "C=C", 28.054, 0.0, {("C", "C", "double"): 1.33}, {}),
    ("Ethyne", "C#C", 26.038, 0.0, {("C", "C", "triple"): 1.20}, {("C", "C", "H"): 180.0}),
    ("Ethane", "CC", 30.070, 0.0, {("C", "C", "single"): 1.54}, {}),
    ("Methanol", "CO", 32.042, None, {}, {}),
    ("Ethanol", "CCO", 46.069, None, {}, {}),
]


def measure(molecule: dict[str, Any]) -> tuple[dict[tuple[str, str, str], list[float]], dict[tuple[str, str, str], list[float]]]:
    pos = {a["i"]: np.array([a["x"], a["y"], a["z"]]) for a in molecule["atoms"]}
    el = {a["i"]: a["el"] for a in molecule["atoms"]}
    bonds: dict[tuple[str, str, str], list[float]] = {}
    nb: dict[int, list[int]] = {i: [] for i in pos}
    for b in molecule["bonds"]:
        a1, a2 = sorted((el[b["a"]], el[b["b"]]))
        bonds.setdefault((a1, a2, b["order"]), []).append(float(np.linalg.norm(pos[b["a"]] - pos[b["b"]])))
        nb[b["a"]].append(b["b"])
        nb[b["b"]].append(b["a"])
    angles: dict[tuple[str, str, str], list[float]] = {}
    for c, ns in nb.items():
        for i, j in itertools.combinations(ns, 2):
            x, y = sorted((el[i], el[j]))
            u, v = pos[i] - pos[c], pos[j] - pos[c]
            angles.setdefault((x, el[c], y), []).append(
                math.degrees(math.acos(np.clip(u @ v / (np.linalg.norm(u) * np.linalg.norm(v)), -1, 1))))
    return bonds, angles


def run_once() -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp:
        client = Sidecar(Path(tmp))
        try:
            caps = client.call("system.capabilities", {})
            out: dict[str, Any] = {"caps": caps}
            for name, smiles, *_ in REFERENCE:
                started = time.perf_counter()
                molecule = client.molecule(smiles, name)
                repair = client.call("chem.repairGeometry", {"molecule": molecule})
                props = client.call("sim.properties", {"molecule": repair["molecule"], "level": "standard", "include": ["nocache"]})
                desc = client.call("chem.descriptors", {"molecule": repair["molecule"]})["properties"]
                out[name] = {"repair": repair, "props": props["properties"], "desc": desc, "seconds": time.perf_counter() - started}
            caffeine = client.call("chem.descriptors", {"molecule": client.molecule("Cn1cnc2c1c(=O)n(C)c(=O)n2C")})["properties"]
            peptide = client.call("chem.descriptors", {"molecule": client.molecule(
                "C[C@H](N)C(=O)" + "N[C@@H](C)C(=O)" * 8 + "N[C@@H](C)C(=O)O")})["properties"]
            out["lipinski"] = {"caffeine": caffeine["lipinski"]["value"], "deca-alanine": peptide["lipinski"]["value"]}
            benzene = client.molecule("C1=CC=CC=C1")
            out["aromatic"] = sum(1 for b in benzene["bonds"] if b["order"] == "aromatic")
            return out
        finally:
            client.close()


def geometry_method(repair: dict[str, Any]) -> str:
    """Name the geometry that was actually reported. A structure already at the refined minimum
    (within the idempotency thresholds) keeps its input coordinates, which come from SMILES
    conversion (ETKDGv3 + MMFF94s); otherwise the refinement method produced them."""
    refined = repair["residualEnergy"]["method"].replace(" total energy", "")
    if repair["status"] == "already-optimal":
        return f"MMFF94s input geometry; {refined}: already optimal"
    return f"{refined} geometry"


def fmt(v: float | None, d: int = 3) -> str:
    return "—" if v is None else f"{v:.{d}f}"


def main() -> int:
    first, second = run_once(), run_once()
    rows, failures = [], 0

    def check(ok: bool) -> str:
        nonlocal failures
        failures += 0 if ok else 1
        return "✅" if ok else "❌"

    for name, _smiles, mw_ref, dip_ref, bond_ref, angle_ref in REFERENCE:
        r = first[name]
        bonds, angles = measure(r["repair"]["molecule"])
        mw = r["desc"]["molecularWeight"]["value"]
        rows.append(f"| **{name}** | Molecular weight | {mw_ref:.3f} g/mol | {mw:.3f} g/mol | exact to 0.01 | {r['desc']['molecularWeight']['method']} | {check(round(mw, 2) == round(mw_ref, 2))} |")
        for key, ref in bond_ref.items():
            vals = bonds.get(key, [])
            worst = max(vals, key=lambda v: abs(v - ref)) if vals else float("nan")
            label = f"{key[0]}–{key[1]} ({key[2]})"
            rows.append(f"| | Bond {label} | {ref:.3f} Å | {worst:.4f} Å | ±{BOND_TOL} Å | {geometry_method(r['repair'])} | {check(bool(vals) and abs(worst - ref) <= BOND_TOL)} |")
        for key, ref in angle_ref.items():
            vals = angles.get((min(key[0], key[2]), key[1], max(key[0], key[2])), [])
            worst = max(vals, key=lambda v: abs(v - ref)) if vals else float("nan")
            rows.append(f"| | Angle {key[0]}–{key[1]}–{key[2]} | {ref:.2f}° | {worst:.2f}° | ±{ANGLE_TOL}° | {geometry_method(r['repair'])} | {check(bool(vals) and abs(worst - ref) <= ANGLE_TOL)} |")
        dip = r["props"].get("dipoleMoment")
        if dip_ref is not None and dip:
            ok = dip["value"] < 0.05 if dip_ref == 0 else abs(dip["value"] - dip_ref) <= DIPOLE_TOL
            ref_text = "0 (symmetric)" if dip_ref == 0 else f"{dip_ref:.2f} D"
            tol = "< 0.05 D" if dip_ref == 0 else f"±{DIPOLE_TOL} D"
            rows.append(f"| | Dipole moment | {ref_text} | {dip['value']:.3f} D | {tol} | {dip['method']} | {check(ok)} |")
        if name in ("Methanol", "Ethanol"):
            d = r["desc"]
            rows.append(f"| | H-bond donors / acceptors | 1 / 1 | {d['hBondDonors']['value']} / {d['hBondAcceptors']['value']} | exact | {d['hBondDonors']['method']} | {check(d['hBondDonors']['value'] == 1 and d['hBondAcceptors']['value'] == 1)} |")
            if dip:
                rows.append(f"| | Dipole moment (polar) | > 1 D (exp. {'1.70' if name == 'Methanol' else '1.69'} D) | {dip['value']:.3f} D | polar | {dip['method']} | {check(dip['value'] > 1.0)} |")
        if name == "Ethanol":
            logp = r["desc"]["logP"]
            rows.append(f"| | logP | ≈ −0.14 | {logp['value']:.3f} | ±0.3 | {logp['method']} | {check(abs(logp['value'] + 0.14) <= 0.3)} |")
    lip = first["lipinski"]
    rows.append(f"| **Caffeine** | Lipinski rule of five | passes | {'passes' if lip['caffeine']['passes'] else 'fails'} ({lip['caffeine']['violations']} violations) | — | RDKit descriptors | {check(lip['caffeine']['passes'])} |")
    rows.append(f"| **Deca-alanine** | Lipinski rule of five | fails | {'passes' if lip['deca-alanine']['passes'] else 'fails'} ({lip['deca-alanine']['violations']} violations) | — | RDKit descriptors | {check(not lip['deca-alanine']['passes'])} |")
    rows.append(f"| **Benzene** (Kekulé input) | Aromaticity perceived | 6 aromatic bonds | {first['aromatic']} aromatic bonds | exact | RDKit aromaticity model | {check(first['aromatic'] == 6)} |")

    # Reproducibility: two fresh processes must agree.
    max_dev, max_de = 0.0, 0.0
    for name, *_ in REFERENCE:
        a = np.array([[p["x"], p["y"], p["z"]] for p in first[name]["repair"]["molecule"]["atoms"]])
        b = np.array([[p["x"], p["y"], p["z"]] for p in second[name]["repair"]["molecule"]["atoms"]])
        max_dev = max(max_dev, float(np.max(np.abs(a - b))))
        ea, eb = first[name]["repair"]["residualEnergy"]["value"], second[name]["repair"]["residualEnergy"]["value"]
        if ea is not None and eb is not None:
            max_de = max(max_de, abs(ea - eb))
    reproducible = max_dev < 1e-4 and max_de < 1e-6
    failures += 0 if reproducible else 1
    caps = first["caps"]
    lines = [
        "# Validation report",
        "",
        "Generated by `scripts/validation_report.py` on the real compute sidecar, using exactly the calls the app",
        "makes: SMILES → `chem.convertFormat` → `chem.repairGeometry` (one-click repair) → `sim.properties`",
        "(standard level) and `chem.descriptors`. Reference values and tolerances are those of the specification",
        "(§8): bond lengths ±0.03 Å, angles ±2°, molecular weight exact to two decimals, dipole moments ±0.3 D.",
        "",
        f"**Result: {'all checks pass' if failures == 0 else f'{failures} check(s) failed'}.** "
        f"Reproducibility: two independent runs in fresh processes differ by at most {max_dev:.1e} Å in any coordinate "
        f"and {max_de:.1e} Eh in energy ({'✅' if reproducible else '❌'}).",
        "",
        "| Molecule | Quantity | Reference | MoleculeForge | Tolerance | Method | |",
        "|---|---|---|---|---|---|---|",
        *rows,
        "",
        "## Methods",
        "",
        "* **Geometry.** Repair embeds with RDKit ETKDGv3 (seed 0x5EED) when needed, minimises with MMFF94, then refines:",
        "  hydrides of a single heavy atom (H₂O, NH₃, CH₄) with B3LYP/def2-SVP (PySCF, PyBerny optimiser), larger",
        "  molecules with GFN2-xTB (xtb 6.8.0, tight convergence). A structure already within 0.005 Å RMSD or",
        "  0.05 kcal/mol of the refined minimum is reported as already optimal and returned unchanged; SMILES input",
        "  arrives with an ETKDGv3 + MMFF94s geometry, and the table says where that geometry was kept.",
        "* **Dipole moments.** B3LYP/def2-SVPD single point (PySCF) at the GFN2-xTB geometry of the property battery.",
        "* **Molecular weight, H-bond donors/acceptors, logP, Lipinski.** RDKit (IUPAC standard atomic weights,",
        "  Lipinski definitions, Wildman–Crippen logP).",
        "",
        "## Environment",
        "",
        f"* MoleculeForge compute {caps['app']['computeVersion']} on {platform.system()} {platform.machine()},"
        f" {caps['cpu'].get('physicalCores')} physical cores; engines: "
        + ", ".join(f"{label} {caps['engines'][key]['version']}" for key, label in (("xtb", "xtb"), ("mopac", "MOPAC"), ("vina", "AutoDock Vina"))
                    if caps["engines"].get(key, {}).get("available"))
        + f"; PySCF {caps['engines']['libraries'].get('pyscf', 'unavailable')}; OpenMM {caps['engines']['libraries'].get('openmm')}; "
        + f"RDKit {caps['engines']['libraries'].get('rdkit')}",
        "* Wall time per molecule (repair + standard properties): "
        + ", ".join(f"{name} {first[name]['seconds']:.1f} s" for name, *_ in REFERENCE),
        "",
    ]
    out = ROOT / "docs" / "VALIDATION_REPORT.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}: {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
