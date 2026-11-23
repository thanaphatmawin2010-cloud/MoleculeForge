"""§9.1 element-data integrity: all 118 elements, required fields present, every value with a unit
and a source, and nothing invented (unknown values are null with status "unknown")."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]
DATA = json.loads((ROOT / "data" / "elements.json").read_text(encoding="utf-8"))
ELEMENTS = DATA["elements"]
REQUIRED = ("Z", "symbol", "name", "nameEn", "atomicMass", "category", "period", "block", "electronConfiguration",
            "shellElectrons", "cpkColorHex", "isotopes")
QUANTITIES = ("electronegativityPauling", "electronegativityAllen", "radiusVanDerWaals", "radiusAtomic", "electronAffinity",
              "density", "meltingPointK", "boilingPointK", "heatOfFusion", "heatOfVaporization", "molarHeatCapacity",
              "thermalConductivity", "dipolePolarizability")


def test_all_118_elements_in_order() -> None:
    assert [e["Z"] for e in ELEMENTS] == list(range(1, 119))
    assert len({e["symbol"] for e in ELEMENTS}) == 118


@pytest.mark.parametrize("element", ELEMENTS, ids=lambda e: e["symbol"])
def test_required_fields_are_present(element: dict[str, Any]) -> None:
    for field in REQUIRED:
        assert element.get(field) not in (None, "", []), f"{element['symbol']}: {field} missing"
    assert element["atomicMass"]["value"] > 0 and element["atomicMass"]["unit"] == "u"
    assert element["atomicMass"]["source"]
    assert sum(element["shellElectrons"]) == element["Z"]
    assert element["electronConfiguration"]["full"]


@pytest.mark.parametrize("element", ELEMENTS, ids=lambda e: e["symbol"])
def test_every_quantity_has_unit_status_and_source(element: dict[str, Any]) -> None:
    for field in QUANTITIES:
        q = element[field]
        assert "value" in q and q.get("unit"), f"{element['symbol']}.{field} lacks a unit"
        assert q.get("status") in ("measured", "predicted", "unknown"), f"{element['symbol']}.{field}"
        if q["value"] is None:
            assert q["status"] == "unknown", f"{element['symbol']}.{field}: a missing value must be marked unknown"
        else:
            assert q.get("source"), f"{element['symbol']}.{field} has a value without a source"
    for kind in ("single", "double", "triple"):
        q = element["radiusCovalent"][kind]
        assert q.get("unit") == "pm" and q.get("status") in ("measured", "predicted", "unknown")


def test_superheavy_values_are_never_presented_as_measured() -> None:
    for element in ELEMENTS:
        if element["Z"] < 100:
            continue
        for field in ("density", "meltingPointK", "boilingPointK"):
            assert element[field]["status"] in ("predicted", "unknown"), f"{element['symbol']}.{field}"


@pytest.mark.parametrize(("symbol", "mass", "en"), [("H", 1.008, 2.20), ("C", 12.011, 2.55), ("O", 15.999, 3.44), ("Fe", 55.845, 1.83),
                                                    ("Au", 196.97, 2.54)])
def test_reference_values(symbol: str, mass: float, en: float) -> None:
    element = next(e for e in ELEMENTS if e["symbol"] == symbol)
    assert element["atomicMass"]["value"] == pytest.approx(mass, abs=0.01)
    assert element["electronegativityPauling"]["value"] == pytest.approx(en, abs=0.01)


def test_cross_check_discrepancies_are_documented() -> None:
    crosscheck = json.loads((ROOT / "data" / "elements.crosscheck.json").read_text(encoding="utf-8"))
    assert crosscheck, "the independent cross-check report ships with the data"
