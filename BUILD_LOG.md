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
  Because of the energy test, the library's water keeps the MMFF94s geometry it gets from SMILES
  conversion (104.0°): B3LYP finds it less than 0.05 kcal/mol above its own minimum (103.1°), and
  experiment is 104.5°.
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

## Requirement status

VERIFIED means checked on this build machine (Linux x64, 4 CPU cores, no GPU), by the named test or
measurement. NOT VERIFIED HERE means it cannot be checked on this machine; the reason is given.

### §13 deliverables

| Item | Status | Evidence |
|---|---|---|
| D1 Source repository matching §4.4 | VERIFIED | layout as §4.4, with the documented `compute/mfcompute` package |
| D2 Installers | Linux `.deb` and AppImage: VERIFIED. Windows `.msi`/`.exe`, macOS `.dmg`: NOT VERIFIED HERE | Both Linux installers were built, installed or run, and launched under Xvfb (cold start and socket audit below). Windows and macOS need their own build machines: `.github/workflows/release.yml` builds them, unsigned unless signing secrets are configured, and has not been run |
| D3 Engines, data and model bundled | VERIFIED (Linux) | a 3.27 GB payload (frozen sidecar, xtb, MOPAC, Vina, llama-server, data, licences and the 2.5 GB model) inside both installers; the installed app runs with no network |
| D4 Docs | VERIFIED | README, docs/ARCHITECTURE.md, docs/USER_GUIDE.md, docs/ADDING_A_LOCALE.md, this file |
| D5 Green test suite | VERIFIED | 750 Python tests (unit, IPC integration, §8 chemistry validation); 2 slow assistant tests, run with both bundled models; 54 Vitest; 4 Rust; 10 Playwright (journey, drag-and-drop, periodic table, axe in three theme/locale combinations, four performance tests); ruff, mypy --strict, tsc --strict, ESLint, clippy, the i18n gate and OSV-Scanner all clean |
| D6 Validation report | VERIFIED | docs/VALIDATION_REPORT.md, generated by `scripts/validation_report.py` (two fresh-process runs) |
| D7 Licences | VERIFIED | `LICENSES/`: 574 components, each with its licence text; GPL/LGPL handling described above |

### §7 features (acceptance criteria)

