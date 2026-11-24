# MoleculeForge

An offline desktop workbench for building, validating and simulating molecules. You draw in 2D and
see 3D at the same time, every bond is checked as you draw it, and geometry repair takes one click.
It includes a sourced periodic table of all 118 elements, a library of more than 180 prebuilt
molecules, and real property calculations: force fields, GFN2-xTB, PM7 and B3LYP, molecular
dynamics and docking. A local AI assistant answers by calling those same tools. It runs entirely on
your computer, with no network access at runtime, in English and Thai.

* **For users:** see [docs/USER_GUIDE.md](docs/USER_GUIDE.md).
* **For developers:** see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [BUILD_LOG.md](BUILD_LOG.md).
* **Scientific validation:** see [docs/VALIDATION_REPORT.md](docs/VALIDATION_REPORT.md).
* **Licences:** MoleculeForge is MIT-licensed. Bundled third-party components keep their own licences; see [LICENSES/THIRD_PARTY_NOTICES.md](LICENSES/THIRD_PARTY_NOTICES.md).

## Install

Download the installer for your system from the GitHub **Releases** page: the `-setup.exe` (or
`.msi`) for Windows, the `.dmg` for macOS (Apple silicon or Intel, macOS 14 or later), the `.deb`
or `.AppImage` for Linux. Each installer already contains the calculation engines, the data and the
language model; there is nothing else to set up and the app never goes online. The macOS and Linux
installers are larger than GitHub's 2 GB limit per file, so they are published in two parts that
are joined with one command before installing. The installers are not code-signed, so Windows and
macOS ask for confirmation on first launch. Windows installers cannot exceed 2 GB, so they bundle a
smaller model, and B3LYP (PySCF) is not available on Windows. The
[user guide](docs/USER_GUIDE.md#installing) covers all of this step by step.

## Build from source

### Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Rust | ≥ 1.90 | desktop shell (Tauri 2) |
| Node.js + pnpm | Node ≥ 20, pnpm ≥ 9 | UI |
| Python + uv | Python 3.12 (uv installs it) | compute sidecar |
| CMake + a C++ compiler | CMake ≥ 3.24 | building `llama-server` |
| Linux only | `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev spirv-headers` (+ Vulkan headers for GPU builds) | Tauri / llama.cpp |

### Steps

```bash
pnpm install
```

```bash
(cd compute && uv sync --all-groups)
```

```bash
python3 scripts/fetch_engines.py
```

```bash
(cd compute && uv run pyinstaller packaging/moleculeforge-compute.spec --noconfirm)
```

```bash
compute/.venv/bin/python scripts/collect_licenses.py
```

```bash
compute/.venv/bin/python scripts/stage_resources.py
```

```bash
pnpm tauri build
```

On Linux, build the `.deb` with `pnpm tauri build --bundles deb` and the AppImage with the script
below. Tauri's own AppImage step runs linuxdeploy over the bundled engines, which fails on
libraries that are only resolved at runtime. The script builds the AppImage without the payload,
adds the payload, and packs it again.

```bash
compute/.venv/bin/python scripts/build_appimage.py
```

`fetch_engines.py` downloads and verifies everything pinned in `scripts/engines.lock.json`: xtb,
MOPAC, Vina, llama.cpp (built from source), the model and the report fonts. To regenerate the data
sets, run `scripts/build_elements.py` (needs the `data` dependency group) and
`scripts/build_library.py`. Installers for all three operating systems are built by
`.github/workflows/release.yml`; pushing a tag such as `v1.0.0` also publishes them as a GitHub
release (`scripts/release_assets.py` splits files of 2 GB or more and writes the release notes).
On Windows, llama.cpp is built with clang and Ninja (`choco install ninja llvm`) and needs the
Vulkan SDK; on macOS, set `MACOSX_DEPLOYMENT_TARGET=14.0`.

### Run in development

```bash
pnpm tauri dev
```

A debug build of the shell runs the sidecar from `compute/.venv`. To work on the UI in a browser,
start the development bridge and Vite. The bridge is a loopback WebSocket with a per-session token,
and production builds compile it out.

```bash
node ui/scripts/dev-bridge.mjs --port 8765
```

```bash
pnpm --dir ui dev
```

Then open the URL the bridge prints.

## Tests

| Suite | Command |
|---|---|
| UI unit (Vitest) | `pnpm --dir ui test` |
| UI types, lint, i18n coverage | `pnpm --dir ui typecheck && pnpm --dir ui lint && pnpm --dir ui i18n:check` |
| Compute unit, integration, §8 chemistry validation (pytest) | `cd compute && uv run pytest -m "not slow"` |
| Compute lint and types | `cd compute && uv run ruff check mfcompute ../scripts ../tests && uv run mypy mfcompute` |
| Local assistant (slow, CPU) | `cd compute && uv run pytest -m slow` |
| Shell (Rust) | `cd app-shell/src-tauri && cargo test` |
| End to end (Playwright) + accessibility (axe) | `pnpm --dir ui e2e` |
| Dependency audit | `osv-scanner scan source --config osv-scanner.toml --lockfile compute/uv.lock --lockfile pnpm-lock.yaml --lockfile app-shell/src-tauri/Cargo.lock` |
| Validation report | `compute/.venv/bin/python scripts/validation_report.py` |
| Installed app: cold start and offline socket audit | `xvfb-run -a compute/.venv/bin/python scripts/launch_check.py --binary /usr/bin/moleculeforge` |

## Repository layout

```
app-shell/   Tauri 2 shell (Rust): window, IPC allowlist, sidecar lifecycle, file dialogs
ui/          React + TypeScript UI: design system, features, locales (ICU), typed IPC client
compute/     Python sidecar (mfcompute): chem/, sim/, data/, ai/, JSON-RPC server, PyInstaller spec
data/        elements.json (118), molecules/ (prebuilt library), knowledge/ (assistant references)
scripts/     engine fetching, data builds, licence collection, staging, AppImage assembly,
             validation report, installed-app launch check
tests/       unit/, integration/, chem-validation/, e2e/
docs/        architecture, user guide, validation report, adding a locale
LICENSES/    third-party licence texts (generated by scripts/collect_licenses.py)
```
