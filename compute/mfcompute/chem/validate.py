"""Structure validation (``chem.sanitize`` / ``chem.validateBonds``) and minimal auto-correction.

Detection layers
----------------
1. Graph checks that RDKit would reject outright (self bonds, duplicates, isotopes).
2. RDKit chemistry problems (valence, kekulization) via ``DetectChemistryProblems``.
3. Post-sanitisation checks (radicals, hypervalence, fragments).
4. Geometric checks when 3D coordinates exist (overlaps, clashes, bond lengths).

Auto-correction
---------------
Fixes are attempted in order of chemical minimality (see ``_fix_valence``) and every
applied fix is logged as ``{before, reason, fix, after}``; the caller receives the
corrected molecule, the operations applied, and an old→new atom index map.
"""

from __future__ import annotations

import itertools
import math
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from rdkit import Chem

from ..data import elements
from ..models import Atom, Bond, BondOrder, Issue, Molecule
from ..rpc import CHEMISTRY_ERROR, RpcError
from . import convert
from .issues import describe_fix, display_params, make_issue

PT = Chem.GetPeriodicTable()

CLASH_LIMIT = 0.70  # Å, minimum non-bonded separation (spec 7.4 acceptance)
OVERLAP_LIMIT = 0.20  # Å
BOND_TOLERANCE = 0.30  # fractional deviation from the covalent-radius estimate before warning

ONIUM_PLUS = {"N", "P", "As", "Sb", "O", "S", "Se", "Te"}
ATE_MINUS = {"B", "Al", "Ga"}
STEP_DOWN: dict[BondOrder, BondOrder] = {"triple": "double", "double": "single", "aromatic": "single"}

FIXABLE = {"SELF_BOND", "DUPLICATE_BOND", "ISOTOPE_UNKNOWN", "VALENCE_EXCEEDED", "AROMATIC_INVALID", "UNDERSATURATED"}


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def _max_valence(symbol: str, charge: int) -> int | None:
    z = PT.GetAtomicNumber(symbol)
    effective = z - charge if PT.GetNOuterElecs(z) >= 3 or charge < 0 else z
    effective = max(1, min(118, effective))
    valences = [v for v in PT.GetValenceList(effective)]
    if not valences or -1 in valences:
        return None
    return max(valences)


def graph_issues(molecule: Molecule) -> list[Issue]:
    issues: list[Issue] = []
    seen: dict[tuple[int, int], int] = {}
    for idx, bond in enumerate(molecule.bonds):
        if bond.a == bond.b:
            issues.append(make_issue("SELF_BOND", atoms=[bond.a], bonds=[idx], atom=bond.a))
            continue
        key = (min(bond.a, bond.b), max(bond.a, bond.b))
        if key in seen:
            issues.append(make_issue("DUPLICATE_BOND", atoms=list(key), bonds=[seen[key], idx], a=key[0], b=key[1]))
        else:
            seen[key] = idx
    for atom in molecule.atoms:
        try:
            z = PT.GetAtomicNumber(atom.el)
        except Exception:
            issues.append(make_issue("UNKNOWN_ELEMENT", atoms=[atom.i], element=atom.el))
            continue
        if atom.isotope and PT.GetMassForIsotope(z, atom.isotope) <= 0.0:
            issues.append(make_issue("ISOTOPE_UNKNOWN", atoms=[atom.i], isotope=atom.isotope, element=atom.el))
    return issues


def _rdkit_unsanitized(molecule: Molecule) -> Chem.Mol:
    rw = Chem.RWMol()
    for atom in molecule.atoms:
        rd_atom = Chem.Atom(PT.GetAtomicNumber(atom.el))
        rd_atom.SetFormalCharge(atom.charge)
        if atom.isotope:
            rd_atom.SetIsotope(atom.isotope)
        if atom.hCount is not None:
            rd_atom.SetNumExplicitHs(atom.hCount)
            rd_atom.SetNoImplicit(True)
        rw.AddAtom(rd_atom)
    for bond in molecule.bonds:
        rw.AddBond(bond.a, bond.b, convert.ORDER_TO_RD[bond.order])
        if bond.order == "aromatic":
            rd_bond = rw.GetBondBetweenAtoms(bond.a, bond.b)
            rd_bond.SetIsAromatic(True)
            rw.GetAtomWithIdx(bond.a).SetIsAromatic(True)
            rw.GetAtomWithIdx(bond.b).SetIsAromatic(True)
    return rw.GetMol()


