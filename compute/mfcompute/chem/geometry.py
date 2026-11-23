"""One-click structure repair (``chem.repairGeometry``) and geometric analysis helpers.

Pipeline: detect → auto-correct chemistry → perceive hybridisation/VSEPR → add hydrogens →
choose starting coordinates (keep usable user geometry, else ETKDGv3) → minimise (MMFF94,
UFF fallback) → optional GFN2-xTB refinement → diff + report.

Idempotency: when the input is already chemically valid with a usable geometry, only the
final-stage method is run from the current coordinates; if the structure moves less than
``OPTIMAL_RMSD`` the original coordinates are returned unchanged and the report says
``already-optimal``.
"""

from __future__ import annotations

import contextlib
import math
import time
from typing import Any

import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem

from ..jobs import JobContext
from ..models import Molecule
from ..rpc import RpcError
from ..sim import forcefield, xtb
from . import convert, reference, validate

OPTIMAL_RMSD = 0.02  # Å
# MMFF94 lacks parameters for some species (e.g. cumulated C=O in CO2, where it falls back to an
# empirical 1.405 Å rule), so "auto" refinement finishes small/medium systems with GFN2-xTB.
AUTO_XTB_MAX_ATOMS = 300
OPTIMAL_DE = 0.05  # kcal/mol
MAX_LISTED_CHANGES = 2000
HYBRID_STERIC = {
    Chem.HybridizationType.SP: 2,
    Chem.HybridizationType.SP2: 3,
    Chem.HybridizationType.SP3: 4,
    Chem.HybridizationType.SP3D: 5,
    Chem.HybridizationType.SP3D2: 6,
}
HYBRID_LABEL = {
    Chem.HybridizationType.S: "s",
    Chem.HybridizationType.SP: "sp",
    Chem.HybridizationType.SP2: "sp2",
    Chem.HybridizationType.SP3: "sp3",
    Chem.HybridizationType.SP3D: "sp3d",
    Chem.HybridizationType.SP3D2: "sp3d2",
}


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------


def _angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    u, v = a - b, c - b
    cosang = float(np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-12))
    return math.degrees(math.acos(max(-1.0, min(1.0, cosang))))


def _dihedral(p0: np.ndarray, p1: np.ndarray, p2: np.ndarray, p3: np.ndarray) -> float:
    b0, b1, b2 = p0 - p1, p2 - p1, p3 - p2
    b1n = b1 / (np.linalg.norm(b1) + 1e-12)
    v = b0 - np.dot(b0, b1n) * b1n
    w = b2 - np.dot(b2, b1n) * b1n
    x = float(np.dot(v, w))
    y = float(np.dot(np.cross(b1n, v), w))
    return math.degrees(math.atan2(y, x))


def measure(mol: Chem.Mol, conf_id: int = -1) -> dict[str, list[dict[str, Any]]]:
    pos = mol.GetConformer(conf_id).GetPositions()
    symbols = [a.GetSymbol() for a in mol.GetAtoms()]
    bonds, angles, dihedrals = [], [], []
    for bond in mol.GetBonds():
        i, j = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        order = "aromatic" if bond.GetIsAromatic() else {Chem.BondType.DOUBLE: "double", Chem.BondType.TRIPLE: "triple"}.get(bond.GetBondType(), "single")
        bonds.append({"atoms": [i, j], "elements": [symbols[i], symbols[j]], "order": order,
                      "value": float(np.linalg.norm(pos[i] - pos[j]))})
    for atom in mol.GetAtoms():
        j = atom.GetIdx()
        nbrs = sorted(n.GetIdx() for n in atom.GetNeighbors())
        for x in range(len(nbrs)):
            for y in range(x + 1, len(nbrs)):
                i, k = nbrs[x], nbrs[y]
                angles.append({"atoms": [i, j, k], "elements": [symbols[i], symbols[j], symbols[k]],
                               "value": _angle(pos[i], pos[j], pos[k])})
    for bond in mol.GetBonds():
        j, k = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        for ni in mol.GetAtomWithIdx(j).GetNeighbors():
            i = ni.GetIdx()
            if i == k:
                continue
            for nl in mol.GetAtomWithIdx(k).GetNeighbors():
                l_idx = nl.GetIdx()
                if l_idx in (j, i):
                    continue
                dihedrals.append({"atoms": [i, j, k, l_idx], "elements": [symbols[i], symbols[j], symbols[k], symbols[l_idx]],
                                  "value": _dihedral(pos[i], pos[j], pos[k], pos[l_idx])})
    return {"bonds": bonds, "angles": angles, "dihedrals": dihedrals}


