# Build log

Decisions taken while building MoleculeForge, the components it ships, every assumption made where
the specification left room, the status of each requirement, and the self-audit loops (§12).

## Final library table (§5)

| Need | Chosen | Version | Licence | Notes / rejected alternatives |
|---|---|---|---|---|
| Desktop shell | [Tauri](https://github.com/tauri-apps/tauri) | 2.12 | MIT / Apache-2.0 | Electron rejected: larger, and ships a Node runtime in the shell |
| UI framework | [React](https://github.com/facebook/react) | 18.3.1 | MIT | |
| Styling | [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | 3.4.19 | MIT | on top of MoleculeForge's own CSS-variable design tokens |
| Accessible primitives | [Radix UI](https://github.com/radix-ui/primitives) | 1.x / 2.x | MIT | shadcn/ui not copied; primitives restyled in `ui/src/design-system` |
| Motion, icons, palette, state | Framer Motion, Lucide, cmdk, Zustand | 11.18 / 0.460 / 1.1 / 5.1 | MIT / ISC / MIT / MIT | |
| 2D sketcher | MoleculeForge SVG sketcher (own code) | | MIT | Ketcher and Kekule.js rejected: their look and interaction model fight the bespoke design (P7), and Ketcher's bundle is large. RDKit (sidecar) supplies depiction coordinates and wedges |
| 3D viewer | [Three.js](https://github.com/mrdoob/three.js) with an own instanced scene | 0.170.0 | MIT | Mol* and 3Dmol.js rejected for the same reason; instancing draws all atoms and all bonds in two calls |
| Cheminformatics | [RDKit](https://github.com/rdkit/rdkit) | 2026.09.2 | BSD-3-Clause | |
| File formats | RDKit readers/writers | | BSD-3-Clause | [Open Babel](https://github.com/openbabel/openbabel) rejected: GPL-2.0, and RDKit covers MOL/SDF/SMILES/InChI/XYZ/PDB |
| JS cheminformatics | none | | | OpenChemLib not needed: validation runs in the sidecar in 2–5 ms |
| Mechanics / dynamics | [OpenMM](https://github.com/openmm/openmm) | 8.6.1 | MIT; LGPL-2.1 for the CUDA/OpenCL platforms | MMFF94/MMFF94s implemented as OpenMM custom forces; energies match RDKit to machine precision (`tests/unit/compute/test_openmm_mmff.py`) |
| Semi-empirical QM | [xtb](https://github.com/grimme-lab/xtb) (GFN2-xTB, GFN-FF) | 6.8.0 | LGPL-3.0 | separate executable (conda-forge build, with dftd4, s-dftd3, tblite, OpenBLAS) |
| Heats of formation | [MOPAC](https://github.com/openmopac/mopac) (PM7) | 23.2.5 | Apache-2.0 | added: GFN2-xTB gives no ΔHf |
| DFT | [PySCF](https://github.com/pyscf/pyscf) | 2.15.1 | Apache-2.0 | Psi4 rejected: distributed through conda only, which makes freezing it into the sidecar impractical. PySCF has no Windows build; on Windows, DFT is reported unavailable |
| DFT geometry optimiser | [PyBerny](https://github.com/jhrmnn/pyberny) (+ [MolSym](https://github.com/NASymmetry/MolSym)) | 0.7.0 (1.3.1) | MPL-2.0 (MIT) | [geomeTRIC](https://github.com/leeping/geomeTRIC) used first, then removed: its licence adds a clause forbidding use in AI-training datasets to BSD-3-Clause, a field-of-use restriction every redistributor would inherit |
| Docking | [AutoDock Vina](https://github.com/ccsb-scripps/AutoDock-Vina) + [Meeko](https://github.com/forlilab/Meeko) (+ gemmi) | 1.2.7 / 0.8.0 (0.7.5) | Apache-2.0 / LGPL-2.1 (MPL-2.0) | Vina is a separate executable; Meeko ships as plain, replaceable Python source in the frozen sidecar (`_internal/meeko/`) |
| Numerics | NumPy, SciPy | 2.5.5 / 1.18.1 | BSD-3-Clause | |
| Element data | [mendeleev](https://github.com/lmmentel/mendeleev) (build time only) | 1.4.0 | MIT | [Periodic-Table-JSON](https://github.com/Bowserinator/Periodic-Table-JSON) used only as an independent cross-check, not shipped (results below) |
| i18n | i18next + i18next-icu + FormatJS intl-messageformat | 27.2.6 / 2.7.1 / 10.7.18 | MIT / MIT / BSD-3-Clause | |
| Local LLM runtime | [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` | b12650 | MIT | Ollama rejected: a second always-on service with its own model store, harder to bundle offline |
| Local model | Qwen3-4B-Instruct-2507, Q4_K_M GGUF (macOS, Linux); Qwen3-1.7B, Q4_K_M (Windows) | HF revisions a06e946 / d7f544e | Apache-2.0 | reliable tool calling at 2.5 GB; Windows bundles the 1.1 GB model because Windows installers cannot exceed 2 GB. Any GGUF can be loaded from the assistant |
| In-process ML | none | | | transformers.js and onnxruntime not needed: retrieval is BM25 over curated notes |
| Local database | SQLite through Python `sqlite3` (FTS5) | | public domain | better-sqlite3 rejected: Tauri has no Node runtime |
| Validation | Zod / pydantic | 4.6.7 / 2.14.4 | MIT | |
| HTML sanitising | DOMPurify (+ marked) | 3.5.0 (15.0.12) | Apache-2.0 or MPL-2.0 (MIT) | assistant Markdown is sanitised before rendering |
| PDF reports | ReportLab + uharfbuzz, IBM Plex Sans Thai | 5.1.0 / 0.57.0 / 1.1.0 | BSD / Apache-2.0 / OFL-1.1 | HarfBuzz shaping for correct Thai |
| Sidecar packaging | PyInstaller | 6.22.3 | GPL-2.0 with the bootloader exception | only the bootloader ships; the exception allows this |
| Dependency audit | [OSV-Scanner](https://github.com/google/osv-scanner) | 2.2.4 | Apache-2.0 | |
| Tests | pytest, Vitest, Playwright + axe-core | 9.2 / 5.1.1 / 1.65.1 + 4.11.0 | MIT / MIT / Apache-2.0 + MPL-2.0 | |

`LICENSES/` holds the licence text of every bundled component (574 components, generated by
`scripts/collect_licenses.py`; `THIRD_PARTY_NOTICES.md` is the index). No GPL code is linked into a
MoleculeForge binary: the GCC runtime libraries inside the engines carry the GCC Runtime Library
Exception, and the PyInstaller bootloader its own exception. LGPL components (xtb and its
libraries, Meeko, libquadmath, OpenMM's GPU platforms) are separate processes or replaceable files.

## Decisions

* **Sidecar package layout.** §4.4 lists `compute/chem`, `compute/sim` and `compute/server.py`. They
  live one level down in the importable package `compute/mfcompute/` (`chem/`, `sim/`, `server.py`),
  which PyInstaller, pytest and mypy need. Everything else follows §4.4.
* **Geometry refinement tiers.** Repair minimises with MMFF94 and then refines. Hydrides of one heavy
  atom use B3LYP/def2-SVP (PySCF, PyBerny). GFN2-xTB opens water to 107.2°, outside the §8 ±2°
  gate, while B3LYP gives 103.1° in 5–11 s. Molecules up to 300 atoms use GFN2-xTB, which meets the
  gates there; B3LYP would cost 13–30 s even for ethanol.
* **Idempotent repair.** A structure within 0.005 Å RMSD, or within 0.05 kcal/mol, of the refined
  minimum is reported "already optimal" and returned unchanged. The first version accepted 0.02 Å.
  Because of the energy test, the library's water keeps its MMFF94 geometry (104.0°): B3LYP finds
  it less than 0.05 kcal/mol above its own minimum (103.1°), and experiment is 104.5°.
* **Never cache a failed engine.** Property results are cached by InChIKey and method, except when
  an engine failed (as opposed to being skipped by a size limit).
* **Stereo is drawn only when the source stated it.** Each structure records where its stereo came
  from (`meta.stereo`). Wedges are drawn for 3D sources and fully specified SMILES/InChI, only on
  genuinely stereogenic centres (inverting one must change the canonical SMILES), and any
  structural edit clears them.
* **Answer verification keeps the tools.** If an answer contains a number that no tool result,
  reference note or user message supports, the draft is discarded and the next turn must call a
  tool (`tool_choice: required`). The first version re-asked without tools, so a model that skipped
  the tools could never recover; Qwen3-1.7B exposed this.
* **Model choice stays dialog-mediated.** The shell's `choose_model` command opens a native file
  dialog and checks the GGUF magic number; `ai.configure` is accepted only with that exact path. The
  sidecar validates the file again and remembers the choice.
* **Simulation warnings are coded.** Each warning carries a code and parameters that the UI
  translates (English text is kept for exports and the assistant), so Thai users never see an
  English sentence.
* **No prototype freezing.** Tauri's `freezePrototype` breaks zod, which assigns `toString` on its
  own objects, and left the window blank. It is off; the hardening that matters stays on: four
  granted commands, a strict CSP, a method allowlist with size and shape checks, and pydantic
  validation of every request.
* **Development bridge.** A loopback WebSocket with a per-session token lets the UI run in a
  browser for development and Playwright. Production builds compile it out, together with its CSP
  entry, and it applies the same allowlist as the shell.
* **Licences are collected per package.** The conda-built engines ship OpenBLAS, LAPACK, the GCC
  runtime and libquadmath; `fetch_engines.py` copies each package's own licence files (verified
  against conda's recorded sha256) and `collect_licenses.py` adds the canonical SPDX text where a
  package ships none.
* **Live physics relaxes only what the user draws.** It runs after the user's own edits on
  structures of up to 500 atoms. It does not run after opening a file or a library entry (they
  carry their own 3D coordinates) or after a repair, whose B3LYP/GFN2-xTB geometry it would
  otherwise overwrite with a force-field one. Found when a 5,001-atom file kept the engine busy for
  minutes.
* **3D level of detail.** Up to 300 atoms the viewer keeps smooth spheres; above 300 and 1,500 atoms
  it switches to coarser spheres and cap-less bond cylinders (about 7× fewer triangles at the top
  tier). When WebGL runs on a CPU rasteriser (SwiftShader, llvmpipe) it also turns off
  multisampling and renders at pixel ratio 1. Measured here without a GPU: 5,001 atoms went from
  1.1 to 4 fps, 501 atoms from 8.6 to 20 fps.
* **Toggle-button groups, not ARIA grids.** The periodic table and the library's family grid have no
  grid keyboard model, so they are groups of `aria-pressed` buttons; the ARIA grid roles they had
  were invalid without rows.
* **AppImage assembly.** Tauri's AppImage step runs linuxdeploy over every library in the payload
  and stops at dependencies that only resolve at runtime (OpenMM plugins, GPU back-ends).
  `scripts/build_appimage.py` builds the AppImage without the payload, adds it, and repacks it.
* **Fonts and models are fetched at build time** and verified against `scripts/engines.lock.json`.
  Nothing is fetched at runtime.

## Assumptions

1. **Auto-update is off.** Updating needs network access, which P3 forbids. A newer installer
   replaces the app.
2. **"Lossless round-trip"** means graph, charges, isotopes, stereo and coordinates survive to each
   format's precision: MOL/SDF/XYZ 1e-4 Å, PDB 1e-3 Å. SMILES and InChI carry no coordinates, so
   for them identity, including stereo, survives.
3. **Ethanol logP.** §8 gives "≈ −0.14" without a tolerance. Wildman–Crippen gives −0.001; the test
   accepts ±0.3. Experiment is −0.31.
4. **Dipole moments** come from B3LYP/def2-SVPD at the property battery's GFN2-xTB geometry for small
   molecules, and from GFN2-xTB beyond the DFT size limit or where PySCF is unavailable.
5. **"Large peptide fails Lipinski"** is tested with deca-alanine (MW 729, 11 donors).
6. **Unknown element values** are null with status `unknown`, never estimated. Values for Z ≥ 100
   and the bulk properties of At and Fr are marked `predicted`.
7. **Windows and macOS installers and code signing** are produced by
   `.github/workflows/release.yml`. This build machine runs Linux, so only the Linux installers
   were built, installed and launched here. macOS builds are signed and notarised when the Apple
   secrets are configured; Windows `.msi`/`.exe` files can be signed afterwards with `signtool`.
8. **The 2 GB Windows installer limit.** Windows Installer and NSIS packages cannot exceed 2 GB and
   the default model alone is 2.5 GB, so Windows bundles Qwen3-1.7B (1.1 GB). It passes the same
   assistant tests as the default model (tools called, MW 46.07 for ethanol, refusal, loopback only).
9. **PySCF on Windows.** PySCF publishes no Windows build. There DFT steps report themselves
   unavailable, dipoles come from GFN2-xTB, and one-heavy-atom hydrides keep their MMFF94 geometry,
   which is within 1.5° of experiment for H₂O, NH₃, H₂S and PH₃ (GFN2-xTB would open water to 107°).
10. **The MoleculeForge code is MIT-licensed.**
11. **GPU performance** (60 fps at 5,000 atoms, GPU-accelerated MD and LLM) depends on the user's
    hardware. This machine has no GPU, so measurements here use software rendering and the CPU.

## Element data cross-check (§7.5)

`scripts/build_elements.py` compares every element against Periodic-Table-JSON
(`data/elements.crosscheck.json`). All 118 elements and their symbols match; 33 values differ by more
than the tolerance (1 % for masses and ionisation energies, 2 % for temperatures and
electronegativity, 5 % for densities). In every case MoleculeForge keeps mendeleev's value, which
names its source, and shows the status listed.

| Z | Element | Property | MoleculeForge (mendeleev) | Periodic-Table-JSON | Status shown in the app | Note |
|---|---|---|---|---|---|---|
| 5 | B | Density (g/cm³) | 2.34 | 2.08 | measured | Solid β-rhombohedral boron vs the density of the liquid at the melting point. |
| 6 | C | Density (g/cm³) | 2.2 | 1.821 | measured | Different forms of carbon (graphite vs a lower-density form). |
| 6 | C | Boiling point (K) | 4098.15 | 3915 | measured | Carbon sublimes; the sources quote different sublimation temperatures. |
| 28 | Ni | Boiling point (K) | 3186.15 | 3003 | measured | Different compilations of the boiling point. |
| 31 | Ga | Boiling point (K) | 2502.15 | 2673 | measured | Different compilations of the boiling point. |
| 33 | As | Melting point (K) | 1090.15 | 887 | measured | Arsenic sublimes at 1 atm (≈ 887 K); 1090 K is its melting point under pressure (triple point). |
| 39 | Y | Boiling point (K) | 3618.15 | 3203 | measured | Different compilations of the boiling point. |
| 43 | Tc | Atomic mass (u) | 97.0 | 98 | longest-lived isotope | No stable isotope; the sources pick different long-lived isotopes (⁹⁷Tc and ⁹⁸Tc have similar half-lives). |
| 43 | Tc | 1st ionisation energy (kJ/mol) | 686.916 | 702 | measured | Different compilations; mendeleev takes NIST ASD values. |
| 51 | Sb | Boiling point (K) | 1860.15 | 1908 | measured | Different compilations of the boiling point. |
| 59 | Pr | Boiling point (K) | 3793.15 | 3403 | measured | Different compilations of the boiling point. |
| 62 | Sm | Boiling point (K) | 2067.15 | 2173 | measured | Different compilations of the boiling point. |
| 64 | Gd | Boiling point (K) | 3546.15 | 3273 | measured | Different compilations of the boiling point. |
| 65 | Tb | Boiling point (K) | 3503.15 | 3396 | measured | Different compilations of the boiling point. |
| 67 | Ho | Boiling point (K) | 2973.15 | 2873 | measured | Different compilations of the boiling point. |
| 73 | Ta | 1st ionisation energy (kJ/mol) | 728.423 | 761 | measured | Different compilations; mendeleev takes NIST ASD values. |
| 74 | W | Boiling point (K) | 5828.15 | 6203 | measured | Different compilations of the boiling point. |
| 74 | W | 1st ionisation energy (kJ/mol) | 758.764 | 770 | measured | Different compilations; mendeleev takes NIST ASD values. |
| 76 | Os | 1st ionisation energy (kJ/mol) | 814.165 | 840 | measured | Different compilations; mendeleev takes NIST ASD values. |
| 77 | Ir | Boiling point (K) | 4701.15 | 4403 | measured | Different compilations of the boiling point. |
| 77 | Ir | 1st ionisation energy (kJ/mol) | 865.186 | 880 | measured | Different compilations; mendeleev takes NIST ASD values. |
| 79 | Au | Boiling point (K) | 3109.15 | 3243 | measured | Different compilations of the boiling point. |
| 85 | At | Density (g/cm³) | 7.0 | 6.35 | predicted | Prediction; the two sources quote different predictions. |
| 87 | Fr | Electronegativity (Pauling) | 0.7 | 0.79 | predicted | Prediction; the two sources quote different predictions. |
| 87 | Fr | 1st ionisation energy (kJ/mol) | 392.96 | 380 | measured | Different compilations; mendeleev takes NIST ASD values. |
| 88 | Ra | Density (g/cm³) | 5.0 | 5.5 | measured | Different compilations. |
| 88 | Ra | Melting point (K) | 969.15 | 1233 | measured | Different compilations of the melting point. |
| 89 | Ac | Melting point (K) | 1323.15 | 1500 | measured | Different compilations of the melting point. |
| 89 | Ac | 1st ionisation energy (kJ/mol) | 519.114 | 499 | measured | Different compilations; mendeleev takes NIST ASD values. |
| 90 | Th | 1st ionisation energy (kJ/mol) | 608.504 | 587 | measured | Different compilations; mendeleev takes NIST ASD values. |
| 103 | Lr | 1st ionisation energy (kJ/mol) | 478.567 | 470 | measured | Different compilations; mendeleev takes NIST ASD values. |
| 114 | Fl | Density (g/cm³) | 9.928 | 14 | predicted | Prediction; the two sources quote different predictions. |
| 118 | Og | Density (g/cm³) | 7.0 | 4.95 | predicted | Prediction; the two sources quote different predictions. |
