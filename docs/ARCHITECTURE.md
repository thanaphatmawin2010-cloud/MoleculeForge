# MoleculeForge architecture

MoleculeForge is an offline desktop application built from three processes that never talk to the
network. The user interface is a React app inside a Tauri web view. A small Rust shell owns the
window, the file dialogs and the compute engine. The compute engine is a Python sidecar that
runs the chemistry and simulation work.

```
┌────────────────────────── MoleculeForge (Tauri 2, Rust) ─────────────────────────────┐
│  Web view: React 18 + TypeScript UI                                                  │
│    design system · 2D sketcher · Three.js viewer · periodic table · library ·        │
│    simulation dashboard · assistant · i18n (ICU, en/th)                              │
│        │ invoke("rpc_send")  ▲ event "sidecar://message"     (Tauri IPC, no sockets) │
│  Rust shell: method allowlist + shape/size checks · native open/save dialogs ·       │
│        │ stdin  ▲ stdout     (newline-delimited JSON-RPC 2.0)                         │
└────────┼────────┼────────────────────────────────────────────────────────────────────┘
         ▼        │
   Compute sidecar (Python 3.12, frozen with PyInstaller)
     pydantic-validated methods · job pool with progress + cancellation
     ├─ RDKit (in process): parsing, sanitisation, validation, descriptors, MMFF94/UFF, ETKDG
     ├─ OpenMM (in process): MMFF94 as custom forces, Langevin dynamics, CPU/OpenCL/CUDA
     ├─ PySCF (spawned worker process): B3LYP single points, finite-field polarisability,
     │     B3LYP geometry optimisation (geomeTRIC) for one-heavy-atom hydrides
     ├─ xtb 6.8 (subprocess): GFN2-xTB / GFN-FF optimisation, Hessians, charges
     ├─ MOPAC 23 (subprocess): PM7 heats of formation
     ├─ AutoDock Vina 1.2.7 (subprocess) + Meeko: docking
     └─ llama-server (subprocess, 127.0.0.1, random port + per-session API key): local LLM
```

## Process model and protocol

* **UI ↔ shell.** The web view can call exactly three commands (`rpc_send`, `open_text_file`,
  `save_file`) and listen to events. Nothing else is granted (see
  `app-shell/src-tauri/capabilities/main.json`). The page is served from the bundle with a strict
  Content-Security-Policy whose `connect-src` allows only the Tauri IPC origin.
* **Shell ↔ sidecar.** The shell spawns the sidecar with `MF_RESOURCE_DIR` (bundled engines and data)
  and `MF_DATA_DIR` (per-user state), relays one JSON-RPC request per line to its stdin, and forwards
  every stdout line to the window. Before relaying, `sidecar::validate_request` checks the request is a
  single-line JSON object with `jsonrpc: "2.0"`, a method on the allowlist (all sidecar methods
  except `system.shutdown`, which only the shell may send), and no unexpected fields, and that it is
  within the 64 MB size limit. If the sidecar exits unexpectedly the shell sends the UI a synthetic
  `sidecar.exit` notification. On exit it asks the sidecar to shut down, closes stdin, and kills the
  process after 4 s if needed.
* **Sidecar.** `mfcompute/server.py` reads requests, validates parameters with strict pydantic
  models (unknown fields are rejected), and runs each method on one of three pools: interactive
  (fast queries), job (long computations) or AI. The transport field `jobId` routes progress
  notifications (`{"method": "progress", "params": {jobId, percent, stage, message, data}}`) and
  cancellation (`job.cancel`). Control requests are never registered as cancellable work. The
  real stdout file descriptor is reserved for the protocol, and file descriptor 1 is redirected to
  stderr, so a library that prints cannot corrupt the stream.
* **UI client.** `ui/src/ipc/client.ts` sends requests, validates every response with zod, supports
  per-call timeouts, and becomes ready either on the sidecar's `ready` notification or on the first
  successful `system.ping`. `ui/src/ipc/api.ts` is the typed method surface.

## Chemistry pipelines

* **Live validation (§7.3).** Each structural edit is committed as an undoable command and checked
  by `chem.validateBonds` (2–3 ms warm). Reason codes in `mfcompute/chem/issues.py` carry 1-based
  atom numbers. The UI localises each code through `ui/src/locales/*/issues.json`. Fixes are
  applied as a separate undoable command and announced with "Bond connection fixed successfully.".
  Valid bonds are confirmed with "Bond connected correctly.". With live physics on, coordinates are
  relaxed with MMFF94 and the frames stream back into the 3D view. A deterministic 0.02 Å nudge
  breaks the symmetry of exactly linear or planar sketches, so they are never left on a saddle point.
* **One-click repair (§7.4, `mfcompute/chem/geometry.py`).** The stages are: detect, fix chemistry,
  perceive hybridisation and VSEPR, add hydrogens, choose a start geometry (keep a usable one,
  otherwise ETKDGv3), minimise with MMFF94 (UFF as fallback), then refine. Hydrides of one heavy atom
  are refined with B3LYP/def2-SVP; other molecules up to 300 atoms with GFN2-xTB. Every change goes
  into the report: before and after values, the method for each stage, convergence, and the
  reference-range geometry check. A structure within 0.005 Å RMSD or 0.05 kcal/mol of the refined
  minimum is "already optimal" and returned unchanged, which makes repair idempotent. Reports
  export to Markdown or PDF (`chem/report.py`), with labels supplied by the UI in the reader's
  language.
