"""Conversion between the canonical molecule JSON (spec 6.1), RDKit and file formats.

Round-trip guarantees (verified by tests/integration/compute/test_formats.py):

* ``sdf`` / ``mol``: graph, formal charges, isotopes, stereo and coordinates (1e-4 Å).
* ``pdb``: graph incl. bond orders (multiple CONECT), charges and coordinates (1e-3 Å).
* ``xyz``: elements and coordinates (1e-5 Å); bonds re-perceived for the given net charge.
* ``smiles`` / ``inchi``: molecular graph identity (canonical SMILES / standard InChI);
  coordinates are regenerated with ETKDGv3 when ``embed3d`` is true.
"""

from __future__ import annotations

import io
import uuid
from collections.abc import Iterable

from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem, rdDetermineBonds, rdMolDescriptors
from rdkit.Geometry import Point3D

from ..models import Atom, Bond, Molecule, MoleculeMeta
from ..rpc import CHEMISTRY_ERROR, RpcError

RDLogger.DisableLog("rdApp.*")

PT = Chem.GetPeriodicTable()

ORDER_TO_RD = {
    "single": Chem.BondType.SINGLE,
    "double": Chem.BondType.DOUBLE,
    "triple": Chem.BondType.TRIPLE,
    "aromatic": Chem.BondType.AROMATIC,
}

EMBED_SEED = 0x5EED


def element_number(symbol: str) -> int:
    try:
        z = int(PT.GetAtomicNumber(symbol))
    except Exception as exc:
        raise RpcError(CHEMISTRY_ERROR, f"Unknown element symbol '{symbol}'", {"code": "UNKNOWN_ELEMENT", "element": symbol}) from exc
    if z < 1 or z > 118:
        raise RpcError(CHEMISTRY_ERROR, f"Unknown element symbol '{symbol}'", {"code": "UNKNOWN_ELEMENT", "element": symbol})
    return z


def is_3d(molecule: Molecule) -> bool:
    """Canonical molecules always carry 3D coordinates; only all-zero coordinates mean "none yet".

    Planar molecules (water, benzene, CO2) legitimately have z == 0 for every atom.
    """
    if len(molecule.atoms) == 1:
        return True
    return any(abs(a.x) + abs(a.y) + abs(a.z) > 1e-6 for a in molecule.atoms) and len({(a.x, a.y, a.z) for a in molecule.atoms}) > 1


def _wedge_sketch(molecule: Molecule) -> bool:
    return all(abs(a.z) < 1e-6 for a in molecule.atoms) and any(b.stereo in ("wedge", "hash") for b in molecule.bonds)


def to_rdkit(molecule: Molecule, *, sanitize: bool = True) -> Chem.Mol:
    """Build an RDKit molecule. Raises RpcError(CHEMISTRY_ERROR) when it cannot be sanitized."""
    rw = Chem.RWMol()
    for atom in molecule.atoms:
        rd_atom = Chem.Atom(element_number(atom.el))
        rd_atom.SetFormalCharge(atom.charge)
        if atom.isotope:
            rd_atom.SetIsotope(atom.isotope)
        if atom.hCount is not None:
            rd_atom.SetNumExplicitHs(atom.hCount)
            rd_atom.SetNoImplicit(True)
        rw.AddAtom(rd_atom)
    seen: set[tuple[int, int]] = set()
    for bond in molecule.bonds:
        key = (min(bond.a, bond.b), max(bond.a, bond.b))
        if bond.a == bond.b:
            raise RpcError(CHEMISTRY_ERROR, "An atom cannot bond to itself", {"code": "SELF_BOND", "atom": bond.a})
        if key in seen:
            raise RpcError(CHEMISTRY_ERROR, "Duplicate bond", {"code": "DUPLICATE_BOND", "atoms": list(key)})
        seen.add(key)
        rw.AddBond(bond.a, bond.b, ORDER_TO_RD[bond.order])
        if bond.order == "aromatic":
            rd_bond = rw.GetBondBetweenAtoms(bond.a, bond.b)
            rd_bond.SetIsAromatic(True)
            rw.GetAtomWithIdx(bond.a).SetIsAromatic(True)
            rw.GetAtomWithIdx(bond.b).SetIsAromatic(True)
    three_d = is_3d(molecule) and not _wedge_sketch(molecule)
    if molecule.atoms:
        conf = Chem.Conformer(len(molecule.atoms))
        for atom in molecule.atoms:
            conf.SetAtomPosition(atom.i, Point3D(atom.x, atom.y, atom.z))
        conf.Set3D(three_d)
        rw.AddConformer(conf, assignId=True)
    if not three_d:
        for bond, spec in zip(rw.GetBonds(), molecule.bonds, strict=True):
            if spec.stereo == "wedge":
                bond.SetBondDir(Chem.BondDir.BEGINWEDGE)
            elif spec.stereo == "hash":
                bond.SetBondDir(Chem.BondDir.BEGINDASH)
    mol = rw.GetMol()
    if sanitize:
        try:
            Chem.SanitizeMol(mol)
        except Exception as exc:
            raise RpcError(CHEMISTRY_ERROR, f"Structure is not chemically valid: {exc}", {"code": "SANITIZE_FAILED"}) from exc
        if three_d:
            Chem.AssignStereochemistryFrom3D(mol)
        else:
            Chem.AssignChiralTypesFromBondDirs(mol)
            _apply_double_bond_flags(mol, molecule)
            Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    return mol