def perceive(mol: Chem.Mol) -> list[dict[str, Any]]:
    """Hybridisation, steric number, lone pairs and VSEPR class for every non-terminal heavy atom."""
    ring_info = mol.GetRingInfo()
    out = []
    for atom in mol.GetAtoms():
        if atom.GetAtomicNum() == 1:
            continue
        sigma = atom.GetDegree()
        hyb = atom.GetHybridization()
        steric = HYBRID_STERIC.get(hyb)
        lone_pairs = max(0, steric - sigma) if steric is not None else 0
        vclass = reference.vsepr_class(sigma, lone_pairs) if sigma >= 2 else None
        ideal = reference.VSEPR_ANGLES.get(vclass) if vclass else None
        small_ring = ring_info.MinAtomRingSize(atom.GetIdx()) if ring_info.NumAtomRings(atom.GetIdx()) else 0
        out.append({
            "atom": atom.GetIdx(),
            "element": atom.GetSymbol(),
            "hybridization": HYBRID_LABEL.get(hyb, str(hyb).lower()),
            "stericNumber": steric,
            "sigmaBonds": sigma,
            "lonePairs": lone_pairs,
            "vsepr": vclass,
            "idealAngle": ideal[0] if ideal else None,
            "aromatic": atom.GetIsAromatic(),
            "smallestRing": small_ring or None,
        })
    return out


def kabsch_rmsd(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) == 0:
        return 0.0
    pa = a - a.mean(axis=0)
    pb = b - b.mean(axis=0)
    h = pa.T @ pb
    u, _s, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    corr = np.diag([1.0, 1.0, d])
    rot = vt.T @ corr @ u.T
    diff = (rot @ pa.T).T - pb
    return float(np.sqrt((diff**2).sum() / len(a)))


# ---------------------------------------------------------------------------
# Repair pipeline
# ---------------------------------------------------------------------------


def _usable_geometry(molecule: Molecule) -> bool:
    if not convert.is_3d(molecule):
        return False
    issues = validate.geometry_issues(molecule)
    if any(i.code in ("ATOMS_OVERLAP", "CLASH") for i in issues):
        return False
    long_or_short = sum(1 for i in issues if i.code in ("BOND_TOO_LONG", "BOND_TOO_SHORT"))
    return long_or_short == 0


def _diff(before: dict[str, list[dict[str, Any]]], after: dict[str, list[dict[str, Any]]], mapping: dict[int, int],
          method: str) -> dict[str, Any]:
    def keyed(items: list[dict[str, Any]], remap: bool) -> dict[tuple[int, ...], dict[str, Any]]:
        out = {}
        for item in items:
            atoms = [mapping.get(a, -1) for a in item["atoms"]] if remap else item["atoms"]
            if -1 in atoms:
                continue
            key = tuple(atoms)
            out[key if key[0] <= key[-1] else key[::-1]] = item
        return out

    result: dict[str, Any] = {}
    for kind, unit, threshold in (("bonds", "Å", 0.005), ("angles", "°", 0.5), ("dihedrals", "°", 2.0)):
        old = keyed(before[kind], True)
        new = keyed(after[kind], False)
        changes = []
        for key, item in new.items():
            if key not in old:
                continue
            delta = item["value"] - old[key]["value"]
            if kind == "dihedrals":
                delta = (delta + 180.0) % 360.0 - 180.0
            if abs(delta) >= threshold:
                changes.append({
                    "atoms": list(key), "elements": item["elements"],
                    "old": round(old[key]["value"], 4), "new": round(item["value"], 4),
                    "delta": round(delta, 4), "unit": unit, "rule": method,
                    **({"order": item["order"]} if kind == "bonds" else {}),
                })
        changes.sort(key=lambda c: -abs(c["delta"]))
        result[kind] = changes[:MAX_LISTED_CHANGES]
        result[f"{kind}Total"] = len(changes)
    return result


