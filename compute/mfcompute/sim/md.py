"""Molecular dynamics (``sim.md``): Langevin dynamics with OpenMM (MMFF94) or an RDKit-UFF BAOAB
integrator for molecules MMFF cannot type (metals, main-group exotica)."""

from __future__ import annotations

import math
import time
from typing import Any

import numpy as np
import openmm
from openmm import unit
from rdkit import Chem
from rdkit.Chem import AllChem, rdMolDescriptors

from ..chem import convert
from ..jobs import JobContext
from ..models import MdParams
from . import forcefield, openmm_mmff
from .notes import single

KB_KCAL = 0.0019872043  # kcal/(mol·K)
R_J = 8.314462618  # J/(mol·K)
MAX_FRAMES = 200


def _prepare(params: MdParams) -> Chem.Mol:
    mol = convert.to_rdkit(params.molecule)
    if mol.GetNumConformers() == 0 or not mol.GetConformer().Is3D():
        mol = convert.embed_3d(mol)
    else:
        mol = Chem.AddHs(mol, addCoords=True)
    return mol


def _block_error(series: np.ndarray, blocks: int = 5) -> float:
    if series.size < blocks * 2:
        return float(series.std(ddof=1) / math.sqrt(max(1, series.size))) if series.size > 1 else 0.0
    means = np.array([b.mean() for b in np.array_split(series, blocks)])
    return float(means.std(ddof=1) / math.sqrt(blocks))