def _bond_index(molecule: Molecule) -> dict[tuple[int, int], int]:
    return {(min(b.a, b.b), max(b.a, b.b)): i for i, b in enumerate(molecule.bonds)}


def chemistry_issues(molecule: Molecule) -> tuple[list[Issue], Chem.Mol | None]:
    """RDKit-level issues. Returns the sanitized RDKit molecule when sanitization succeeds."""
    issues: list[Issue] = []
    mol = _rdkit_unsanitized(molecule)
    degree = [0] * len(molecule.atoms)
    valence_sum = [0.0] * len(molecule.atoms)
    weights = {"single": 1.0, "double": 2.0, "triple": 3.0, "aromatic": 1.5}
    for bond in molecule.bonds:
        degree[bond.a] += 1
        degree[bond.b] += 1
        valence_sum[bond.a] += weights[bond.order]
        valence_sum[bond.b] += weights[bond.order]
    for problem in Chem.DetectChemistryProblems(mol):
        kind = problem.GetType()
        if kind == "AtomValenceException":
            idx = problem.GetAtomIdx()
            atom = molecule.atoms[idx]
            explicit = round(valence_sum[idx]) + (atom.hCount or 0)
            allowed = _max_valence(atom.el, atom.charge)
            issues.append(
                make_issue(
                    "VALENCE_EXCEEDED",
                    atoms=[idx],
                    element=atom.el,
                    atom=idx,
                    valence=explicit,
                    allowed=allowed if allowed is not None else "?",
                    charge=atom.charge,
                )
            )
        elif kind in ("KekulizeException", "AtomKekulizeException"):
            atoms = list(problem.GetAtomIndices()) if hasattr(problem, "GetAtomIndices") else [problem.GetAtomIdx()]
            index = _bond_index(molecule)
            bonds = sorted(
                index[(min(a, b), max(a, b))] for a, b in itertools.combinations(atoms, 2) if (min(a, b), max(a, b)) in index
            )
            issues.append(make_issue("AROMATIC_INVALID", atoms=atoms, bonds=bonds, atomList=", ".join(str(a + 1) for a in atoms)))
    if issues:
        return issues, None
    try:
        Chem.SanitizeMol(mol)
    except Exception as exc:
        raise RpcError(CHEMISTRY_ERROR, f"Structure could not be sanitized: {exc}", {"code": "SANITIZE_FAILED"}) from exc
    for rd_atom in mol.GetAtoms():
        idx = rd_atom.GetIdx()
        radicals = rd_atom.GetNumRadicalElectrons()
        atom = molecule.atoms[idx]
        if radicals:
            if atom.hCount is not None and rd_atom.GetAtomicNum() > 1:
                issues.append(make_issue("UNDERSATURATED", atoms=[idx], element=atom.el, atom=idx))
            else:
                issues.append(make_issue("RADICAL", atoms=[idx], element=atom.el, atom=idx, radicals=radicals))
        default = PT.GetDefaultValence(rd_atom.GetAtomicNum())
        total = rd_atom.GetTotalValence()
        if (default > 0 and rd_atom.GetFormalCharge() == 0 and total > default
                and PT.GetNOuterElecs(rd_atom.GetAtomicNum()) >= 5 and rd_atom.GetAtomicNum() > 10):
            issues.append(make_issue("HYPERVALENT", atoms=[idx], element=atom.el, atom=idx, valence=total))
        if abs(atom.charge) >= 3 and rd_atom.GetAtomicNum() <= 54 and not _is_metal(atom.el):
            issues.append(make_issue("CHARGE_UNUSUAL", atoms=[idx], element=atom.el, atom=idx, charge=atom.charge))
    fragments = len(Chem.GetMolFrags(mol)) if mol.GetNumAtoms() else 0
    if fragments > 1:
        issues.append(make_issue("FRAGMENTS", count=fragments))
    return issues, mol