| Feature | Status | Evidence |
|---|---|---|
| 7.1 UI: water built from blank within ~60 s | VERIFIED | e2e journey (draws water, validates, repairs, simulates, saves, switches language, asks the assistant); onboarding guide in the app |
| 7.1 Design tokens; no unstyled components | VERIFIED | `ui/src/design-system`; token contrast tests (Vitest) |
| 7.1 a11y (AA contrast, keyboard, labels) | VERIFIED | axe (WCAG 2 A/AA) on all four views plus element detail, command palette and assistant, in light, dark and Thai: no serious or critical findings |
| 7.1 ~60 fps interaction | VERIFIED for 2D and panels; 3D see §10 | drawing 50 atoms: longest main-thread task 52–60 ms across runs; median frame 16.7 ms while a simulation runs |
| 7.2 Canvas: all elements and bond types, undo/redo, measure, 2D/3D sync | VERIFIED | Vitest graph and measurement tests (distance, angle, signed dihedral); e2e journey and drag-and-drop test |
| 7.2 Lossless round-trip MOL/SDF/SMILES/XYZ/PDB | VERIFIED | `tests/integration/compute/test_formats_and_library.py` (assumption 2 defines lossless) |
| 7.2 50-atom molecule without lag | VERIFIED | e2e: 49 bond edits in 9.5–10.1 s (including the test driver's pointer moves), longest main-thread task 52–60 ms |
| 7.3 Live validation messages, reason codes, fix log, < 100 ms | VERIFIED | unit and integration tests (exact messages, codes, the `{before, reason, fix, after}` fix log); latency test < 100 ms |
| 7.4 One-click repair: progress, cancel, no clash < 0.7 Å, ±10 % geometry, report PDF/Markdown, idempotent | VERIFIED | chemistry-validation tests (§8 geometry within ±0.03 Å and ±2°); progress and cancellation tests (the DFT worker is terminated); report export test, including non-Latin names; "already optimal" idempotency test; no-clash test over the library |
| 7.5 Periodic table: 118 elements, all fields with units, detail, heatmap, search, trends, localised | VERIFIED | element unit tests; cross-check above; e2e periodic-table test (search, detail, heat map, trends); axe scans in English and Thai |
| 7.6 ≥ 100 prebuilt molecules, validated with zero corrections, insertable as fragments | VERIFIED | 187 molecules; `test_prebuilt_library.py` (each validates with zero corrections, no atoms closer than 0.7 Å); fragment insertion by button and by drag-and-drop |
| 7.7 Storage: auto-category, InChIKey duplicates, periodic-style grid, persistence, import/export | VERIFIED | library integration tests (duplicate detection, export, persistence across an engine restart); e2e save |
| 7.8 Simulation: offline, full property set with units and methods, progress and cancel, cache, export | VERIFIED | integration tests (units and methods, progress, cancellation, cache by InChIKey and method); Vitest CSV/JSON export tests; validation report |
| 7.8 GPU used automatically when present | NOT VERIFIED HERE | no GPU on this machine; `system.capabilities` detects OpenMM CUDA/OpenCL and llama.cpp Vulkan back-ends and selects them |
| 7.8 Several thousand atoms without crashing | VERIFIED | 5,001-atom structure loaded, validated and rendered (e2e) |
| 7.9 Runtime language switch, zero untranslated strings, ICU plurals, RTL | VERIFIED | i18n gate (770 keys × 2 locales); Vitest ICU and RTL tests; e2e switch to Thai |
| 7.10 Local assistant calls the real tools, never invents numbers, refuses unsafe requests, offline | VERIFIED | slow integration tests with both bundled models (Qwen3-4B-Instruct-2507 and Qwen3-1.7B): tools called, MW 46.07 for ethanol, refusal, loopback sockets only; e2e journey in Thai |
| 7.10 GPU-accelerated when available | NOT VERIFIED HERE | no GPU; llama.cpp is built with the Vulkan back-end and offloads automatically when a device is reported |

### §10 budgets (measured here, no GPU)

| Budget | Result | Status |
|---|---|---|
| Cold start < 5 s to interactive | `.deb` 1.31–2.09 s (the first launch after installation reads a cold disk cache), AppImage 1.82–1.89 s; three launches each under Xvfb, measured by the shell from start-up until the UI's first request after the engine is ready | VERIFIED |
| 3D ~60 fps up to ~5,000 atoms | 501 atoms: 20 fps; 5,001 atoms: 4 fps (software rendering) | NOT VERIFIED HERE: needs a GPU. The renderer draws atoms and bonds as two instanced meshes with level of detail |
| Bond validation < 100 ms | median 2.3 ms (aspirin, 21 atoms) to 4.7 ms (cholesterol, 74 atoms), JSON-RPC round trip included; 5,001 atoms: 0.5 s | VERIFIED |
| Small-molecule MMFF minimisation < 2 s | 0.02–0.10 s from randomly distorted geometries (aspirin, caffeine, cholesterol) | VERIFIED |
| UI never blocks | median frame 16.7 ms while a Standard property job ran; worst frame 17–67 ms across runs (67 ms when other test processes shared the CPU); all computation runs in the sidecar | VERIFIED |
| Security hardening | four granted commands, strict CSP, method allowlist, pydantic validation of every request, DOMPurify, size limits on opened files, loopback-only model server with a random key | VERIFIED (tests in `test_protocol_and_security.py` and the Rust unit tests) |
| OSV-Scanner | no unjustified advisories | VERIFIED |
| Offline (no non-loopback sockets) | sidecar test, assistant tests, and the whole installed-app process tree | VERIFIED |

## Self-audit loops (§12)

Each loop is BUILD → TEST → SELF-AUDIT → FIX. A self-audit re-reads the specification section by
section against the running application, the test results and the licences.

| Loop | Found | Fixed by |
|---|---|---|
| 1. Core build and first full test pass | fix messages numbered atoms from 0; `job.cancel` cancelled itself; the shared server handle was empty under `python -m`; H₂ got a NaN 2D layout; the view switch stalled in an exit animation; a library race created duplicate columns; engine errors surfaced as "validation: Required"; stale formula in the inspector; saved layouts reopened mirrored; adamantane drawn with wedges | 1-based numbering in fix logs; separate ids for control requests; `runtime.py`; layout fallbacks; enter-only transitions; a locked library singleton; error-first response parsing; result tagging; RDKit-orientation saves; stereogenic-centre check |
| 2. Packaging and the installed app | blank window in the installed app (zod vs `freezePrototype`); GFN2-xTB water at 107.2° (§8 gate ±2°); failed engine results cached; `ink-3` contrast 4.43:1; 20 dependency advisories; RTL mirrored numbers and the periodic table; 133 mypy errors | `freezePrototype` off plus a boot guard and error boundary; B3LYP tier for one-heavy-atom hydrides; no caching after an engine failure; darker token; upgrades and documented exceptions; `.ltr-run` isolation; typed code |
| 3. Licence and compliance audit | root `package.json` said Apache-2.0; three unused UI dependencies; Meeko (LGPL) compiled into the archive; OpenBLAS, LAPACK, GCC runtime and libquadmath shipped without licence texts; geomeTRIC's non-AI clause; CI did not run mypy; README build commands pointed at a missing CLI | MIT everywhere; dependencies removed; Meeko as plain source; per-package conda licences and SPDX texts; PyBerny; mypy in CI; corrected commands |
| 4. Feature audit against §7 acceptance criteria | no drag-and-drop fragment insertion; no way to load a larger model; simulation warnings shown in English to Thai users; Windows installers cannot hold the 2.5 GB model and PySCF has no Windows build; answer verification re-asked the model without tools (a small model could not recover); the OpenMM–RDKit parity test cited in a docstring did not exist, and writing it exposed rounded MMFF constants | drag-and-drop; Assistant > Language model with dialog-pinned paths; coded, translated warnings; Windows bundles Qwen3-1.7B and reports DFT unavailable; verification requires a tool call; exact constants and the test |
| 5. End-to-end, accessibility and performance | Playwright browser and bridge used different tokens; Tauri's AppImage step failed on the payload; live physics re-relaxed loaded files and overwrote repair geometry, and kept a 5,001-atom file busy for minutes; 3D at 1.1 fps for 5,001 atoms without a GPU; invalid ARIA grids and small-text contrast just under AA; unlabelled atoms had no DOM geometry; no test that prebuilt molecules validate unchanged or that the periodic table's search, heat map and trends work | worker-shared token; `scripts/build_appimage.py`; live-physics scope; level of detail and software-rendering path; toggle-button groups and darker tokens; atom footprints; new library, periodic-table and performance tests |
| 6. Status-table audit (every claim must cite a test or measurement) | no test that prebuilt molecules validate unchanged or have no clashes; none for the periodic table's search, heat map and trends; the validation report labelled kept MMFF94s geometries as B3LYP and printed MOPAC's version as "ersion" (the capability probe's regex, also visible in the app) | `test_prebuilt_library.py`; periodic-table e2e test; accurate labels; fixed version pattern with a test |
| 7. Full audit after rebuilding the installers | all suites green; ARCHITECTURE.md out of date in eight places (live-physics scope, parity figure, answer verification, model choice, Windows model, coded warnings, level of detail, AppImage step); a user-guide label | documentation updated |
| 8. Full audit (documents re-read; every status claim traced to its test) | the log called the library's water geometry MMFF94 (it is MMFF94s); no tests behind six claims (measurement maths, persistence across a restart, CSV/JSON export, the `{before, reason, fix, after}` fix log, result caching, cancelling a repair); Thai molecule names lost their vowel marks in export file names and their whole name in repair-report file names | wording; the six tests (export moved into a testable module); file-name stems keep Unicode letters, marks and digits, with tests |
| 9. Full audit (all suites re-run; documents re-read) | the README's test table lacked ruff/mypy and the installed-app launch check, and its scripts list the AppImage and launch-check scripts; the tests that engine codes are translated covered only `en` and `th`, so a newly added language would have passed unchecked | README completed; the tests now cover every locale folder, and docs/ADDING_A_LOCALE.md says so |
| 10. Full audit (specification §4 and §6 traced field by field; installers rebuilt and relaunched; all suites re-run) | every §4.3 method and §6 field present, but the prebuilt molecules' `meta.created` held the catalogue version ("2026.11.1") instead of an ISO 8601 time (§6.1) | catalogue release timestamp in ISO 8601; library rewritten; test |
| 11. Full audit | __AUDIT11__ | |
| 12. Full audit | __AUDIT12__ | |
