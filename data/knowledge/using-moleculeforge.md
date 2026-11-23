# Building molecules
source: MoleculeForge user guide
Choose an element in the toolbar (or press its key: C, H, N, O, S, P, F, L for Cl, B for Br, I) and click the canvas to place an atom. Drag from an atom to another atom to bond them, or to empty space to grow a new bonded atom. Click a bond to cycle single, double and triple. Every edit is checked immediately; invalid bonds are corrected automatically and the correction can be undone with Ctrl+Z.

# Repair and optimisation
source: MoleculeForge user guide
"Repair & optimise" (Shift+R) fixes valence problems, adds missing hydrogens, generates or relaxes 3D coordinates with MMFF94 (UFF for elements MMFF does not cover) and refines small molecules with GFN2-xTB. The report lists every changed bond length, angle and dihedral with units, the method used, convergence and the final energy, and can be exported as Markdown or PDF.

# Simulation
source: MoleculeForge user guide
The Simulate view computes properties locally: descriptors, force-field energy, GFN2-xTB orbitals, charges and dipole, vibrational frequencies and IR spectrum, PM7 heat of formation, DFT values for small molecules, thermochemistry, surface area and optional molecular dynamics. Docking places the current molecule onto a receptor chosen from the library.