def _is_metal(symbol: str) -> bool:
    record = elements.get(symbol=symbol)
    return record["category"] in {
        "alkali-metal", "alkaline-earth-metal", "transition-metal", "post-transition-metal", "lanthanide", "actinide",
    }


def geometry_issues(molecule: Molecule) -> list[Issue]:
    if len(molecule.atoms) < 2 or not convert.is_3d(molecule):
        return []
    issues: list[Issue] = []
    coords = np.array([[a.x, a.y, a.z] for a in molecule.atoms], dtype=float)
    n = len(coords)
    neighbours: list[set[int]] = [set() for _ in range(n)]
    for bond in molecule.bonds:
        if bond.a != bond.b:
            neighbours[bond.a].add(bond.b)
            neighbours[bond.b].add(bond.a)
    for idx, bond in enumerate(molecule.bonds):
        if bond.a == bond.b:
            continue
        a, b = molecule.atoms[bond.a], molecule.atoms[bond.b]
        length = float(np.linalg.norm(coords[bond.a] - coords[bond.b]))
        expected = elements.expected_bond_length(a.el, b.el, bond.order)
        if length < OVERLAP_LIMIT:
            issues.append(make_issue("ATOMS_OVERLAP", atoms=[bond.a, bond.b], bonds=[idx], a=bond.a, b=bond.b, distance=round(length, 3)))
        elif length > expected * (1 + BOND_TOLERANCE):
            issues.append(make_issue("BOND_TOO_LONG", atoms=[bond.a, bond.b], bonds=[idx], a=bond.a, b=bond.b,
                                     length=round(length, 3), expected=round(expected, 3)))
        elif length < expected * (1 - BOND_TOLERANCE):
            issues.append(make_issue("BOND_TOO_SHORT", atoms=[bond.a, bond.b], bonds=[idx], a=bond.a, b=bond.b,
                                     length=round(length, 3), expected=round(expected, 3)))
    if n <= 4000:
        from scipy.spatial import cKDTree

        tree = cKDTree(coords)
        for i, j in sorted(tree.query_pairs(CLASH_LIMIT)):
            if j in neighbours[i] or neighbours[i] & neighbours[j]:
                continue  # 1-2 and 1-3 pairs are governed by bond/angle terms
            distance = float(np.linalg.norm(coords[i] - coords[j]))
            code = "ATOMS_OVERLAP" if distance < OVERLAP_LIMIT else "CLASH"
            issues.append(make_issue(code, atoms=[i, j], a=i, b=j, distance=round(distance, 3), limit=CLASH_LIMIT))
    return issues


def detect(molecule: Molecule, *, geometry: bool = True) -> tuple[list[Issue], Chem.Mol | None]:
    issues = graph_issues(molecule)
    rd: Chem.Mol | None = None
    if not any(i.code in ("SELF_BOND", "DUPLICATE_BOND", "UNKNOWN_ELEMENT") for i in issues):
        chem_issues, rd = chemistry_issues(molecule)
        issues.extend(chem_issues)
    if geometry and not any(i.code in ("SELF_BOND", "UNKNOWN_ELEMENT") for i in issues):
        issues.extend(geometry_issues(molecule))
    return issues, rd


# ---------------------------------------------------------------------------
# Auto-correction
# ---------------------------------------------------------------------------


@dataclass
class FixState:
    molecule: Molecule
    atom_map: list[int]  # original index -> current index (-1 = removed)
    log: list[dict[str, Any]] = field(default_factory=list)
    ops: list[dict[str, Any]] = field(default_factory=list)


