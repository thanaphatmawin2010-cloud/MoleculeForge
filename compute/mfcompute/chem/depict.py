"""2D depiction coordinates shared by the sketcher (chem.layout2d), the library build and reports."""

from __future__ import annotations

import numpy as np
from rdkit import Chem
from rdkit.Chem import rdDepictor


def _depict(mol: Chem.Mol) -> Chem.Mol | None:
    """2D coordinates via CoordGen, then RDKit's own depictor; None if both give non-finite values."""
    for coordgen in (True, False):
        depict = Chem.Mol(mol)
        rdDepictor.SetPreferCoordGen(coordgen)
        rdDepictor.Compute2DCoords(depict)
        if np.all(np.isfinite(depict.GetConformer().GetPositions())):
            return depict
    return None


def layout_2d(rd: Chem.Mol) -> list[list[float]]:
    """Textbook 2D layout: depict the heavy-atom skeleton, then place each hydrogen around it.

    Laying out with every hydrogen present lets CoordGen bend the skeleton to make room for
    them (1,3-butadiene came out U-shaped); the skeleton-first layout gives the usual zigzags.
    Index order matches ``rd`` exactly. CoordGen returns NaN for H2, so results are checked.
    """
    n = rd.GetNumAtoms()
    heavy = [a.GetIdx() for a in rd.GetAtoms() if a.GetAtomicNum() != 1]
    if heavy and len(heavy) < n:
        tagged = Chem.Mol(rd)
        for atom in tagged.GetAtoms():
            atom.SetIntProp("orig", atom.GetIdx())
        skeleton = Chem.RemoveHs(tagged, sanitize=False)
        skeleton.UpdatePropertyCache(strict=False)
        depicted = _depict(skeleton)
        if depicted is not None:
            full = Chem.AddHs(depicted, addCoords=True)
            pos = full.GetConformer().GetPositions()
            coords: dict[int, list[float]] = {}
            new_h: dict[int, list[int]] = {}
            for atom in full.GetAtoms():
                if atom.HasProp("orig"):
                    coords[atom.GetIntProp("orig")] = [round(float(pos[atom.GetIdx()][0]), 4), round(float(pos[atom.GetIdx()][1]), 4)]
                else:  # hydrogen re-added by AddHs: belongs to its single heavy neighbour
                    anchor = atom.GetNeighbors()[0].GetIntProp("orig")
                    new_h.setdefault(anchor, []).append(atom.GetIdx())
            for anchor, added in new_h.items():
                originals = sorted(nb.GetIdx() for nb in rd.GetAtomWithIdx(anchor).GetNeighbors()
                                   if nb.GetAtomicNum() == 1 and nb.GetIdx() not in coords)
                for orig, idx in zip(originals, added, strict=False):
                    coords[orig] = [round(float(pos[idx][0]), 4), round(float(pos[idx][1]), 4)]
            if len(coords) == n and all(np.isfinite(v) for xy in coords.values() for v in xy):
                return [coords[i] for i in range(n)]
    depicted = _depict(rd)
    if depicted is not None:
        return [[round(float(x), 4), round(float(y), 4)] for x, y, _ in depicted.GetConformer().GetPositions()]
    return [[round(1.5 * i, 4), 0.0] for i in range(n)]


def _keep_stereogenic(mol: Chem.Mol) -> bool:
    """Clear chiral tags that do not define stereoisomerism; return whether any remain.

    A tagged atom is kept only if inverting it changes the canonical isomeric SMILES, which is
    the definition of a stereogenic centre. Cage bridgeheads such as adamantane's (tagged from 3D
    but not stereogenic) are dropped; ring stereo such as cis/trans-1,4-dimethylcyclohexane stays.
    """
    tagged = [a.GetIdx() for a in mol.GetAtoms() if a.GetChiralTag() in (Chem.ChiralType.CHI_TETRAHEDRAL_CW,
                                                                         Chem.ChiralType.CHI_TETRAHEDRAL_CCW)]
    if not tagged:
        return False
    reference = Chem.MolToSmiles(Chem.RemoveHs(mol, sanitize=False))
    keep = []
    for idx in tagged:
        flipped = Chem.Mol(mol)
        flipped.GetAtomWithIdx(idx).InvertChirality()
        if Chem.MolToSmiles(Chem.RemoveHs(flipped, sanitize=False)) != reference:
            keep.append(idx)
    for idx in set(tagged) - set(keep):
        mol.GetAtomWithIdx(idx).SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
    return bool(keep)


def wedges(mol3d: Chem.Mol, layout: list[list[float]], explicit_h: bool = False) -> list[dict[str, object]]:
    """Wedge/hash bonds that show the 3D structure's tetrahedral stereocentres in a 2D layout.

    Chirality is perceived from the 3D coordinates, then RDKit picks the bonds to wedge using the
    given 2D positions. For a skeletal drawing (``explicit_h`` False, hydrogens on carbon hidden)
    the wedges are chosen on the hydrogen-suppressed skeleton, so they sit on heavy-atom bonds as
    in print. When hydrogens are drawn, their 2D positions take part in the reading, so the wedges
    are chosen on the full structure instead. Returned bond indices refer to ``mol3d``; ``from`` is
    the narrow (stereocentre) end.
    """
    n = mol3d.GetNumAtoms()
    if n == 0 or len(layout) != n or mol3d.GetNumConformers() == 0 or not mol3d.GetConformer().Is3D():
        return []
    tagged = Chem.Mol(mol3d)
    Chem.AssignStereochemistryFrom3D(tagged)
    if not _keep_stereogenic(tagged):
        return []
    for atom in tagged.GetAtoms():
        atom.SetIntProp("orig", atom.GetIdx())
    tagged.RemoveAllConformers()
    flat = Chem.Conformer(n)
    for i, (x, y) in enumerate(layout):
        flat.SetAtomPosition(i, (float(x), float(y), 0.0))
    flat.Set3D(False)
    tagged.AddConformer(flat, assignId=True)
    skeleton = tagged if explicit_h else Chem.RemoveHs(tagged, sanitize=False)
    skeleton.UpdatePropertyCache(strict=False)
    if skeleton.GetNumConformers() == 0:
        return []
    Chem.WedgeMolBonds(skeleton, skeleton.GetConformer())
    out: list[dict[str, object]] = []
    for bond in skeleton.GetBonds():
        direction = bond.GetBondDir()
        if direction not in (Chem.BondDir.BEGINWEDGE, Chem.BondDir.BEGINDASH):
            continue
        a = bond.GetBeginAtom().GetIntProp("orig")
        b = bond.GetEndAtom().GetIntProp("orig")
        original = mol3d.GetBondBetweenAtoms(a, b)
        if original is None:
            continue
        out.append({"bond": original.GetIdx(), "kind": "wedge" if direction == Chem.BondDir.BEGINWEDGE else "hash", "from": a})
    return out
