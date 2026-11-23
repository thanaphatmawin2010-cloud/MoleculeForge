"""GFN2-xTB / GFN-FF via the bundled ``xtb`` executable (LGPL-3.0, separate process)."""

from __future__ import annotations

import json
import re
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rdkit import Chem

from .. import capabilities, paths
from ..jobs import JobContext, run_process
from ..rpc import ENGINE_UNAVAILABLE, RpcError

HARTREE_TO_EV = 27.211386245988
HARTREE_TO_KCAL = 627.509474
AU_DIPOLE_TO_DEBYE = 2.541746473
BOHR3_TO_ANG3 = 0.148184711
MAX_Z = 86  # GFN parametrisations cover H–Rn


@dataclass
class XtbResult:
    method: str
    energy_hartree: float | None = None
    gap_ev: float | None = None
    homo_ev: float | None = None
    lumo_ev: float | None = None
    dipole_debye: float | None = None
    dipole_vector_debye: list[float] | None = None
    charges: list[float] = field(default_factory=list)
    orbital_energies_ev: list[float] = field(default_factory=list)
    occupations: list[float] = field(default_factory=list)
    polarizability_au: float | None = None
    coordinates: list[list[float]] | None = None
    frequencies: list[float] = field(default_factory=list)
    ir_intensities: list[float] = field(default_factory=list)
    reduced_masses: list[float] = field(default_factory=list)
    normal_modes: list[list[list[float]]] = field(default_factory=list)
    converged: bool = True
    cycles: int = 0
    version: str = ""
    raw_tail: str = ""


def available() -> bool:
    return paths.executable("xtb", "xtb") is not None


def supports(mol: Chem.Mol) -> bool:
    return all(a.GetAtomicNum() <= MAX_Z for a in mol.GetAtoms())


def _write_xyz(mol: Chem.Mol, path: Path) -> None:
    conf = mol.GetConformer()
    lines = [str(mol.GetNumAtoms()), "MoleculeForge"]
    for atom in mol.GetAtoms():
        p = conf.GetAtomPosition(atom.GetIdx())
        lines.append(f"{atom.GetSymbol():<3}{p.x:16.10f}{p.y:16.10f}{p.z:16.10f}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _unpaired(mol: Chem.Mol) -> int:
    return sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms())


def run(
    mol: Chem.Mol,
    ctx: JobContext,
    *,
    task: str = "sp",
    gfn: str = "2",
    opt_level: str = "normal",
    percent_from: float = 0.0,
    percent_to: float = 100.0,
    stage: str = "xtb",
    solvent: str | None = None,
    timeout: float = 3600.0,
    max_cycles: int | None = None,
) -> XtbResult:
    exe = paths.executable("xtb", "xtb")
    if exe is None:
        raise RpcError(ENGINE_UNAVAILABLE, "xtb is not bundled on this platform", {"engine": "xtb"})
    if not supports(mol):
        raise RpcError(ENGINE_UNAVAILABLE, "GFN methods cover elements up to Rn (Z=86)", {"engine": "xtb", "code": "ELEMENT_COVERAGE"})
    work = paths.scratch_dir() / f"xtb-{uuid.uuid4().hex[:10]}"
    work.mkdir(parents=True)
    try:
        _write_xyz(mol, work / "input.xyz")
        charge = Chem.GetFormalCharge(mol)
        args = [str(exe), "input.xyz", "--chrg", str(charge), "--uhf", str(_unpaired(mol)), "--json"]
        args += ["--gfnff"] if gfn == "ff" else ["--gfn", gfn]
        if task == "opt":
            args += ["--opt", opt_level]
        elif task == "ohess":
            args += ["--ohess", opt_level]
        elif task == "hess":
            args += ["--hess"]
        if solvent:
            args += ["--alpb", solvent]
        if max_cycles:
            args += ["--cycles", str(max_cycles)]
        threads = capabilities.recommended_threads()
        args += ["--parallel", str(threads)]
        env = capabilities.engine_env("xtb")
        n_atoms = mol.GetNumAtoms()
        expected_cycles = max(10, min(400, 3 * n_atoms))
        cycles = 0
        conf_lines: list[str] = []

        def on_line(line: str) -> None:
            nonlocal cycles
            match = re.search(r"CYCLE\s+(\d+)", line)
            if match:
                cycles = int(match.group(1))
                frac = min(0.95, cycles / expected_cycles)
                ctx.progress(percent_from + (percent_to - percent_from) * frac, stage, f"GFN{gfn}-xTB optimisation cycle {cycles}")
            elif "Hessian" in line and "calculation" in line.lower():
                ctx.progress(percent_from + (percent_to - percent_from) * 0.6, stage, "Computing Hessian (vibrational analysis)")
            conf_lines.append(line)

        code, output = run_process(ctx, args, cwd=str(work), env=env, timeout=timeout, on_line=on_line)
        if code != 0 or not (work / "xtbout.json").exists():
            tail = "".join(output.splitlines(True)[-25:])
            raise RpcError(ENGINE_UNAVAILABLE, "xtb calculation failed", {"engine": "xtb", "exitCode": code, "log": tail})
        result = _parse(work, output, gfn)
        result.cycles = cycles
        result.converged = "FAILED TO CONVERGE" not in output.upper() and "NOT CONVERGED" not in output.upper()
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _parse(work: Path, output: str, gfn: str) -> XtbResult:
    data: dict[str, Any] = json.loads((work / "xtbout.json").read_text(encoding="utf-8"))
    method = "GFN-FF" if gfn == "ff" else f"GFN{gfn}-xTB"
    result = XtbResult(method=method, version=str(data.get("xtb version", "")))
    result.energy_hartree = float(data["total energy"]) if "total energy" in data else None
    if "HOMO-LUMO gap / eV" in data:
        result.gap_ev = float(data["HOMO-LUMO gap / eV"])
    dip = data.get("dipole / a.u.")
    if dip:
        vec = [float(x) * AU_DIPOLE_TO_DEBYE for x in dip]
        result.dipole_vector_debye = [round(v, 5) for v in vec]
        result.dipole_debye = round(sum(v * v for v in vec) ** 0.5, 5)
    result.charges = [float(q) for q in data.get("partial charges", [])]
    energies = [float(e) for e in data.get("orbital energies / eV", [])]
    occ = [float(o) for o in data.get("fractional occupation", [])]
    result.orbital_energies_ev = energies
    result.occupations = occ
    if energies and occ and len(energies) == len(occ):
        occupied = [e for e, o in zip(energies, occ, strict=True) if o > 1e-3]
        virtual = [e for e, o in zip(energies, occ, strict=True) if o <= 1e-3]
        result.homo_ev = max(occupied) if occupied else None
        result.lumo_ev = min(virtual) if virtual else None
    match = re.search(r"Mol\.\s+α\(0\)\s+/au\s+:\s+([-\d.Ee+]+)", output)
    if match:
        result.polarizability_au = float(match.group(1))
    opt = work / "xtbopt.xyz"
    if opt.exists():
        rows = opt.read_text(encoding="utf-8").splitlines()[2:]
        result.coordinates = [[float(v) for v in row.split()[1:4]] for row in rows if row.strip()]
    if (work / "g98.out").exists():
        _parse_g98(work / "g98.out", result)
    result.raw_tail = "".join(output.splitlines(True)[-12:])
    return result


