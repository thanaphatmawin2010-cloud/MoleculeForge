"""``sim.dock``: AutoDock Vina docking of a ligand onto a (rigid) receptor + interaction analysis.

Ligand and receptor are typed with Meeko (AutoDock atom types, Gasteiger charges). Results
are educational/research estimates: rigid receptor, implicit solvation in the Vina scoring
function, no entropy beyond Vina's torsional term.
"""

from __future__ import annotations

import re
import shutil
import time
import uuid
from typing import Any

import numpy as np
from rdkit import Chem, DataStructs
from rdkit.Chem import AllChem, Crippen, Lipinski, rdFingerprintGenerator

from .. import capabilities, paths
from ..chem import convert
from ..jobs import JobContext, run_process
from ..models import DockParams
from ..rpc import CHEMISTRY_ERROR, ENGINE_UNAVAILABLE, RpcError
from .notes import single

VINA_METHOD = "AutoDock Vina 1.2.7 scoring function"
MAX_RECEPTOR_ATOMS = 5000


def _prepared(molecule: Any, role: str) -> Chem.Mol:
    mol = convert.to_rdkit(molecule)
    if mol.GetNumConformers() == 0 or not mol.GetConformer().Is3D():
        mol = convert.embed_3d(mol)
    else:
        mol = Chem.AddHs(mol, addCoords=True)
    if role == "receptor" and mol.GetNumAtoms() > MAX_RECEPTOR_ATOMS:
        raise RpcError(CHEMISTRY_ERROR, f"Receptor exceeds {MAX_RECEPTOR_ATOMS} atoms", {"code": "TOO_LARGE"})
    return mol


def _pdbqt(mol: Chem.Mol, rigid: bool) -> str:
    from meeko import MoleculePreparation, PDBQTWriterLegacy

    prep = MoleculePreparation(rigid_macrocycles=True, merge_these_atom_types=("H",))
    setups = prep.prepare(mol)
    text, ok, err = PDBQTWriterLegacy.write_string(setups[0])
    if not ok:
        raise RpcError(CHEMISTRY_ERROR, f"Could not type molecule for docking: {err}", {"code": "PDBQT_FAILED"})
    if not rigid:
        return str(text)
    keep = [ln for ln in str(text).splitlines() if ln.startswith(("ATOM", "HETATM"))]
    return "\n".join(keep) + "\n"


def _parse_modes(output: str) -> list[dict[str, float]]:
    modes = []
    for match in re.finditer(r"(?m)^\s+(\d+)\s+(-?\d+\.\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$", output):
        modes.append({"mode": int(match.group(1)), "affinity": float(match.group(2)),
                      "rmsdLowerBound": float(match.group(3)), "rmsdUpperBound": float(match.group(4))})
    return modes


def _contacts(rec: Chem.Mol, lig: Chem.Mol) -> dict[str, Any]:
    rp, lp = rec.GetConformer().GetPositions(), lig.GetConformer().GetPositions()
    from scipy.spatial import cKDTree

    tree = cKDTree(rp)
    hbonds, hydrophobic = [], []
    for i, atom in enumerate(lig.GetAtoms()):
        for j in tree.query_ball_point(lp[i], 4.0):
            ra = rec.GetAtomWithIdx(j)
            d = float(np.linalg.norm(lp[i] - rp[j]))
            pair = {atom.GetSymbol(), ra.GetSymbol()}
            if pair <= {"N", "O"} and d <= 3.5:
                donors = [a for a in (atom, ra) if a.GetTotalNumHs() > 0]
                if donors:
                    hbonds.append({"ligandAtom": i, "receptorAtom": j, "distance": round(d, 3), "unit": "Å"})
            elif atom.GetSymbol() == "C" and ra.GetSymbol() == "C" and d <= 4.0:
                hydrophobic.append({"ligandAtom": i, "receptorAtom": j, "distance": round(d, 3), "unit": "Å"})
    return {"hydrogenBonds": hbonds, "hydrophobicContacts": len(hydrophobic),
            "closestContact": round(float(tree.query(lp)[0].min()), 3)}


def _interaction_energy(rec: Chem.Mol, lig: Chem.Mol) -> dict[str, Any] | None:
    if not (AllChem.MMFFHasAllMoleculeParams(rec) and AllChem.MMFFHasAllMoleculeParams(lig)):
        return None
    complex_ = Chem.CombineMols(rec, lig)
    Chem.SanitizeMol(complex_)

    def energy(m: Chem.Mol) -> float:
        props = AllChem.MMFFGetMoleculeProperties(m)
        return float(AllChem.MMFFGetMoleculeForceField(m, props, ignoreInterfragInteractions=False).CalcEnergy())

    e = energy(complex_) - energy(rec) - energy(lig)
    return {"value": round(e, 3), "unit": "kcal/mol", "method": "MMFF94 single point: E(complex) − E(receptor) − E(ligand), gas phase"}


def _compatibility(rec: Chem.Mol, lig: Chem.Mol) -> dict[str, Any]:
    gen = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
    fa, fb = gen.GetFingerprint(Chem.RemoveHs(rec)), gen.GetFingerprint(Chem.RemoveHs(lig))
    return {
        "tanimotoSimilarity": {"value": round(DataStructs.TanimotoSimilarity(fa, fb), 4), "unit": "", "method": "Morgan r=2, 2048 bits"},
        "donorAcceptorComplementarity": {
            "value": min(Lipinski.NumHDonors(rec), Lipinski.NumHAcceptors(lig)) + min(Lipinski.NumHDonors(lig), Lipinski.NumHAcceptors(rec)),
            "unit": "", "method": "min(HBD_A, HBA_B) + min(HBD_B, HBA_A) (educational heuristic)"},
        "logPDifference": {"value": round(abs(Crippen.MolLogP(rec) - Crippen.MolLogP(lig)), 3), "unit": "", "method": "|ΔlogP| Wildman–Crippen"},
        "chargeProduct": {"value": Chem.GetFormalCharge(rec) * Chem.GetFormalCharge(lig), "unit": "e²", "method": "formal charge product (<0 attractive)"},
    }