def _snapshot_atom(m: Molecule, idx: int) -> dict[str, Any]:
    atom = m.atoms[idx]
    bonds = [{"to": b.b if b.a == idx else b.a, "order": b.order} for b in m.bonds if idx in (b.a, b.b)]
    return {"atom": idx, "element": atom.el, "charge": atom.charge, "hCount": atom.hCount, "bonds": bonds}


def _snapshot_bond(m: Molecule, idx: int) -> dict[str, Any]:
    bond = m.bonds[idx]
    return {"bond": idx, "a": bond.a, "b": bond.b, "order": bond.order}


def _with_atoms(m: Molecule, atoms: list[Atom]) -> Molecule:
    return m.model_copy(update={"atoms": atoms})


def _set_bond_order(m: Molecule, idx: int, order: str) -> Molecule:
    bonds = list(m.bonds)
    bonds[idx] = bonds[idx].model_copy(update={"order": order})
    return m.model_copy(update={"bonds": bonds})


def _remove_bond(m: Molecule, idx: int) -> Molecule:
    return m.model_copy(update={"bonds": [b for i, b in enumerate(m.bonds) if i != idx]})


def _set_atom(m: Molecule, idx: int, **changes: Any) -> Molecule:
    atoms = list(m.atoms)
    atoms[idx] = atoms[idx].model_copy(update=changes)
    return _with_atoms(m, atoms)


def _remove_atom(m: Molecule, idx: int) -> tuple[Molecule, list[int]]:
    mapping = [i if i < idx else (-1 if i == idx else i - 1) for i in range(len(m.atoms))]
    atoms = [a.model_copy(update={"i": mapping[a.i]}) for a in m.atoms if a.i != idx]
    bonds = [
        b.model_copy(update={"a": mapping[b.a], "b": mapping[b.b]})
        for b in m.bonds
        if idx not in (b.a, b.b)
    ]
    return m.model_copy(update={"atoms": atoms, "bonds": bonds}), mapping


def _error_count(m: Molecule) -> int:
    issues, _ = detect(m, geometry=False)
    return sum(1 for i in issues if i.severity == "error")


def _atom_errors(m: Molecule, idx: int) -> bool:
    issues, _ = detect(m, geometry=False)
    return any(i.severity == "error" and idx in i.atoms for i in issues)


def _record(state: FixState, reason: Issue | str, op: dict[str, Any], before: dict[str, Any], after_molecule: Molecule,
            after_ref: tuple[str, int] | None, reason_params: dict[str, Any] | None = None, **describe: Any) -> None:
    """Log one applied fix with everything needed to explain it in any language.

    ``reason``/``reasonParams`` identify the issue that triggered the fix (localised through
    ``issues:code.<CODE>``); ``fix.params`` fills ``issues:fix.<op>``. Atom numbers are 1-based.
    """
    code = reason.code if isinstance(reason, Issue) else reason
    if reason_params is None:
        reason_params = dict(reason.params) if isinstance(reason, Issue) else {}
    after: dict[str, Any] = {}
    if after_ref is not None:
        kind, ref = after_ref
        if kind == "atom" and 0 <= ref < len(after_molecule.atoms):
            after = _snapshot_atom(after_molecule, ref)
        elif kind == "bond" and 0 <= ref < len(after_molecule.bonds):
            after = _snapshot_bond(after_molecule, ref)
        elif kind == "removed":
            after = {"removed": True}
    state.ops.append(op)
    state.log.append({"before": before, "reason": code, "reasonParams": reason_params, "after": after,
                      "fix": {**op, "description": describe_fix(op["op"], **describe), "params": display_params(describe)}})


def _order_change(old: BondOrder, new: BondOrder) -> dict[str, Any]:
    """Description parameters of a bond-order fix ("from" is a keyword, so they travel as a dict)."""
    return {"from": old, "to": new}


