# Build log

This file records the decisions taken while building MoleculeForge, the components it ships, every
assumption made where the specification left room, the status of each requirement, and the
self-audit loops (§12).

## Final library table (§5)

| Need | Chosen | Version | Licence | Notes / rejected alternatives |
|---|---|---|---|---|
| Desktop shell | Tauri | 2.12 | MIT/Apache-2.0 | Electron rejected (size, Node runtime in the shell) |
| UI framework | React | 18.3 | MIT | |
| Styling | Tailwind CSS | 3.4 | MIT | over CSS-variable design tokens of our own |
| Components / a11y | Radix UI primitives | 1.x | MIT | shadcn/ui not used verbatim; primitives restyled in `ui/src/design-system` |
| Motion / icons | Framer Motion 11 / Lucide | | MIT / ISC | |
| 2D sketcher | MoleculeForge SVG sketcher (own) | | MIT | Ketcher and Kekule.js rejected: their look and interaction model fight the bespoke design (P7), and Ketcher's bundle is large; RDKit (sidecar) supplies depiction coordinates |
| 3D viewer | Three.js (instanced meshes, own scene) | 0.170 | MIT | Mol* and 3Dmol.js rejected for the same reason; instancing keeps large molecules at two draw calls |
| Cheminformatics | RDKit | 2026.09.2 | BSD-3 | |
| Format I/O | RDKit + own writers | | BSD-3 | Open Babel rejected (GPL-2.0; RDKit covers MOL/SDF/SMILES/InChI/XYZ/PDB) |
| JS cheminformatics | — | | | OpenChemLib not needed: validation runs in the sidecar in 2–3 ms |
| MD / mechanics | OpenMM | 8.6.1 | MIT (+LGPL CUDA/OpenCL) | MMFF94 implemented as OpenMM custom forces, parity with RDKit < 1e-4 kcal/mol |
| Semi-empirical QM | xtb (GFN2-xTB, GFN-FF) | 6.8.0 | LGPL-3.0 | separate process |
| Semi-empirical (heats of formation) | MOPAC (PM7) | 23.2.5 | Apache-2.0 | added: GFN2-xTB gives no ΔHf |
| QM / DFT | PySCF | 2.15.1 | Apache-2.0 | Psi4 rejected: no wheels for all three platforms, harder to freeze; PySCF runs in a spawned worker |
| Geometry optimiser (DFT) | geomeTRIC | 1.1.1 | BSD-3 | |
| Docking | AutoDock Vina + Meeko | 1.2.7 / 0.8.0 | Apache-2.0 / LGPL-2.1 | Meeko shipped as replaceable Python files (LGPL) |
| Numerics | NumPy, SciPy | 2.5, 1.18 | BSD-3 | |
| Element data | mendeleev (build time) | 1.4.0 | MIT | Periodic-Table-JSON used only as an independent cross-check, not shipped |
| i18n | i18next + i18next-icu (FormatJS intl-messageformat) | 27.2 / 2.7 / 10.7 | MIT / BSD-3 | |
| Local LLM runtime | llama.cpp `llama-server` | b12650 | MIT | Ollama rejected: a second always-on service with its own model store, harder to bundle offline |
| Local model | Qwen3-4B-Instruct-2507 (Q4_K_M GGUF) | 2507 | Apache-2.0 | strong tool calling at 2.5 GB; larger GGUF models can be selected |
| In-process ML | — | | | transformers.js / onnxruntime not needed: retrieval is BM25 over curated passages |
| Local database | SQLite (Python `sqlite3`, FTS5) | | public domain | better-sqlite3 rejected: Tauri has no Node runtime |
| Validation | Zod / pydantic | 4.6 / 2.x | MIT | |
| HTML sanitising | DOMPurify | 3.x | Apache-2.0/MPL-2.0 | assistant Markdown is rendered via marked + DOMPurify |
| PDF reports | ReportLab + uharfbuzz, IBM Plex Sans Thai | 5.1 / 0.57 / 1.1.0 | BSD / Apache-2.0 / OFL-1.1 | HarfBuzz shaping for correct Thai |
| Dependency audit | OSV-Scanner | 2.2.4 | Apache-2.0 | |
| Tests | Vitest 5, Playwright 1.65 (+ axe-core), pytest 8 | | MIT / Apache-2.0 / MPL-2.0 | |

