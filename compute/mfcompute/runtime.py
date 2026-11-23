"""Process-wide handle to the running RPC server.

Kept in its own module because the server is normally started as ``python -m
mfcompute.server`` (module ``__main__``): a global inside ``server.py`` would then exist
twice, and handlers importing ``mfcompute.server`` would see an empty copy.
"""

from __future__ import annotations

from typing import Any

SERVER: Any = None  # mfcompute.server.Server once main() has started