def geometry_tables(mol: Chem.Mol) -> dict[str, Any]:
    data = measure(mol)
    cumulated = {a.GetIdx() for a in mol.GetAtoms()
                 if a.GetAtomicNum() == 6 and a.GetDegree() == 2 and all(b.GetBondType() == Chem.BondType.DOUBLE for b in a.GetBonds())}
    groups: dict[str, dict[str, Any]] = {}
    for bond in data["bonds"]:
        el_a, el_b = bond["elements"]
        is_cum = bond["atoms"][0] in cumulated or bond["atoms"][1] in cumulated
        ref = reference.bond_reference(el_a, el_b, bond["order"], cumulated=is_cum)
        a, b = sorted((el_a, el_b))
        label = f"{a}–{b} ({bond['order']}{', cumulated' if is_cum and ref is reference.CUMULATED_CO else ''})"
        g = groups.setdefault(label, {"type": label, "values": [], "reference": ref})
        g["values"].append(bond["value"])
    bond_table = []
    for g in groups.values():
        vals = np.array(g["values"])
        ref = g["reference"]
        within = bool(np.all(np.abs(vals - ref.typical) <= 0.10 * ref.typical))
        bond_table.append({
            "type": g["type"], "count": int(vals.size), "mean": round(float(vals.mean()), 4),
            "min": round(float(vals.min()), 4), "max": round(float(vals.max()), 4), "unit": "Å",
            "reference": {"typical": ref.typical, "low": ref.low, "high": ref.high, "source": ref.source},
            "withinTenPercent": within, "withinRange": bool(np.all((vals >= ref.low - 0.02) & (vals <= ref.high + 0.02))),
        })
    perceived = {p["atom"]: p for p in perceive(mol)}
    angle_groups: dict[str, list[float]] = {}
    strained: list[float] = []
    for ang in data["angles"]:
        center = ang["atoms"][1]
        info = perceived.get(center)
        if info is None or info["vsepr"] is None:
            continue
        if info["smallestRing"] and info["smallestRing"] <= 4:
            strained.append(ang["value"])
            continue
        if info["vsepr"] in ("AX5", "AX6", "AX4E", "AX3E2", "AX4E2"):
            continue  # multiple ideal angles; reported per atom in the hybridisation table
        angle_groups.setdefault(info["vsepr"], []).append(ang["value"])
    angle_table = []
    for cls, values in sorted(angle_groups.items()):
        ideal, low, high = reference.VSEPR_ANGLES[cls]
        vals = np.array(values)
        angle_table.append({
            "class": cls, "count": int(vals.size), "mean": round(float(vals.mean()), 3), "min": round(float(vals.min()), 3),
            "max": round(float(vals.max()), 3), "unit": "°", "ideal": ideal, "range": [low, high],
            "withinTenPercent": bool(np.all(np.abs(vals - ideal) <= 0.10 * ideal)),
        })
    if strained:
        vals = np.array(strained)
        angle_table.append({"class": "small-ring (strained)", "count": int(vals.size), "mean": round(float(vals.mean()), 3),
                            "min": round(float(vals.min()), 3), "max": round(float(vals.max()), 3), "unit": "°",
                            "ideal": None, "range": None, "withinTenPercent": True})
    pos = mol.GetConformer().GetPositions()
    min_nb = {"value": None, "unit": "Å", "atoms": None}
    if len(pos) > 1:
        from scipy.spatial import cKDTree

        excluded = set()
        for bond in mol.GetBonds():
            excluded.add((min(bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()), max(bond.GetBeginAtomIdx(), bond.GetEndAtomIdx())))
        for atom in mol.GetAtoms():
            nbrs = [n.GetIdx() for n in atom.GetNeighbors()]
            for x in range(len(nbrs)):
                for y in range(x + 1, len(nbrs)):
                    excluded.add((min(nbrs[x], nbrs[y]), max(nbrs[x], nbrs[y])))
        tree = cKDTree(pos)
        best = math.inf
        for i, j in tree.query_pairs(3.0):
            if (i, j) in excluded:
                continue
            d = float(np.linalg.norm(pos[i] - pos[j]))
            if d < best:
                best, min_nb["atoms"] = d, [int(i), int(j)]
        if math.isfinite(best):
            min_nb["value"] = round(best, 4)
    return {"bondTable": sorted(bond_table, key=lambda r: r["type"]), "angleTable": angle_table, "minNonBondedDistance": min_nb}


