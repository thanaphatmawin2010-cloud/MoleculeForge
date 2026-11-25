# MoleculeForge

An offline desktop workbench for building, validating and simulating molecules. You draw in 2D and
see 3D at the same time, every bond is checked as you draw it, and geometry repair takes one click.
It includes a sourced periodic table of all 118 elements, a library of more than 180 prebuilt
molecules, and real property calculations: force fields, GFN2-xTB, PM7 and B3LYP, molecular
dynamics and docking. A local AI assistant answers by calling those same tools. It runs entirely on
your computer, with no network access at runtime, in English and Thai.

* **Try it first:** MoleculeForge Lite, a free trial, runs in your browser at
  **https://thanaphatmawin2010-cloud.github.io/MoleculeForge/** and on Android; see
  [below](#try-it-moleculeforge-lite-web-and-android).
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

## Try it: MoleculeForge Lite (web and Android)

MoleculeForge Lite is the trial edition: the same interface running on a chemistry engine compiled to
WebAssembly (RDKit, the same release as the desktop app, plus OpenChemLib's MMFF94), entirely on the
device. It draws, validates and repairs structures live, computes descriptors, MMFF94 geometries,
shape and surface areas, and includes the periodic table and the molecule library (saved molecules
stay in the browser or app). Molecular dynamics, docking, quantum chemistry (GFN2-xTB, PM7, B3LYP),
the AI assistant, PDF reports and InChI/XYZ/PDB import are desktop-only; the trial shows where each
one would be and links to the download. It works on phones (touch drawing, pinch zoom).

* **Web:** published by [.github/workflows/pages.yml](.github/workflows/pages.yml) to the
  repository's GitHub Pages site (`https://<owner>.github.io/<repository>/`; one-time setup:
  *Settings > Pages > Source: GitHub Actions*). It can be installed from the browser and then works
  offline. The page requests nothing from any other site.
* **Android 8.0 or newer:** the `.apk` on the Releases page (and the `.aab` for Google Play). The app
  has no internet permission at all.

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

### MoleculeForge Lite (web trial and Android app)

```bash
pnpm --dir ui build:lite           # → ui/dist-lite (serve it with: pnpm --dir ui preview:lite)
pnpm --dir ui dev:lite             # development server on http://127.0.0.1:5174
```

The Android app wraps `ui/dist-lite` (build it first). With JDK 17 or newer and the Android SDK
(`ANDROID_HOME`), from `android/`:

```bash
./gradlew assembleRelease bundleRelease
```

The APK is signed when `MF_ANDROID_KEYSTORE`, `MF_ANDROID_KEYSTORE_PASSWORD`, `MF_ANDROID_KEY_ALIAS`
and `MF_ANDROID_KEY_PASSWORD` are set. For release builds in CI, create a key once with `keytool` (part of
every Java JDK and of Android Studio), and keep the file and its password safe: every future update
must be signed with it.

```bash
keytool -genkeypair -keystore moleculeforge-release.jks -alias moleculeforge -keyalg RSA -keysize 4096 -validity 10000
```

```bash
base64 < moleculeforge-release.jks
```

and add the repository secrets (*Settings > Secrets and variables > Actions*):
`ANDROID_KEYSTORE_BASE64` (the second command's output), `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` (`moleculeforge`) and `ANDROID_KEY_PASSWORD` (the same password: keytool's
default PKCS12 keystores use one password). Every release then updates installed copies in place;
without the secrets each build gets its own key. After changing an Android dependency, refresh the
lockfile with `./gradlew :app:dependencies --write-locks`. The launcher and web-app icons come from
the desktop icon: `compute/.venv/bin/python scripts/gen_app_icons.py`.

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
| Lite engine: parity with the desktop engine (Vitest, part of the UI suite) | `pnpm --dir ui exec vitest run ../tests/unit/lite` |
| Lite end to end: desktop and phone sizes, offline, accessibility | `pnpm --dir ui build:lite && pnpm --dir ui e2e:lite` |
| Android: lint, build, instrumented test on a device or emulator | `cd android && ./gradlew lintRelease assembleRelease connectedDebugAndroidTest` |
| Dependency audit | `osv-scanner scan source --config osv-scanner.toml --lockfile compute/uv.lock --lockfile pnpm-lock.yaml --lockfile app-shell/src-tauri/Cargo.lock --lockfile android/app/gradle.lockfile` |
| Validation report | `compute/.venv/bin/python scripts/validation_report.py` |
| Installed app: cold start and offline socket audit | `xvfb-run -a compute/.venv/bin/python scripts/launch_check.py --binary /usr/bin/moleculeforge` |

## Repository layout

```
app-shell/   Tauri 2 shell (Rust): window, IPC allowlist, sidecar lifecycle, file dialogs
ui/          React + TypeScript UI: design system, features, locales (ICU), typed IPC client;
             ui/src/lite: MoleculeForge Lite's WebAssembly engine (same JSON-RPC methods, Web Worker)
android/     Android app (Kotlin): a WebView around the Lite build, no network permission
compute/     Python sidecar (mfcompute): chem/, sim/, data/, ai/, JSON-RPC server, PyInstaller spec
data/        elements.json (118), molecules/ (prebuilt library), knowledge/ (assistant references)
scripts/     engine fetching, data builds, licence collection, staging, AppImage assembly,
             validation report, installed-app launch check
tests/       unit/ (lite/: parity with the desktop engine), integration/, chem-validation/, e2e/, e2e-lite/
docs/        architecture, user guide, validation report, adding a locale
LICENSES/    third-party licence texts (generated by scripts/collect_licenses.py)
```
