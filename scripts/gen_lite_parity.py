#!/usr/bin/env python3
"""Record the desktop engine's answers for MoleculeForge Lite's parity tests.

Runs the desktop sidecar's own functions (validation with auto-fix, sanitisation, descriptors) on

* every prebuilt library molecule (with its automatic category),
* hand-written editing scenarios (valence, aromaticity, charges, radicals, clean-up groups, ...),
* seeded random small structures that stress the valence rules,

and writes tests/fixtures/lite-parity.json. tests/unit/lite/parity.test.ts runs the browser engine
on the same inputs and compares. Regenerate after changing either engine:

    compute/.venv/bin/python scripts/gen_lite_parity.py
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "compute"))

from mfcompute.chem import convert, descriptors, validate  # noqa: E402
from mfcompute.data.categorize import categorize  # noqa: E402
from mfcompute.models import Molecule  # noqa: E402
from mfcompute.rpc import RpcError  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "lite-parity.json"


def molecule(atoms: list[tuple[Any, ...]], bonds: list[tuple[int, int, str]], name: str = "") -> dict[str, Any]:
    out_atoms = []
    for i, spec in enumerate(atoms):
        el, x, y, z, *rest = spec
        extra = rest[0] if rest else {}
        out_atoms.append({"i": i, "el": el, "x": x, "y": y, "z": z, "charge": extra.get("charge", 0),
                          "isotope": extra.get("isotope"), "hCount": extra.get("hCount")})
    return {"id": f"case-{name or 'x'}", "name": name, "formula": "", "atoms": out_atoms,
            "bonds": [{"a": a, "b": b, "order": o, "stereo": "none"} for a, b, o in bonds],
            "props": {}, "meta": {"smiles": "", "inchi": "", "inchikey": "", "category": "", "source": "user",
                                  "created": "2026-01-01T00:00:00+00:00", "stereo": ""}}


def ring(elements: list[str], radius: float = 1.2) -> list[tuple[Any, ...]]:
    import math
    n = len(elements)
    return [(el, round(radius * math.cos(2 * math.pi * i / n), 4), round(radius * math.sin(2 * math.pi * i / n), 4), 0.0)
            for i, el in enumerate(elements)]


def scenarios() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    def add(name: str, atoms: list[tuple[Any, ...]], bonds: list[tuple[int, int, str]], focus: list[int] | None = None) -> None:
        cases.append({"name": name, "molecule": molecule(atoms, bonds, name), "focusBonds": focus or []})

    add("water", [("O", 0, 0, 0), ("H", 0.96, 0, 0), ("H", -0.24, 0.93, 0)], [(0, 1, "single"), (0, 2, "single")], [1])
    add("pentavalent-carbon", [("C", 0, 0, 0), ("C", 1.5, 0, 0), ("C", -1.5, 0, 0), ("C", 0, 1.5, 0), ("C", 0, -1.5, 0), ("C", 0, 0, 1.5)],
        [(0, 1, "single"), (0, 2, "single"), (0, 3, "single"), (0, 4, "single"), (0, 5, "single")], [4])
    add("tetravalent-nitrogen", [("N", 0, 0, 0), ("C", 1.47, 0, 0), ("C", -1.47, 0, 0), ("C", 0, 1.47, 0), ("C", 0, -1.47, 0)],
        [(0, 1, "single"), (0, 2, "single"), (0, 3, "single"), (0, 4, "single")], [3])
    add("boron-four", [("B", 0, 0, 0), ("F", 1.4, 0, 0), ("F", -1.4, 0, 0), ("F", 0, 1.4, 0), ("F", 0, -1.4, 0)],
        [(0, 1, "single"), (0, 2, "single"), (0, 3, "single"), (0, 4, "single")], [3])
    add("double-to-triple", [("C", 0, 0, 0), ("O", 1.2, 0, 0)], [(0, 1, "triple")], [0])
    add("trivalent-oxygen", [("O", 0, 0, 0), ("C", 1.43, 0, 0), ("C", -1.43, 0, 0), ("C", 0, 1.43, 0)],
        [(0, 1, "single"), (0, 2, "single"), (0, 3, "single")], [2])
    add("pyrrole-no-h", ring(["N", "C", "C", "C", "C"]), [(0, 1, "aromatic"), (1, 2, "aromatic"), (2, 3, "aromatic"), (3, 4, "aromatic"), (4, 0, "aromatic")])
    add("benzene-aromatic", ring(["C"] * 6, 1.39), [(i, (i + 1) % 6, "aromatic") for i in range(6)])
    add("cyclopentadiene-aromatic", ring(["C"] * 5), [(i, (i + 1) % 5, "aromatic") for i in range(5)])
    add("pyridine", ring(["N", "C", "C", "C", "C", "C"], 1.39), [(i, (i + 1) % 6, "aromatic") for i in range(6)])
    add("aromatic-chain", [("C", 0, 0, 0), ("C", 1.4, 0, 0), ("C", 2.8, 0, 0)], [(0, 1, "aromatic"), (1, 2, "aromatic")])
    add("nitro-neutral", [("C", 0, 0, 0), ("N", 1.47, 0, 0), ("O", 2.1, 1.0, 0), ("O", 2.1, -1.0, 0)],
        [(0, 1, "single"), (1, 2, "double"), (1, 3, "double")])
    add("nitro-charged", [("C", 0, 0, 0), ("N", 1.47, 0, 0, {"charge": 1}), ("O", 2.1, 1.0, 0), ("O", 2.1, -1.0, 0, {"charge": -1})],
        [(0, 1, "single"), (1, 2, "double"), (1, 3, "single")])
    add("perchlorate-neutral", [("Cl", 0, 0, 0), ("O", 1.4, 0, 0), ("O", -1.4, 0, 0), ("O", 0, 1.4, 0), ("O", 0, -1.4, 0)],
        [(0, 1, "double"), (0, 2, "double"), (0, 3, "double"), (0, 4, "single")])
    add("sulfuric-acid", [("S", 0, 0, 0), ("O", 1.43, 0, 0), ("O", -1.43, 0, 0), ("O", 0, 1.57, 0), ("O", 0, -1.57, 0)],
        [(0, 1, "double"), (0, 2, "double"), (0, 3, "single"), (0, 4, "single")])
    add("sf6", [("S", 0, 0, 0)] + [("F", *p) for p in [(1.56, 0, 0), (-1.56, 0, 0), (0, 1.56, 0), (0, -1.56, 0), (0, 0, 1.56), (0, 0, -1.56)]],
        [(0, i, "single") for i in range(1, 7)])
    add("pcl5", [("P", 0, 0, 0)] + [("Cl", *p) for p in [(2.0, 0, 0), (-2.0, 0, 0), (0, 2.0, 0), (0, -2.0, 0), (0, 0, 2.0)]],
        [(0, i, "single") for i in range(1, 6)])
    add("ammonium", [("N", 0, 0, 0, {"charge": 1})], [])
    add("hydroxide", [("O", 0, 0, 0, {"charge": -1})], [])
    add("methyl-radical", [("C", 0, 0, 0, {"hCount": 3})], [])
    add("carbene-hcount", [("C", 0, 0, 0, {"hCount": 2}), ("O", 1.43, 0, 0)], [(0, 1, "single")])
    add("isotope-bad", [("C", 0, 0, 0, {"isotope": 40}), ("O", 1.43, 0, 0)], [(0, 1, "single")])
    add("isotope-d", [("H", 0, 0, 0, {"isotope": 2}), ("O", 0.96, 0, 0)], [(0, 1, "single")])
    add("self-bond", [("C", 0, 0, 0), ("O", 1.43, 0, 0)], [(0, 1, "single"), (0, 0, "single")])
    add("duplicate-bond", [("C", 0, 0, 0), ("O", 1.43, 0, 0)], [(0, 1, "single"), (1, 0, "single")])
    add("unknown-element", [("Xx", 0, 0, 0), ("O", 1.43, 0, 0)], [(0, 1, "single")])
    add("unusual-charge", [("C", 0, 0, 0, {"charge": 3}), ("O", 1.43, 0, 0)], [(0, 1, "single")])
    add("fragments", [("C", 0, 0, 0), ("O", 5, 0, 0)], [])
    add("clash", [("C", 0, 0, 0), ("O", 1.43, 0, 0), ("C", 0.3, 0.2, 0.1)], [(0, 1, "single")])
    add("long-bond", [("C", 0, 0, 0), ("O", 3.2, 0, 0)], [(0, 1, "single")], [0])
    add("short-bond", [("C", 0, 0, 0), ("C", 0.5, 0, 0)], [(0, 1, "single")], [0])
    add("overlap", [("C", 0, 0, 0), ("O", 0.1, 0, 0)], [(0, 1, "single")], [0])
    add("excess-h", [("C", 0, 0, 0)] + [("H", *p) for p in [(1.09, 0, 0), (-1.09, 0, 0), (0, 1.09, 0), (0, -1.09, 0), (0, 0, 1.09)]],
        [(0, i, "single") for i in range(1, 6)], [4])
    add("oxygen-three-h", [("O", 0, 0, 0), ("H", 0.96, 0, 0), ("H", -0.96, 0, 0), ("H", 0, 0.96, 0)],
        [(0, 1, "single"), (0, 2, "single"), (0, 3, "single")], [2])
    add("azide-neutral", [("C", 0, 0, 0), ("N", 1.47, 0, 0), ("N", 2.7, 0, 0), ("N", 3.8, 0, 0)],
        [(0, 1, "single"), (1, 2, "double"), (2, 3, "triple")])
    add("phosphine-oxide", [("P", 0, 0, 0), ("O", 1.48, 0, 0), ("C", -1.0, 1.4, 0), ("C", -1.0, -1.4, 0), ("C", -1.0, 0, 1.4)],
        [(0, 1, "double"), (0, 2, "single"), (0, 3, "single"), (0, 4, "single")])
    add("thiophene", ring(["S", "C", "C", "C", "C"], 1.3), [(i, (i + 1) % 5, "aromatic") for i in range(5)])
    add("furan-kekule", ring(["O", "C", "C", "C", "C"], 1.2),
        [(0, 1, "single"), (1, 2, "double"), (2, 3, "single"), (3, 4, "double"), (4, 0, "single")])
    return cases


def random_cases(count: int, seed: int = 20261124) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    elements = ["C", "C", "C", "N", "N", "O", "O", "S", "P", "Cl", "F", "B", "H", "Br", "Si"]
    orders = ["single"] * 6 + ["double"] * 3 + ["triple"] + ["aromatic"]
    cases = []
    for k in range(count):
        n = rng.randint(2, 7)
        atoms: list[tuple[Any, ...]] = []
        for _i in range(n):
            extra: dict[str, Any] = {}
            roll = rng.random()
            if roll < 0.12:
                extra["charge"] = rng.choice([-1, 1])
            elif roll < 0.15:
                extra["charge"] = rng.choice([-2, 2])
            if rng.random() < 0.1:
                extra["hCount"] = rng.randint(0, 3)
            atoms.append((rng.choice(elements), round(rng.uniform(-3, 3), 3), round(rng.uniform(-3, 3), 3), round(rng.uniform(-1, 1), 3), extra))
        bonds: list[tuple[int, int, str]] = []
        seen: set[tuple[int, int]] = set()
        for i in range(1, n):
            j = rng.randrange(0, i)
            bonds.append((j, i, rng.choice(orders)))
            seen.add((j, i))
        for _ in range(rng.randint(0, 2)):
            a, b = sorted(rng.sample(range(n), 2))
            if (a, b) not in seen:
                seen.add((a, b))
                bonds.append((a, b, rng.choice(orders)))
        focus = [len(bonds) - 1] if rng.random() < 0.5 else []
        cases.append({"name": f"random-{k}", "molecule": molecule(atoms, bonds, f"random-{k}"), "focusBonds": focus})
    return cases


def run_validate(case: dict[str, Any]) -> dict[str, Any]:
    mol = Molecule.model_validate(case["molecule"])
    try:
        result = validate.validate(mol, [], case["focusBonds"], True)
    except RpcError as err:
        return {"error": {"code": err.code, "message": err.message}}
    final: Molecule = result["molecule"]
    return {
        "status": result["status"],
        "message": result["message"],
        "initialIssues": [{"code": i.code, "atoms": i.atoms, "message": i.message} for i in result["initialIssues"]],
        "issues": [{"code": i.code, "atoms": i.atoms, "message": i.message} for i in result["issues"]],
        "fixes": [{"op": f["fix"]["op"], "reason": f["reason"], "description": f["fix"]["description"]} for f in result["fixes"]],
        "atomMap": result["atomMap"],
        "formula": final.formula,
        "smiles": final.meta.smiles,
        "inchikey": final.meta.inchikey,
    }


def run_descriptors(mol: Molecule) -> dict[str, Any] | None:
    try:
        props = descriptors.compute(mol)
    except RpcError:
        return None
    keep = ("formula", "molecularWeight", "exactMass", "atomCount", "heavyAtomCount", "netCharge", "radicalElectrons", "logP",
            "molarRefractivity", "tpsa", "hBondDonors", "hBondAcceptors", "rotatableBonds", "ringCount", "aromaticRingCount",
            "fractionCsp3", "stereocenters", "gasteigerCharges", "qed")
    out = {k: props[k]["value"] for k in keep}
    out["lipinskiViolations"] = props["lipinski"]["value"]["violations"]
    out["pKa"] = [(s["groupId"], s["site"]) for s in props["pKaEstimates"]["value"]]
    return out


def main() -> int:
    library = json.loads((ROOT / "data" / "molecules" / "library.json").read_text(encoding="utf-8"))["molecules"]
    payload: dict[str, Any] = {"validation": [], "library": []}
    for case in scenarios() + random_cases(400):
        payload["validation"].append({**case, "expected": run_validate(case)})
    for entry in library:
        mol = Molecule.model_validate(entry["molecule"])
        sanitized = validate.sanitize(mol)
        payload["library"].append({
            "molecule": entry["molecule"],
            "sanitize": {"valid": sanitized["valid"], "codes": sorted({i.code for i in sanitized["issues"]}),
                         "smiles": sanitized["molecule"].meta.smiles, "inchikey": sanitized["molecule"].meta.inchikey,
                         "formula": sanitized["molecule"].formula,
                         "hybridization": [a["hybridization"] for a in sanitized["atoms"]]},
            "descriptors": run_descriptors(mol),
            "category": categorize(convert.to_rdkit(mol)),
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(payload['validation'])} validation cases, {len(payload['library'])} library molecules "
          f"({OUT.stat().st_size / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
