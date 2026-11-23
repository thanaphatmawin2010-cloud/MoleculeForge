"""Kohn–Sham DFT with PySCF in an isolated worker process.

* Single points (B3LYP/def2-SVPD): dipole, orbitals, Mulliken charges, finite-field polarisability.
* Geometry optimisation (B3LYP/def2-SVP with density fitting, geomeTRIC optimiser) for hydrides
  of a single heavy atom (H2O, NH3, CH4, H2S, HF, ...), where GFN2-xTB angles are not accurate
  enough (it opens water to 107.2° and ammonia to 107.7°; B3LYP gives 103.1° and 105.1°, the
  experimental values being 104.5° and 106.7°) and B3LYP is affordable (about 5–7 s). Larger
  molecules keep GFN2-xTB, which meets the reference tolerances there at a fraction of the cost.

Running PySCF in a spawned process gives hard cancellation (the process is terminated) and
keeps a numerical failure from taking down the sidecar.
"""

from __future__ import annotations

import multiprocessing as mp
import queue
import time
from typing import Any

from rdkit import Chem

from ..jobs import JobContext
from ..rpc import ENGINE_UNAVAILABLE, RpcError

FUNCTIONAL = "b3lyp"
BASIS = "def2-svpd"
METHOD = "B3LYP/def2-SVPD (PySCF)"
HARTREE_TO_EV = 27.211386245988
AU_POL_TO_A3 = 0.148184711
FIELD = 0.002  # au, finite-field step
OPT_BASIS = "def2-svp"
OPT_METHOD = "B3LYP/def2-SVP (PySCF, density fitting; geomeTRIC optimiser)"
MAX_OPT_HEAVY_ATOMS = 1
MAX_OPT_ATOMS = 8
HARTREE_TO_KCAL = 627.509474


def supported(mol: Chem.Mol) -> bool:
    return all(a.GetAtomicNum() <= 86 for a in mol.GetAtoms())


def can_optimize(mol: Chem.Mol) -> bool:
    """DFT geometry optimisation is affordable and well defined: tiny, closed-shell, H–Kr."""
    heavy = sum(1 for a in mol.GetAtoms() if a.GetAtomicNum() > 1)
    return (1 < mol.GetNumAtoms() <= MAX_OPT_ATOMS and heavy <= MAX_OPT_HEAVY_ATOMS
            and all(a.GetAtomicNum() <= 36 for a in mol.GetAtoms())
            and sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms()) == 0)


def _worker(payload: dict[str, Any], out: Any) -> None:  # pragma: no cover - runs in a child process
    try:
        import numpy as np
        from pyscf import dft, gto, lib

        lib.num_threads(payload["threads"])
        heavy = {el for el, *_ in payload["atoms"] if gto.charge(el) > 36}
        mol = gto.M(
            atom=[(el, (x, y, z)) for el, x, y, z in payload["atoms"]],
            unit="Angstrom", charge=payload["charge"], spin=payload["spin"], basis=BASIS,
            ecp={el: "def2-svp" for el in heavy} if heavy else {}, verbose=0,
        )
        mf = dft.RKS(mol) if payload["spin"] == 0 else dft.UKS(mol)
        mf.xc = FUNCTIONAL
        mf.conv_tol = 1e-9
        mf.max_cycle = 150
        out.put(("progress", 10, "SCF"))
        energy = mf.kernel()
        if not mf.converged:
            mf = mf.newton()
            energy = mf.kernel()
        dip = mf.dip_moment(unit="Debye", verbose=0)
        mo_e = np.asarray(mf.mo_energy)
        mo_occ = np.asarray(mf.mo_occ)
        if mo_e.ndim == 2:  # unrestricted
            occ_e = np.concatenate([mo_e[s][mo_occ[s] > 0] for s in range(2)])
            vir_e = np.concatenate([mo_e[s][mo_occ[s] == 0] for s in range(2)])
        else:
            occ_e, vir_e = mo_e[mo_occ > 0], mo_e[mo_occ == 0]
        homo = float(occ_e.max()) * HARTREE_TO_EV
        lumo = float(vir_e.min()) * HARTREE_TO_EV if vir_e.size else None
        charges = mf.mulliken_pop(verbose=0)[1].tolist()
        result: dict[str, Any] = {
            "energy": float(energy), "converged": bool(mf.converged), "dipole": [float(x) for x in dip],
            "homo": homo, "lumo": lumo, "mulliken": charges,
            "orbitals": (mo_e if mo_e.ndim == 1 else mo_e[0]).tolist(),
            "occupations": (mo_occ if mo_occ.ndim == 1 else mo_occ[0]).tolist(),
            "nao": mol.nao,
        }
        if payload["polarizability"]:
            h1 = mf.get_hcore()
            ints = mol.intor("int1e_r")
            alpha = np.zeros((3, 3))
            dm0 = mf.make_rdm1()
            for axis in range(3):
                dips = []
                for sign in (+1, -1):
                    out.put(("progress", 40 + 25 * axis + (0 if sign > 0 else 12), f"finite field {'xyz'[axis]}{'+' if sign > 0 else '-'}"))
                    mf_f = dft.RKS(mol) if payload["spin"] == 0 else dft.UKS(mol)
                    mf_f.xc = FUNCTIONAL
                    mf_f.conv_tol = 1e-10
                    field_h = h1 + sign * FIELD * ints[axis]
                    mf_f.get_hcore = lambda *a, _h=field_h: _h
                    mf_f.kernel(dm0=dm0)
                    dips.append(np.asarray(mf_f.dip_moment(unit="AU", verbose=0)))
                alpha[:, axis] = (dips[0] - dips[1]) / (2 * FIELD)
            alpha = 0.5 * (alpha + alpha.T)
            result["polarizability"] = {"tensorAu": alpha.tolist(), "isotropicAu": float(np.trace(alpha) / 3.0)}
        out.put(("result", result))
    except Exception as exc:
        out.put(("error", f"{type(exc).__name__}: {exc}"))