Every bundled component's licence text is in `LICENSES/` (generated; 563 components). No GPL code is
linked into any MoleculeForge binary: the PyInstaller bootloader is GPL-2.0 *with* its bootloader
exception, and the LGPL components (xtb, Meeko, OpenMM's GPU platforms) run as separate processes or
ship as replaceable libraries.

## Decisions

* **Sidecar package layout.** §4.4 lists `compute/chem`, `compute/sim` and `compute/server.py`. They
  live one level down in the importable package `compute/mfcompute/` (`chem/`, `sim/`, `server.py`),
  which is what PyInstaller, pytest and mypy need. Everything else follows §4.4.
* **Geometry refinement tiers.** Repair minimises with MMFF94, then refines. Hydrides of one heavy
  atom use B3LYP/def2-SVP: GFN2-xTB opens water to 107.2°, outside the §8 ±2° gate, while B3LYP
  gives 103.1° in about 6 s. Everything up to 300 atoms uses GFN2-xTB, which meets the gates there;
  B3LYP would cost 13–30 s even for ethanol.
* **Idempotent repair.** A structure within 0.005 Å RMSD or 0.05 kcal/mol of the refined minimum
  is returned unchanged ("already optimal"). The first version accepted 0.02 Å, which let water keep
  its MMFF geometry; it was tightened during the self-audit.
* **Never cache a failed engine.** Property results are cached by InChIKey and method, except when
  an engine failed (as opposed to being skipped by a size limit). Found when a failed DFT run was
  replayed from the cache.
* **Stereo is shown only when the source stated it.** Each structure records the origin of its
  stereo (`meta.stereo`). Wedges are drawn for 3D sources and fully specified SMILES/InChI, only on
  genuinely stereogenic centres (an inversion must change the canonical SMILES), and are cleared by
  any structural edit. A sketch relaxed from a flat drawing has arbitrary handedness and must not be
  wedged.
* **No prototype freezing.** Tauri's `freezePrototype` breaks zod, a dependency that assigns
  `toString` on its own objects, and left the window blank. It is off; the hardening that matters
  stays on: three granted commands, a strict CSP, a method allowlist with size and shape checks,
  and pydantic validation.
* **Dev bridge.** A loopback WebSocket with a per-session token lets the UI run in a browser for
  development and Playwright. It is compiled out of production builds, together with its CSP entry,
  and applies the same allowlist as the shell.
* **Fonts and model are fetched at build time** and verified against `scripts/engines.lock.json`.
  Nothing is fetched at runtime.

## Assumptions

1. **Auto-update is off.** Updating needs network access, which principle P3 forbids. Updates are
   installed by running a newer installer.
2. **"Lossless round-trip"** means graph, charges, isotopes, stereo and coordinates are preserved to
   each format's precision: MOL/SDF/XYZ 1e-4 Å, PDB 1e-3 Å. SMILES and InChI carry no coordinates,
   so for them identity, including stereo, is preserved.
3. **Ethanol logP.** The specification gives "≈ −0.14" without a tolerance. Wildman–Crippen gives
   −0.001; the test accepts ±0.3. Experiment is −0.31.
4. **Dipole moments** come from B3LYP/def2-SVPD at the property battery's GFN2-xTB geometry for
   small molecules (≤ 12 heavy atoms at the standard level), and from GFN2-xTB beyond that.
5. **"Large peptide fails Lipinski"** is tested with deca-alanine (MW 729, 11 donors).
6. **Unknown element values** are null with status `unknown`, never estimated. Values for Z ≥ 100,
   and the bulk properties of At and Fr, are marked `predicted`.
7. **Windows and macOS installers, and code signing,** are built by `.github/workflows/release.yml`.
   This build environment is Linux-only, so only the Linux installers were built and launched here.
8. **The MoleculeForge code is MIT-licensed.**
9. **Performance on GPUs** (60 fps at 5,000 atoms; GPU-accelerated MD and LLM) depends on the
   user's hardware. The renderer draws all atoms and all bonds in two instanced draw calls; the
   measurements here are on CPU-only, software-rendered hardware.

## Requirement status (§13)

(Updated at the end of the build; see the final section.)
