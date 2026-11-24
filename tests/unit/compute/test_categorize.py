"""Automatic library categories do not depend on whether hydrogens are drawn as atoms."""

from __future__ import annotations

import pytest
from rdkit import Chem

from mfcompute.data.categorize import categorize

CASES = [
    ("C", "hydrocarbons"), ("CO", "alcohols-ethers"), ("CCO", "alcohols-ethers"), ("C=O", "carbonyls"),
    ("OC=O", "acids-derivatives"), ("O=C=O", "inorganic"), ("[C-]#[O+]", "inorganic"), ("O", "inorganic"),
    ("c1ccccc1", "aromatics"), ("CCl", "halogenated"), ("CN", "nitrogen-compounds"), ("CS", "sulfur-phosphorus"),
    ("NCC(=O)O", "biomolecules"), ("[NH4+]", "ions"),
]


@pytest.mark.parametrize(("smiles", "expected"), CASES)
def test_category_with_implicit_and_explicit_hydrogens(smiles: str, expected: str) -> None:
    implicit = Chem.MolFromSmiles(smiles)
    assert categorize(implicit) == expected
    assert categorize(Chem.AddHs(implicit)) == expected