def _summarise(times_ps: list[float], epot: list[float], ekin: list[float], temps: list[float], rg: list[float],
               dof: int, temperature: float) -> dict[str, Any]:
    burn = max(1, len(epot) // 5)  # discard first 20% as equilibration
    ep = np.array(epot[burn:])
    ek = np.array(ekin[burn:])
    et = ep + ek
    tt = np.array(temps[burn:])
    var = float(et.var(ddof=1)) if et.size > 1 else 0.0
    cv_kcal = var / (KB_KCAL * temperature**2)  # kcal/(mol·K), canonical-ensemble fluctuation formula
    cv = cv_kcal * 4184.0
    return {
        "averagePotentialEnergy": {"value": round(float(ep.mean()), 4), "unit": "kcal/mol", "uncertainty": round(_block_error(ep), 4)},
        "averageKineticEnergy": {"value": round(float(ek.mean()), 4), "unit": "kcal/mol", "uncertainty": round(_block_error(ek), 4)},
        "averageTotalEnergy": {"value": round(float(et.mean()), 4), "unit": "kcal/mol", "uncertainty": round(_block_error(et), 4)},
        "averageTemperature": {"value": round(float(tt.mean()), 2), "unit": "K", "uncertainty": round(_block_error(tt), 2)},
        "temperatureStdDev": {"value": round(float(tt.std(ddof=1)) if tt.size > 1 else 0.0, 2), "unit": "K"},
        "heatCapacityCv": {"value": round(cv, 2), "unit": "J/(mol·K)", "uncertainty": None,
                           "note": "from total-energy fluctuations ⟨δE²⟩/(k_B T²); converges slowly for short runs"},
        "averageRadiusOfGyration": {"value": round(float(np.mean(rg[burn:])), 4), "unit": "Å"},
        "degreesOfFreedom": {"value": dof, "unit": ""},
        "equipartitionKineticEnergy": {"value": round(0.5 * dof * KB_KCAL * temperature, 4), "unit": "kcal/mol"},
        "timeSeries": {"timePs": [round(t, 4) for t in times_ps], "potential": [round(x, 4) for x in epot],
                       "kinetic": [round(x, 4) for x in ekin], "temperature": [round(x, 2) for x in temps],
                       "radiusOfGyration": [round(x, 4) for x in rg]},
    }


def _rg(pos: np.ndarray, masses: np.ndarray) -> float:
    com = (pos * masses[:, None]).sum(axis=0) / masses.sum()
    return float(math.sqrt(((pos - com) ** 2 * masses[:, None]).sum() / masses.sum()))


def run(params: MdParams, ctx: JobContext) -> dict[str, Any]:
    started = time.perf_counter()
    mol = _prepare(params)
    n = mol.GetNumAtoms()
    masses = np.array([a.GetMass() for a in mol.GetAtoms()])
    reports = max(1, params.steps // params.reportEvery)
    frame_stride = max(1, reports // MAX_FRAMES)
    dof = 3 * n - 3 if n > 1 else 3
    if AllChem.MMFFHasAllMoleculeParams(mol):
        engine, ff = "OpenMM", "MMFF94"
        result = _run_openmm(mol, params, ctx, masses, frame_stride, dof)
    else:
        ff = forcefield.choose_force_field(mol, "UFF")
        engine = "MoleculeForge BAOAB (RDKit UFF forces)"
        if n > 400:
            from ..rpc import TOO_LARGE, RpcError

            raise RpcError(TOO_LARGE, "UFF dynamics is limited to 400 atoms; MMFF-typable systems run on OpenMM", {"atoms": n})
        result = _run_uff(mol, params, ctx, masses, frame_stride, dof)
    frames, times, epot, ekin, temps, rgs, final_pos, platform = result
    conf = mol.GetConformer()
    for idx, (x, y, z) in enumerate(final_pos):
        conf.SetAtomPosition(idx, (float(x), float(y), float(z)))
    summary = _summarise(times, epot, ekin, temps, rgs, dof, params.temperatureK)
    geometry = convert.from_rdkit(mol, mol_id=params.molecule.id, name=params.molecule.name,
                                  source=params.molecule.meta.source, category=params.molecule.meta.category)
    properties = {key: {"value": val["value"], "unit": val["unit"], "method": f"{ff} Langevin MD ({engine})",
                        **({"uncertainty": val["uncertainty"]} if val.get("uncertainty") is not None else {})}
                  for key, val in summary.items() if key != "timeSeries"}
    ctx.progress(100, "done", "Dynamics complete", force=True)
    return {
        "jobId": ctx.job_id,
        "method": "Langevin molecular dynamics",
        "engine": engine if platform is None else f"{engine} ({platform})",
        "forceField": ff,
        "hamiltonian": None,
        "converged": True,
        "durationMs": int((time.perf_counter() - started) * 1000),
        "geometry": geometry,
        "properties": properties,
        **single("mdGasPhase"),
        "data": {"trajectory": frames, "timeSeries": summary["timeSeries"],
                 "settings": {"temperatureK": params.temperatureK, "timestepFs": params.timestepFs, "steps": params.steps,
                              "frictionPerPs": params.frictionPerPs, "seed": params.seed}},
    }


def _run_openmm(mol: Chem.Mol, params: MdParams, ctx: JobContext, masses: np.ndarray, stride: int, dof: int):  # type: ignore[no-untyped-def]
    system, _ = openmm_mmff.build_system(mol)
    system.addForce(openmm.CMMotionRemover())
    integrator = openmm.LangevinMiddleIntegrator(params.temperatureK * unit.kelvin, params.frictionPerPs / unit.picosecond,
                                                 params.timestepFs * unit.femtoseconds)
    integrator.setRandomNumberSeed(params.seed)
    platform = openmm_mmff.best_platform()
    context = openmm.Context(system, integrator, platform)
    context.setPositions(openmm_mmff.positions_nm(mol))
    openmm.LocalEnergyMinimizer.minimize(context, 1.0, 200)
    context.setVelocitiesToTemperature(params.temperatureK * unit.kelvin, params.seed)
    frames: list[list[list[float]]] = []
    times, epot, ekin, temps, rgs = [], [], [], [], []
    done = 0
    report = 0
    while done < params.steps:
        ctx.check()
        steps = min(params.reportEvery, params.steps - done)
        integrator.step(steps)
        done += steps
        state = context.getState(getEnergy=True, getPositions=True)
        pe = state.getPotentialEnergy().value_in_unit(unit.kilocalorie_per_mole)
        ke = state.getKineticEnergy().value_in_unit(unit.kilocalorie_per_mole)
        pos = np.asarray(state.getPositions(asNumpy=True).value_in_unit(unit.angstrom))
        times.append(done * params.timestepFs / 1000.0)
        epot.append(pe)
        ekin.append(ke)
        temps.append(2 * ke / (dof * KB_KCAL))
        rgs.append(_rg(pos, masses))
        if report % stride == 0:
            frames.append(np.round(pos, 4).tolist())
            ctx.progress(100 * done / params.steps, "md", f"{times[-1]:.2f} ps", {"frame": frames[-1], "timePs": times[-1],
                                                                              "temperature": round(temps[-1], 1), "energy": round(pe, 3)})
        report += 1
    final = np.asarray(context.getState(getPositions=True).getPositions(asNumpy=True).value_in_unit(unit.angstrom))
    name = platform.getName()
    del context
    return frames, times, epot, ekin, temps, rgs, final, name


def _run_uff(mol: Chem.Mol, params: MdParams, ctx: JobContext, masses: np.ndarray, stride: int, dof: int):  # type: ignore[no-untyped-def]
    """BAOAB Langevin integrator (Leimkuhler & Matthews 2013) on RDKit UFF forces; Å, fs, kcal/mol, amu."""
    ff = forcefield.build_force_field(mol, "UFF")
    ff.Minimize(maxIts=200)
    rng = np.random.default_rng(params.seed)
    x = np.asarray(ff.Positions(), dtype=float).reshape(-1, 3)
    m = masses[:, None]
    conv = 4.184e-4  # kcal/mol/Å per amu -> Å/fs²
    kt = KB_KCAL * params.temperatureK
    v = rng.normal(0.0, 1.0, x.shape) * np.sqrt(kt * conv / m)
    v -= (v * m).sum(axis=0) / m.sum()
    dt = params.timestepFs
    gamma = params.frictionPerPs / 1000.0  # 1/fs
    c1 = math.exp(-gamma * dt)
    c3 = np.sqrt((1 - c1**2) * kt * conv / m)

    def forces(pos: np.ndarray) -> tuple[np.ndarray, float]:
        flat = pos.ravel().tolist()
        grad = np.asarray(ff.CalcGrad(flat), dtype=float).reshape(-1, 3)
        return -grad, float(ff.CalcEnergy(flat))

    f, pe = forces(x)
    frames: list[list[list[float]]] = []
    times, epot, ekin, temps, rgs = [], [], [], [], []
    report = 0
    for step in range(1, params.steps + 1):
        v += 0.5 * dt * conv * f / m
        x += 0.5 * dt * v
        v = c1 * v + c3 * rng.normal(0.0, 1.0, x.shape)
        x += 0.5 * dt * v
        f, pe = forces(x)
        v += 0.5 * dt * conv * f / m
        if step % params.reportEvery == 0:
            ctx.check()
            ke = 0.5 * float((m * v**2).sum()) / conv
            times.append(step * dt / 1000.0)
            epot.append(pe)
            ekin.append(ke)
            temps.append(2 * ke / (dof * KB_KCAL))
            rgs.append(_rg(x, masses))
            if report % stride == 0:
                frames.append(np.round(x, 4).tolist())
                ctx.progress(100 * step / params.steps, "md", f"{times[-1]:.2f} ps", {"frame": frames[-1], "timePs": times[-1],
                                                                                 "temperature": round(temps[-1], 1), "energy": round(pe, 3)})
            report += 1
    return frames, times, epot, ekin, temps, rgs, x, None


def radius_of_gyration(mol: Chem.Mol) -> float:
    return float(rdMolDescriptors.CalcRadiusOfGyration(mol))
