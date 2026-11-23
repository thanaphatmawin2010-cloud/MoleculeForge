# PyInstaller spec for the MoleculeForge compute sidecar (one-folder build).
#
#   cd compute && uv run pyinstaller packaging/moleculeforge-compute.spec --noconfirm
#
# Output: compute/dist/compute/moleculeforge-compute[.exe] plus _internal/. LGPL components
# (meeko, and the separately bundled xtb executable) stay as replaceable files, as their
# licences require; nothing GPL is linked into this process.
import os
import sysconfig
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

site = Path(sysconfig.get_paths()["purelib"])
datas, binaries, hiddenimports = [], [], []
for package in ("rdkit", "openmm", "pyscf", "meeko", "gemmi", "uharfbuzz", "geometric", "networkx"):
    d, b, h = collect_all(package)
    datas += d
    binaries += b
    hiddenimports += h
datas += collect_data_files("reportlab")
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