def _fix_valence(state: FixState, issue: Issue, focus_bonds: set[int]) -> bool:
    m = state.molecule
    idx = issue.atoms[0]
    atom = m.atoms[idx]
    before = _snapshot_atom(m, idx)
    incident = [i for i, b in enumerate(m.bonds) if idx in (b.a, b.b)]
    focus = [i for i in incident if i in focus_bonds]

    # 1. Free a valence by removing a terminal explicit hydrogen (most natural for "replace H").
    if atom.el != "H":
        h_bonds = [
            i for i in incident
            if m.atoms[m.bonds[i].b if m.bonds[i].a == idx else m.bonds[i].a].el == "H"
            and i not in focus_bonds
        ]
        for bond_idx in reversed(h_bonds):
            bond = m.bonds[bond_idx]
            h_idx = bond.b if bond.a == idx else bond.a
            if sum(1 for b in m.bonds if h_idx in (b.a, b.b)) != 1:
                continue
            candidate, mapping = _remove_atom(m, h_idx)
            new_idx = mapping[idx]
            if not _atom_errors(candidate, new_idx):
                state.molecule = candidate
                state.atom_map = [mapping[i] if i >= 0 else -1 for i in state.atom_map]
                _record(state, issue, {"op": "removeAtom", "atom": h_idx}, before, candidate, ("atom", new_idx), atom=h_idx)
                return True
            break

    # 2. Reduce an explicitly specified hydrogen count.
    if atom.hCount:
        candidate = _set_atom(m, idx, hCount=atom.hCount - 1)
        if not _atom_errors(candidate, idx):
            state.molecule = candidate
            _record(state, issue, {"op": "setHCount", "atom": idx, "hCount": atom.hCount - 1}, before, candidate,
                    ("atom", idx), element=atom.el, atom=idx, hCount=atom.hCount - 1)
            return True

    # 3. Lower the order of the bond that was just drawn.
    for bond_idx in focus:
        bond = m.bonds[bond_idx]
        order = bond.order
        while order in STEP_DOWN:
            order = STEP_DOWN[order]
            candidate = _set_bond_order(m, bond_idx, order)
            if not _atom_errors(candidate, idx):
                state.molecule = candidate
                _record(state, issue, {"op": "setBondOrder", "bond": bond_idx, "order": order}, _snapshot_bond(m, bond_idx),
                        candidate, ("bond", bond_idx), a=bond.a, b=bond.b, **_order_change(bond.order, order))
                return True

    # 4. Standard onium / -ate charge (e.g. NR4+, BF4-) when exactly one bond too many.
    for charge in ((+1,) if atom.el in ONIUM_PLUS else ()) + ((-1,) if atom.el in ATE_MINUS else ()):
        if atom.charge != 0:
            break
        candidate = _set_atom(m, idx, charge=charge)
        if not _atom_errors(candidate, idx):
            state.molecule = candidate
            _record(state, issue, {"op": "setCharge", "atom": idx, "charge": charge}, before, candidate, ("atom", idx),
                    element=atom.el, atom=idx, charge=charge)
            return True

    # 5. Lower the highest-order bond on the atom.
    ranked = sorted(incident, key=lambda i: {"triple": 3, "double": 2, "aromatic": 1.5}.get(m.bonds[i].order, 1), reverse=True)
    for bond_idx in ranked:
        bond = m.bonds[bond_idx]
        if bond.order not in STEP_DOWN:
            continue
        order = STEP_DOWN[bond.order]
        candidate = _set_bond_order(m, bond_idx, order)
        if _error_count(candidate) < _error_count(m):
            state.molecule = candidate
            _record(state, issue, {"op": "setBondOrder", "bond": bond_idx, "order": order}, _snapshot_bond(m, bond_idx),
                    candidate, ("bond", bond_idx), a=bond.a, b=bond.b, **_order_change(bond.order, order))
            return True

    # 6. Remove the newest offending bond (focus first, otherwise the longest bond).
    removal_order = focus or sorted(incident, key=lambda i: _bond_length(m, i), reverse=True)
    for bond_idx in removal_order:
        bond = m.bonds[bond_idx]
        candidate = _remove_bond(m, bond_idx)
        if _error_count(candidate) < _error_count(m):
            state.molecule = candidate
            _record(state, issue, {"op": "removeBond", "bond": bond_idx}, _snapshot_bond(m, bond_idx), candidate,
                    ("removed", bond_idx), a=bond.a, b=bond.b)
            return True
    return False


