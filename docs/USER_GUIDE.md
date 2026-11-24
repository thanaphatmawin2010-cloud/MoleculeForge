# MoleculeForge user guide

MoleculeForge lets you draw a molecule, check it as you go, repair its 3D geometry in one click,
explore the elements, keep a library of structures, and compute their properties. Everything runs
on your computer: nothing is uploaded, and no internet connection is needed.

## Installing

| System | Installer | Notes |
|---|---|---|
| Windows 10/11 | `MoleculeForge_1.0.0_x64-setup.exe` or `.msi` | Installs for the current user; the WebView2 runtime is included. |
| macOS 11+ | `MoleculeForge_1.0.0_aarch64.dmg` / `_x64.dmg` | Drag MoleculeForge to Applications. |
| Linux | `MoleculeForge_1.0.0_amd64.AppImage` or `.deb` | AppImage: make it executable and run it. `.deb`: `sudo apt install ./MoleculeForge_1.0.0_amd64.deb`. |

Every installer contains all the calculation engines, the element and molecule data, and the AI
model, so nothing has to be downloaded after installation.

On Windows, two things differ:

* Windows installers cannot be larger than 2 GB, so they bundle a smaller model (Qwen3-1.7B). The
  larger model used on macOS and Linux (Qwen3-4B-Instruct-2507) can be loaded from
  **Assistant → Language model**.
* PySCF, the density-functional (B3LYP) engine, is not available for Windows. Dipoles, orbitals
  and charges come from GFN2-xTB there. Small hydrides such as water keep their MMFF94 geometry
  after repair; its bond angles are within 1.5° of experiment for water, ammonia, hydrogen
  sulfide and phosphine.

## Your first molecule (about one minute)

The first time you open the app, a short guide builds water with you:

1. Press **O**, then click the drawing area to place an oxygen atom.
2. Press **H**, then drag outward from the oxygen. Do it twice to add two hydrogens.
3. Each new bond is checked as soon as you draw it, and **"Bond connected correctly."** appears.
   The 3D view on the right relaxes the molecule into its real shape, with the H–O–H angle near 104°.

## Drawing (Build)

| Action | How |
|---|---|
| Choose an element | Click it in the toolbar, press its key (**C H N O S P F**, **L** = Cl, **B** = Br, **I**), or open the full periodic table from the grid button |
| Place an atom | Click an empty spot |
| Grow a bond | Drag outward from an atom, or click an atom to add a bonded atom |
| Bond order | Keys **1–4** (single, double, triple, aromatic), or click an existing bond to cycle its order |
| Change an element | With the atom tool, click an atom of a different element |
| Charge | **Q**, then click an atom (Shift-click lowers the charge) |
| Measure | **M**, then pick 2, 3 or 4 atoms to get a distance, angle or dihedral |
| Select / move | **V**, then drag atoms or draw a selection box; **Delete** removes the selection |
| Erase | **E**, then click an atom or bond |
| Rings | Benzene, cyclohexane and cyclopentane buttons in the toolbar: click to add one beside the drawing, or drag it onto the spot where you want it |
| Undo / redo | **Ctrl Z** / **Ctrl Y** (⌘ on macOS); unlimited |
| Add hydrogens | **Shift H** |
| Clean up 2D layout | The wand button |
| Fit to view | **F** |

The inspector on the right shows the formula, molecular weight, counts, live validation, and
switches for **Live physics**, **carbon labels** and **hydrogens on carbon**. Live physics relaxes
the 3D shape after each edit you make, for structures of up to 500 atoms; molecules you open and
repaired structures keep their coordinates until you press **Relax now**. Molecules opened from
files or the library are drawn as skeletal formulas, with hydrogens on carbon hidden; the switch
shows them. Stereocentres from a file or the library appear as wedge and hash bonds.

### Validation messages

Every edit is checked within a fraction of a second. Problems are outlined in red and explained in
plain language, for example *"C atom 1 has 5 bonds; at most 4 are allowed with charge 0."* Atom
numbers match the numbers in the repair report and the measure tool. When a fix is unambiguous,
MoleculeForge applies it and tells you **"Bond connection fixed successfully."**, and **Undo**
reverses it.

## One-click repair

Click **Repair** (or press **Shift R**). MoleculeForge fixes valence, charge and aromaticity
problems, adds missing hydrogens, builds 3D coordinates if needed, and optimises the geometry. Small
hydrides are optimised with B3LYP density-functional theory; other molecules with the GFN2-xTB
quantum method. You can watch the molecule move while it is optimised. The report lists:

