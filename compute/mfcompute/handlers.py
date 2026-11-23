"""RPC method implementations (spec 4.3). Importing this module registers every method."""

from __future__ import annotations

from typing import Any

from . import capabilities
from .jobs import JobContext
from .models import (
    AiConfigParams,
    AiQueryParams,
    ConvertParams,
    DockParams,
    ElementParams,
    JobRef,
    LibraryExportParams,
    LibraryFavoriteParams,
    LibraryIdParams,
    LibraryImportParams,
    LibraryListParams,
    LibrarySaveParams,
    MdParams,
    MinimizeParams,
    MoleculeParams,
    PropertiesParams,
    RepairParams,
    ReportExportParams,
    ValidateParams,
)
from .registry import method
from .rpc import CHEMISTRY_ERROR, RpcError

# ---------------------------------------------------------------------------
# system / jobs
# ---------------------------------------------------------------------------


@method("system.ping", kind="control")
def ping(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """Liveness probe."""
    from . import __version__

    return {"pong": True, "version": __version__}


@method("system.capabilities", kind="interactive")
def system_capabilities(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """CPU cores, vector extensions, RAM, GPUs and bundled engines."""
    return capabilities.detect(refresh=bool(params.get("refresh", False)))


@method("system.shutdown", kind="control")
def system_shutdown(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """Stop all jobs and exit after replying."""
    from . import server

    if server.SERVER is not None:
        server.SERVER.cancel_all()
        server.SERVER.shutting_down.set()
    return {"ok": True}


@method("job.cancel", JobRef, kind="control")
def job_cancel(params: JobRef, ctx: JobContext) -> dict[str, Any]:
    """Cancel a running job by id."""
    from . import server

    found = server.SERVER.cancel(params.jobId) if server.SERVER is not None else False
    return {"jobId": params.jobId, "cancelled": found}


@method("ai.cancel", JobRef, kind="control")
def ai_cancel(params: JobRef, ctx: JobContext) -> dict[str, Any]:
    """Cancel a running assistant turn."""
    return job_cancel(params, ctx)


# ---------------------------------------------------------------------------
# chemistry
# ---------------------------------------------------------------------------


@method("chem.sanitize", MoleculeParams)
def chem_sanitize(params: MoleculeParams, ctx: JobContext) -> dict[str, Any]:
    """Validity pass: valence, charge, aromaticity, radicals; returns issues and the sanitized molecule."""
    from .chem import validate

    return validate.sanitize(params.molecule)


@method("chem.validateBonds", ValidateParams)
def chem_validate_bonds(params: ValidateParams, ctx: JobContext) -> dict[str, Any]:
    """Classify atoms/bonds as valid or invalid and apply the minimal correct fix."""
    from .chem import validate

    return validate.validate(params.molecule, params.focusAtoms, params.focusBonds, params.autoFix)


@method("chem.repairGeometry", RepairParams, kind="job")
def chem_repair_geometry(params: RepairParams, ctx: JobContext) -> dict[str, Any]:
    """One-click repair: fix chemistry, rebuild/relax 3D geometry and return a detailed report."""
    from .chem import geometry

    return geometry.repair(params.molecule, refine=params.refine, force_field=params.forceField, ctx=ctx)


@method("chem.relax", MinimizeParams, kind="job")
def chem_relax(params: MinimizeParams, ctx: JobContext) -> dict[str, Any]:
    """Fast local force-field relaxation used while editing (streams frames)."""
    from .chem import geometry

    return {"molecule": geometry.quick_relax(params.molecule, ctx, max_steps=min(params.maxSteps, 400))}


@method("chem.descriptors", MoleculeParams)
def chem_descriptors(params: MoleculeParams, ctx: JobContext) -> dict[str, Any]:
    """Cheminformatics descriptors (MW, logP, TPSA, HBD/HBA, Lipinski, Veber, QED, pKa estimates...)."""
    from .chem import descriptors

    return {"properties": descriptors.compute(params.molecule)}


@method("chem.convertFormat", ConvertParams)
def chem_convert_format(params: ConvertParams, ctx: JobContext) -> dict[str, Any]:
    """Convert between the canonical molecule JSON and SDF/MOL/SMILES/InChI/XYZ/PDB."""
    from .chem import convert

    if params.source == "molecule":
        molecules = params.molecules or ([params.molecule] if params.molecule else [])
        if not molecules:
            raise RpcError(CHEMISTRY_ERROR, "No molecule supplied", {"code": "EMPTY_INPUT"})
    else:
        if params.data is None:
            raise RpcError(CHEMISTRY_ERROR, "No input data", {"code": "EMPTY_INPUT"})
        molecules = convert.parse(params.source, params.data, charge=params.charge, embed3d=params.embed3d, name=params.name)
    if params.target == "molecule":
        return {"molecules": molecules}
    return {"data": convert.write(params.target, molecules), "format": params.target, "count": len(molecules)}


@method("chem.layout2d", MoleculeParams)
def chem_layout_2d(params: MoleculeParams, ctx: JobContext) -> dict[str, Any]:
    """Publication-style 2D depiction coordinates (RDKit CoordGen) for the sketcher."""
    from rdkit.Chem import rdDepictor

    from .chem import convert

    mol = convert.to_rdkit(params.molecule, sanitize=False)
    mol.UpdatePropertyCache(strict=False)
    rdDepictor.SetPreferCoordGen(True)
    rdDepictor.Compute2DCoords(mol)
    pos = mol.GetConformer().GetPositions()
    return {"layout2d": [[round(float(x), 4), round(float(y), 4)] for x, y, _ in pos]}


# ---------------------------------------------------------------------------
# simulation
# ---------------------------------------------------------------------------


@method("sim.minimize", MinimizeParams, kind="job")
def sim_minimize(params: MinimizeParams, ctx: JobContext) -> dict[str, Any]:
    """Energy minimisation with MMFF94/MMFF94s/UFF, GFN-FF or GFN2-xTB."""
    from .sim import minimize

    return minimize.run(params, ctx)


@method("sim.md", MdParams, kind="job")
def sim_md(params: MdParams, ctx: JobContext) -> dict[str, Any]:
    """Langevin molecular dynamics (OpenMM, MMFF94 or UFF) with thermodynamic averages."""
    from .sim import md

    return md.run(params, ctx)


@method("sim.properties", PropertiesParams, kind="job")
def sim_properties(params: PropertiesParams, ctx: JobContext) -> dict[str, Any]:
    """Full property battery (descriptors, FF, GFN2-xTB, PM7, DFT, vibrations, thermochemistry, SASA)."""
    from .sim import properties

    return properties.run(params, ctx)


@method("sim.dock", DockParams, kind="job")
def sim_dock(params: DockParams, ctx: JobContext) -> dict[str, Any]:
    """AutoDock Vina docking of a ligand onto a receptor plus interaction analysis."""
    from .sim import dock

    return dock.run(params, ctx)


# ---------------------------------------------------------------------------
# elements & library
# ---------------------------------------------------------------------------


@method("elements.get", ElementParams)
def elements_get(params: ElementParams, ctx: JobContext) -> dict[str, Any]:
    """One element by atomic number or symbol."""
    from .data import elements

    return elements.get(params.z, params.symbol)


@method("elements.all")
def elements_all(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """All 118 elements with sources and the status legend."""
    from .data import elements

    data = elements.dataset()
    return {"elements": data["elements"], "statusLegend": data["statusLegend"], "sources": data["sources"]}


@method("library.list", LibraryListParams)
def library_list(params: LibraryListParams, ctx: JobContext) -> dict[str, Any]:
    """Search/list prebuilt and user molecules."""
    from .data import library

    return library.STORE().list(params)


@method("library.load", LibraryIdParams)
def library_load(params: LibraryIdParams, ctx: JobContext) -> dict[str, Any]:
    """Load one molecule (with its 2D layout) by id."""
    from .data import library

    return library.STORE().load(params.id)


@method("library.save", LibrarySaveParams)
def library_save(params: LibrarySaveParams, ctx: JobContext) -> dict[str, Any]:
    """Save a user molecule; auto-categorises and detects duplicates by InChIKey."""
    from .data import library

    return library.STORE().save(params)


@method("library.delete", LibraryIdParams)
def library_delete(params: LibraryIdParams, ctx: JobContext) -> dict[str, Any]:
    """Delete a user molecule (prebuilt molecules are read-only)."""
    from .data import library

    return library.STORE().delete(params.id)


@method("library.favorite", LibraryFavoriteParams)
def library_favorite(params: LibraryFavoriteParams, ctx: JobContext) -> dict[str, Any]:
    """Mark or unmark a favourite."""
    from .data import library

    return library.STORE().favorite(params.id, params.favorite)


@method("library.categories")
def library_categories(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """Category grid definition with counts."""
    from .data import library

    return library.STORE().categories()


@method("library.import", LibraryImportParams, kind="job")
def library_import(params: LibraryImportParams, ctx: JobContext) -> dict[str, Any]:
    """Import SDF or JSON molecules into the user library."""
    from .data import library

    return library.STORE().import_data(params, ctx)


@method("library.export", LibraryExportParams)
def library_export(params: LibraryExportParams, ctx: JobContext) -> dict[str, Any]:
    """Export molecules as SDF or JSON."""
    from .data import library

    return library.STORE().export_data(params)


# ---------------------------------------------------------------------------
# reports & AI
# ---------------------------------------------------------------------------


@method("report.export", ReportExportParams, kind="job")
def report_export(params: ReportExportParams, ctx: JobContext) -> dict[str, Any]:
    """Render a repair report as Markdown or PDF (base64)."""
    from .chem import report

    return report.export(params.report, params.format, params.locale)


@method("ai.query", AiQueryParams, kind="ai")
def ai_query(params: AiQueryParams, ctx: JobContext) -> dict[str, Any]:
    """Ask the local chemistry assistant; it computes answers by calling MoleculeForge tools."""
    from .ai import assistant

    return assistant.answer(params, ctx)


@method("ai.status", kind="interactive")
def ai_status(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """Model availability and runtime state."""
    from .ai import llm

    return llm.status()


@method("ai.configure", AiConfigParams, kind="interactive")
def ai_configure(params: AiConfigParams, ctx: JobContext) -> dict[str, Any]:
    """Select a different local GGUF model or context size (restarts the runtime lazily)."""
    from .ai import llm

    return llm.configure(params)
