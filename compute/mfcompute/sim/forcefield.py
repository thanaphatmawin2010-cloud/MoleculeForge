"""Classical force-field minimisation (MMFF94 / MMFF94s / UFF via RDKit) with live frame streaming."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem
from rdkit.ForceField import rdForceField

from ..jobs import JobContext
from ..rpc import CHEMISTRY_ERROR, RpcError

LARGE_SYSTEM = 300  # atoms; above this the static non-bonded list is truncated at 9 Å


@dataclass
class MinimizationResult:
    method: str
    converged: bool
    iterations: int
    energy_initial: float
    energy_final: float
    gradient_rms: float
    duration_ms: int
    frames: int = 0
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "converged": self.converged,
            "iterations": self.iterations,
            "energyInitial": round(self.energy_initial, 6),
            "energyFinal": round(self.energy_final, 6),
            "energyUnit": "kcal/mol",
            "gradientRms": round(self.gradient_rms, 6),
            "gradientUnit": "kcal/(mol·Å)",
            "durationMs": self.duration_ms,
            "notes": self.notes,
        }


def choose_force_field(mol: Chem.Mol, preference: str = "auto") -> str:
    """Pick MMFF94 when every atom is MMFF-typable, otherwise UFF (all elements up to Lr)."""
    if preference in ("MMFF94", "MMFF94s"):
        if AllChem.MMFFHasAllMoleculeParams(mol):
            return preference
        preference = "auto"
    if preference == "UFF":
        if AllChem.UFFHasAllMoleculeParams(mol):
            return "UFF"
        raise RpcError(CHEMISTRY_ERROR, "UFF has no parameters for at least one atom in this structure", {"code": "NO_FF_PARAMS"})
    if AllChem.MMFFHasAllMoleculeParams(mol):
        return "MMFF94"
    if AllChem.UFFHasAllMoleculeParams(mol):
        return "UFF"
    raise RpcError(
        CHEMISTRY_ERROR,
        "No classical force field covers every element in this structure (UFF stops at Lr, Z=103)",
        {"code": "NO_FF_PARAMS"},
    )


def build_force_field(mol: Chem.Mol, method: str, conf_id: int = -1) -> rdForceField.ForceField:
    thresh = 9.0 if mol.GetNumAtoms() > LARGE_SYSTEM else 100.0
    if method in ("MMFF94", "MMFF94s"):
        props = AllChem.MMFFGetMoleculeProperties(mol, mmffVariant=method)
        if props is None:
            raise RpcError(CHEMISTRY_ERROR, "MMFF typing failed", {"code": "NO_FF_PARAMS"})
        ff = AllChem.MMFFGetMoleculeForceField(mol, props, nonBondedThresh=thresh, confId=conf_id, ignoreInterfragInteractions=False)
    else:
        ff = AllChem.UFFGetMoleculeForceField(mol, vdwThresh=4.0 if thresh < 100 else 10.0, confId=conf_id, ignoreInterfragInteractions=False)
    if ff is None:
        raise RpcError(CHEMISTRY_ERROR, f"Could not set up {method}", {"code": "NO_FF_PARAMS"})
    ff.Initialize()
    return ff


def gradient_rms(ff: rdForceField.ForceField) -> float:
    grad = np.asarray(ff.CalcGrad(), dtype=float)
    return float(np.sqrt(np.mean(grad**2))) if grad.size else 0.0


def coordinates(mol: Chem.Mol, conf_id: int = -1) -> list[list[float]]:
    pos = mol.GetConformer(conf_id).GetPositions()
    return [[round(float(x), 5), round(float(y), 5), round(float(z), 5)] for x, y, z in pos]


def minimize(
    mol: Chem.Mol,
    method: str,
    ctx: JobContext,
    *,
    max_steps: int = 2000,
    stream: bool = True,
    stage: str = "minimize",
    percent_from: float = 0.0,
    percent_to: float = 100.0,
    force_tol: float = 1e-4,
    energy_tol: float = 1e-7,
) -> MinimizationResult:
    """Minimise in place (conformer coordinates are updated), streaming intermediate frames."""
    started = time.perf_counter()
    ff = build_force_field(mol, method)
    e0 = float(ff.CalcEnergy())
    chunk = 25 if mol.GetNumAtoms() < 200 else 10
    done = 0
    converged = False
    frames = 0
    while done < max_steps:
        ctx.check()
        steps = min(chunk, max_steps - done)
        status = ff.Minimize(maxIts=steps, forceTol=force_tol, energyTol=energy_tol)
        done += steps
        converged = status == 0
        fraction = min(1.0, done / max_steps) if not converged else 1.0
        percent = percent_from + (percent_to - percent_from) * fraction
        data = None
        if stream:
            data = {"frame": coordinates(mol), "energy": round(float(ff.CalcEnergy()), 5), "unit": "kcal/mol", "method": method, "step": done}
            frames += 1
        ctx.progress(percent, stage, f"{method}: step {done}", data)
        if converged:
            break
    e1 = float(ff.CalcEnergy())
    return MinimizationResult(
        method=method,
        converged=converged,
        iterations=done,
        energy_initial=e0,
        energy_final=e1,
        gradient_rms=gradient_rms(ff),
        duration_ms=int((time.perf_counter() - started) * 1000),
        frames=frames,
    )


def energy(mol: Chem.Mol, method: str) -> float:
    return float(build_force_field(mol, method).CalcEnergy())
