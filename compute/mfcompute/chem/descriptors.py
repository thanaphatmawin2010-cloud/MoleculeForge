"""Cheminformatics descriptors (``chem.descriptors``): every value carries unit and method."""

from __future__ import annotations

from typing import Any

from rdkit import Chem
from rdkit.Chem import QED, AllChem, Crippen, Descriptors, Lipinski, rdMolDescriptors

from ..models import Molecule
from . import convert, pka


def _pv(value: Any, unit: str, method: str, uncertainty: float | None = None) -> dict[str, Any]:
    record: dict[str, Any] = {"value": value, "unit": unit, "method": method}
    if uncertainty is not None:
        record["uncertainty"] = uncertainty
    return record


def compute(molecule: Molecule) -> dict[str, dict[str, Any]]:
    mol = convert.to_rdkit(molecule)
    return compute_rdkit(mol)


def compute_rdkit(mol: Chem.Mol) -> dict[str, dict[str, Any]]:
    heavy = Chem.RemoveHs(mol)
    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)
    hbd = Lipinski.NumHDonors(mol)
    hba = Lipinski.NumHAcceptors(mol)
    nhoh = Lipinski.NHOHCount(mol)
    no_count = Lipinski.NOCount(mol)
    tpsa = rdMolDescriptors.CalcTPSA(mol)
    rot = rdMolDescriptors.CalcNumRotatableBonds(mol)
    lipinski_checks = {
        "molecularWeight≤500": mw <= 500,
        "logP≤5": logp <= 5,
        "hBondDonors(NH+OH)≤5": nhoh <= 5,
        "hBondAcceptors(N+O)≤10": no_count <= 10,
    }
    violations = sum(1 for ok in lipinski_checks.values() if not ok)
    veber_checks = {"rotatableBonds≤10": rot <= 10, "tpsa≤140": tpsa <= 140}
    gasteiger_mol = Chem.Mol(mol)
    AllChem.ComputeGasteigerCharges(gasteiger_mol)
    gasteiger = []
    for atom in gasteiger_mol.GetAtoms():
        q = atom.GetDoubleProp("_GasteigerCharge") if atom.HasProp("_GasteigerCharge") else float("nan")
        gasteiger.append(round(q, 4) if q == q else None)
    try:
        qed = QED.qed(heavy)
    except Exception:  # noqa: BLE001 - QED is undefined for some inorganic species
        qed = None
    chiral = Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False)
    props: dict[str, dict[str, Any]] = {
        "formula": _pv(rdMolDescriptors.CalcMolFormula(mol), "", "RDKit CalcMolFormula"),
        "molecularWeight": _pv(round(mw, 4), "g/mol", "IUPAC standard atomic weights (RDKit MolWt)"),
        "exactMass": _pv(round(Descriptors.ExactMolWt(mol), 6), "Da", "Monoisotopic mass (RDKit ExactMolWt)"),
        "atomCount": _pv(mol.GetNumAtoms(), "", "count"),
        "heavyAtomCount": _pv(heavy.GetNumAtoms(), "", "count"),
        "netCharge": _pv(Chem.GetFormalCharge(mol), "e", "sum of formal charges"),
        "radicalElectrons": _pv(sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms()), "", "count"),
        "logP": _pv(round(logp, 3), "", "Wildman–Crippen atomic contributions (RDKit)", uncertainty=0.68),
        "molarRefractivity": _pv(round(Crippen.MolMR(mol), 3), "cm³/mol", "Wildman–Crippen (RDKit)"),
        "tpsa": _pv(round(tpsa, 2), "Å²", "Ertl topological polar surface area (N,O)"),
        "hBondDonors": _pv(hbd, "", "RDKit Lipinski.NumHDonors"),
        "hBondAcceptors": _pv(hba, "", "RDKit Lipinski.NumHAcceptors"),
        "rotatableBonds": _pv(rot, "", "RDKit strict rotatable-bond definition"),
        "ringCount": _pv(rdMolDescriptors.CalcNumRings(mol), "", "SSSR ring count"),
        "aromaticRingCount": _pv(rdMolDescriptors.CalcNumAromaticRings(mol), "", "RDKit aromaticity model"),
        "fractionCsp3": _pv(round(rdMolDescriptors.CalcFractionCSP3(mol), 4), "", "RDKit"),
        "stereocenters": _pv(len(chiral), "", "RDKit CIP stereocentre perception"),
        "gasteigerCharges": _pv(gasteiger, "e", "Gasteiger–Marsili PEOE"),
        "lipinski": _pv(
            {"checks": lipinski_checks, "violations": violations, "passes": violations <= 1,
             "values": {"molecularWeight": round(mw, 3), "logP": round(logp, 3), "nhOhCount": nhoh, "noCount": no_count}},
            "", "Lipinski rule of five (≤1 violation allowed)",
        ),
        "veber": _pv({"checks": veber_checks, "passes": all(veber_checks.values()), "values": {"rotatableBonds": rot, "tpsa": round(tpsa, 2)}},
                     "", "Veber et al. 2002 oral bioavailability rules"),
        "qed": _pv(round(qed, 4) if qed is not None else None, "", "Bickerton et al. 2012 quantitative estimate of drug-likeness"),
        "pKaEstimates": _pv(pka.estimate(mol), "", pka.METHOD),
    }
    return props
