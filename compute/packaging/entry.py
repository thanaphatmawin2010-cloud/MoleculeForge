"""Frozen entry point for the compute sidecar (PyInstaller)."""

import multiprocessing

if __name__ == "__main__":
    # Must run first: PySCF DFT jobs run in spawned child processes of this executable.
    multiprocessing.freeze_support()
    from mfcompute.server import main

    main()
