"""MMFF94/MMFF94s expressed as an OpenMM ``System`` (enables GPU/CPU-accelerated MD and minimisation).

Every term is taken from RDKit's MMFF parameter assignment, so the OpenMM energy matches
RDKit's ``MMFFGetMoleculeForceField(...).CalcEnergy()`` (verified per term by
tests/unit/compute/test_openmm_mmff.py). Functional forms: Halgren, J. Comput. Chem. 17,
490 (1996). Internal units: Å and kcal/mol converted to OpenMM's nm and kJ/mol.
"""

from __future__ import annotations

import itertools
from typing import Any

import openmm
from openmm import unit
from rdkit import Chem
from rdkit.Chem import AllChem

from ..rpc import CHEMISTRY_ERROR, RpcError

KCAL_TO_KJ = 4.184
RAD_TO_DEG = 57.29577951308232
MDYNE_A_TO_KCAL = 143.9325
# Halgren prints these as 0.043844 and 2.51210; RDKit (the reference implementation) uses the exact
# products, and so do we, so energies agree to rounding error rather than to 1e-5 relative.
ANGLE_K = MDYNE_A_TO_KCAL / RAD_TO_DEG**2
STRETCH_BEND_K = MDYNE_A_TO_KCAL / RAD_TO_DEG
LINEAR_TYPES = {4, 42, 53, 61}  # MMFFPROP "lin" flag: sp carbon, sp nitrogen, central =N=, isonitrile N
CUTOFF_ATOMS = 2000  # above this, non-bonded interactions use a 1.2 nm cutoff with switching


