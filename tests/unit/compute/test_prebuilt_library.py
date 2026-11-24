"""§7.6 / §7.4: every shipped prebuilt molecule is valid as stored and physically reasonable."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from mfcompute.chem import validate
from mfcompute.models import Molecule

ROOT = Path(__file__).resolve().parents[3]
LIBRARY = json.loads((ROOT / "data" / "molecules" / "library.json").read_text(encoding="utf-8"))["molecules"]
MOLECULES = [Molecule.model_validate(entry["molecule"]) for entry in LIBRARY]


def test_at_least_one_hundred_molecules_with_complete_metadata() -> None:
    assert len(MOLECULES) >= 100
    for m in MOLECULES:
        assert m.name and m.formula and m.meta.smiles and m.meta.inchi and m.meta.inchikey and m.meta.category, m.name
        assert datetime.fromisoformat(m.meta.created).tzinfo is not None, f"{m.name}: created must be ISO 8601 (§6.1)"
        assert all(np.isfinite([a.x, a.y, a.z]).all() for a in m.atoms), m.name


@pytest.mark.parametrize("molecule", MOLECULES, ids=[m.name for m in MOLECULES])
def test_prebuilt_molecule_validates_with_zero_corrections(molecule: Molecule) -> None:
    result = validate.validate(molecule, [], [], True)
    assert result["status"] == "valid" and not result["fixes"], f"{molecule.name}: {result['message']}"


@pytest.mark.parametrize("molecule", MOLECULES, ids=[m.name for m in MOLECULES])
def test_prebuilt_geometry_has_no_clashes(molecule: Molecule) -> None:
    """§7.4: no two atoms closer than 0.7 Å."""
    if len(molecule.atoms) < 2:
        return
    xyz = np.array([[a.x, a.y, a.z] for a in molecule.atoms])
    distances = np.linalg.norm(xyz[:, None, :] - xyz[None, :, :], axis=-1)
    np.fill_diagonal(distances, np.inf)
    assert distances.min() >= 0.7, f"{molecule.name}: atoms {np.unravel_index(distances.argmin(), distances.shape)} at {distances.min():.3f} Å"