* every connectivity fix and the reason for it;
* every bond length, angle and dihedral that changed (before and after, with units);
* a check of bond lengths and angles against reference ranges;
* the method used at each stage, convergence, and the final energy.

Run repair again on a repaired structure and the report says **Already optimal**: repair never
moves a structure that is already at the minimum. Use **Export PDF** or **Export Markdown** to keep
the report; it is written in the language the app is using.

## Elements

The periodic table shows all 118 elements. Colour the table by family, or by a property such as
electronegativity, atomic radius, ionisation energy, density or melting point. Click an element to
see its data: atomic mass, electron configuration and shells, oxidation states, radii,
electronegativities, ionisation energies, physical properties, isotopes, discovery and uses.

Every value shows its unit and source. Values that have never been measured, such as the density
of the heaviest elements, are marked **Predicted** or **Unknown**; they are never filled in with
invented numbers.

## Library

The library holds more than 180 prebuilt molecules, from water and ions to drugs, sugars, amino
acids and solvents, plus everything you save. It is arranged like a periodic table of families.
You can search by name, formula or SMILES, filter to built-in molecules, your own molecules or
favourites, and star a molecule as a favourite. The open and insert buttons on each card load the
molecule into the editor or add it to the current drawing.

* **Save to library** (inspector) files your molecule into a family automatically. If an identical
  structure already exists, the app tells you and offers to save it anyway.
* **Import / Export**: SDF or JSON, for moving collections between computers.

## Simulate

Choose a job, then press **Run**:

| Job | What it computes |
|---|---|
| **Properties** | Formula, masses, charge, logP, polar surface area, drug-likeness (QED, Lipinski, Veber), estimated pKa; GFN2-xTB energies, orbitals and charges; dipole moment; surface area and volume. **Standard** and **Thorough** add vibrational frequencies and the IR spectrum, thermochemistry (ZPE, H, S, G at 298 K), the PM7 heat of formation and B3LYP dipole and polarisability for small molecules. |
| **Minimise** | Force-field or quantum geometry optimisation, with live frames. |
| **Dynamics** | Molecular dynamics at a chosen temperature: energies, temperature and radius-of-gyration traces. |
| **Dock** | AutoDock Vina docking of the current molecule into a receptor, with binding modes, affinities and contacts. |

Every number shows its unit and the method that produced it (hover for details), and uncertainties
where they are known. Export results as CSV or JSON. Long jobs show their progress and can be
cancelled. The hardware panel shows how many CPU cores and which GPU are being used.

## Assistant

Open the assistant with the robot button or **Ctrl J**. Ask about the molecule on the canvas, an
element, or a result, for example *"Is this molecule drug-like?"* or *"Explain the repair."* The
assistant runs on your computer and works out answers by calling MoleculeForge's own tools; each
tool call is shown with its result. It names the methods it relied on, marks its confidence, and
flags any number that did not come from a tool. It refuses requests that are unsafe or outside
chemistry. On a typical laptop CPU an answer takes from several seconds to a few minutes; a GPU
makes it faster.

To use a different model, open **Language model** (the chip button in the assistant's header),
choose **Choose a model file…** and pick any GGUF language model on your computer. Larger models answer
better but need more memory. The choice is remembered; **Use the bundled model** switches back.

## Language and appearance

Use the language button in the top bar or the command palette (**Ctrl K**) to switch between
English and ไทย (Thai) at any time; no restart is needed. The moon and sun button switches between
the light and dark themes.

## Files

**Open** (Ctrl O, or from the command palette) reads MOL, SDF, SMILES, InChI, XYZ and PDB files of
up to 64 MB. Opened files are treated as untrusted and checked before use. **Export** writes the
same formats; the round trip keeps connectivity, charges, isotopes, stereochemistry and coordinates.

## Troubleshooting

* **"Compute engine stopped"**: restart MoleculeForge. The engine log is in your user data folder
  (`logs/compute.log`): `%APPDATA%\org.moleculeforge.desktop` on Windows,
  `~/Library/Application Support/org.moleculeforge.desktop` on macOS and
  `~/.local/share/org.moleculeforge.desktop` on Linux.
* **The 3D view is empty**: your graphics driver does not provide WebGL. Everything else still works.
* **The assistant is slow**: the local model runs on the CPU unless a supported GPU is found. The
  hardware panel in Simulate shows which is in use.