def build_system(mol: Chem.Mol, variant: str = "MMFF94") -> tuple[openmm.System, dict[str, int]]:
    props = AllChem.MMFFGetMoleculeProperties(mol, mmffVariant=variant)
    if props is None:
        raise RpcError(CHEMISTRY_ERROR, "MMFF typing failed for this structure", {"code": "NO_FF_PARAMS"})
    n = mol.GetNumAtoms()
    system = openmm.System()
    for atom in mol.GetAtoms():
        system.addParticle(atom.GetMass() * unit.dalton)
    counts = {"bonds": 0, "angles": 0, "stretchBend": 0, "oop": 0, "torsions": 0, "pairs14": 0}

    k = KCAL_TO_KJ
    bond_force = openmm.CustomBondForce(
        f"{k}*143.9325*0.5*kb*dr^2*(1+cs*dr+7/12*cs^2*dr^2); dr=10*r-r0; cs=-2.0"
    )
    bond_force.addPerBondParameter("kb")
    bond_force.addPerBondParameter("r0")
    r0_of: dict[tuple[int, int], float] = {}
    for bond in mol.GetBonds():
        i, j = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        params = props.GetMMFFBondStretchParams(mol, i, j)
        if params is None:
            raise RpcError(CHEMISTRY_ERROR, "Missing MMFF bond parameter", {"atoms": [i, j]})
        _, kb, r0 = params
        bond_force.addBond(i, j, [kb, r0])
        r0_of[(i, j)] = r0_of[(j, i)] = r0
        counts["bonds"] += 1
    system.addForce(bond_force)

    angle_force = openmm.CustomAngleForce(
        f"{k}*{ANGLE_K!r}*0.5*ka*dt^2*(1+cb*dt); dt=(theta-theta0)*{RAD_TO_DEG}; cb=-0.006981317"
    )
    angle_force.addPerAngleParameter("ka")
    angle_force.addPerAngleParameter("theta0")
    linear_force = openmm.CustomAngleForce(f"{k}*143.9325*ka*(1+cos(theta))")
    linear_force.addPerAngleParameter("ka")
    sb_force = openmm.CustomCompoundBondForce(
        3,
        f"{k}*{STRETCH_BEND_K!r}*(kijk*(10*distance(p1,p2)-r0ij)+kkji*(10*distance(p3,p2)-r0kj))*(angle(p1,p2,p3)-theta0)*{RAD_TO_DEG}",
    )
    for name in ("kijk", "kkji", "r0ij", "r0kj", "theta0"):
        sb_force.addPerBondParameter(name)
    for atom in mol.GetAtoms():
        j = atom.GetIdx()
        nbrs = sorted(n_.GetIdx() for n_ in atom.GetNeighbors())
        linear = props.GetMMFFAtomType(j) in LINEAR_TYPES
        for i, kk in itertools.combinations(nbrs, 2):
            params = props.GetMMFFAngleBendParams(mol, i, j, kk)
            if params is None:
                continue
            _, ka, theta0 = params
            if linear:
                linear_force.addAngle(i, j, kk, [ka])
            else:
                angle_force.addAngle(i, j, kk, [ka, theta0 / RAD_TO_DEG])
                sb = props.GetMMFFStretchBendParams(mol, i, j, kk)
                if sb is not None:
                    _, kba_ijk, kba_kji = sb
                    sb_force.addBond([i, j, kk], [kba_ijk, kba_kji, r0_of[(i, j)], r0_of[(kk, j)], theta0 / RAD_TO_DEG])
                    counts["stretchBend"] += 1
            counts["angles"] += 1
    for force in (angle_force, linear_force, sb_force):
        system.addForce(force)

    oop_force = openmm.CustomCompoundBondForce(
        4, f"{k}*{ANGLE_K!r}*0.5*koop*chi^2; chi=asin(min(1,max(-1,sin(angle(p4,p2,p3))*sin(dihedral(p4,p2,p3,p1)))))*{RAD_TO_DEG}"
    )
    oop_force.addPerBondParameter("koop")
    for atom in mol.GetAtoms():
        j = atom.GetIdx()
        nbrs = [n_.GetIdx() for n_ in atom.GetNeighbors()]
        if len(nbrs) != 3:
            continue
        for out in range(3):
            l_idx = nbrs[out]
            i, kk = [nbrs[x] for x in range(3) if x != out]
            koop = props.GetMMFFOopBendParams(mol, i, j, kk, l_idx)
            if koop is None or koop == 0:
                continue
            oop_force.addBond([i, j, kk, l_idx], [koop])
            counts["oop"] += 1
    system.addForce(oop_force)

    torsion_force = openmm.CustomTorsionForce(f"{k}*0.5*(v1*(1+cos(theta))+v2*(1-cos(2*theta))+v3*(1+cos(3*theta)))")
    for name in ("v1", "v2", "v3"):
        torsion_force.addPerTorsionParameter(name)
    seen: set[tuple[int, int, int, int]] = set()
    for bond in mol.GetBonds():
        j, kk = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        for ni in mol.GetAtomWithIdx(j).GetNeighbors():
            i = ni.GetIdx()
            if i == kk:
                continue
            for nl in mol.GetAtomWithIdx(kk).GetNeighbors():
                l_idx = nl.GetIdx()
                if l_idx in (j, i):
                    continue
                key = (i, j, kk, l_idx) if i < l_idx else (l_idx, kk, j, i)
                if key in seen:
                    continue
                seen.add(key)
                params = props.GetMMFFTorsionParams(mol, i, j, kk, l_idx)
                if params is None:
                    continue
                _, v1, v2, v3 = params
                if v1 == v2 == v3 == 0:
                    continue
                torsion_force.addTorsion(i, j, kk, l_idx, [v1, v2, v3])
                counts["torsions"] += 1
    system.addForce(torsion_force)

    # --- non-bonded: buffered 14-7 vdW + buffered Coulomb -------------------------------
    types = [props.GetMMFFAtomType(i) for i in range(n)]
    unique = sorted(set(types))
    local = {t: x for x, t in enumerate(unique)}
    first_of_type = {t: types.index(t) for t in unique}
    nt = len(unique)
    rstar = [0.0] * (nt * nt)
    eps = [0.0] * (nt * nt)
    for a, ta in enumerate(unique):
        for b, tb in enumerate(unique):
            ia, ib = first_of_type[ta], first_of_type[tb]
            params = props.GetMMFFVdWParams(ia, ib)
            rstar[a + nt * b] = params[2]
            eps[a + nt * b] = params[3]
    vdw_expr = "eps*(1.07*rs/(R+0.07*rs))^7*((1.12*rs^7/(R^7+0.12*rs^7))-2)"
    elec_expr = "332.0716*q1*q2/(R+0.05)"
    nb = openmm.CustomNonbondedForce(f"{k}*({vdw_expr}+{elec_expr}); R=10*r; rs=rtab(t1,t2); eps=etab(t1,t2)")
    nb.addTabulatedFunction("rtab", openmm.Discrete2DFunction(nt, nt, rstar))
    nb.addTabulatedFunction("etab", openmm.Discrete2DFunction(nt, nt, eps))
    nb.addPerParticleParameter("t")
    nb.addPerParticleParameter("q")
    charges = [props.GetMMFFPartialCharge(i) for i in range(n)]
    for i in range(n):
        nb.addParticle([float(local[types[i]]), charges[i]])
    topo = Chem.GetDistanceMatrix(mol)
    pair14 = openmm.CustomBondForce(f"{k}*(eps*(1.07*rs/(R+0.07*rs))^7*((1.12*rs^7/(R^7+0.12*rs^7))-2)+0.75*332.0716*qq/(R+0.05)); R=10*r")
    for name in ("rs", "eps", "qq"):
        pair14.addPerBondParameter(name)
    for i in range(n):
        for j in range(i + 1, n):
            d = topo[i][j]
            if d <= 3:
                nb.addExclusion(i, j)
            if d == 3:
                params = props.GetMMFFVdWParams(i, j)
                pair14.addBond(i, j, [params[2], params[3], charges[i] * charges[j]])
                counts["pairs14"] += 1
    if n > CUTOFF_ATOMS:
        nb.setNonbondedMethod(openmm.CustomNonbondedForce.CutoffNonPeriodic)
        nb.setCutoffDistance(1.2 * unit.nanometer)
        nb.setUseSwitchingFunction(True)
        nb.setSwitchingDistance(1.0 * unit.nanometer)
    else:
        nb.setNonbondedMethod(openmm.CustomNonbondedForce.NoCutoff)
    system.addForce(nb)
    system.addForce(pair14)
    for index, force in enumerate(system.getForces()):
        force.setForceGroup(min(index, 31))
    return system, counts


def positions_nm(mol: Chem.Mol) -> list[openmm.Vec3]:
    pos = mol.GetConformer().GetPositions()
    positions: list[Any] = [openmm.Vec3(float(x) / 10.0, float(y) / 10.0, float(z) / 10.0) for x, y, z in pos] * unit.nanometer
    return positions


def best_platform(preferred: str | None = None) -> openmm.Platform:
    names = [openmm.Platform.getPlatform(i).getName() for i in range(openmm.Platform.getNumPlatforms())]
    for name in ([preferred] if preferred else []) + ["CUDA", "HIP", "OpenCL", "Metal", "CPU", "Reference"]:
        if name in names:
            return openmm.Platform.getPlatformByName(name)
    return openmm.Platform.getPlatform(0)


def energy_kcal(mol: Chem.Mol, variant: str = "MMFF94", platform: str = "Reference") -> float:
    system, _ = build_system(mol, variant)
    integrator = openmm.VerletIntegrator(0.001)
    context = openmm.Context(system, integrator, openmm.Platform.getPlatformByName(platform))
    context.setPositions(positions_nm(mol))
    value = context.getState(getEnergy=True).getPotentialEnergy().value_in_unit(unit.kilocalorie_per_mole)
    del context
    return float(value)