* **Property battery (`sim/properties.py`).** The levels are fast, standard and thorough. They cover
  RDKit descriptors, GFN2-xTB optimisation, the Hessian with RRHO and quasi-RRHO thermochemistry,
  PM7 heats of formation, B3LYP dipoles, orbitals and polarisabilities, SASA and shape, and an
  optional 10 ps MD run. Each level has size limits. Every value has the form
  `{value, unit, method, uncertainty?}`. Results are cached by InChIKey and method. A result in which
  an engine *failed* is never cached, so the next run tries the engine again.
* **Dynamics and docking.** MD uses OpenMM with MMFF94 expressed as custom forces (energy parity
  with RDKit better than 1e-4 kcal/mol), or MoleculeForge's own BAOAB integrator on UFF forces.
  Docking runs Vina on Meeko-typed inputs with a blind search box covering the receptor.
* **Stereochemistry.** Each structure records where its stereo came from (`meta.stereo`): a 3D source,
  fully specified SMILES or InChI, partially specified, none, or unknown. Wedge and hash bonds are
  drawn only when the source specified the stereo. They are computed by `chem.wedges` from the 3D
  structure and the current 2D layout, only for genuinely stereogenic centres. Any structural edit
  clears the claim.

## Data

* `data/elements.json`: 118 elements built by `scripts/build_elements.py`. Every value carries a
  unit, a status (measured, predicted or unknown) and a source. Values that are not known are null,
  never invented. An independent cross-check report is in `data/elements.crosscheck.json`.
* `data/molecules/`: the prebuilt library built by `scripts/build_library.py` from `catalog.json`.
  The build checks CIP labels and InChIKeys, rejects any stereo the 3D embedding would have
  invented, requires zero-correction validation and idempotent repair, and generates skeletal 2D
  layouts and stereo wedges. In the app the library lives in SQLite with FTS5
  (`mfcompute/data/library.py`). Prebuilt rows are re-synchronised whenever the bundled file's
  content hash changes, and favourites are kept.
* `data/knowledge/`: curated reference passages that the assistant retrieves with BM25.
* `data/models/`: the GGUF language model (Qwen3-4B-Instruct-2507, Q4_K_M), checked against its sha256.

## Local assistant (§7.10)

`mfcompute/ai/` starts `llama-server` on 127.0.0.1 with a random port and a random API key. The
server runs in offline mode with no web UI. The assistant runs a tool loop over eight
strictly-schematised tools (sanitize, validateBonds, repairGeometry, descriptors, simulate, dock,
getElement, lookupMolecule) that call the real engines. Before an answer is shown, every number in it
must match a tool result, the user's message or the retrieved references. Otherwise the model
revises once, and any numbers still unsupported are flagged and confidence drops to low. Requests
outside chemistry or that are unsafe are refused. Tool calls stream to the UI as they happen.

## User interface

* `src/design-system/`: tokens (CSS variables for light and dark, contrast-tested), primitives
  (Radix), overlays and the `Quantity`/`Formula` renderers.
* `src/features/`: `canvas` (sketcher, 3D viewer, actions, repair dialog), `periodic`, `library`,
  `simulate` and `assistant`.
* `src/state/`: zustand stores. The editor store holds documents with unlimited undo and redo.
* `src/locales/`: ICU message files. `ui/scripts/check-i18n.mjs` fails CI on any missing key,
  placeholder mismatch, untranslated value family or hard-coded JSX text.
* Failures are contained. Each view is wrapped in an error boundary, and a separate boot script
  shows a readable message if the app cannot start, so the window is never blank.

## Build pipeline

1. `scripts/fetch_engines.py`: xtb and MOPAC (conda-forge), the Vina binary, `llama-server` built
   from a pinned llama.cpp tag, the model (sha256-verified) and the report fonts. All pins are in
   `scripts/engines.lock.json`.
2. `scripts/build_elements.py`, `scripts/build_library.py`: the data sets.
3. `pyinstaller packaging/moleculeforge-compute.spec`: the frozen sidecar. OpenMM plugin libraries
   keep their layout; LGPL components remain replaceable files.
4. `scripts/collect_licenses.py`: licence texts for every bundled component, written to `LICENSES/`.
5. `scripts/stage_resources.py`: stages the installer payload, using hard links.
6. `tauri build`: builds the installers (`.deb` and AppImage on Linux, `.msi` and NSIS `.exe` on
   Windows, `.dmg` on macOS; see `.github/workflows/release.yml`).

## Repository layout

```
app-shell/src-tauri/   Rust shell, Tauri config, capabilities, icons
ui/                    React UI (src/design-system, features, locales, ipc, lib, state)
compute/               Python sidecar package (mfcompute: chem/, sim/, data/, ai/, server.py), PyInstaller spec
data/                  elements.json, molecules/, knowledge/, models/ (fetched), fonts/ (fetched)
scripts/               fetch, build, licence, staging and report generators
tests/                 unit/, integration/, chem-validation/, e2e/
docs/                  architecture, user guide, validation report, adding a locale
LICENSES/              third-party licence texts (generated)
```
