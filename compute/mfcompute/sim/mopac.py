"""PM7 heats of formation with the bundled MOPAC (Apache-2.0, separate process)."""

from __future__ import annotations

import re
import shutil
import uuid
from typing import Any

from rdkit import Chem

from .. import capabilities, paths
from ..jobs import JobContext, run_process
from ..rpc import ENGINE_UNAVAILABLE, RpcError

METHOD = "PM7 (MOPAC)"
MULTIPLICITY = {1: "", 2: "DOUBLET", 3: "TRIPLET", 4: "QUARTET", 5: "QUINTET"}
# PM7 covers H–Ba, Hf–Bi and the lanthanides (as sparkles); see MOPAC documentation.
SUPPORTED = set(range(1, 57)) | set(range(72, 84)) | set(range(57, 72))


def available() -> bool:
    return paths.executable("mopac", "mopac") is not None


def supports(mol: Chem.Mol) -> bool:
    return all(a.GetAtomicNum() in SUPPORTED for a in mol.GetAtoms())


def heat_of_formation(mol: Chem.Mol, ctx: JobContext, *, optimize: bool = True, percent_from: float = 0.0,
                      percent_to: float = 100.0) -> dict[str, Any]:
    exe = paths.executable("mopac", "mopac")
    if exe is None:
        raise RpcError(ENGINE_UNAVAILABLE, "MOPAC is not bundled on this platform", {"engine": "mopac"})
    radicals = sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms())
    mult = MULTIPLICITY.get(radicals + 1, "")
    keywords = ["PM7", "PRECISE", f"CHARGE={Chem.GetFormalCharge(mol)}", f"THREADS={capabilities.recommended_threads()}"]
    if mult:
        keywords += ["UHF", mult]
    if not optimize:
        keywords.append("1SCF")
    flag = 1 if optimize else 0
    conf = mol.GetConformer()
    lines = [" ".join(keywords), "MoleculeForge heat of formation", ""]
    for atom in mol.GetAtoms():
        p = conf.GetAtomPosition(atom.GetIdx())
        lines.append(f"{atom.GetSymbol():<3}{p.x:14.8f} {flag}{p.y:14.8f} {flag}{p.z:14.8f} {flag}")
    work = paths.scratch_dir() / f"mopac-{uuid.uuid4().hex[:10]}"
    work.mkdir(parents=True)
    try:
        (work / "job.mop").write_text("\n".join(lines) + "\n\n", encoding="utf-8")
        ctx.progress(percent_from, "pm7", "PM7 geometry optimisation" if optimize else "PM7 single point", force=True)
        code, _ = run_process(ctx, [str(exe), "job.mop"], cwd=str(work), env=capabilities.engine_env("mopac"), timeout=1800)
        out_path = work / "job.out"
        text = out_path.read_text(encoding="utf-8", errors="replace") if out_path.exists() else ""
        hof = re.search(r"FINAL HEAT OF FORMATION\s*=\s*([-\d.]+)\s*KCAL/MOL\s*=\s*([-\d.]+)\s*KJ/MOL", text)
        if code != 0 or hof is None:
            error = re.search(r"(?m)^\s*(.*(?:ERROR|NOT (?:AVAILABLE|PARAMETERIZED)).*)$", text)
            raise RpcError(ENGINE_UNAVAILABLE, "PM7 calculation failed", {"engine": "mopac", "detail": error.group(1).strip() if error else ""})
        result: dict[str, Any] = {
            # PM7 mean absolute error for organic heats of formation is about 4-5 kcal/mol (~20 kJ/mol).
            "heatOfFormation": {"value": float(hof.group(2)), "unit": "kJ/mol", "method": METHOD, "uncertainty": 20.0},
            "heatOfFormationKcal": {"value": float(hof.group(1)), "unit": "kcal/mol", "method": METHOD, "uncertainty": 4.8},
        }
        ip = re.search(r"IONIZATION POTENTIAL\s*=\s*([-\d.]+)\s*EV", text)
        if ip:
            result["ionizationPotential"] = {"value": float(ip.group(1)), "unit": "eV", "method": f"{METHOD} Koopmans"}
        dip = re.search(r"(?m)^\s*SUM\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)", text)
        if dip:
            result["dipoleMomentPm7"] = {"value": float(dip.group(1)), "unit": "D", "method": METHOD}
        ctx.progress(percent_to, "pm7", "PM7 complete", force=True)
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)