def repair(molecule: Molecule, *, refine: str, force_field: str, ctx: JobContext) -> dict[str, Any]:
    started = time.perf_counter()
    methods: list[dict[str, Any]] = []
    ctx.progress(2, "detect", "Checking valence, charges and aromaticity", force=True)
    initial_issues, _ = validate.detect(molecule)
    fix = validate.validate(molecule, [], [], True)
    fixed: Molecule = fix["molecule"]
    if fix["status"] == "invalid":
        return {
            "status": "failed",
            "reason": fix["message"],
            "issuesFound": initial_issues,
            "fixesApplied": fix["fixes"],
            "remainingIssues": [i for i in fix["issues"] if i.severity == "error"],
            "molecule": fixed,
            "durationMs": int((time.perf_counter() - started) * 1000),
        }
    methods.append({"stage": "sanitize", "method": "RDKit sanitisation + MoleculeForge minimal-fix rules",
                    "details": f"{len(fix['fixes'])} automatic correction(s)"})
    atom_map = {old: new for old, new in enumerate(fix["atomMap"]) if new >= 0}

    ctx.progress(8, "perceive", "Perceiving hybridisation and VSEPR geometry", force=True)
    rd = convert.to_rdkit(fixed)
    before_measure: dict[str, list[dict[str, Any]]] = {"bonds": [], "angles": [], "dihedrals": []}
    if molecule.atoms and not any(i.code in ("SELF_BOND", "DUPLICATE_BOND", "UNKNOWN_ELEMENT") for i in initial_issues):
        with contextlib.suppress(Exception):  # an unmeasurable input simply yields no "before" values
            before_measure = measure(convert.to_rdkit(molecule, sanitize=False))
    usable = _usable_geometry(fixed)
    n_before = rd.GetNumAtoms()
    rd_h = Chem.AddHs(rd, addCoords=rd.GetConformer().Is3D() if rd.GetNumConformers() else False)
    added = list(range(n_before, rd_h.GetNumAtoms()))
    methods.append({"stage": "perceive", "method": "RDKit hybridisation + VSEPR (Gillespie) domain counting", "details": ""})
    chemically_clean = not any(i.severity == "error" for i in initial_issues)

    try:
        ff_name: str | None = forcefield.choose_force_field(rd_h, force_field)
    except RpcError:
        ff_name = None  # e.g. octahedral S in SF6 or tetrahedral Os(VIII): no UFF atom type
    xtb_ok = xtb.available() and xtb.supports(rd_h)
    use_xtb = xtb_ok and (
        refine == "gfn2-xtb" or ff_name is None or (refine == "auto" and rd_h.GetNumAtoms() <= AUTO_XTB_MAX_ATOMS)
    )
    if ff_name is None and not use_xtb:
        return {
            "status": "failed",
            "reason": "No force field or tight-binding method in MoleculeForge covers every element in this structure.",
            "issuesFound": initial_issues, "fixesApplied": fix["fixes"], "remainingIssues": [], "molecule": fixed,
            "durationMs": int((time.perf_counter() - started) * 1000),
        }
    final_method = "GFN2-xTB" if use_xtb else str(ff_name)
    if refine == "gfn2-xtb" and final_method != "GFN2-xTB":
        methods.append({"stage": "refine", "method": "GFN2-xTB", "details": "skipped: engine unavailable or element outside H–Rn"})
    if ff_name is None:
        methods.append({"stage": "minimize", "method": "classical force field", "details": "skipped: no MMFF94/UFF atom types; GFN2-xTB used directly"})

    start_coords = rd_h.GetConformer().GetPositions().copy()
    embedded = False
    if not (usable and not added) and (not usable or not rd_h.GetConformer().Is3D()):
        ctx.progress(15, "embed", "Generating 3D coordinates (ETKDGv3)", force=True)
        rd_h = convert.embed_3d(rd_h, keep_existing=False)
        embedded = True
        added = list(range(n_before, rd_h.GetNumAtoms()))
        methods.append({"stage": "embed", "method": "RDKit ETKDGv3 distance geometry", "details": f"random seed {convert.EMBED_SEED}"})
    candidate_optimal = chemically_clean and usable and not added and not embedded
    total_cycles = 0
    ff_result = None
    if ff_name is not None and (final_method != "GFN2-xTB" or embedded or added or not usable):
        ff_result = forcefield.minimize(rd_h, ff_name, ctx, max_steps=5000, stage="minimize", percent_from=25, percent_to=70)
        methods.append({"stage": "minimize", "method": ff_name, "details": f"{ff_result.iterations} steps, converged={ff_result.converged}"})
    xtb_result = None
    xtb_start_energy: float | None = None
    if final_method == "GFN2-xTB" and rd_h.GetNumAtoms() > 1:
        if candidate_optimal:
            xtb_start_energy = xtb.run(rd_h, ctx, task="sp", gfn="2", percent_from=60, percent_to=70, stage="refine").energy_hartree
        total_cycles = 0
        for attempt in range(3):  # restart from the last geometry until the optimiser reports convergence
            xtb_result = xtb.run(rd_h, ctx, task="opt", gfn="2", opt_level="tight", percent_from=70 + 8 * attempt,
                                 percent_to=78 + 8 * attempt, stage="refine")
            total_cycles += xtb_result.cycles
            if xtb_result.coordinates:
                conf = rd_h.GetConformer()
                for idx, (x, y, z) in enumerate(xtb_result.coordinates):
                    conf.SetAtomPosition(idx, (x, y, z))
            if xtb_result.converged:
                break
        methods.append({"stage": "refine", "method": "GFN2-xTB (ANC optimiser, tight)",
                        "details": f"{total_cycles} cycles, converged={xtb_result.converged}"})

    final_coords = rd_h.GetConformer().GetPositions()
    common = min(len(start_coords), len(final_coords))
    rmsd = kabsch_rmsd(np.asarray(start_coords[:common]), np.asarray(final_coords[:common])) if not embedded else None
    if xtb_result is not None and xtb_start_energy is not None and xtb_result.energy_hartree is not None:
        energy_change = abs(xtb_start_energy - xtb_result.energy_hartree) * xtb.HARTREE_TO_KCAL
    elif ff_result is not None:
        energy_change = abs(ff_result.energy_final - ff_result.energy_initial)
    else:
        energy_change = 0.0
    # "Already optimal" = nothing material changes: either the atoms barely move, or they drift along a
    # flat coordinate (e.g. a free benzyl rotation) with a negligible energy change.
    already_optimal = candidate_optimal and rmsd is not None and (rmsd < OPTIMAL_RMSD or energy_change < OPTIMAL_DE)
    if already_optimal:
        final_molecule = molecule
        rd_report = convert.to_rdkit(molecule)
    else:
        final_molecule = convert.from_rdkit(rd_h, mol_id=molecule.id, name=molecule.name, source=molecule.meta.source,
                                            props=molecule.props, category=molecule.meta.category)
        # Re-embedding keeps the input's stereocentres; a connectivity fix may not, so it resets the origin.
        kept = molecule.meta.stereo if not fix["fixes"] else ""
        final_molecule = final_molecule.model_copy(update={"meta": final_molecule.meta.model_copy(update={"stereo": kept})})
        rd_report = rd_h
    ctx.progress(97, "report", "Writing repair report", force=True)
    after_measure = measure(rd_report)
    changes = {"bonds": [], "angles": [], "dihedrals": [], "bondsTotal": 0, "anglesTotal": 0, "dihedralsTotal": 0}
    if not already_optimal and before_measure["bonds"]:
        changes = _diff(before_measure, after_measure, atom_map, final_method)
    tables = geometry_tables(rd_report)
    final_issues, _ = validate.detect(final_molecule)
    residual: dict[str, Any]
    if xtb_result is not None and xtb_result.energy_hartree is not None:
        residual = {"value": round(xtb_result.energy_hartree, 8), "unit": "Eh", "method": "GFN2-xTB total energy"}
    else:
        if ff_name is not None:
            residual = {"value": round(forcefield.energy(rd_report, ff_name), 6), "unit": "kcal/mol", "method": f"{ff_name} potential energy"}
        else:
            residual = {"value": None, "unit": "kcal/mol", "method": "not applicable (single atom or no energy model)"}
    report = {
        "status": "already-optimal" if already_optimal else "repaired",
        "molecule": final_molecule,
        "issuesFound": initial_issues,
        "fixesApplied": fix["fixes"],
        "hybridization": perceive(rd_report),
        "changes": {**changes, "addedAtoms": [] if already_optimal else [
            {"atom": i, "element": rd_report.GetAtomWithIdx(i).GetSymbol(), "reason": "implicit hydrogen made explicit"}
            for i in added if i < rd_report.GetNumAtoms()
        ], "removedAtoms": [{"atom": old, "reason": "removed by valence fix"} for old, new in enumerate(fix["atomMap"]) if new < 0]},
        "methods": methods,
        "convergence": {
            "forceField": ff_result.as_dict() if ff_result else None,
            "xtb": {"method": "GFN2-xTB", "converged": xtb_result.converged, "cycles": total_cycles,
                    "energy": xtb_result.energy_hartree, "unit": "Eh"} if xtb_result else None,
        },
        "residualEnergy": residual,
        "rmsd": {"value": round(rmsd, 4) if rmsd is not None else None, "unit": "Å",
                 "note": "Kabsch-aligned RMSD between input and output coordinates" if rmsd is not None else "new coordinates generated"},
        "geometryCheck": tables,
        "finalIssues": final_issues,
        "atomMap": fix["atomMap"],
        "durationMs": int((time.perf_counter() - started) * 1000),
    }
    ctx.progress(100, "done", "Repair complete", force=True)
    return report