def _bond_length(m: Molecule, idx: int) -> float:
    b = m.bonds[idx]
    a1, a2 = m.atoms[b.a], m.atoms[b.b]
    return math.dist((a1.x, a1.y, a1.z), (a2.x, a2.y, a2.z))


def _kekule_assignment(m: Molecule, bond_ids: list[int]) -> dict[int, str] | None:
    """Find single/double orders for the given aromatic bonds giving every atom at most one double bond,
    maximising the number of double bonds (exact search for small systems)."""
    atoms_needing: dict[int, Any] = {}
    for i in bond_ids:
        b = m.bonds[i]
        atoms_needing[b.a] = atoms_needing.get(b.a, 0)
        atoms_needing[b.b] = atoms_needing.get(b.b, 0)
    best: tuple[int, dict[int, str]] | None = None
    bond_ids = sorted(bond_ids)
    if len(bond_ids) > 22:
        return None

    def search(k: int, used: set[int], chosen: dict[int, str], doubles: int) -> None:
        nonlocal best
        if k == len(bond_ids):
            if best is None or doubles > best[0]:
                best = (doubles, dict(chosen))
            return
        bond = m.bonds[bond_ids[k]]
        if bond.a not in used and bond.b not in used:
            chosen[bond_ids[k]] = "double"
            search(k + 1, used | {bond.a, bond.b}, chosen, doubles + 1)
        chosen[bond_ids[k]] = "single"
        search(k + 1, used, chosen, doubles)

    search(0, set(), {}, 0)
    return best[1] if best else None


def _fix_aromatic(state: FixState, issue: Issue) -> bool:
    m = state.molecule
    atoms = issue.atoms
    # 1. Pyrrole-type nitrogen needs an explicit hydrogen ([nH]).
    for idx in atoms:
        atom = m.atoms[idx]
        if atom.el == "N" and atom.hCount is None and atom.charge == 0:
            degree = sum(1 for b in m.bonds if idx in (b.a, b.b))
            if degree == 2:
                candidate = _set_atom(m, idx, hCount=1)
                if _error_count(candidate) < _error_count(m):
                    state.molecule = candidate
                    _record(state, issue, {"op": "setHCount", "atom": idx, "hCount": 1}, _snapshot_atom(m, idx), candidate,
                            ("atom", idx), element="N", atom=idx, hCount=1)
                    return True
    # 2. Replace the aromatic flags with an explicit Kekulé structure.
    aromatic_bonds = [i for i, b in enumerate(m.bonds) if b.order == "aromatic" and (b.a in atoms or b.b in atoms)]
    assignment = _kekule_assignment(m, aromatic_bonds)
    if assignment is None:
        return False
    candidate = m
    for bond_idx, order in assignment.items():
        candidate = _set_bond_order(candidate, bond_idx, order)
    if _error_count(candidate) < _error_count(m):
        before = {"bonds": [_snapshot_bond(m, i) for i in aromatic_bonds]}
        state.molecule = candidate
        op = {"op": "kekulize", "bonds": {str(k): v for k, v in assignment.items()}}
        numbers = ", ".join(str(a + 1) for a in sorted(atoms))  # 1-based, as labelled in the editor
        state.ops.append(op)
        state.log.append({"before": before, "reason": issue.code, "reasonParams": dict(issue.params),
                          "fix": {**op, "description": describe_fix("kekulize", atoms=numbers),
                                  "params": {"atoms": numbers}},
                          "after": {"bonds": [_snapshot_bond(candidate, i) for i in aromatic_bonds]}})
        return True
    return False


