"""``sim.minimize``: energy minimisation with a classical force field or a tight-binding method."""

from __future__ import annotations

import time
from typing import Any

import openmm
from openmm import unit
from rdkit import Chem

from ..chem import convert
from ..jobs import JobContext
from ..models import MinimizeParams
from ..rpc import ENGINE_UNAVAILABLE, RpcError
from . import forcefield, openmm_mmff, xtb

OPENMM_THRESHOLD = 1500  # atoms; larger MMFF systems minimise on OpenMM (cutoffs, multithreaded/GPU)


def _prepare(molecule: Any) -> Chem.Mol:
    mol = convert.to_rdkit(molecule)
    if mol.GetNumConformers() == 0 or not mol.GetConformer().Is3D():
        return convert.embed_3d(mol)
    return Chem.AddHs(mol, addCoords=True)


def run(params: MinimizeParams, ctx: JobContext) -> dict[str, Any]:
    started = time.perf_counter()
    mol = _prepare(params.molecule)
    method: str = params.method
    if method == "auto":
        method = forcefield.choose_force_field(mol)
    properties: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    engine = "RDKit"
    converged = False
    if method in ("GFN2-xTB", "GFN-FF"):
        if not xtb.available():
            raise RpcError(ENGINE_UNAVAILABLE, "xtb is not available on this platform", {"engine": "xtb"})
        res = xtb.run(mol, ctx, task="opt", gfn="ff" if method == "GFN-FF" else "2", opt_level="normal", stage="minimize")
        if res.coordinates:
            conf = mol.GetConformer()
            for idx, (x, y, z) in enumerate(res.coordinates):
                conf.SetAtomPosition(idx, (x, y, z))
        engine, converged = f"xtb {res.version}", res.converged
        if res.energy_hartree is not None:
            properties["potentialEnergy"] = {"value": round(res.energy_hartree, 8), "unit": "Eh", "method": method}
        properties.update({k: v for k, v in xtb.as_properties(res).items() if k not in ("totalEnergy",)})
        properties["optimizationCycles"] = {"value": res.cycles, "unit": "", "method": f"{method} ANC optimiser"}
    elif method in ("MMFF94", "MMFF94s") and mol.GetNumAtoms() > OPENMM_THRESHOLD:
        engine, converged = _openmm_minimize(mol, method, params.maxSteps, ctx, properties)
    else:
        result = forcefield.minimize(mol, method, ctx, max_steps=params.maxSteps, stream=params.streamFrames, stage="minimize")
        converged = result.converged
        properties["potentialEnergy"] = {"value": round(result.energy_final, 5), "unit": "kcal/mol", "method": method}
        properties["initialEnergy"] = {"value": round(result.energy_initial, 5), "unit": "kcal/mol", "method": method}
        properties["gradientRms"] = {"value": round(result.gradient_rms, 6), "unit": "kcal/(mol·Å)", "method": method}
        properties["iterations"] = {"value": result.iterations, "unit": "", "method": "RDKit BFGS"}
        if not converged:
            warnings.append(f"Stopped after {params.maxSteps} steps before reaching the gradient tolerance.")
    geometry = convert.from_rdkit(mol, mol_id=params.molecule.id, name=params.molecule.name,
                                  source=params.molecule.meta.source, props=params.molecule.props,
                                  category=params.molecule.meta.category)
    ctx.progress(100, "done", "Minimisation complete", force=True)
    return {
        "jobId": ctx.job_id,
        "method": "energy minimisation",
        "engine": engine,
        "forceField": method if method not in ("GFN2-xTB",) else None,
        "hamiltonian": method if method == "GFN2-xTB" else None,
        "converged": converged,
        "durationMs": int((time.perf_counter() - started) * 1000),
        "geometry": geometry,
        "properties": properties,
        "warnings": warnings,
    }


def _openmm_minimize(mol: Chem.Mol, method: str, max_steps: int, ctx: JobContext, properties: dict[str, Any]) -> tuple[str, bool]:
    system, _ = openmm_mmff.build_system(mol, method)
    platform = openmm_mmff.best_platform()
    context = openmm.Context(system, openmm.VerletIntegrator(0.001), platform)
    context.setPositions(openmm_mmff.positions_nm(mol))
    e0 = context.getState(getEnergy=True).getPotentialEnergy().value_in_unit(unit.kilocalorie_per_mole)

    class Reporter(openmm.MinimizationReporter):  # type: ignore[misc]
        def report(self, iteration, x, grad, args):  # type: ignore[no-untyped-def]
            if ctx.cancelled:
                return True
            if iteration % 10 == 0:
                ctx.progress(min(95.0, 100 * iteration / max_steps), "minimize", f"OpenMM L-BFGS iteration {iteration}")
            return False

    openmm.LocalEnergyMinimizer.minimize(context, 0.5, max_steps, Reporter())
    ctx.check()
    state = context.getState(getEnergy=True, getPositions=True, getForces=True)
    e1 = state.getPotentialEnergy().value_in_unit(unit.kilocalorie_per_mole)
    pos = state.getPositions(asNumpy=True).value_in_unit(unit.angstrom)
    conf = mol.GetConformer()
    for idx, (x, y, z) in enumerate(pos):
        conf.SetAtomPosition(idx, (float(x), float(y), float(z)))
    import numpy as np

    forces = np.asarray(state.getForces(asNumpy=True).value_in_unit(unit.kilocalorie_per_mole / unit.angstrom))
    grms = float(np.sqrt((forces**2).mean()))
    properties["potentialEnergy"] = {"value": round(e1, 5), "unit": "kcal/mol", "method": f"{method} (OpenMM, 1.2 nm cutoff)"}
    properties["initialEnergy"] = {"value": round(e0, 5), "unit": "kcal/mol", "method": method}
    properties["gradientRms"] = {"value": round(grms, 6), "unit": "kcal/(mol·Å)", "method": method}
    name = platform.getName()
    del context
    return f"OpenMM ({name})", grms < 0.5
