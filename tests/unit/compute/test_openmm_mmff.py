"""MMFF94/MMFF94s as OpenMM forces reproduce RDKit's reference implementation (§7.8 mechanics)."""

from __future__ import annotations

import pytest
from rdkit import Chem
from rdkit.Chem import AllChem

from mfcompute.sim import openmm_mmff

MOLECULES = {
    "ethanol": "CCO",
    "acetonitrile (linear sp)": "CC#N",
    "acetate (anion)": "CC(=O)[O-]",
    "methylammonium (cation)": "C[NH3+]",
    "benzene": "c1ccccc1",
    "aspirin": "CC(=O)Oc1ccccc1C(=O)O",
    "caffeine": "Cn1cnc2c1c(=O)n(C)c(=O)n2C",
    "glycine zwitterion": "[NH3+]CC(=O)[O-]",
    "chloroform": "ClC(Cl)Cl",
    "dimethyl sulfoxide": "CS(C)=O",
}


def _embedded(smiles: str) -> Chem.Mol:
    mol = Chem.AddHs(Chem.MolFromSmiles(smiles))
    assert AllChem.EmbedMolecule(mol, randomSeed=11) == 0
    return mol


@pytest.mark.parametrize("variant", ["MMFF94", "MMFF94s"])
@pytest.mark.parametrize("name", sorted(MOLECULES))
def test_openmm_energy_matches_rdkit(name: str, variant: str) -> None:
    mol = _embedded(MOLECULES[name])
    props = AllChem.MMFFGetMoleculeProperties(mol, mmffVariant=variant)
    reference = AllChem.MMFFGetMoleculeForceField(mol, props).CalcEnergy()
    ours = openmm_mmff.energy_kcal(mol, variant=variant)
    assert ours == pytest.approx(reference, abs=1e-6), f"{name} {variant}: OpenMM {ours} vs RDKit {reference}"


def test_agreement_holds_away_from_the_minimum() -> None:
    """A distorted geometry exercises the anharmonic terms (cubic stretch, quartic bend, torsions)."""
    mol = _embedded("CC(=O)Oc1ccccc1C(=O)O")
    conf = mol.GetConformer()
    for i in range(mol.GetNumAtoms()):
        p = conf.GetAtomPosition(i)
        conf.SetAtomPosition(i, (p.x * 1.04, p.y * 0.97, p.z + 0.05 * (i % 3)))
    props = AllChem.MMFFGetMoleculeProperties(mol)
    reference = AllChem.MMFFGetMoleculeForceField(mol, props).CalcEnergy()
    assert openmm_mmff.energy_kcal(mol) == pytest.approx(reference, abs=1e-6)
