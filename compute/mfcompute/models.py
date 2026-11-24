"""Typed data models (spec section 6) shared by every RPC method.

The canonical molecule schema (6.1) is mirrored one-to-one by the TypeScript Zod
schema in ``ui/src/ipc/schema.ts``; both ends validate every message.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_ATOMS = 20_000

BondOrder = Literal["single", "double", "triple", "aromatic"]
BondStereo = Literal["none", "wedge", "hash", "cis", "trans"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Atom(Strict):
    i: int = Field(ge=0)
    el: str = Field(min_length=1, max_length=3)
    x: float
    y: float
    z: float
    charge: int = Field(default=0, ge=-8, le=8)
    isotope: int | None = Field(default=None, ge=1, le=350)
    hCount: int | None = Field(default=None, ge=0, le=8)

    @field_validator("el")
    @classmethod
    def _element_symbol(cls, value: str) -> str:
        symbol = value.strip()
        if not symbol.isalpha():
            raise ValueError(f"invalid element symbol {value!r}")
        return symbol[0].upper() + symbol[1:].lower()


class Bond(Strict):
    a: int = Field(ge=0)
    b: int = Field(ge=0)
    order: BondOrder = "single"
    stereo: BondStereo = "none"


class MoleculeMeta(Strict):
    smiles: str = ""
    inchi: str = ""
    inchikey: str = ""
    category: str = ""
    source: Literal["prebuilt", "user"] = "user"
    created: str = Field(default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds"))
    #: Where the 3D structure's stereo came from, so the editor only shows stereo the source stated:
    #: "coordinates" (a real 3D source), "defined" (2D/SMILES/InChI with every stereocentre given),
    #: "partial" (some centres left open; embedding chose them arbitrarily), "none" (no stereocentres),
    #: "" (unknown, e.g. drawn or edited in the app).
    stereo: Literal["coordinates", "defined", "partial", "none", ""] = ""


class Molecule(Strict):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(default="", max_length=256)
    formula: str = Field(default="", max_length=256)
    atoms: list[Atom] = Field(default_factory=list, max_length=MAX_ATOMS)
    bonds: list[Bond] = Field(default_factory=list, max_length=MAX_ATOMS * 4)
    props: dict[str, Any] = Field(default_factory=dict)
    meta: MoleculeMeta = Field(default_factory=MoleculeMeta)

    @model_validator(mode="after")
    def _indices_consistent(self) -> Molecule:
        for position, atom in enumerate(self.atoms):
            if atom.i != position:
                raise ValueError(f"atom index {atom.i} at position {position}: indices must be 0..n-1 in order")
        n = len(self.atoms)
        for bond in self.bonds:
            if bond.a >= n or bond.b >= n:
                raise ValueError(f"bond {bond.a}-{bond.b} references a missing atom (n={n})")
        return self


class PropertyValue(Strict):
    value: Any
    unit: str
    method: str
    uncertainty: float | None = None


class Issue(Strict):
    code: str
    severity: Literal["error", "warning", "info"]
    message: str
    atoms: list[int] = Field(default_factory=list)
    bonds: list[int] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)


class SimulationResult(Strict):
    jobId: str
    method: str
    engine: str
    forceField: str | None = None
    hamiltonian: str | None = None
    converged: bool
    durationMs: int
    geometry: Molecule
    properties: dict[str, PropertyValue]
    warnings: list[str] = Field(default_factory=list)
    warningCodes: list[dict[str, Any]] = Field(default_factory=list)
    data: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# RPC parameter models
# ---------------------------------------------------------------------------


class MoleculeParams(Strict):
    molecule: Molecule
    jobId: str | None = None


class ValidateParams(Strict):
    molecule: Molecule
    focusAtoms: list[int] = Field(default_factory=list)
    focusBonds: list[int] = Field(default_factory=list)
    autoFix: bool = True
    jobId: str | None = None


class RepairParams(Strict):
    molecule: Molecule
    refine: Literal["auto", "none", "gfn2-xtb"] = "auto"
    forceField: Literal["auto", "MMFF94", "MMFF94s", "UFF"] = "auto"
    jobId: str | None = None


class WedgesParams(Strict):
    molecule: Molecule
    layout2d: list[tuple[float, float]] = Field(max_length=100_000)
    explicitH: bool = False
    jobId: str | None = None

    @model_validator(mode="after")
    def _one_point_per_atom(self) -> WedgesParams:
        if len(self.layout2d) != len(self.molecule.atoms):
            raise ValueError("layout2d must have one (x, y) pair per atom")
        if not all(math.isfinite(x) and math.isfinite(y) for x, y in self.layout2d):
            raise ValueError("layout2d contains non-finite coordinates")
        return self


class ConvertParams(Strict):
    source: Literal["molecule", "sdf", "mol", "smiles", "inchi", "xyz", "pdb"]
    target: Literal["molecule", "sdf", "mol", "smiles", "inchi", "xyz", "pdb"]
    data: str | None = None
    molecule: Molecule | None = None
    molecules: list[Molecule] | None = None
    charge: int = 0
    embed3d: bool = True
    name: str = ""
    jobId: str | None = None


class MinimizeParams(Strict):
    molecule: Molecule
    method: Literal["auto", "MMFF94", "MMFF94s", "UFF", "GFN-FF", "GFN2-xTB"] = "auto"
    maxSteps: int = Field(default=2000, ge=1, le=100_000)
    streamFrames: bool = True
    jobId: str | None = None


class RelaxParams(Strict):
    molecule: Molecule
    maxSteps: int = Field(default=300, ge=1, le=5000)
    addHydrogens: bool = False
    jobId: str | None = None


class MdParams(Strict):
    molecule: Molecule
    temperatureK: float = Field(default=300.0, gt=0, le=5000)
    timestepFs: float = Field(default=1.0, gt=0, le=4)
    steps: int = Field(default=10_000, ge=100, le=5_000_000)
    reportEvery: int = Field(default=100, ge=1)
    frictionPerPs: float = Field(default=1.0, gt=0, le=100)
    seed: int = 20240601
    jobId: str | None = None


class PropertiesParams(Strict):
    molecule: Molecule
    level: Literal["fast", "standard", "thorough"] = "standard"
    include: list[str] = Field(default_factory=list)
    md: bool = False
    jobId: str | None = None


class DockParams(Strict):
    receptor: Molecule
    ligand: Molecule
    exhaustiveness: int = Field(default=8, ge=1, le=64)
    numModes: int = Field(default=9, ge=1, le=20)
    boxPadding: float = Field(default=6.0, ge=2.0, le=30.0)
    seed: int = 42
    jobId: str | None = None


class JobRef(Strict):
    jobId: str


class ElementParams(Strict):
    z: int | None = Field(default=None, ge=1, le=118)
    symbol: str | None = None


class LibraryListParams(Strict):
    query: str = ""
    category: str | None = None
    source: Literal["prebuilt", "user", "all"] = "all"
    favoritesOnly: bool = False
    #: "default": built-in molecules first, then by name; "recent": last saved first.
    sort: Literal["default", "name", "recent", "weight"] = "default"
    limit: int = Field(default=500, ge=1, le=5000)
    offset: int = Field(default=0, ge=0)


class LibrarySaveParams(Strict):
    molecule: Molecule
    layout2d: list[list[float]] | None = None
    #: Stereo wedges as displayed ({"bond", "kind": "wedge"|"hash", "from"}); only sent when the stereo is known.
    wedges: list[dict[str, int | str]] = Field(default_factory=list, max_length=2000)
    tags: list[str] = Field(default_factory=list)
    favorite: bool = False
    overwrite: bool = False

    @model_validator(mode="after")
    def _valid_wedges(self) -> LibrarySaveParams:
        n_bonds, n_atoms = len(self.molecule.bonds), len(self.molecule.atoms)
        for w in self.wedges:
            bond, kind, start = w.get("bond"), w.get("kind"), w.get("from")
            if not (isinstance(bond, int) and 0 <= bond < n_bonds and kind in ("wedge", "hash")
                    and isinstance(start, int) and 0 <= start < n_atoms):
                raise ValueError("invalid wedge entry")
        return self


class LibraryIdParams(Strict):
    id: str


class LibraryFavoriteParams(Strict):
    id: str
    favorite: bool


class LibraryImportParams(Strict):
    format: Literal["sdf", "json"]
    data: str


class LibraryExportParams(Strict):
    format: Literal["sdf", "json"]
    ids: list[str] = Field(default_factory=list)


class ReportExportParams(Strict):
    report: dict[str, Any]
    format: Literal["markdown", "pdf"]
    locale: str = Field(default="en", max_length=16)
    #: Localised labels from the UI: "<label>": text, plus "fixLines"/"issueLines" (lists) and "stageNames" (map).
    strings: dict[str, str | list[str] | dict[str, str]] = Field(default_factory=dict, max_length=80)

    @field_validator("strings")
    @classmethod
    def _bounded_strings(cls, value: dict[str, Any]) -> dict[str, Any]:
        for key, item in value.items():
            size = len(item) if isinstance(item, (list, dict)) else 1
            if len(key) > 64 or size > 2000:
                raise ValueError(f"strings[{key[:64]}] is too large")
        return value


class AiQueryParams(Strict):
    prompt: str = Field(min_length=1, max_length=8000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=40)
    molecule: Molecule | None = None
    context: dict[str, Any] = Field(default_factory=dict)
    locale: str = "en"
    jobId: str | None = None


class AiConfigParams(Strict):
    modelPath: str | None = Field(default=None, max_length=4096)
    useDefault: bool = False
    contextSize: int = Field(default=8192, ge=2048, le=131072)
    gpuLayers: int | None = None
