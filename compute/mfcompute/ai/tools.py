"""Tools the assistant may call (spec 7.10). Each returns compact JSON with values, units and methods."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any

from ..chem import convert, descriptors, geometry, validate
from ..data import elements, library
from ..jobs import JobContext
from ..models import DockParams, LibraryListParams, Molecule, PropertiesParams
from ..rpc import RpcError

ToolFn = Callable[[dict[str, Any], "ToolContext"], dict[str, Any]]

_MOLECULE_ARG = {
    "smiles": {"type": "string", "description": "SMILES of the molecule. Omit to use the molecule currently open in MoleculeForge."},
}


class ToolContext:
    def __init__(self, molecule: Molecule | None, job: JobContext) -> None:
        self.molecule = molecule
        self.job = job

    def resolve(self, args: dict[str, Any]) -> Molecule:
        smiles = args.get("smiles")
        if isinstance(smiles, str) and smiles.strip():
            return convert.parse("smiles", smiles.strip())[0]
        if self.molecule is None or not self.molecule.atoms:
            raise RpcError(-32002, "No molecule is open and no SMILES was given", {"code": "NO_MOLECULE"})
        return self.molecule


def _pv(props: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    out = {}
    for key in keys:
        item = props.get(key)
        if item is None:
            continue
        value = item["value"] if isinstance(item, dict) else getattr(item, "value", None)
        unit = item["unit"] if isinstance(item, dict) else getattr(item, "unit", "")
        method = item["method"] if isinstance(item, dict) else getattr(item, "method", "")
        out[key] = {"value": value, "unit": unit, "method": method}
    return out


def tool_sanitize(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    mol = ctx.resolve(args)
    result = validate.sanitize(mol)
    return {"valid": result["valid"], "formula": result["molecule"].formula, "smiles": result["molecule"].meta.smiles,
            "issues": [{"code": i.code, "severity": i.severity, "message": i.message} for i in result["issues"]]}


def tool_validate_bonds(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    mol = ctx.resolve(args)
    result = validate.validate(mol, [], [], True)
    return {"status": result["status"], "message": result["message"],
            "fixesProposed": [f["fix"]["description"] for f in result["fixes"]],
            "remainingIssues": [{"code": i.code, "message": i.message} for i in result["issues"] if i.severity != "info"],
            "note": "Fixes are proposals; the user's document is only changed if they accept them in the editor."}


def tool_repair_geometry(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    mol = ctx.resolve(args)
    report = geometry.repair(mol, refine="auto", force_field="auto", ctx=ctx.job)
    if report["status"] == "failed":
        return {"status": "failed", "reason": report.get("reason")}
    changes = report["changes"]
    return {
        "status": report["status"],
        "methods": [m["method"] for m in report["methods"]],
        "residualEnergy": report["residualEnergy"],
        "fixesApplied": [f["fix"]["description"] for f in report["fixesApplied"]],
        "largestBondChanges": changes["bonds"][:5],
        "largestAngleChanges": changes["angles"][:5],
        "counts": {k: changes[f"{k}Total"] for k in ("bonds", "angles", "dihedrals")},
        "bondTable": [{k: row[k] for k in ("type", "count", "mean", "unit", "withinTenPercent")} | {"reference": row["reference"]}
                      for row in report["geometryCheck"]["bondTable"]],
        "angleTable": [{k: row[k] for k in ("class", "count", "mean", "unit", "ideal")} for row in report["geometryCheck"]["angleTable"]],
        "minNonBondedDistance": report["geometryCheck"]["minNonBondedDistance"],
    }


def tool_descriptors(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    mol = ctx.resolve(args)
    props = descriptors.compute(mol)
    return {"formula": props["formula"]["value"], **_pv(props, [
        "molecularWeight", "exactMass", "logP", "tpsa", "hBondDonors", "hBondAcceptors", "rotatableBonds", "ringCount",
        "aromaticRingCount", "qed", "lipinski", "veber", "pKaEstimates", "molarRefractivity", "netCharge"])}


def tool_simulate(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    from ..sim import properties

    mol = ctx.resolve(args)
    level = args.get("level") if args.get("level") in ("fast", "standard") else "fast"
    result = properties.run(PropertiesParams(molecule=mol, level=level), ctx.job)
    props = result["properties"]
    keys = ["molecularWeight", "potentialEnergy", "totalEnergy", "homo", "lumo", "homoLumoGap", "dipoleMoment", "polarizability",
            "heatOfFormation", "zeroPointEnergy", "entropy", "gibbsCorrection", "sasa", "molecularVolume", "logP", "tpsa", "qed"]
    out = {"methods": result["data"].get("methods", []), "warnings": result["warnings"], **_pv(props, keys)}
    freqs = props.get("vibrationalFrequencies")
    if freqs is not None:
        values = freqs["value"] if isinstance(freqs, dict) else freqs.value
        intens = props["irIntensities"]["value"] if isinstance(props["irIntensities"], dict) else props["irIntensities"].value
        strongest = sorted([(f, i) for f, i in zip(values, intens, strict=False) if f > 10], key=lambda x: -x[1])[:6]
        out["strongestIrBands"] = [{"frequency": round(f, 1), "unit": "cm-1", "intensity": round(i, 2), "intensityUnit": "km/mol"} for f, i in strongest]
    return out


def tool_dock(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    from ..sim import dock

    receptor_query = str(args.get("receptor", "")).strip()
    hits = library.STORE().list(LibraryListParams(query=receptor_query, limit=1))["items"] if receptor_query else []
    if not hits:
        return {"error": f"No library molecule matches receptor '{receptor_query}'."}
    receptor = Molecule.model_validate(library.STORE().load(hits[0]["id"])["molecule"])
    ligand = ctx.resolve(args)
    result = dock.run(DockParams(receptor=receptor, ligand=ligand, exhaustiveness=8), ctx.job)
    return {"receptor": hits[0]["name"], "modes": result["data"]["modes"][:5], "warnings": result["warnings"],
            **_pv(result["properties"], ["bestAffinity", "interactionEnergy", "hydrogenBondCount", "hydrophobicContactCount"])}


def tool_get_element(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    query = str(args.get("element", "")).strip()
    record = None
    if query.isdigit():
        record = elements.get(z=int(query))
    else:
        for el in elements.all_elements():
            if el["symbol"].lower() == query.lower() or el["nameEn"].lower() == query.lower():
                record = el
                break
    if record is None:
        return {"error": f"Unknown element '{query}'"}
    keep = ["Z", "symbol", "nameEn", "atomicMass", "category", "group", "period", "block", "electronConfiguration",
            "electronegativityPauling", "radiusCovalent", "radiusVanDerWaals", "electronAffinity", "oxidationStates",
            "density", "meltingPointK", "boilingPointK", "electricalType", "crystalStructure", "commonUses"]
    out = {k: record[k] for k in keep}
    out["firstIonizationEnergy"] = {"value": (record["ionizationEnergies"]["values"] or [None])[0], "unit": "kJ/mol"}
    out["naturalIsotopes"] = [{"massNumber": i["massNumber"], "abundance": i["abundance"]["value"]}
                              for i in record["isotopes"] if (i["abundance"]["value"] or 0) > 0]
    out["source"] = "MoleculeForge element dataset (mendeleev: IUPAC/CIAAW, NIST, CRC)"
    return out


def tool_lookup_molecule(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    query = str(args.get("query", "")).strip()
    items = library.STORE().list(LibraryListParams(query=query, limit=5))["items"]
    return {"matches": [{"name": i["name"], "formula": i["formula"], "smiles": i["smiles"], "category": i["category"],
                         "source": i["source"], "descriptors": i["descriptors"]} for i in items]}


TOOLS: dict[str, tuple[ToolFn, str, dict[str, Any], list[str]]] = {
    "sanitize": (tool_sanitize, "Check valence, charges, aromaticity and radicals of a molecule.", _MOLECULE_ARG, []),
    "validateBonds": (tool_validate_bonds, "Validate every bond and propose minimal fixes for invalid ones.", _MOLECULE_ARG, []),
    "repairGeometry": (tool_repair_geometry,
                       "Repair chemistry and optimise 3D geometry; returns bond/angle changes, methods, convergence and energy.",
                       _MOLECULE_ARG, []),
    "descriptors": (tool_descriptors,
                    "Cheminformatics descriptors: MW, exact mass, logP, TPSA, H-bond donors/acceptors, Lipinski, Veber, QED, pKa estimates.",
                    _MOLECULE_ARG, []),
    "simulate": (tool_simulate,
                 "Run the local quantum/force-field property battery: energies, HOMO/LUMO, dipole, polarisability, heat of formation, IR bands, thermochemistry.",
                 {**_MOLECULE_ARG, "level": {"type": "string", "enum": ["fast", "standard"], "description": "fast (seconds) or standard (includes DFT for small molecules)."}},
                 []),
    "dock": (tool_dock, "Dock the molecule onto a receptor from the library with AutoDock Vina (educational estimate).",
             {**_MOLECULE_ARG, "receptor": {"type": "string", "description": "Library name of the receptor molecule."}}, ["receptor"]),
    "getElement": (tool_get_element, "Look up an element's data (mass, configuration, electronegativity, radii, physical properties, isotopes).",
                   {"element": {"type": "string", "description": "Symbol, name or atomic number."}}, ["element"]),
    "lookupMolecule": (tool_lookup_molecule, "Search the molecule library by name, formula or SMILES.",
                       {"query": {"type": "string", "description": "Name, formula or SMILES fragment."}}, ["query"]),
}


def schemas() -> list[dict[str, Any]]:
    return [
        {"type": "function", "function": {"name": name, "description": desc,
                                          "parameters": {"type": "object", "properties": props, "required": required}}}
        for name, (_fn, desc, props, required) in TOOLS.items()
    ]


def execute(name: str, raw_arguments: str, ctx: ToolContext) -> tuple[bool, dict[str, Any], int]:
    started = time.perf_counter()
    if name not in TOOLS:
        return False, {"error": f"Unknown tool {name}"}, 0
    try:
        args = json.loads(raw_arguments) if raw_arguments.strip() else {}
        if not isinstance(args, dict):
            raise ValueError("arguments must be an object")
    except (json.JSONDecodeError, ValueError) as exc:
        return False, {"error": f"Invalid arguments: {exc}"}, 0
    try:
        result = TOOLS[name][0](args, ctx)
        ok = "error" not in result
    except RpcError as err:
        if err.code == -32000:
            raise
        result, ok = {"error": err.message}, False
    except Exception as exc:
        result, ok = {"error": f"{type(exc).__name__}: {exc}"}, False
    return ok, result, int((time.perf_counter() - started) * 1000)