def _apply_double_bond_flags(mol: Chem.Mol, molecule: Molecule) -> None:
    for bond, spec in zip(mol.GetBonds(), molecule.bonds, strict=True):
        if spec.stereo not in ("cis", "trans") or bond.GetBondType() != Chem.BondType.DOUBLE:
            continue
        begin, end = bond.GetBeginAtom(), bond.GetEndAtom()
        left = [n.GetIdx() for n in begin.GetNeighbors() if n.GetIdx() != end.GetIdx()]
        right = [n.GetIdx() for n in end.GetNeighbors() if n.GetIdx() != begin.GetIdx()]
        if not left or not right:
            continue
        bond.SetStereoAtoms(min(left), min(right))
        bond.SetStereo(Chem.BondStereo.STEREOCIS if spec.stereo == "cis" else Chem.BondStereo.STEREOTRANS)


def _bond_stereo(bond: Chem.Bond) -> str:
    direction = bond.GetBondDir()
    if direction == Chem.BondDir.BEGINWEDGE:
        return "wedge"
    if direction == Chem.BondDir.BEGINDASH:
        return "hash"
    stereo = bond.GetStereo()
    if stereo in (Chem.BondStereo.STEREOE, Chem.BondStereo.STEREOTRANS):
        return "trans"
    if stereo in (Chem.BondStereo.STEREOZ, Chem.BondStereo.STEREOCIS):
        return "cis"
    return "none"


def _bond_order(bond: Chem.Bond) -> str:
    if bond.GetIsAromatic() or bond.GetBondType() == Chem.BondType.AROMATIC:
        return "aromatic"
    return {
        Chem.BondType.DOUBLE: "double",
        Chem.BondType.TRIPLE: "triple",
    }.get(bond.GetBondType(), "single")


def from_rdkit(
    mol: Chem.Mol,
    *,
    mol_id: str | None = None,
    name: str = "",
    source: str = "user",
    props: dict[str, object] | None = None,
    category: str = "",
) -> Molecule:
    conf = mol.GetConformer() if mol.GetNumConformers() else None
    atoms: list[Atom] = []
    for rd_atom in mol.GetAtoms():
        idx = rd_atom.GetIdx()
        pos = conf.GetAtomPosition(idx) if conf is not None else Point3D(0, 0, 0)
        atoms.append(
            Atom(
                i=idx,
                el=rd_atom.GetSymbol(),
                x=round(float(pos.x), 6),
                y=round(float(pos.y), 6),
                z=round(float(pos.z), 6),
                charge=rd_atom.GetFormalCharge(),
                isotope=rd_atom.GetIsotope() or None,
                hCount=rd_atom.GetNumExplicitHs() if rd_atom.GetNoImplicit() and rd_atom.GetAtomicNum() != 1 else None,
            )
        )
    bonds = [
        Bond(a=b.GetBeginAtomIdx(), b=b.GetEndAtomIdx(), order=_bond_order(b), stereo=_bond_stereo(b))
        for b in mol.GetBonds()
    ]
    molecule = Molecule(
        id=mol_id or f"mol-{uuid.uuid4().hex[:12]}",
        name=name,
        atoms=atoms,
        bonds=bonds,
        props=dict(props or {}),
        meta=MoleculeMeta(source=source, category=category),
    )
    return annotate(molecule, mol)