def _apply_fix(state: FixState, issue: Issue, focus_bonds: set[int]) -> bool:
    m = state.molecule
    if issue.code == "SELF_BOND":
        idx = issue.bonds[0]
        bond = m.bonds[idx]
        state.molecule = _remove_bond(m, idx)
        _record(state, issue, {"op": "removeBond", "bond": idx}, _snapshot_bond(m, idx), state.molecule, ("removed", idx),
                a=bond.a, b=bond.b)
        return True
    if issue.code == "DUPLICATE_BOND":
        idx = issue.bonds[-1]
        bond = m.bonds[idx]
        state.molecule = _remove_bond(m, idx)
        _record(state, issue, {"op": "removeBond", "bond": idx}, _snapshot_bond(m, idx), state.molecule, ("removed", idx),
                a=bond.a, b=bond.b)
        return True
    if issue.code == "ISOTOPE_UNKNOWN":
        idx = issue.atoms[0]
        before = _snapshot_atom(m, idx)
        state.molecule = _set_atom(m, idx, isotope=None)
        _record(state, issue, {"op": "clearIsotope", "atom": idx}, before, state.molecule, ("atom", idx), atom=idx)
        return True
    if issue.code == "UNDERSATURATED":
        idx = issue.atoms[0]
        before = _snapshot_atom(m, idx)
        state.molecule = _set_atom(m, idx, hCount=None)
        _record(state, issue, {"op": "setHCount", "atom": idx, "hCount": None}, before, state.molecule, ("atom", idx),
                element=m.atoms[idx].el, atom=idx, hCount="auto")
        return True
    if issue.code == "VALENCE_EXCEEDED":
        return _fix_valence(state, issue, focus_bonds)
    if issue.code == "AROMATIC_INVALID":
        return _fix_aromatic(state, issue)
    return False


def _snap_focus_geometry(state: FixState, focus_bonds: set[int]) -> None:
    """Move a terminal atom of a freshly drawn bond to the expected bond length ("snap")."""
    m = state.molecule
    if not convert.is_3d(m):
        return
    degree = [0] * len(m.atoms)
    for b in m.bonds:
        degree[b.a] += 1
        degree[b.b] += 1
    for idx in sorted(focus_bonds):
        if idx >= len(m.bonds):
            continue
        bond = m.bonds[idx]
        end_a, end_b = m.atoms[bond.a], m.atoms[bond.b]
        expected = elements.expected_bond_length(end_a.el, end_b.el, bond.order)
        length = _bond_length(m, idx)
        if abs(length - expected) / expected <= BOND_TOLERANCE:
            continue
        move, anchor = (end_b, end_a) if degree[bond.b] == 1 else ((end_a, end_b) if degree[bond.a] == 1 else (None, None))
        if move is None or anchor is None:
            continue
        vec = np.array([move.x - anchor.x, move.y - anchor.y, move.z - anchor.z])
        norm = float(np.linalg.norm(vec))
        direction = vec / norm if norm > 1e-6 else np.array([1.0, 0.0, 0.0])
        new = np.array([anchor.x, anchor.y, anchor.z]) + direction * expected
        before = _snapshot_atom(m, move.i)
        m = _set_atom(m, move.i, x=round(float(new[0]), 6), y=round(float(new[1]), 6), z=round(float(new[2]), 6))
        state.molecule = m
        _record(state, "BOND_TOO_LONG" if length > expected else "BOND_TOO_SHORT",
                {"op": "moveAtom", "atom": move.i, "x": float(new[0]), "y": float(new[1]), "z": float(new[2])},
                before, m, ("atom", move.i),
                reason_params=display_params({"a": bond.a, "b": bond.b, "length": round(length, 3), "expected": round(expected, 3)}),
                atom=move.i, length=round(expected, 3))