def run(params: DockParams, ctx: JobContext) -> dict[str, Any]:
    started = time.perf_counter()
    exe = paths.executable("vina", "vina")
    if exe is None:
        raise RpcError(ENGINE_UNAVAILABLE, "AutoDock Vina is not bundled on this platform", {"engine": "vina"})
    ctx.progress(3, "prepare", "Preparing receptor and ligand", force=True)
    rec = _prepared(params.receptor, "receptor")
    lig = _prepared(params.ligand, "ligand")
    rec_pos = rec.GetConformer().GetPositions()
    center = (rec_pos.max(axis=0) + rec_pos.min(axis=0)) / 2
    lig_extent = float(np.ptp(lig.GetConformer().GetPositions(), axis=0).max())
    size = np.clip(np.ptp(rec_pos, axis=0) + 2 * params.boxPadding + lig_extent / 2, 16.0, 80.0)
    work = paths.scratch_dir() / f"vina-{uuid.uuid4().hex[:10]}"
    work.mkdir(parents=True)
    try:
        (work / "receptor.pdbqt").write_text(_pdbqt(rec, rigid=True), encoding="utf-8")
        (work / "ligand.pdbqt").write_text(_pdbqt(lig, rigid=False), encoding="utf-8")
        args = [str(exe), "--receptor", "receptor.pdbqt", "--ligand", "ligand.pdbqt",
                "--center_x", f"{center[0]:.3f}", "--center_y", f"{center[1]:.3f}", "--center_z", f"{center[2]:.3f}",
                "--size_x", f"{size[0]:.2f}", "--size_y", f"{size[1]:.2f}", "--size_z", f"{size[2]:.2f}",
                "--exhaustiveness", str(params.exhaustiveness), "--num_modes", str(params.numModes),
                "--seed", str(params.seed), "--cpu", str(capabilities.recommended_threads()), "--out", "out.pdbqt"]
        stars = 0

        def on_line(line: str) -> None:
            nonlocal stars
            stars += line.count("*")
            ctx.progress(5 + min(85, stars * 85 / 51), "dock", "Searching poses (Monte Carlo + BFGS)")

        code, output = run_process(ctx, args, cwd=str(work), env=capabilities.engine_env("vina"), timeout=3600, on_line=on_line)
        modes = _parse_modes(output)
        if code != 0 or not modes or not (work / "out.pdbqt").exists():
            raise RpcError(ENGINE_UNAVAILABLE, "Vina docking failed", {"engine": "vina", "log": output[-1200:]})
        out_text = (work / "out.pdbqt").read_text(encoding="utf-8")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    ctx.progress(92, "analyse", "Analysing interactions", force=True)
    from meeko import PDBQTMolecule, RDKitMolCreate

    docked = RDKitMolCreate.from_pdbqt_mol(PDBQTMolecule(out_text, skip_typing=True))[0]
    best = Chem.Mol(docked, confId=docked.GetConformers()[0].GetId())
    best_h = Chem.AddHs(best, addCoords=True)
    contacts = _contacts(rec, best_h)
    inter = _interaction_energy(rec, best_h)
    complex_mol = Chem.CombineMols(rec, best_h)
    Chem.SanitizeMol(complex_mol)
    geometry = convert.from_rdkit(complex_mol, name=f"{params.receptor.name or 'receptor'} + {params.ligand.name or 'ligand'}")
    properties: dict[str, dict[str, Any]] = {
        "bestAffinity": {"value": modes[0]["affinity"], "unit": "kcal/mol", "method": VINA_METHOD, "uncertainty": 2.85},
        "poseCount": {"value": len(modes), "unit": "", "method": VINA_METHOD},
        "hydrogenBondCount": {"value": len(contacts["hydrogenBonds"]), "unit": "", "method": "D···A ≤ 3.5 Å (N, O) with donor H"},
        "hydrophobicContactCount": {"value": contacts["hydrophobicContacts"], "unit": "", "method": "C···C ≤ 4.0 Å"},
        "closestContact": {"value": contacts["closestContact"], "unit": "Å", "method": "minimum interatomic distance"},
        **_compatibility(rec, lig),
    }
    if inter is not None:
        properties["interactionEnergy"] = inter
    ctx.progress(100, "done", "Docking complete", force=True)
    pose_coords = [np.round(conf.GetPositions(), 4).tolist() for conf in docked.GetConformers()]
    return {
        "jobId": ctx.job_id,
        "method": "molecular docking",
        "engine": "AutoDock Vina 1.2.7 + Meeko",
        "forceField": "Vina empirical scoring",
        "hamiltonian": None,
        "converged": True,
        "durationMs": int((time.perf_counter() - started) * 1000),
        "geometry": geometry,
        "properties": properties,
        **single("dockingEstimate"),
        "data": {"modes": modes, "box": {"center": center.round(3).tolist(), "size": size.round(2).tolist(), "unit": "Å"},
                 "poses": pose_coords, "ligandAtomCount": docked.GetNumAtoms(), "receptorAtomCount": rec.GetNumAtoms(),
                 "contacts": contacts},
    }