def _opt_worker(payload: dict[str, Any], out: Any) -> None:  # pragma: no cover - runs in a child process
    try:
        import os

        # geomeTRIC logs every step to stdout/stderr; results travel over the queue, so silence it.
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        from pyscf import dft, gto, lib
        from pyscf.geomopt.geometric_solver import kernel as geometric_kernel

        lib.num_threads(payload["threads"])
        mol = gto.M(atom=[(el, (x, y, z)) for el, x, y, z in payload["atoms"]], unit="Angstrom",
                    charge=payload["charge"], spin=0, basis=OPT_BASIS, verbose=0)

        def method(m: Any) -> Any:
            mf = dft.RKS(m).density_fit()
            mf.xc = FUNCTIONAL
            mf.conv_tol = 1e-10
            mf.max_cycle = 150
            return mf

        energies: list[float] = []

        def callback(envs: dict[str, Any]) -> None:
            energies.append(float(envs["energy"]))
            coords = envs["mol"].atom_coords(unit="Angstrom").tolist()
            out.put(("frame", coords, energies[-1], len(energies)))

        converged, mol_eq = geometric_kernel(method(mol), maxsteps=payload["maxSteps"], callback=callback)
        final = method(mol_eq)
        energy = float(final.kernel())
        out.put(("result", {"coordinates": mol_eq.atom_coords(unit="Angstrom").tolist(), "energy": energy,
                            "initialEnergy": energies[0] if energies else energy, "converged": bool(converged),
                            "steps": len(energies), "scfConverged": bool(final.converged)}))
    except Exception as exc:
        out.put(("error", f"{type(exc).__name__}: {exc}"))


def _run(target: Any, payload: dict[str, Any], ctx: JobContext, percent_from: float, percent_to: float, stage: str,
         timeout: float, label: str) -> dict[str, Any]:
    """Run a worker in a spawned process, relaying progress/frames, with cancellation and a timeout."""
    context = mp.get_context("spawn")
    channel = context.Queue()
    proc = context.Process(target=target, args=(payload, channel), daemon=True)
    proc.start()
    deadline = time.monotonic() + timeout
    try:
        while True:
            if ctx.cancelled:
                proc.terminate()
                ctx.check()
            if time.monotonic() > deadline:
                proc.terminate()
                raise RpcError(ENGINE_UNAVAILABLE, "DFT calculation timed out", {"engine": "pyscf"})
            try:
                kind, *rest = channel.get(timeout=0.25)
            except queue.Empty:
                if not proc.is_alive():
                    raise RpcError(ENGINE_UNAVAILABLE, "DFT worker exited unexpectedly", {"engine": "pyscf", "exitCode": proc.exitcode}) from None
                continue
            if kind == "progress":
                pct, what = rest
                ctx.progress(percent_from + (percent_to - percent_from) * pct / 100.0, stage, f"{label}: {what}")
            elif kind == "frame":
                coords, energy, step = rest
                pct = min(95.0, 100.0 * step / max(1, payload.get("maxSteps", 60)) * 3)
                ctx.progress(percent_from + (percent_to - percent_from) * pct / 100.0, stage, f"{label}: step {step}",
                             {"frame": [[round(v, 5) for v in xyz] for xyz in coords], "energy": round(energy, 8), "unit": "Eh",
                              "method": label, "step": step})
            elif kind == "error":
                raise RpcError(ENGINE_UNAVAILABLE, f"DFT failed: {rest[0]}", {"engine": "pyscf"})
            else:
                return dict(rest[0])
    finally:
        if proc.is_alive():
            proc.terminate()
        proc.join(timeout=5)


def optimize(mol: Chem.Mol, ctx: JobContext, *, threads: int, percent_from: float, percent_to: float,
             stage: str = "refine", max_steps: int = 60, timeout: float = 1800.0) -> dict[str, Any]:
    """B3LYP/def2-SVP geometry optimisation from the current conformer; coordinates in Å."""
    if not can_optimize(mol):
        raise RpcError(ENGINE_UNAVAILABLE, "DFT optimisation is limited to small closed-shell H–Kr molecules", {"engine": "pyscf"})
    conf = mol.GetConformer()
    payload = {"atoms": [(a.GetSymbol(), *map(float, conf.GetAtomPosition(a.GetIdx()))) for a in mol.GetAtoms()],
               "charge": Chem.GetFormalCharge(mol), "threads": threads, "maxSteps": max_steps}
    return _run(_opt_worker, payload, ctx, percent_from, percent_to, stage, timeout, "B3LYP/def2-SVP optimisation")


def single_point(mol: Chem.Mol, ctx: JobContext, *, polarizability: bool, threads: int,
                 percent_from: float, percent_to: float, timeout: float = 3600.0) -> dict[str, Any]:
    if not supported(mol):
        raise RpcError(ENGINE_UNAVAILABLE, "def2 basis sets cover H–Rn", {"engine": "pyscf"})
    conf = mol.GetConformer()
    atoms = [(a.GetSymbol(), *map(float, conf.GetAtomPosition(a.GetIdx()))) for a in mol.GetAtoms()]
    spin = sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms())
    payload = {"atoms": atoms, "charge": Chem.GetFormalCharge(mol), "spin": spin, "threads": threads,
               "polarizability": polarizability}
    return _run(_worker, payload, ctx, percent_from, percent_to, "dft", timeout, METHOD)
