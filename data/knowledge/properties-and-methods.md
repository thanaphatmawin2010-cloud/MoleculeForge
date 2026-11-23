# Drug-likeness rules
source: Lipinski et al., Adv. Drug Deliv. Rev. 23 (1997) 3; Veber et al., J. Med. Chem. 45 (2002) 2615; Bickerton et al., Nat. Chem. 4 (2012) 90
Lipinski's rule of five flags likely poor oral absorption when more than one of these is violated: molecular weight ≤ 500, logP ≤ 5, H-bond donors (OH + NH) ≤ 5, H-bond acceptors (N + O) ≤ 10. Veber's rules add rotatable bonds ≤ 10 and polar surface area ≤ 140 Å². QED combines eight properties into a 0–1 desirability score; higher is more drug-like. These are screening heuristics for teaching, not predictions of safety or efficacy.

# logP and TPSA
source: Wildman & Crippen, J. Chem. Inf. Comput. Sci. 39 (1999) 868; Ertl et al., J. Med. Chem. 43 (2000) 3714
logP is the octanol/water partition coefficient on a log10 scale; positive values mean lipophilic. MoleculeForge reports the Wildman–Crippen atom-contribution estimate (typical error about 0.7 log units). Topological polar surface area (TPSA) sums tabulated contributions of N and O atoms (and attached H); values above about 140 Å² correlate with poor membrane permeability.

# pKa
source: CRC Handbook of Chemistry and Physics, dissociation constants
pKa = −log10 Ka. Typical aqueous values: carboxylic acids about 4–5 (acetic acid 4.76), phenols about 10, aliphatic alcohols about 16, protonated aliphatic amines about 10–11, protonated pyridine 5.2, protonated aniline 4.6, imidazolium 7.0. MoleculeForge's pKa values are functional-group estimates (±1.5 units) without substituent effects.

# Frontier orbitals
source: Fukui (1952); Koopmans (1934)
The HOMO (highest occupied molecular orbital) and LUMO (lowest unoccupied) govern reactivity and electronic excitation. A large HOMO–LUMO gap indicates kinetic stability; small gaps occur in conjugated or reactive species. Orbital energies depend strongly on the method: semi-empirical GFN2-xTB and DFT (B3LYP) gaps differ, so compare values computed with the same method.

# Dipole moment and polarizability
source: CRC Handbook; Atkins, Physical Chemistry
The dipole moment (in debye, D) measures charge separation: water 1.85 D, ammonia 1.47 D, symmetric molecules such as CO2, benzene and methane 0 D. Polarizability (Å³) measures how easily the electron cloud is distorted by an electric field and grows with size: water 1.45 Å³, benzene about 10 Å³.

# Computational methods in MoleculeForge
source: Halgren, J. Comput. Chem. 17 (1996) 490; Rappé et al., J. Am. Chem. Soc. 114 (1992) 10024; Bannwarth, Ehlert & Grimme, J. Chem. Theory Comput. 15 (2019) 1652; Stewart, J. Mol. Model. 19 (2013) 1; Becke (1993)
MMFF94 is a classical force field for organic molecules; UFF covers elements up to Lr with lower accuracy. GFN2-xTB is a fast semi-empirical tight-binding quantum method for elements H–Rn, good for geometries and qualitative electronic properties. PM7 (MOPAC) estimates heats of formation with a mean absolute error around 4–5 kcal/mol for organic molecules. B3LYP/def2-SVPD (density functional theory, PySCF) is the most accurate method used here, applied to small molecules for dipoles, orbitals and polarizability. Every reported number lists the method that produced it.

# Thermochemistry
source: McQuarrie, Statistical Thermodynamics; Grimme, Chem. Eur. J. 18 (2012) 9955
From harmonic vibrational frequencies, statistical thermodynamics gives zero-point energy (ZPE), enthalpy H, entropy S and Gibbs free energy G = H − TS for an ideal gas at 298.15 K and 1 atm. Low-frequency modes (< 100 cm⁻¹) are poorly described as harmonic oscillators; the quasi-RRHO correction of Grimme treats them as free rotors for the entropy. An imaginary frequency means the structure is a saddle point, not a minimum.

# Infrared spectra
source: Silverstein, Spectrometric Identification of Organic Compounds
Characteristic IR absorptions: O–H stretch 3200–3600 cm⁻¹ (broad when hydrogen bonded); N–H 3300–3500; C–H 2850–3100; C≡N about 2250; C≡C about 2150; C=O 1650–1750; C=C 1600–1680; C–O 1000–1300. Computed harmonic frequencies are typically a few percent higher than experiment.

# Molecular dynamics
source: Frenkel & Smit, Understanding Molecular Simulation
Molecular dynamics integrates Newton's equations of motion; a Langevin thermostat keeps the average temperature at the target. Averages such as potential energy and radius of gyration converge as the simulation gets longer; the heat capacity estimated from energy fluctuations needs long runs to be reliable.

# Docking
source: Eberhardt et al., J. Chem. Inf. Model. 61 (2021) 3891 (AutoDock Vina 1.2)
Docking searches for ligand poses in a binding site and scores them with an empirical function (kcal/mol, more negative = stronger predicted binding). Vina's typical error is around 2–3 kcal/mol; scores rank poses and compounds but are not experimental binding free energies. MoleculeForge treats the receptor as rigid.
