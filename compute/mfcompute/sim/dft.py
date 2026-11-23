"""Kohn–Sham DFT single points with PySCF (B3LYP/def2-SVPD) in an isolated worker process.

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


def supported(mol: Chem.Mol) -> bool:
    return all(a.GetAtomicNum() <= 86 for a in mol.GetAtoms())


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


def single_point(mol: Chem.Mol, ctx: JobContext, *, polarizability: bool, threads: int,
                 percent_from: float, percent_to: float, timeout: float = 3600.0) -> dict[str, Any]:
    if not supported(mol):
        raise RpcError(ENGINE_UNAVAILABLE, "def2 basis sets cover H–Rn", {"engine": "pyscf"})
    conf = mol.GetConformer()
    atoms = [(a.GetSymbol(), *map(float, conf.GetAtomPosition(a.GetIdx()))) for a in mol.GetAtoms()]
    spin = sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms())
    payload = {"atoms": atoms, "charge": Chem.GetFormalCharge(mol), "spin": spin, "threads": threads,
               "polarizability": polarizability}
    context = mp.get_context("spawn")
    channel = context.Queue()
    proc = context.Process(target=_worker, args=(payload, channel), daemon=True)
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
                pct, stage = rest
                ctx.progress(percent_from + (percent_to - percent_from) * pct / 100.0, "dft", f"{METHOD}: {stage}")
            elif kind == "error":
                raise RpcError(ENGINE_UNAVAILABLE, f"DFT failed: {rest[0]}", {"engine": "pyscf"})
            else:
                return dict(rest[0])
    finally:
        if proc.is_alive():
            proc.terminate()
        proc.join(timeout=5)
