"""Rule-based pKa estimates for ionisable functional groups.

Each SMARTS pattern maps to the experimental aqueous pKa (25 °C) of a parent compound
(CRC Handbook of Chemistry and Physics, "Dissociation constants of organic acids and
bases"). Substituent effects are not modelled, so estimates carry ±1.5 units.
"""

from __future__ import annotations

from typing import Any

from rdkit import Chem

METHOD = "Functional-group lookup of parent-compound aqueous pKa (CRC Handbook); ±1.5 units"

# (name, kind, SMARTS, pKa, parent compound). "kind": acid = pKa of the neutral/acidic form;
# base = pKa of the conjugate acid.
RULES: list[tuple[str, str, str, float, str]] = [
    ("sulfonic acid", "acid", "[SX4](=O)(=O)[OX2H1]", -1.9, "methanesulfonic acid"),
    ("phosphate/phosphonic acid", "acid", "[PX4](=O)[OX2H1]", 2.1, "phosphoric acid (first)"),
    ("aromatic carboxylic acid", "acid", "a[CX3](=O)[OX2H1]", 4.2, "benzoic acid"),
    ("carboxylic acid", "acid", "[CX3;!$(Ca)](=O)[OX2H1]", 4.76, "acetic acid"),
    ("tetrazole", "acid", "[nH]1nnnc1", 4.9, "5-methyltetrazole"),
    ("thiophenol", "acid", "c[SX2H1]", 6.6, "thiophenol"),
    ("1,3-dicarbonyl C–H", "acid", "[CX3](=O)[CH2][CX3](=O)", 8.9, "acetylacetone"),
    ("imide", "acid", "[CX3](=O)[NX3H1][CX3](=O)", 9.6, "succinimide"),
    ("phenol", "acid", "c[OX2H1]", 9.95, "phenol"),
    ("sulfonamide", "acid", "[SX4](=O)(=O)[NX3H2,NX3H1]", 10.1, "benzenesulfonamide"),
    ("aliphatic thiol", "acid", "[CX4][SX2H1]", 10.5, "ethanethiol"),
    ("aliphatic alcohol", "acid", "[CX4][OX2H1]", 15.9, "ethanol"),
    ("water", "acid", "[OX2H2]", 15.7, "water"),
    ("guanidine", "base", "[NX3][CX3](=[NX2;!$(N-a)])[NX3]", 13.6, "guanidine"),
    ("amidine", "base", "[CX3;!$(C(N)(N)=N)](=[NX2;!$(N-a)])[NX3;H1,H2]", 12.4, "acetamidine"),
    ("secondary aliphatic amine", "base", "[NX3;H1;!$(N-[!#6;!#1]);!$(N-C=[O,N,S]);!$(N-a)]([CX4])[CX4]", 11.0, "diethylamine"),
    ("primary aliphatic amine", "base", "[NX3;H2;!$(N-[!#6;!#1]);!$(N-C=[O,N,S]);!$(N-a)][CX4]", 10.6, "ethylamine"),
    ("tertiary aliphatic amine", "base", "[NX3;H0;!$(N-[!#6]);!$(N-C=[O,N,S]);!$(N-a)]([CX4])([CX4])[CX4]", 9.8, "trimethylamine"),
    ("ammonia", "base", "[NX3H3]", 9.25, "ammonia"),
    ("imidazole", "base", "[nX2;r5]:c:[nX3H1;r5]", 6.95, "imidazole"),
    ("pyridine", "base", "[nX2;r6]", 5.23, "pyridine"),
    ("aniline", "base", "c[NX3;H2,H1;!$(N-C=[O,N,S])]", 4.6, "aniline"),
]

_COMPILED = [(name, kind, Chem.MolFromSmarts(smarts), value, parent) for name, kind, smarts, value, parent in RULES]


def estimate(mol: Chem.Mol) -> list[dict[str, Any]]:
    """Return one record per matched ionisable site (heavy-atom anchored, no double counting)."""
    claimed: set[int] = set()
    sites = []
    for name, kind, pattern, value, parent in _COMPILED:
        if pattern is None:
            continue
        for match in mol.GetSubstructMatches(pattern):
            heavy = tuple(i for i in match if mol.GetAtomWithIdx(i).GetAtomicNum() != 1)
            anchor = _anchor(mol, heavy, kind)
            if anchor in claimed:
                continue
            claimed.add(anchor)
            sites.append({
                "group": name, "kind": kind, "pKa": value, "uncertainty": 1.5, "atoms": list(heavy), "site": anchor,
                "parentCompound": parent,
            })
    return sorted(sites, key=lambda s: s["pKa"])


def _anchor(mol: Chem.Mol, atoms: tuple[int, ...], kind: str) -> int:
    """The ionisable atom: the acidic heteroatom bearing H, or the basic nitrogen."""
    hetero = [i for i in atoms if mol.GetAtomWithIdx(i).GetSymbol() in ("O", "S", "N")]
    if kind == "acid":
        with_h = [i for i in hetero if mol.GetAtomWithIdx(i).GetTotalNumHs() > 0]
        if with_h:
            return with_h[-1]
        carbons = [i for i in atoms if mol.GetAtomWithIdx(i).GetSymbol() == "C" and mol.GetAtomWithIdx(i).GetTotalNumHs() > 0]
        return carbons[0] if carbons else atoms[0]
    nitrogens = [i for i in atoms if mol.GetAtomWithIdx(i).GetSymbol() == "N"]
    return nitrogens[0] if nitrogens else atoms[0]
