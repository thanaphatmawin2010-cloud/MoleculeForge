"""Functional-group based auto-categorisation and the periodic-table-style library grid.

The grid mirrors the periodic table's block structure: each category is a "family" with a
fixed row/column so the library view reads like Mendeleev's table (spec 7.7).
"""

from __future__ import annotations

from dataclasses import dataclass

from rdkit import Chem
from rdkit.Chem import QED, Lipinski


@dataclass(frozen=True)
class Category:
    id: str
    row: int
    col: int
    family: str  # colour family token used by the UI


CATEGORIES: list[Category] = [
    Category("inorganic", 1, 1, "s-block"),
    Category("ions", 2, 1, "s-block"),
    Category("hydrocarbons", 1, 3, "p-block"),
    Category("aromatics", 2, 3, "p-block"),
    Category("halogenated", 3, 3, "p-block"),
    Category("alcohols-ethers", 1, 4, "p-block"),
    Category("carbonyls", 2, 4, "p-block"),
    Category("acids-derivatives", 3, 4, "p-block"),
    Category("nitrogen-compounds", 1, 5, "p-block"),
    Category("sulfur-phosphorus", 2, 5, "p-block"),
    Category("biomolecules", 1, 2, "d-block"),
    Category("drugs-actives", 2, 2, "d-block"),
    Category("monomers-polymers", 3, 2, "d-block"),
    Category("solvents", 3, 1, "s-block"),
    Category("coordination", 3, 5, "f-block"),
    Category("other", 4, 5, "f-block"),
]
CATEGORY_IDS = {c.id for c in CATEGORIES}

METALS = set(range(3, 5)) | set(range(11, 14)) | set(range(19, 32)) | set(range(37, 51)) | set(range(55, 85)) | set(range(87, 119))

_PATTERNS = {name: Chem.MolFromSmarts(s) for name, s in {
    "amino_acid": "[NX3,NX4+][CX4][CX3](=O)[OX2H1,OX1-]",
    "nucleobase": "[#6]1[#7][#6](=[#8])[#7][#6][#6,#7]1",
    "carboxylic": "[CX3](=O)[OX2H1,OX1-]",
    "ester": "[#6][CX3](=O)[OX2][#6]",
    "amide": "[CX3](=O)[NX3]",
    "anhydride": "[CX3](=O)[OX2][CX3](=O)",
    "acyl_halide": "[CX3](=O)[F,Cl,Br,I]",
    "aldehyde": "[CX3H1](=O)[#6,#1]",
    "formaldehyde": "[CX3H2]=O",
    "ketone": "[#6][CX3](=O)[#6]",
    "alcohol": "[CX4][OX2H1]",
    "ether": "[OD2]([#6])[#6]",
    "amine": "[NX3;!$(N-C=[O,N,S]);!$(N-[a])]",
    "nitrile": "[CX2]#[NX1]",
    "nitro": "[NX3+](=O)[O-]",
    "aromatic": "a",
    "halide": "[#6][F,Cl,Br,I]",
    "sp": "[#16,#15]",
}.items()}


def _has(mol: Chem.Mol, name: str) -> bool:
    pattern = _PATTERNS[name]
    return pattern is not None and mol.HasSubstructMatch(pattern)


def categorize(mol: Chem.Mol) -> str:
    heavy = Chem.RemoveHs(mol, sanitize=False)
    zs = {a.GetAtomicNum() for a in heavy.GetAtoms()}
    n_heavy = heavy.GetNumAtoms()
    charge = Chem.GetFormalCharge(mol)
    if len(Chem.GetMolFrags(mol)) == 1 and charge != 0 and n_heavy <= 12:
        return "ions"
    if zs & METALS:
        return "coordination"
    if 6 not in zs or (zs <= {6, 8} and n_heavy <= 3 and not any(a.GetTotalNumHs() for a in heavy.GetAtoms() if a.GetAtomicNum() == 6)):
        return "inorganic"
    if _has(mol, "amino_acid") or _has(mol, "nucleobase"):
        return "biomolecules"
    hydroxyls = len(mol.GetSubstructMatches(_PATTERNS["alcohol"]))
    if hydroxyls >= 4 and 8 in zs and zs <= {1, 6, 8}:
        return "biomolecules"  # carbohydrates
    try:
        qed = QED.qed(heavy)
    except Exception:
        qed = 0.0
    if n_heavy >= 10 and _has(mol, "aromatic") and zs & {7, 8} and qed >= 0.55 and Lipinski.NumHDonors(mol) <= 5:
        return "drugs-actives"
    if _has(mol, "acyl_halide") or _has(mol, "anhydride") or _has(mol, "carboxylic") or _has(mol, "ester") or _has(mol, "amide"):
        return "acids-derivatives"
    if _has(mol, "aldehyde") or _has(mol, "formaldehyde") or _has(mol, "ketone"):
        return "carbonyls"
    if _has(mol, "nitro") or _has(mol, "nitrile") or _has(mol, "amine") or (7 in zs and not _has(mol, "aromatic")):
        return "nitrogen-compounds"
    if _has(mol, "halide"):
        return "halogenated"
    if zs & {15, 16}:
        return "sulfur-phosphorus"
    if _has(mol, "aromatic"):
        return "aromatics"
    if _has(mol, "alcohol") or _has(mol, "ether"):
        return "alcohols-ethers"
    if zs <= {1, 6}:
        return "hydrocarbons"
    return "other"