def annotate(molecule: Molecule, mol: Chem.Mol | None = None) -> Molecule:
    """Fill formula, SMILES, InChI and InChIKey from the structure (best effort)."""
    try:
        rd = mol if mol is not None else to_rdkit(molecule)
    except RpcError:
        return molecule
    try:
        formula = rdMolDescriptors.CalcMolFormula(rd)
    except Exception:
        formula = ""
    smiles = inchi = inchikey = ""
    try:
        heavy = Chem.RemoveHs(rd, sanitize=True)
        smiles = Chem.MolToSmiles(heavy)
    except Exception:
        smiles = ""
    try:
        inchi = Chem.MolToInchi(rd, options="-w") or ""
        inchikey = Chem.InchiToInchiKey(inchi) if inchi else ""
    except Exception:
        inchi = inchikey = ""
    meta = molecule.meta.model_copy(update={"smiles": smiles, "inchi": inchi, "inchikey": inchikey or ""})
    return molecule.model_copy(update={"formula": formula, "meta": meta})


def embed_3d(mol: Chem.Mol, *, seed: int = EMBED_SEED, keep_existing: bool = False) -> Chem.Mol:
    """Return a hydrogen-complete molecule with a 3D conformer (ETKDGv3 + short force-field polish)."""
    has_coords = mol.GetNumConformers() > 0
    mol_h = Chem.AddHs(mol, addCoords=has_coords)
    if keep_existing and has_coords and mol_h.GetConformer().Is3D():
        return mol_h
    params = AllChem.ETKDGv3()
    params.randomSeed = seed
    params.useRandomCoords = mol_h.GetNumAtoms() > 200
    params.maxIterations = 2000
    status = AllChem.EmbedMolecule(mol_h, params)
    if status != 0:
        params.useRandomCoords = True
        status = AllChem.EmbedMolecule(mol_h, params)
    if status != 0:
        raise RpcError(CHEMISTRY_ERROR, "Could not generate 3D coordinates for this structure", {"code": "EMBED_FAILED"})
    if AllChem.MMFFHasAllMoleculeParams(mol_h):
        AllChem.MMFFOptimizeMolecule(mol_h, maxIters=500, mmffVariant="MMFF94s")
    elif AllChem.UFFHasAllMoleculeParams(mol_h):
        AllChem.UFFOptimizeMolecule(mol_h, maxIters=500)
    return mol_h


# ---------------------------------------------------------------------------
# File formats
# ---------------------------------------------------------------------------


def stereo_origin(mol: Chem.Mol) -> str:
    """Classify the source's stereo before any embedding (see ``MoleculeMeta.stereo``).

    Potential centres are found with RDKit's newer perception, which also sees ring stereo
    (1,4-disubstituted cyclohexanes); it can over-report cage bridgeheads, which only makes the
    result more cautious ("partial" hides wedges that would not be drawn anyway).
    """
    if mol.GetNumConformers() and mol.GetConformer().Is3D():
        return "coordinates"
    try:
        centres = Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False)
    except Exception:
        return ""
    if not centres:
        return "none"
    return "partial" if any(label == "?" for _, label in centres) else "defined"


def _finish(mol: Chem.Mol, name: str, embed3d: bool) -> Molecule:
    origin = stereo_origin(mol)
    if mol.GetNumConformers() == 0 or not mol.GetConformer().Is3D():
        if embed3d:
            mol = embed_3d(mol)
        elif mol.GetNumConformers() == 0:
            AllChem.Compute2DCoords(mol)
    molecule = from_rdkit(mol, name=name)
    return molecule.model_copy(update={"meta": molecule.meta.model_copy(update={"stereo": origin})})


def _sanitized(mol: Chem.Mol | None, what: str) -> Chem.Mol:
    if mol is None:
        raise RpcError(CHEMISTRY_ERROR, f"Could not parse {what}", {"code": "PARSE_FAILED", "format": what})
    try:
        Chem.SanitizeMol(mol)
    except Exception as exc:
        raise RpcError(CHEMISTRY_ERROR, f"{what} record is not chemically valid: {exc}", {"code": "SANITIZE_FAILED"}) from exc
    if mol.GetNumConformers() and mol.GetConformer().Is3D():
        Chem.AssignStereochemistryFrom3D(mol)
    else:
        Chem.AssignChiralTypesFromBondDirs(mol)
        Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    return mol


