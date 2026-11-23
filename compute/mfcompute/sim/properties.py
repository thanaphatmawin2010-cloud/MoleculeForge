"""``sim.properties``: the full property battery, every value with unit and method.

Stages (each gated by element coverage and system size, all local):

1. RDKit descriptors, Gasteiger charges, drug-likeness, pKa estimates.
2. Force-field geometry (MMFF94 / UFF) and potential energy.
3. GFN2-xTB optimisation: energy, frontier orbitals, dipole, charges, D4 polarisability.
4. GFN2-xTB Hessian: harmonic frequencies, IR intensities, normal modes, RRHO/qRRHO thermochemistry.
5. PM7 (MOPAC) heat of formation.
6. B3LYP/def2-SVPD (PySCF) single point: dipole, orbitals, Mulliken charges, finite-field polarisability.
7. Surface area, volume, radius of gyration, rotational constants.
8. Optional short Langevin MD for thermodynamic averages.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from typing import Any

import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem, rdFreeSASA, rdMolDescriptors

from .. import __version__, capabilities, paths
from ..chem import convert, descriptors
from ..data import elements
from ..jobs import JobContext
from ..models import MdParams, PropertiesParams
from ..rpc import RpcError
from . import dft, forcefield, md, mopac, thermo, xtb

LIMITS = {
    #            xtb opt, xtb hess, pm7, dft heavy atoms, dft polarisability heavy atoms
    "fast": {"xtb": 400, "hess": 0, "pm7": 0, "dft": 0, "pol": 0},
    "standard": {"xtb": 1000, "hess": 120, "pm7": 300, "dft": 12, "pol": 3},
    "thorough": {"xtb": 2500, "hess": 250, "pm7": 600, "dft": 30, "pol": 16},
}
_CACHE_LOCK = threading.Lock()


def _cache() -> sqlite3.Connection:
    conn = sqlite3.connect(paths.user_dir() / "results-cache.sqlite", check_same_thread=False)
    conn.execute("CREATE TABLE IF NOT EXISTS results (key TEXT PRIMARY KEY, created REAL, payload TEXT)")
    return conn


def _cache_key(params: PropertiesParams, inchikey: str) -> str:
    caps = capabilities.detect()
    engines = {k: caps["engines"][k].get("version") for k in ("xtb", "mopac") if isinstance(caps["engines"].get(k), dict)}
    material = json.dumps({"inchikey": inchikey, "level": params.level, "include": sorted(params.include), "md": params.md,
                           "engines": engines, "compute": __version__, "libs": caps["engines"]["libraries"]}, sort_keys=True)
    return hashlib.sha256(material.encode()).hexdigest()


def _pv(value: Any, unit: str, method: str, uncertainty: float | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"value": value, "unit": unit, "method": method}
    if uncertainty is not None:
        out["uncertainty"] = uncertainty
    return out


def _surface_and_shape(mol: Chem.Mol) -> dict[str, dict[str, Any]]:
    props: dict[str, dict[str, Any]] = {}
    radii = [elements.vdw_radius(a.GetSymbol()) for a in mol.GetAtoms()]
    opts = rdFreeSASA.SASAOpts()
    opts.algorithm = rdFreeSASA.LeeRichards
    opts.probeRadius = 1.4
    sasa = rdFreeSASA.CalcSASA(mol, radii, confIdx=-1, opts=opts)
    polar = sum(float(a.GetProp("SASA")) for a in mol.GetAtoms() if a.HasProp("SASA") and a.GetSymbol() in ("N", "O", "S", "P"))
    props["sasa"] = _pv(round(float(sasa), 2), "Å²", "Lee–Richards (FreeSASA), Alvarez/Bondi vdW radii, 1.4 Å probe")
    props["polarSasa"] = _pv(round(polar, 2), "Å²", "Lee–Richards SASA of N, O, S, P atoms")
    try:
        props["molecularVolume"] = _pv(round(float(AllChem.ComputeMolVolume(mol, gridSpacing=0.2)), 2), "Å³",
                                       "van der Waals volume, 0.2 Å grid (RDKit)")
    except Exception:  # noqa: BLE001
        pass
    if mol.GetNumAtoms() > 1:
        props["radiusOfGyration"] = _pv(round(float(rdMolDescriptors.CalcRadiusOfGyration(mol)), 4), "Å", "mass-weighted (RDKit)")
        rot = thermo.rotational_constants(mol)
        props["rotationalConstants"] = _pv([round(x, 6) if x else None for x in rot["ghz"]], "GHz", "rigid rotor from principal moments")
        props["principalMoments"] = _pv([round(x, 4) for x in rot["momentsAmuA2"]], "amu·Å²", "inertia tensor eigenvalues")
    props["rotationalSymmetryNumber"] = _pv(thermo.symmetry_number(mol), "", "proper rotations of the 3D structure")
    return props


def run(params: PropertiesParams, ctx: JobContext) -> dict[str, Any]:
    started = time.perf_counter()
    limits = LIMITS[params.level]
    warnings: list[str] = []
    methods_used: list[str] = []
    ctx.progress(1, "prepare", "Preparing structure", force=True)
    mol = convert.to_rdkit(params.molecule)
    mol = convert.embed_3d(mol) if mol.GetNumConformers() == 0 or not mol.GetConformer().Is3D() else Chem.AddHs(mol, addCoords=True)
    inchikey = convert.annotate(params.molecule).meta.inchikey
    use_cache = "nocache" not in params.include and bool(inchikey)
    key = _cache_key(params, inchikey) if use_cache else ""
    if use_cache:
        with _CACHE_LOCK:
            row = _cache().execute("SELECT payload FROM results WHERE key = ?", (key,)).fetchone()
        if row:
            cached = json.loads(row[0])
            cached["jobId"] = ctx.job_id
            cached["warnings"] = [*cached.get("warnings", []), "Result served from the local cache (same InChIKey and method)."]
            ctx.progress(100, "done", "Loaded cached result", force=True)
            return cached

    props: dict[str, dict[str, Any]] = {}
    data: dict[str, Any] = {}
    n_atoms = mol.GetNumAtoms()
    n_heavy = mol.GetNumHeavyAtoms()
    multiplicity = sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms()) + 1

    ctx.progress(4, "descriptors", "Cheminformatics descriptors")
    props.update(descriptors.compute_rdkit(mol))
    methods_used.append("RDKit descriptors")

    ctx.progress(8, "forcefield", "Force-field optimisation")
    ff_name = forcefield.choose_force_field(mol)
    ff_res = forcefield.minimize(mol, ff_name, ctx, max_steps=4000, stream=True, stage="forcefield", percent_from=8, percent_to=20)
    props["potentialEnergy"] = _pv(round(ff_res.energy_final, 4), "kcal/mol", f"{ff_name} (RDKit)")
    methods_used.append(ff_name)
    geometry_method = ff_name

    xtb_res = None
    if xtb.available() and xtb.supports(mol) and n_atoms <= limits["xtb"]:
        try:
            task = "ohess" if n_atoms <= limits["hess"] else "opt"
            xtb_res = xtb.run(mol, ctx, task=task, gfn="2", opt_level="normal", percent_from=20, percent_to=60, stage="gfn2-xtb")
            if xtb_res.coordinates:
                conf = mol.GetConformer()
                for idx, (x, y, z) in enumerate(xtb_res.coordinates):
                    conf.SetAtomPosition(idx, (x, y, z))
                geometry_method = "GFN2-xTB"
            props.update(xtb.as_properties(xtb_res))
            methods_used.append("GFN2-xTB")
            data["orbitals"] = {"energiesEv": xtb_res.orbital_energies_ev, "occupations": xtb_res.occupations, "method": "GFN2-xTB"}
            if xtb_res.frequencies:
                real = [f for f in xtb_res.frequencies]
                props["vibrationalFrequencies"] = _pv([round(f, 2) for f in real], "cm⁻¹", "GFN2-xTB harmonic")
                props["irIntensities"] = _pv([round(i, 3) for i in xtb_res.ir_intensities], "km/mol", "GFN2-xTB dipole derivatives")
                props["reducedMasses"] = _pv([round(m, 4) for m in xtb_res.reduced_masses], "amu", "GFN2-xTB")
                props["imaginaryFrequencyCount"] = _pv(sum(1 for f in real if f < -10), "", "GFN2-xTB Hessian")
                data["normalModes"] = {"frequencies": real, "intensities": xtb_res.ir_intensities, "displacements": xtb_res.normal_modes}
                thermochem = thermo.thermochemistry(mol, real, xtb_res.energy_hartree, multiplicity=multiplicity)
                data["thermochemistry"] = thermochem
                method = "RRHO on GFN2-xTB frequencies, 298.15 K, 1 atm"
                props["zeroPointEnergy"] = _pv(thermochem["zeroPointEnergy"]["value"], "kJ/mol", method)
                props["enthalpyCorrection"] = _pv(thermochem["thermalEnthalpyCorrection"]["value"], "kJ/mol", method)
                props["entropy"] = _pv(thermochem["entropy"]["value"], "J/(mol·K)", method)
                props["entropyQuasiRRHO"] = _pv(thermochem["entropyQuasiRRHO"]["value"], "J/(mol·K)", "quasi-RRHO (Grimme 2012), 100 cm⁻¹")
                props["heatCapacityCp"] = _pv(thermochem["heatCapacityCp"]["value"], "J/(mol·K)", method)
                props["gibbsCorrection"] = _pv(thermochem["gibbsCorrectionQuasiRRHO"]["value"], "kJ/mol", "quasi-RRHO, 298.15 K")
                if "gibbsFreeEnergy" in thermochem:
                    props["gibbsFreeEnergy"] = _pv(thermochem["gibbsFreeEnergy"]["value"], "Eh", "GFN2-xTB + quasi-RRHO")
                    props["enthalpy"] = _pv(thermochem["enthalpy"]["value"], "Eh", "GFN2-xTB + RRHO")
                if props["imaginaryFrequencyCount"]["value"]:
                    warnings.append("Imaginary frequencies found: the structure is not a true minimum at the GFN2-xTB level.")
            elif limits["hess"]:
                warnings.append(f"Vibrational analysis skipped: {n_atoms} atoms exceeds the {params.level} limit of {limits['hess']}.")
        except RpcError as err:
            if err.code == -32000:
                raise
            warnings.append(f"GFN2-xTB step skipped: {err.message}")
    elif not xtb.supports(mol):
        warnings.append("GFN2-xTB covers H–Rn only; tight-binding properties were not computed.")

    if limits["pm7"] and mopac.available() and mopac.supports(mol) and n_atoms <= limits["pm7"]:
        try:
            props.update(mopac.heat_of_formation(mol, ctx, optimize=True, percent_from=60, percent_to=68))
            methods_used.append("PM7")
        except RpcError as err:
            if err.code == -32000:
                raise
            warnings.append(f"PM7 heat of formation unavailable: {err.message}")

    if limits["dft"] and dft.supported(mol) and n_heavy <= limits["dft"]:
        try:
            res = dft.single_point(mol, ctx, polarizability=n_heavy <= limits["pol"], threads=capabilities.recommended_threads(),
                                   percent_from=68, percent_to=92)
            vec = res["dipole"]
            props["dipoleMoment"] = _pv(round(float(np.linalg.norm(vec)), 3), "D", f"{dft.METHOD} at {geometry_method} geometry")
            props["dipoleVector"] = _pv([round(v, 4) for v in vec], "D", dft.METHOD)
            props["homo"] = _pv(round(res["homo"], 4), "eV", dft.METHOD)
            if res["lumo"] is not None:
                props["lumo"] = _pv(round(res["lumo"], 4), "eV", dft.METHOD)
                props["homoLumoGap"] = _pv(round(res["lumo"] - res["homo"], 4), "eV", dft.METHOD)
            props["dftEnergy"] = _pv(round(res["energy"], 8), "Eh", dft.METHOD)
            props["partialChargesMulliken"] = _pv([round(q, 4) for q in res["mulliken"]], "e", f"{dft.METHOD} Mulliken")
            data["orbitalsDft"] = {"energiesEv": [e * dft.HARTREE_TO_EV for e in res["orbitals"]], "occupations": res["occupations"],
                                   "method": dft.METHOD}
            if "polarizability" in res:
                iso = res["polarizability"]["isotropicAu"]
                props["polarizability"] = _pv(round(iso * dft.AU_POL_TO_A3, 4), "Å³", f"{dft.METHOD} finite field (±0.002 au)")
                props["polarizabilityTensor"] = _pv([[round(v * dft.AU_POL_TO_A3, 4) for v in row] for row in res["polarizability"]["tensorAu"]],
                                                    "Å³", dft.METHOD)
            if not res["converged"]:
                warnings.append("DFT SCF did not fully converge; DFT values are approximate.")
            methods_used.append(dft.METHOD)
        except RpcError as err:
            if err.code == -32000:
                raise
            warnings.append(f"DFT step skipped: {err.message}")
    elif limits["dft"] and n_heavy > limits["dft"]:
        warnings.append(f"DFT skipped: {n_heavy} heavy atoms exceeds the {params.level} limit of {limits['dft']}; tight-binding values are reported.")

    ctx.progress(93, "surface", "Surface area, volume and shape")
    props.update(_surface_and_shape(mol))

    if params.md:
        ctx.progress(94, "md", "Molecular dynamics (10 ps, 300 K)")
        geometry = convert.from_rdkit(mol, mol_id=params.molecule.id, name=params.molecule.name)
        md_res = md.run(MdParams(molecule=geometry, steps=10_000, reportEvery=100, jobId=None), ctx)
        for k, v in md_res["properties"].items():
            props[f"md.{k}"] = v
        data["md"] = md_res["data"]
        methods_used.append(f"MD ({md_res['engine']})")

    geometry_out = convert.from_rdkit(mol, mol_id=params.molecule.id, name=params.molecule.name, source=params.molecule.meta.source,
                                      props=params.molecule.props, category=params.molecule.meta.category)
    result = {
        "jobId": ctx.job_id,
        "method": "property battery (" + params.level + ")",
        "engine": "MoleculeForge " + __version__,
        "forceField": ff_name,
        "hamiltonian": "GFN2-xTB" if xtb_res else None,
        "converged": ff_res.converged and (xtb_res.converged if xtb_res else True),
        "durationMs": int((time.perf_counter() - started) * 1000),
        "geometry": geometry_out,
        "properties": props,
        "warnings": warnings,
        "data": {**data, "methods": methods_used, "geometryMethod": geometry_method},
    }
    if use_cache:
        with _CACHE_LOCK:
            conn = _cache()
            conn.execute("INSERT OR REPLACE INTO results VALUES (?, ?, ?)",
                         (key, time.time(), json.dumps(result, default=lambda o: o.model_dump(mode="json") if hasattr(o, "model_dump") else str(o))))
            conn.commit()
    ctx.progress(100, "done", "Properties complete", force=True)
    return result
