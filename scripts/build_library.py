#!/usr/bin/env python3
"""Build the prebuilt molecule library (spec 7.6) from data/molecules/catalog.json.

For every catalogue entry:
1. parse SMILES, assert identity (InChIKey) and stereochemistry (CIP labels) when declared;
2. run the same one-click repair pipeline users get (ETKDGv3 → MMFF94/UFF → GFN2-xTB);
3. assert the result validates with zero corrections and a second repair is a no-op;
4. store canonical JSON (spec 6.1), a CoordGen 2D layout and summary descriptors.

Outputs data/molecules/library.json and data/molecules/library.sdf.
Run from compute/:  uv run python ../scripts/build_library.py
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

from rdkit import Chem

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "compute"))

from mfcompute.chem import convert, descriptors, geometry, validate  # noqa: E402
from mfcompute.chem.depict import layout_2d, wedges  # noqa: E402
from mfcompute.data.categorize import CATEGORY_IDS  # noqa: E402
from mfcompute.jobs import JobContext  # noqa: E402

CATALOG = ROOT / "data" / "molecules" / "catalog.json"
OUT_JSON = ROOT / "data" / "molecules" / "library.json"
OUT_SDF = ROOT / "data" / "molecules" / "library.sdf"


def slug(name: str) -> str:
    return "pre-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def stereo_smiles_from_3d(molecule: object) -> str:
    """Canonical SMILES with stereo perceived from the 3D coordinates alone.

    Compared with the catalogue SMILES this catches an embedding that picked a
    stereoisomer the catalogue never named (racemic ibuprofen turning into one
    enantiomer) or flipped a named centre. InChI from 3D is not used for this
    because it reports relative /t layers for achiral cage compounds such as
    adamantane, which would be a false alarm.
    """
    rd = convert.to_rdkit(molecule)  # type: ignore[arg-type]
    Chem.AssignStereochemistryFrom3D(rd)
    # The orientation of a terminal =N-H (amidine, guanidine, imine) is fixed by any
    # 3D structure but is not part of the compound's identity (standard InChI ignores it).
    for bond in rd.GetBonds():
        if bond.GetBondType() == Chem.BondType.DOUBLE and bond.GetStereo() != Chem.BondStereo.STEREONONE:
            ends = (bond.GetBeginAtom(), bond.GetEndAtom())
            if any(sum(1 for n in atom.GetNeighbors() if n.GetAtomicNum() > 1) == 1 for atom in ends):
                bond.SetStereo(Chem.BondStereo.STEREONONE)
                for atom in ends:
                    for nb in atom.GetBonds():
                        if nb.GetBondType() == Chem.BondType.SINGLE:
                            nb.SetBondDir(Chem.BondDir.NONE)
    return Chem.MolToSmiles(Chem.RemoveHs(rd))


def relayout_only() -> int:
    """Recompute layout2d (and stereo wedges) for an existing library.json without re-optimising geometry."""
    from mfcompute.models import Molecule

    payload = json.loads(OUT_JSON.read_text(encoding="utf-8"))
    catalog = {spec["name"]: spec for spec in json.loads(CATALOG.read_text(encoding="utf-8"))["molecules"]}
    for entry in payload["molecules"]:
        rd = convert.to_rdkit(Molecule.model_validate(entry["molecule"]))
        entry["layout2d"] = layout_2d(rd)
        entry["wedges"] = wedges(rd, entry["layout2d"])
        spec = catalog.get(entry["molecule"]["name"])
        if spec is not None:  # stereo origin of the catalogue SMILES (the build guard proved 3D added none)
            entry["molecule"]["meta"]["stereo"] = convert.stereo_origin(Chem.MolFromSmiles(spec["smiles"]))
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"re-laid out {len(payload['molecules'])} molecules")
    return 0


def cip_labels(mol: Chem.Mol) -> list[str]:
    from rdkit.Chem import rdCIPLabeler

    rdCIPLabeler.AssignCIPLabels(mol)
    return [a.GetProp("_CIPCode") for a in mol.GetAtoms() if a.HasProp("_CIPCode")]


def main() -> int:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    entries, failures = [], []
    seen_keys: dict[str, str] = {}
    ctx = JobContext("library-build")
    started = time.time()
    for spec in catalog["molecules"]:
        name = spec["name"]
        try:
            if spec["category"] not in CATEGORY_IDS:
                raise ValueError(f"unknown category {spec['category']}")
            mol2d = Chem.MolFromSmiles(spec["smiles"])
            if mol2d is None:
                raise ValueError("unparseable SMILES")
            labels = cip_labels(Chem.Mol(mol2d))
            if "cip" in spec and sorted(labels) != sorted(spec["cip"]):
                raise ValueError(f"CIP labels {labels} != expected {spec['cip']}")
            if "cipCounts" in spec and {k: labels.count(k) for k in spec["cipCounts"]} != spec["cipCounts"]:
                raise ValueError(f"CIP labels {labels} != expected counts {spec['cipCounts']}")
            molecule = convert.parse("smiles", spec["smiles"], name=name)[0]
            key = molecule.meta.inchikey
            if "inchikey" in spec and key != spec["inchikey"]:
                raise ValueError(f"InChIKey {key} != expected {spec['inchikey']}")
            if "inchikeyPrefix" in spec and not key.startswith(spec["inchikeyPrefix"]):
                raise ValueError(f"InChIKey {key} lacks prefix {spec['inchikeyPrefix']}")
            # 3D embedding must not silently choose (or flip) a stereoisomer the catalogue did not name.
            if len(molecule.atoms) > 1:
                expected, got = Chem.MolToSmiles(mol2d), stereo_smiles_from_3d(molecule)
                if got != expected:
                    raise ValueError(f"3D stereochemistry {got} differs from catalogue {expected}; name the stereoisomer")
            if key in seen_keys:
                raise ValueError(f"duplicate of {seen_keys[key]}")
            seen_keys[key] = name
            if len(molecule.atoms) > 1:
                report = geometry.repair(molecule, refine="auto", force_field="auto", ctx=ctx)
                if report["status"] == "failed":
                    raise ValueError(f"repair failed: {report.get('reason')}")
                molecule = report["molecule"]
                check = validate.validate(molecule, [], [], True)
                if check["fixes"] or check["status"] != "valid":
                    raise ValueError(f"prebuilt geometry needed corrections: {check['fixes'] or check['message']}")
                rerun = geometry.repair(molecule, refine="auto", force_field="auto", ctx=ctx)
                if rerun["status"] != "already-optimal":
                    raise ValueError(f"repair not idempotent (rmsd={rerun['rmsd']})")
                clashes = rerun["geometryCheck"]["minNonBondedDistance"]["value"]
                if clashes is not None and clashes < 0.7:
                    raise ValueError(f"clash {clashes} Å")
            mol_id = slug(name)
            meta = molecule.meta.model_copy(update={"category": spec["category"], "source": "prebuilt",
                                                    "created": catalog["version"]})
            molecule = molecule.model_copy(update={"id": mol_id, "name": name, "meta": meta})
            rd = convert.to_rdkit(molecule)
            layout = layout_2d(rd)
            props = descriptors.compute_rdkit(rd)
            summary = {k: props[k]["value"] for k in ("molecularWeight", "exactMass", "logP", "tpsa", "hBondDonors",
                                                      "hBondAcceptors", "rotatableBonds", "qed")}
            entries.append({"molecule": molecule.model_dump(mode="json"), "layout2d": layout, "wedges": wedges(rd, layout),
                            "tags": spec.get("tags", []), "descriptors": summary})
            print(f"  ok  {name:32} {molecule.formula:12} {spec['category']}")
        except Exception as exc:
            failures.append({"name": name, "error": str(exc)})
            print(f"  FAIL {name}: {exc}")
    payload = {"version": catalog["version"], "count": len(entries), "molecules": entries}
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    from mfcompute.models import Molecule

    OUT_SDF.write_text(convert.write("sdf", [Molecule.model_validate(e["molecule"]) for e in entries]), encoding="utf-8")
    print(f"\n{len(entries)} molecules written in {time.time() - started:.0f}s; {len(failures)} failures")
    for failure in failures:
        print("   ", failure)
    return 1 if failures or len(entries) < 100 else 0


if __name__ == "__main__":
    sys.exit(relayout_only() if "--layout-only" in sys.argv[1:] else main())