def validate(molecule: Molecule, focus_atoms: list[int], focus_bonds: list[int], auto_fix: bool) -> dict[str, Any]:
    started = time.perf_counter()
    if not molecule.atoms:
        return {"status": "valid", "messageKey": "validation.empty", "message": "The canvas is empty.", "results": [],
                "issues": [make_issue("EMPTY")], "fixes": [], "ops": [], "molecule": molecule, "atomMap": [],
                "durationMs": 0}
    issues, _ = detect(molecule)
    focus_b = set(focus_bonds)
    state = FixState(molecule=molecule, atom_map=list(range(len(molecule.atoms))))
    errors = [i for i in issues if i.severity == "error"]
    unfixable: list[Issue] = []
    if auto_fix and errors:
        for _ in range(24):
            current, _ = detect(state.molecule, geometry=False)
            fixable = [i for i in current if i.severity == "error" and i.code in FIXABLE and i not in unfixable]
            if not fixable:
                break
            fixable.sort(key=lambda i: (0 if set(i.bonds) & focus_b or set(i.atoms) & set(focus_atoms) else 1))
            issue = fixable[0]
            if not _apply_fix(state, issue, focus_b):
                unfixable.append(issue)
    if auto_fix:
        _snap_focus_geometry(state, {b for b in focus_b if b < len(state.molecule.bonds)})
    final_issues, rd = detect(state.molecule)
    final_errors = [i for i in final_issues if i.severity == "error"]
    if state.log and not final_errors:
        status, key, message = "fixed", "validation.fixed", "Bond connection fixed successfully."
    elif final_errors:
        status, key, message = "invalid", "validation.invalid", final_errors[0].message
    else:
        status, key, message = "valid", "validation.valid", "Bond connected correctly."
    results = _entity_results(molecule, issues, focus_atoms, focus_bonds)
    result_molecule = convert.annotate(state.molecule, rd) if rd is not None else state.molecule
    return {
        "status": status,
        "messageKey": key,
        "message": message,
        "results": results,
        "issues": final_issues,
        "initialIssues": issues,
        "fixes": state.log,
        "ops": state.ops,
        "molecule": result_molecule,
        "atomMap": state.atom_map,
        "durationMs": int((time.perf_counter() - started) * 1000),
    }


def _entity_results(molecule: Molecule, issues: list[Issue], focus_atoms: list[int], focus_bonds: list[int]) -> list[dict[str, Any]]:
    bonds = focus_bonds or list(range(len(molecule.bonds)))
    atoms = focus_atoms or list(range(len(molecule.atoms)))
    results = []
    for idx in bonds:
        if idx >= len(molecule.bonds):
            continue
        bond = molecule.bonds[idx]
        related = [i for i in issues if i.severity != "info" and (idx in i.bonds or bond.a in i.atoms or bond.b in i.atoms)]
        results.append({
            "kind": "bond", "index": idx, "valid": not any(i.severity == "error" for i in related),
            "reasons": [i.code for i in related] or ["VALID"],
            "explanation": "; ".join(i.message for i in related) or "Bond connected correctly.",
        })
    for idx in atoms:
        if idx >= len(molecule.atoms):
            continue
        related = [i for i in issues if i.severity != "info" and idx in i.atoms]
        results.append({
            "kind": "atom", "index": idx, "valid": not any(i.severity == "error" for i in related),
            "reasons": [i.code for i in related] or ["VALID"],
            "explanation": "; ".join(i.message for i in related) or "Atom valence is valid.",
        })
    return results


def sanitize(molecule: Molecule) -> dict[str, Any]:
    """Report every issue and return the sanitized molecule (aromaticity perceived, metadata filled)."""
    issues, rd = detect(molecule)
    valid = not any(i.severity == "error" for i in issues)
    sanitized = molecule
    if rd is not None:
        perceived_bonds = []
        for bond, rd_bond in zip(molecule.bonds, rd.GetBonds(), strict=True):
            order = "aromatic" if rd_bond.GetIsAromatic() else bond.order if bond.order != "aromatic" else "single"
            perceived_bonds.append(Bond(a=bond.a, b=bond.b, order=order, stereo=bond.stereo))
        sanitized = convert.annotate(molecule.model_copy(update={"bonds": perceived_bonds}), rd)
    implicit = []
    if rd is not None:
        implicit = [{"atom": a.GetIdx(), "implicitH": a.GetNumImplicitHs(), "hybridization": str(a.GetHybridization())}
                    for a in rd.GetAtoms()]
    return {"valid": valid, "issues": issues, "molecule": sanitized, "atoms": implicit}
