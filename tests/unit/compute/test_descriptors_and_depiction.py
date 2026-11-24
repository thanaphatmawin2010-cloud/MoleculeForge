"""§9.1 descriptor math, 2D depiction (finite layouts, stereo wedges) and report rendering."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from rdkit import Chem

from mfcompute.chem import convert, descriptors, report
from mfcompute.models import LibrarySaveParams, Molecule, WedgesParams

ROOT = Path(__file__).resolve().parents[3]
LIBRARY = json.loads((ROOT / "data" / "molecules" / "library.json").read_text(encoding="utf-8"))["molecules"]
ELEMENTS = {e["symbol"]: e["atomicMass"]["value"] for e in json.loads((ROOT / "data" / "elements.json").read_text())["elements"]}


@pytest.mark.parametrize("smiles", ["O", "CCO", "c1ccccc1", "Cn1cnc2c1c(=O)n(C)c(=O)n2C", "OC(=O)CC(O)(CC(=O)O)C(=O)O"])
def test_molecular_weight_is_the_sum_of_standard_atomic_weights(smiles: str) -> None:
    mol = Chem.AddHs(Chem.MolFromSmiles(smiles))
    expected = sum(ELEMENTS[a.GetSymbol()] for a in mol.GetAtoms())
    props = descriptors.compute_rdkit(mol)
    assert props["molecularWeight"]["value"] == pytest.approx(expected, abs=0.01)
    assert props["molecularWeight"]["unit"] == "g/mol"


def test_every_descriptor_has_unit_key_and_method() -> None:
    props = descriptors.compute_rdkit(Chem.AddHs(Chem.MolFromSmiles("CC(=O)Oc1ccccc1C(=O)O")))
    for name, pv in props.items():
        assert "value" in pv and "unit" in pv and pv["method"], name


def test_formula_and_counts() -> None:
    props = descriptors.compute_rdkit(Chem.AddHs(Chem.MolFromSmiles("CC(=O)Oc1ccccc1C(=O)O")))
    assert props["formula"]["value"] == "C9H8O4"
    assert props["hBondDonors"]["value"] == 1 and props["hBondAcceptors"]["value"] == 4  # PubChem: 1 donor, 4 acceptors
    assert props["aromaticRingCount"]["value"] == 1


def test_library_layouts_are_finite_and_complete() -> None:
    for entry in LIBRARY:
        layout = entry["layout2d"]
        assert len(layout) == len(entry["molecule"]["atoms"]), entry["molecule"]["name"]
        assert all(abs(v) < 1e4 for xy in layout for v in xy), entry["molecule"]["name"]


def test_library_wedges_reproduce_every_stereocentre() -> None:
    """Reading the stored 2D layout + wedges with implicit hydrogens gives back the 3D CIP labels."""
    checked = 0
    for entry in LIBRARY:
        if not entry.get("wedges"):
            continue
        rd = convert.to_rdkit(Molecule.model_validate(entry["molecule"]))
        reference = Chem.Mol(rd)
        Chem.AssignStereochemistryFrom3D(reference)
        cip3d = {a.GetIdx(): a.GetProp("_CIPCode") for a in reference.GetAtoms() if a.HasProp("_CIPCode")}
        rw = Chem.RWMol()
        for atom in rd.GetAtoms():
            new = Chem.Atom(atom.GetAtomicNum())
            new.SetFormalCharge(atom.GetFormalCharge())
            new.SetNoImplicit(True)
            rw.AddAtom(new)
        wedges = {w["bond"]: w for w in entry["wedges"]}
        for bond in rd.GetBonds():
            i, j = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
            if bond.GetIdx() in wedges and wedges[bond.GetIdx()]["from"] == j:
                i, j = j, i
            rw.AddBond(i, j, bond.GetBondType())
            if bond.GetIdx() in wedges:
                rw.GetBondBetweenAtoms(i, j).SetBondDir(
                    Chem.BondDir.BEGINWEDGE if wedges[bond.GetIdx()]["kind"] == "wedge" else Chem.BondDir.BEGINDASH)
        conf = Chem.Conformer(rd.GetNumAtoms())
        for i, (x, y) in enumerate(entry["layout2d"]):
            conf.SetAtomPosition(i, (x, y, 0.0))
        conf.Set3D(False)
        rw.AddConformer(conf)
        flat = rw.GetMol()
        Chem.SanitizeMol(flat, catchErrors=True)
        heavy = [a.GetIdx() for a in flat.GetAtoms() if a.GetAtomicNum() != 1]
        skeletal = Chem.RemoveHs(flat)
        Chem.AssignChiralTypesFromBondDirs(skeletal)
        Chem.AssignStereochemistry(skeletal, cleanIt=True, force=True)
        cip2d = {heavy[a.GetIdx()]: a.GetProp("_CIPCode") for a in skeletal.GetAtoms() if a.HasProp("_CIPCode")}
        assert cip2d == cip3d, entry["molecule"]["name"]
        checked += 1
    assert checked >= 25


def test_achiral_cage_gets_no_wedges() -> None:
    adamantane = next(e for e in LIBRARY if e["molecule"]["name"] == "Adamantane")
    assert not adamantane.get("wedges")


def test_stereo_origin_classification() -> None:
    assert convert.parse("smiles", "C[C@H](N)C(=O)O")[0].meta.stereo == "defined"
    assert convert.parse("smiles", "CC(N)C(=O)O")[0].meta.stereo == "partial"
    assert convert.parse("smiles", "CCO")[0].meta.stereo == "none"


def test_wedge_params_are_validated() -> None:
    mol = convert.parse("smiles", "CCO")[0]
    with pytest.raises(ValueError):
        WedgesParams(molecule=mol, layout2d=[(0.0, 0.0)])
    with pytest.raises(ValueError):
        LibrarySaveParams(molecule=mol, wedges=[{"bond": 99, "kind": "wedge", "from": 0}])


def test_report_exports_markdown_and_pdf() -> None:
    from mfcompute.chem import geometry
    from mfcompute.jobs import JobContext

    rep = geometry.repair(convert.parse("smiles", "CC(=O)O", name="acetic acid")[0], refine="auto", force_field="auto", ctx=JobContext("r"))
    data = json.loads(json.dumps(rep, default=lambda o: o.model_dump(mode="json")))
    md = report.export(data, "markdown")
    assert md["filename"] == "acetic-acid-repair-report.md" and "# Repair report: acetic acid" in md["data"]
    pdf = report.export(data, "pdf", "th", {"title": "รายงานการซ่อมแซม"})
    raw = base64.b64decode(pdf["data"])
    assert raw.startswith(b"%PDF") and pdf["bytes"] == len(raw)


def test_report_file_name_keeps_non_latin_names() -> None:
    """A Thai molecule name keeps its vowel marks in the report's file name."""
    from mfcompute.chem.report import _slug

    assert _slug("กรดแอซีติก") == "กรดแอซีติก"
    assert _slug("Acetic acid / glacial") == "acetic-acid-glacial"
    assert _slug("") == "molecule"