def _break_symmetry(mol: Chem.Mol, amplitude: float = 0.02) -> None:
    """Nudge every atom by a tiny, reproducible amount (seeded).

    Sketched input is often exactly planar or linear (H-O-H drawn at 180 degrees); there the
    bending gradient vanishes by symmetry and a minimiser would stay on the saddle point.
    """
    if mol.GetNumConformers() == 0:
        return
    conf = mol.GetConformer()
    pos = conf.GetPositions() + np.random.default_rng(convert.EMBED_SEED).normal(scale=amplitude, size=(mol.GetNumAtoms(), 3))
    for i, p in enumerate(pos):
        conf.SetAtomPosition(i, p.tolist())


def quick_relax(molecule: Molecule, ctx: JobContext, max_steps: int = 300, add_hydrogens: bool = False) -> Molecule:
    """Fast local relaxation for live editing feedback (no embedding, no report).

    Implicit hydrogens are included in the force field so heavy-atom geometry is realistic, then
    dropped again unless ``add_hydrogens`` is set, so the document's atom list never changes
    underneath the editor. Frames are streamed for the original atoms only.
    """
    n_original = len(molecule.atoms)
    rd = convert.to_rdkit(molecule)
    has_coords = rd.GetNumConformers() > 0 and rd.GetConformer().Is3D()
    rd_h = Chem.AddHs(rd, addCoords=True) if has_coords else convert.embed_3d(rd)
    try:
        ff = forcefield.choose_force_field(rd_h)
    except RpcError:
        return molecule
    _break_symmetry(rd_h)
    stream_ctx = ctx
    if not add_hydrogens:
        def forward(method: str, params: dict[str, Any]) -> None:
            data = params.get("data")
            if method == "progress" and isinstance(data, dict) and isinstance(data.get("frame"), list):
                params = {**params, "data": {**data, "frame": data["frame"][:n_original]}}
            if ctx_emit is not None:
                ctx_emit(method, params)

        ctx_emit = ctx._emit
        stream_ctx = ctx.derive(forward)
    forcefield.minimize(rd_h, ff, stream_ctx, max_steps=max_steps, stream=True, stage="relax")
    if not add_hydrogens:
        rw = Chem.RWMol(rd_h)
        for idx in sorted(range(n_original, rd_h.GetNumAtoms()), reverse=True):
            rw.RemoveAtom(idx)
        rd_out = rw.GetMol()
        rd_out.UpdatePropertyCache(strict=False)
        relaxed = rd_out.GetConformer().GetPositions()
        atoms = [a.model_copy(update={"x": round(float(p[0]), 6), "y": round(float(p[1]), 6), "z": round(float(p[2]), 6)})
                 for a, p in zip(molecule.atoms, relaxed, strict=True)]
        return molecule.model_copy(update={"atoms": atoms})
    AllChem.AssignStereochemistryFrom3D(rd_h)
    return convert.from_rdkit(rd_h, mol_id=molecule.id, name=molecule.name, source=molecule.meta.source,
                              props=molecule.props, category=molecule.meta.category)