def parse(fmt: str, data: str, *, charge: int = 0, embed3d: bool = True, name: str = "") -> list[Molecule]:
    text = data.strip("﻿")
    if not text.strip():
        raise RpcError(CHEMISTRY_ERROR, "No input data", {"code": "EMPTY_INPUT"})
    out: list[Molecule] = []
    if fmt in ("sdf", "mol"):
        supplier = Chem.ForwardSDMolSupplier(io.BytesIO(text.encode("utf-8")), sanitize=False, removeHs=False, strictParsing=False)
        for record in supplier:
            mol = _sanitized(record, fmt.upper())
            title = mol.GetProp("_Name") if mol.HasProp("_Name") else ""
            out.append(_finish(mol, title or name, embed3d))
        if not out:
            raise RpcError(CHEMISTRY_ERROR, "No molecules found in file", {"code": "PARSE_FAILED", "format": fmt})
    elif fmt == "smiles":
        for line in _lines(text):
            parts = line.split(maxsplit=1)
            mol = _sanitized(Chem.MolFromSmiles(parts[0], sanitize=False), "SMILES")
            out.append(_finish(mol, parts[1] if len(parts) > 1 else name, embed3d))
    elif fmt == "inchi":
        for line in _lines(text):
            mol = Chem.MolFromInchi(line.split()[0], sanitize=True, removeHs=True)
            if mol is None:
                raise RpcError(CHEMISTRY_ERROR, "Could not parse InChI", {"code": "PARSE_FAILED", "format": "inchi"})
            out.append(_finish(mol, name, embed3d))
    elif fmt == "xyz":
        mol = Chem.MolFromXYZBlock(text if text.endswith("\n") else text + "\n")
        if mol is None:
            raise RpcError(CHEMISTRY_ERROR, "Could not parse XYZ", {"code": "PARSE_FAILED", "format": "xyz"})
        lines = text.splitlines()
        title = lines[1].strip() if len(lines) > 1 else ""
        try:
            rdDetermineBonds.DetermineBonds(mol, charge=charge)
        except Exception:
            mol = Chem.MolFromXYZBlock(text if text.endswith("\n") else text + "\n")
            rdDetermineBonds.DetermineConnectivity(mol)
        out.append(from_rdkit(_sanitized(mol, "XYZ"), name=title or name))
    elif fmt == "pdb":
        mol = Chem.MolFromPDBBlock(text, sanitize=False, removeHs=False, proximityBonding=False)
        if mol is not None and mol.GetNumBonds() == 0 and mol.GetNumAtoms() > 1:
            mol = Chem.MolFromPDBBlock(text, sanitize=False, removeHs=False, proximityBonding=True)
        out.append(from_rdkit(_sanitized(mol, "PDB"), name=name))
    else:
        raise RpcError(CHEMISTRY_ERROR, f"Unsupported input format {fmt}", {"code": "UNSUPPORTED_FORMAT"})
    return out


def _lines(text: str) -> Iterable[str]:
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


def write(fmt: str, molecules: list[Molecule]) -> str:
    if not molecules:
        raise RpcError(CHEMISTRY_ERROR, "Nothing to export", {"code": "EMPTY_INPUT"})
    if fmt in ("sdf", "mol"):
        buf = io.StringIO()
        for molecule in molecules if fmt == "sdf" else molecules[:1]:
            mol = to_rdkit(molecule)
            mol.SetProp("_Name", molecule.name or molecule.id)
            block = Chem.MolToV3KMolBlock(mol) if mol.GetNumAtoms() > 999 else Chem.MolToMolBlock(mol)
            buf.write(block)
            if fmt == "sdf":
                for key in ("smiles", "inchikey", "category"):
                    value = getattr(molecule.meta, key)
                    if value:
                        buf.write(f">  <{key.upper()}>\n{value}\n\n")
                buf.write("$$$$\n")
        return buf.getvalue()
    if fmt == "smiles":
        return "".join(f"{Chem.MolToSmiles(Chem.RemoveHs(to_rdkit(m)))} {m.name}".rstrip() + "\n" for m in molecules)
    if fmt == "inchi":
        return "".join((Chem.MolToInchi(to_rdkit(m)) or "") + "\n" for m in molecules)
    if fmt == "xyz":
        chunks = []
        for m in molecules:
            rows = [f"{a.el:<3}{a.x:15.8f}{a.y:15.8f}{a.z:15.8f}" for a in m.atoms]
            chunks.append(f"{len(m.atoms)}\n{m.name or m.id}\n" + "\n".join(rows) + "\n")
        return "".join(chunks)
    if fmt == "pdb":
        blocks = []
        for m in molecules:
            mol = to_rdkit(m)
            mol.SetProp("_Name", m.name or m.id)
            blocks.append(Chem.MolToPDBBlock(mol))
        return "".join(blocks)
    raise RpcError(CHEMISTRY_ERROR, f"Unsupported output format {fmt}", {"code": "UNSUPPORTED_FORMAT"})
