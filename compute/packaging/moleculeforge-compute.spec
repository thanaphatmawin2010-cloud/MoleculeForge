# PyInstaller spec for the MoleculeForge compute sidecar (one-folder build).
#
#   cd compute && uv run pyinstaller packaging/moleculeforge-compute.spec --noconfirm
#
# Output: compute/dist/compute/moleculeforge-compute[.exe] plus _internal/. LGPL components stay
# replaceable, as their licences require: Meeko ships as plain source files in _internal/meeko/
# (not inside the compiled archive), xtb is a separate executable, and OpenMM's LGPL GPU platforms
# are separate shared libraries. Nothing GPL is linked into this process.
import importlib.util
import os
import sysconfig
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

site = Path(sysconfig.get_paths()["purelib"])
datas, binaries, hiddenimports = [], [], []
for package in ("rdkit", "openmm", "pyscf", "meeko", "gemmi", "uharfbuzz", "berny", "molsym"):
    if importlib.util.find_spec(package) is None:  # PySCF and PyBerny are not published for Windows
        continue
    d, b, h = collect_all(package)
    datas += d
    binaries += b
    hiddenimports += h
datas += collect_data_files("reportlab")
# Meeko is analysed like any other package (so its dependencies are collected) but its own modules
# are taken out of the archive below and shipped as source instead.
datas += collect_data_files("meeko", include_py_files=True)
hiddenimports += collect_submodules("mfcompute")

# OpenMM looks for its core and plugin libraries in <site-packages>/OpenMM.libs/lib[/plugins];
# keep that layout so Platform plugins (CPU, OpenCL, CUDA) load in the frozen app.
openmm_libs = site / "OpenMM.libs" / "lib"
for path in openmm_libs.rglob("*"):
    if path.is_file() and (".so" in path.name or path.suffix in (".dll", ".dylib")):
        binaries.append((str(path), str(Path("OpenMM.libs") / "lib" / path.parent.relative_to(openmm_libs))))

a = Analysis(
    [os.path.join(SPECPATH, "entry.py")],
    pathex=[os.path.dirname(SPECPATH)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "PyQt5", "PySide6", "notebook", "mendeleev", "pandas"],
    noarchive=False,
)
a.pure = [entry for entry in a.pure if entry[0] != "meeko" and not entry[0].startswith("meeko.")]
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="moleculeforge-compute",
    console=True,  # stdio is the protocol channel; the shell hides the console window on Windows
    strip=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="compute")
