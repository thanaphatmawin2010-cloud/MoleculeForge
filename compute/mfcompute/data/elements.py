"""Element dataset access (``elements.get`` / ``elements.all``) and derived radii helpers."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from .. import paths
from ..rpc import NOT_FOUND, RpcError

_PM_TO_ANGSTROM = 0.01


@lru_cache(maxsize=1)
def dataset() -> dict[str, Any]:
    path = paths.data_dir() / "elements.json"
    payload: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    if len(payload["elements"]) != 118:
        raise RuntimeError("elements.json must contain exactly 118 elements")
    return payload


@lru_cache(maxsize=1)
def _by_symbol() -> dict[str, dict[str, Any]]:
    return {e["symbol"]: e for e in dataset()["elements"]}


def all_elements() -> list[dict[str, Any]]:
    return list(dataset()["elements"])


def get(z: int | None = None, symbol: str | None = None) -> dict[str, Any]:
    if z is not None:
        if 1 <= z <= 118:
            return dict(dataset()["elements"][z - 1])
    elif symbol:
        sym = symbol.strip().capitalize()
        if sym in _by_symbol():
            return dict(_by_symbol()[sym])
    raise RpcError(NOT_FOUND, "Element not found", {"z": z, "symbol": symbol})


@lru_cache(maxsize=512)
def covalent_radius(symbol: str, order: int = 1) -> float:
    """Pyykkö covalent radius in Å for bond order 1/2/3, falling back to single-bond radius."""
    record = _by_symbol().get(symbol)
    if record is None:
        return 0.75
    radii = record["radiusCovalent"]
    key = {1: "single", 2: "double", 3: "triple"}.get(order, "single")
    value = radii[key]["value"] if radii[key]["value"] is not None else radii["single"]["value"]
    return float(value) * _PM_TO_ANGSTROM if value is not None else 1.5


@lru_cache(maxsize=512)
def vdw_radius(symbol: str) -> float:
    record = _by_symbol().get(symbol)
    if record is None or record["radiusVanDerWaals"]["value"] is None:
        return 2.0
    return float(record["radiusVanDerWaals"]["value"]) * _PM_TO_ANGSTROM


def expected_bond_length(symbol_a: str, symbol_b: str, order: str) -> float:
    """Expected bond length (Å) from Pyykkö additive covalent radii.

    Aromatic bonds use the mean of single and double radii sums.
    """
    if order == "aromatic":
        return 0.5 * (expected_bond_length(symbol_a, symbol_b, "single") + expected_bond_length(symbol_a, symbol_b, "double"))
    n = {"single": 1, "double": 2, "triple": 3}.get(order, 1)
    return covalent_radius(symbol_a, n) + covalent_radius(symbol_b, n)


def cpk_color(symbol: str) -> str:
    record = _by_symbol().get(symbol)
    return str(record["cpkColorHex"]) if record else "#ff1493"