def _parse_g98(path: Path, result: XtbResult) -> None:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("Frequencies --"):
            freqs = [float(x) for x in line.split("--")[1].split()]
            block: dict[str, list[float]] = {"freq": freqs}
            j = i + 1
            while j < len(lines) and "--" in lines[j]:
                key, values = lines[j].split("--", 1)
                block[key.strip()] = [float(x) for x in values.split()]
                j += 1
            # lines[j] is the "Atom AN X Y Z" header
            j += 1
            displacements: list[list[list[float]]] = [[] for _ in freqs]
            while j < len(lines) and lines[j].strip() and lines[j].split()[0].isdigit():
                parts = lines[j].split()
                vals = [float(x) for x in parts[2:]]
                for k in range(len(freqs)):
                    displacements[k].append(vals[3 * k: 3 * k + 3])
                j += 1
            result.frequencies.extend(freqs)
            result.ir_intensities.extend(block.get("IR Inten", [0.0] * len(freqs)))
            result.reduced_masses.extend(block.get("Red. masses", [0.0] * len(freqs)))
            result.normal_modes.extend(displacements)
            i = j
        else:
            i += 1


def as_properties(result: XtbResult) -> dict[str, dict[str, Any]]:
    """Map an xtb result onto spec 6.4 property records (value + unit + method)."""
    method = result.method
    props: dict[str, dict[str, Any]] = {}
    if result.energy_hartree is not None:
        props["totalEnergy"] = {"value": round(result.energy_hartree, 8), "unit": "Eh", "method": method}
    if result.homo_ev is not None:
        props["homo"] = {"value": round(result.homo_ev, 4), "unit": "eV", "method": method}
    if result.lumo_ev is not None:
        props["lumo"] = {"value": round(result.lumo_ev, 4), "unit": "eV", "method": method}
    if result.gap_ev is not None:
        props["homoLumoGap"] = {"value": round(result.gap_ev, 4), "unit": "eV", "method": method}
    if result.dipole_debye is not None:
        props["dipoleMoment"] = {"value": round(result.dipole_debye, 3), "unit": "D", "method": method}
        props["dipoleVector"] = {"value": result.dipole_vector_debye, "unit": "D", "method": method}
    if result.charges:
        props["partialChargesXtb"] = {"value": [round(q, 4) for q in result.charges], "unit": "e", "method": f"{method} Mulliken"}
    if result.polarizability_au is not None:
        props["polarizability"] = {
            "value": round(result.polarizability_au * BOHR3_TO_ANG3, 4),
            "unit": "Å³",
            "method": f"{method} D4 model static α(0)",
        }
    return props
