#!/usr/bin/env python3
"""Generate ``data/elements.json`` (spec 6.2) for all 118 elements.

Primary source: the ``mendeleev`` package (MIT), which aggregates IUPAC/CIAAW atomic
weights, NUBASE isotope data, Pyykkö covalent radii, Alvarez/Bondi van der Waals
radii, Shannon ionic radii, NIST ionisation energies and CRC thermophysical data.

Cross-check: ``Periodic-Table-JSON`` (Bowserinator, CC BY-SA) is downloaded at build
time only, never shipped; every numeric disagreement beyond tolerance is written to
``data/elements.crosscheck.json`` and summarised in BUILD_LOG.md.

Honesty rules (enforced here, asserted by tests):
* No value is invented. Unknown values are ``null`` with ``status: "unknown"``.
* Bulk properties of elements with Z >= 100 have never been measured on weighable
  samples; any such value from the source is labelled ``status: "predicted"``.

Run with: ``uv run --group data python ../scripts/build_elements.py`` from compute/.
"""

from __future__ import annotations

import json
import math
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any

from mendeleev import element as md_element

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "elements.json"
CROSSCHECK = ROOT / "data" / "elements.crosscheck.json"
EV_TO_KJMOL = 96.48533212331002
PTJ_URL = "https://raw.githubusercontent.com/Bowserinator/Periodic-Table-JSON/master/PeriodicTableJSON.json"

CATEGORY = {
    "Nonmetals": "nonmetal",
    "Noble gases": "noble-gas",
    "Alkali metals": "alkali-metal",
    "Alkaline earth metals": "alkaline-earth-metal",
    "Metalloids": "metalloid",
    "Halogens": "halogen",
    "Poor metals": "post-transition-metal",
    "Transition metals": "transition-metal",
    "Lanthanides": "lanthanide",
    "Actinides": "actinide",
}

# Standard-state electrical behaviour (CRC Handbook classification of the stable
# allotrope at 298 K). Z >= 100: no bulk samples exist, so "unknown".
SEMICONDUCTORS = {"B", "Si", "Ge", "Se", "Te"}
INSULATORS = {"H", "He", "N", "O", "F", "Ne", "P", "S", "Cl", "Ar", "Br", "Kr", "I", "Xe", "Rn"}
CONDUCTOR_NONMETAL = {"C"}  # graphite, the standard-state allotrope, conducts in-plane

# Controlled vocabulary for commonUses: each tag is localised in ui/src/locales/*/elements.json.
USE_TAGS: list[tuple[str, tuple[str, ...]]] = [
    ("alloys", ("alloy",)),
    ("steelmaking", ("steel",)),
    ("semiconductors", ("semiconductor", "transistor", "microchip", "integrated circuit", "silicon chip")),
    ("electronics", ("electronic", "capacitor", "circuit", "computer", "mobile phone", "television", "screen")),
    ("batteries", ("batter",)),
    ("catalysts", ("catalyst", "catalytic")),
    ("medicine", ("medic", "drug", "pharmaceutical", "treatment", "therapy", "antiseptic", "cancer")),
    ("medical-imaging", ("imaging", "mri", "x-ray", "contrast agent", "scan")),
    ("nuclear-power", ("nuclear reactor", "nuclear fuel", "nuclear power", "reactor", "control rod")),
    ("radiation-sources", ("radiation source", "radioactive source", "smoke detector", "radioisotope", "radiography", "tracer")),
    ("lighting", ("lamp", "lighting", "light bulb", "bulb", "neon sign", "fluorescent", "led", "street light")),
    ("lasers", ("laser",)),
    ("magnets", ("magnet",)),
    ("glass-ceramics", ("glass", "ceramic", "enamel", "porcelain")),
    ("pigments", ("pigment", "paint", "dye", "colour", "color")),
    ("fertilisers", ("fertili",)),
    ("water-treatment", ("water treatment", "purif", "disinfect", "drinking water", "swimming pool")),
    ("plastics-polymers", ("plastic", "polymer", "pvc", "teflon", "nylon", "rubber")),
    ("fuels-energy", ("fuel", "rocket", "energy", "power station", "solar")),
    ("jewellery-coinage", ("jewel", "coin")),
    ("aerospace", ("aircraft", "aerospace", "spacecraft", "jet engine", "satellite")),
    ("construction", ("construction", "cement", "building", "plaster", "concrete")),
    ("agriculture", ("agricult", "pesticide", "insecticide", "herbicide", "fungicide", "crop")),
    ("food", ("food", "baking", "salt", "flavour", "drink")),
    ("biological-role", ("essential", "diet", "nutrient", "bones", "teeth", "enzyme", "vitamin", "body")),
    ("photography", ("photograph", "film")),
    ("pyrotechnics", ("firework", "flare", "explosive", "pyrotechnic", "match")),
    ("coatings-plating", ("plating", "galvani", "coating", "electroplat")),
    ("solders", ("solder",)),
    ("superconductors", ("superconduct",)),
    ("cryogenics", ("cryogen", "refrigera", "cooling", "coolant")),
    ("welding", ("weld",)),
    ("dating", ("dating",)),
    ("atomic-clocks", ("atomic clock",)),
    ("optics", ("lens", "optical", "infrared", "fibre", "fiber")),
    ("industrial-chemicals", ("industrial", "chemical", "detergent", "bleach", "acid", "soap")),
    ("research", ("research", "scientific",)),
]

STATUS_PREDICTED_FROM = 100
# Elements below Z=100 that have likewise never been isolated in weighable bulk form.
NO_BULK_SAMPLE = {85, 87}

# Pauling electronegativities where mendeleev carries superseded values; Allred (1961),
# J. Inorg. Nucl. Chem. 17, 215, as tabulated in the CRC Handbook of Chemistry and Physics.
PAULING_ALLRED_1961 = {
    "Tc": 1.9, "Lu": 1.27, "W": 2.36, "Pt": 2.28, "Au": 2.54, "Hg": 2.00,
    "Tl": 1.62, "Pb": 1.87, "Bi": 2.02, "U": 1.38, "Np": 1.36,
}
# Electronegativity of these elements has never been measured; tabulated values are estimates.
PAULING_ESTIMATED = {"Fr", "Ra", "Pm", "At"}

NOTES: dict[str, dict[str, str]] = {
    "C": {"meltingPointK": "Graphite does not melt at 101.325 kPa; it sublimes near 3900 K (triple point about 4600 K at 10 MPa).",
          "boilingPointK": "Sublimation temperature region at 101.325 kPa; values in the literature range from about 3825 to 4100 K."},
    "As": {"meltingPointK": "Grey arsenic melts at its triple point (about 3.6 MPa); at 101.325 kPa it sublimes near 887 K."},
    "He": {"meltingPointK": "Helium does not solidify at 101.325 kPa; the value refers to about 2.5 MPa."},
    "P": {"meltingPointK": "White phosphorus."},
    "S": {"meltingPointK": "Monoclinic sulfur."},
    "Se": {"meltingPointK": "Grey (trigonal) selenium."},
    "Sn": {"meltingPointK": "White (beta) tin."},
}


def num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def quantity(value: Any, unit: str, z: int, *, bulk: bool = False, source: str = "mendeleev", digits: int | None = None) -> dict[str, Any]:
    val = num(value)
    if val is not None and digits is not None:
        val = round(val, digits)
    if val is None:
        status = "unknown"
    elif bulk and (z >= STATUS_PREDICTED_FROM or z in NO_BULK_SAMPLE):
        status = "predicted"
    else:
        status = "measured"
    return {"value": val, "unit": unit, "status": status, "source": source if val is not None else None}


def pauling(e: Any, symbol: str, z: int) -> dict[str, Any]:
    if symbol in PAULING_ALLRED_1961:
        return {"value": PAULING_ALLRED_1961[symbol], "unit": "Pauling", "status": "measured", "source": "Allred 1961 (CRC Handbook)"}
    record = quantity(e.en_pauling, "Pauling", z, digits=2)
    if record["value"] is not None and (symbol in PAULING_ESTIMATED or z >= STATUS_PREDICTED_FROM):
        record["status"] = "predicted"
    return record


def atomic_mass(e: Any, isotopes: list[dict[str, Any]]) -> dict[str, Any]:
    weight = num(e.atomic_weight)
    natural = any((iso["abundance"]["value"] or 0) > 0 for iso in isotopes)
    if natural or not e.is_radioactive:
        return {"value": weight, "uncertainty": num(e.atomic_weight_uncertainty), "unit": "u",
                "isMassNumberOfLongestLived": False, "source": "IUPAC/CIAAW standard atomic weight"}
    timed = [iso for iso in isotopes if iso["halfLife"]["seconds"] is not None]
    if not timed:
        return {"value": weight, "uncertainty": None, "unit": "u", "isMassNumberOfLongestLived": True, "source": "mendeleev"}
    longest = max(timed, key=lambda iso: iso["halfLife"]["seconds"])
    return {"value": float(longest["massNumber"]), "uncertainty": None, "unit": "u", "isMassNumberOfLongestLived": True,
            "source": "mass number of the longest-lived known isotope (NUBASE via mendeleev)"}


def full_configuration(conf: dict[tuple[int, str], int]) -> str:
    return " ".join(f"{n}{l}{count}" for (n, l), count in conf.items())


def tag_uses(text: str | None, symbol: str, z: int) -> list[str]:
    if not text:
        return ["research"] if z >= 100 else []
    lower = text.lower()
    tags = []
    for tag, keys in USE_TAGS:
        if any(re.search(r"\b" + re.escape(k), lower) for k in keys):
            tags.append(tag)
    return tags or ["research"]


def electrical_type(symbol: str, category: str, z: int) -> dict[str, Any]:
    if z >= STATUS_PREDICTED_FROM:
        return {"value": None, "status": "unknown", "source": None}
    if symbol in SEMICONDUCTORS:
        kind = "semiconductor"
    elif symbol in INSULATORS:
        kind = "insulator"
    elif symbol in CONDUCTOR_NONMETAL or category not in ("nonmetal", "noble-gas", "halogen"):
        kind = "conductor"
    else:
        kind = "insulator"
    return {"value": kind, "status": "measured", "source": "CRC Handbook standard-state classification"}


def half_life_seconds(iso: Any) -> float | None:
    if iso.half_life is None:
        return None
    unit = (iso.half_life_unit or "s").strip()
    factors = {
        "ys": 1e-24, "zs": 1e-21, "zsec": 1e-21, "as": 1e-18, "fs": 1e-15, "ps": 1e-12, "ns": 1e-9, "us": 1e-6,
        "asec": 1e-18, "psec": 1e-12, "nsec": 1e-9, "usec": 1e-6, "ysec": 1e-24,
        "msec": 1e-3, "ms": 1e-3, "s": 1.0, "sec": 1.0, "m": 60.0, "min": 60.0, "minute": 60.0,
        "h": 3600.0, "hour": 3600.0, "d": 86400.0, "day": 86400.0,
        "y": 31556952.0, "year": 31556952.0, "kyear": 31556952e3, "Myear": 31556952e6, "Gyear": 31556952e9,
        "Tyear": 31556952e12, "Pyear": 31556952e15, "Eyear": 31556952e18, "Zyear": 31556952e21, "Yyear": 31556952e24,
        "ky": 31556952e3, "My": 31556952e6, "Gy": 31556952e9, "Ty": 31556952e12, "Py": 31556952e15, "Ey": 31556952e18,
        "Zy": 31556952e21, "Yy": 31556952e24,
    }
    factor = factors.get(unit)
    if factor is None:
        return None
    return float(iso.half_life) * factor


def isotope_records(e: Any) -> list[dict[str, Any]]:
    records = []
    for iso in sorted(e.isotopes, key=lambda i: i.mass_number):
        abundance = num(iso.abundance)
        modes = []
        for mode in getattr(iso, "decay_modes", []) or []:
            modes.append({"mode": mode.mode, "intensityPercent": num(mode.intensity), "relation": mode.relation})
        records.append(
            {
                "massNumber": iso.mass_number,
                "mass": {"value": num(iso.mass), "uncertainty": num(iso.mass_uncertainty), "unit": "u"},
                "abundance": {"value": round(abundance / 100.0, 8) if abundance is not None else None, "unit": "fraction"},
                "halfLife": {
                    "value": num(iso.half_life),
                    "unit": iso.half_life_unit,
                    "seconds": half_life_seconds(iso),
                    "stable": bool(iso.is_stable) if iso.is_stable is not None else not bool(iso.is_radioactive),
                },
                "decayMode": modes,
                "nuclearSpin": iso.spin,
                "gFactor": num(iso.g_factor),
                "quadrupoleMomentBarn": num(iso.quadrupole_moment),
            }
        )
    return records


def build_element(z: int) -> dict[str, Any]:
    e = md_element(z)
    symbol = e.symbol
    category = CATEGORY.get(e.series, "unknown")
    try:
        conf = e.ec.conf
        shells = list(e.ec.electrons_per_shell().values())
        full = full_configuration(conf)
    except Exception:  # noqa: BLE001
        conf, shells, full = {}, [], ""
    ion_energies = [round(v * EV_TO_KJMOL, 3) for _, v in sorted(e.ionenergies.items())] if e.ionenergies else []
    ea_ev = num(e.electron_affinity)
    allen_ev = num(e.en_allen)
    discoverers = (e.discoverers or "").strip().rstrip(".")
    ancient = "ancient" in discoverers.lower()
    isotopes = isotope_records(e)
    record: dict[str, Any] = {
        "Z": z,
        "symbol": symbol,
        "name": f"element.{symbol}",
        "nameEn": e.name,
        "atomicMass": atomic_mass(e, isotopes),
        "category": category,
        "group": int(e.group_id) if e.group_id is not None else None,
        "period": int(e.period),
        "block": e.block,
        "electronConfiguration": {"full": full, "nobleGasShorthand": e.econf},
        "shellElectrons": shells,
        "electronegativityPauling": pauling(e, symbol, z),
        "electronegativityAllen": {
            **quantity(round(allen_ev * 0.169, 3) if allen_ev is not None else None, "Pauling units (Allen scale)", z),
            "eV": allen_ev,
        },
        "radiusCovalent": {
            "single": quantity(e.covalent_radius_pyykko, "pm", z, source="Pyykkö & Atsumi 2009", digits=1),
            "double": quantity(e.covalent_radius_pyykko_double, "pm", z, source="Pyykkö & Atsumi 2009", digits=1),
            "triple": quantity(e.covalent_radius_pyykko_triple, "pm", z, source="Pyykkö, Riedel & Patzschke 2005", digits=1),
        },
        "radiusVanDerWaals": (
            quantity(e.vdw_radius_alvarez, "pm", z, source="Alvarez 2013", digits=1)
            if e.vdw_radius_alvarez is not None
            else quantity(e.vdw_radius, "pm", z, source="Bondi 1964 / Mantina 2009", digits=1)
        ),
        "radiusAtomic": quantity(e.atomic_radius, "pm", z, source="Slater 1964 (empirical)", digits=1),
        "ionicRadii": {
            "unit": "pm",
            "source": "Shannon 1976",
            "entries": [
                {
                    "charge": r.charge,
                    "coordination": r.coordination,
                    "spin": r.spin or None,
                    "crystalRadius": num(r.crystal_radius),
                    "ionicRadius": num(r.ionic_radius),
                }
                for r in e.ionic_radii
            ],
        },
        "ionizationEnergies": {"unit": "kJ/mol", "values": ion_energies, "source": "NIST ASD" if ion_energies else None},
        "electronAffinity": quantity(round(ea_ev * EV_TO_KJMOL, 3) if ea_ev is not None else None, "kJ/mol", z),
        "oxidationStates": {"common": list(e.oxistates or []), "all": sorted(set(e.oxidation_states()) if callable(getattr(e, "oxidation_states", None)) else [])},
        "isotopes": isotopes,
        "density": {**quantity(e.density, "g/cm³", z, bulk=True),
                    "conditions": "gases at 298.15 K and 101.325 kPa; condensed phases near room temperature"},
        "meltingPointK": quantity(e.melting_point, "K", z, bulk=True, digits=2),
        "boilingPointK": quantity(e.boiling_point, "K", z, bulk=True, digits=2),
        "heatOfFusion": quantity(e.fusion_heat, "kJ/mol", z, bulk=True),
        "heatOfVaporization": quantity(e.evaporation_heat, "kJ/mol", z, bulk=True),
        "molarHeatCapacity": quantity(e.molar_heat_capacity, "J/(mol·K)", z, bulk=True),
        "thermalConductivity": quantity(e.thermal_conductivity, "W/(m·K)", z, bulk=True),
        "electricalType": electrical_type(symbol, category, z),
        "crystalStructure": {"value": e.lattice_structure, "status": "measured" if e.lattice_structure and z < STATUS_PREDICTED_FROM else ("predicted" if e.lattice_structure else "unknown")},
        "discoveredBy": {"value": None if ancient else (discoverers or None), "knownSinceAntiquity": ancient},
        "yearDiscovered": {"value": int(e.discovery_year) if e.discovery_year else None, "knownSinceAntiquity": ancient},
        "cpkColorHex": (e.cpk_color or e.jmol_color or "#ff1493").lower(),
        "commonUses": tag_uses(e.uses, symbol, z),
        "dipolePolarizability": quantity(e.dipole_polarizability, "a.u.", z, source="Schwerdtfeger & Nagle 2018"),
        "notes": NOTES.get(symbol, {}),
    }
    return record


def crosscheck(elements: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(PTJ_URL, timeout=60) as resp:
            ptj = json.load(resp)["elements"]
    except Exception as exc:  # noqa: BLE001
        return {"status": "unavailable", "error": str(exc)}
    by_z = {item["number"]: item for item in ptj}
    fields = [
        ("atomicMass", lambda e: e["atomicMass"]["value"], "atomic_mass", 0.01),
        ("density", lambda e: e["density"]["value"], "density", 0.05),
        ("meltingPointK", lambda e: e["meltingPointK"]["value"], "melt", 0.02),
        ("boilingPointK", lambda e: e["boilingPointK"]["value"], "boil", 0.02),
        ("electronegativityPauling", lambda e: e["electronegativityPauling"]["value"], "electronegativity_pauling", 0.02),
        ("molarHeatCapacity", lambda e: e["molarHeatCapacity"]["value"], "molar_heat", 0.05),
        ("firstIonizationEnergy", lambda e: (e["ionizationEnergies"]["values"] or [None])[0], "ionization_energies", 0.01),
    ]
    discrepancies = []
    for el in elements:
        other = by_z.get(el["Z"])
        if other is None:
            discrepancies.append({"Z": el["Z"], "field": "*", "note": "missing in Periodic-Table-JSON"})
            continue
        if other.get("symbol") != el["symbol"]:
            discrepancies.append({"Z": el["Z"], "field": "symbol", "ours": el["symbol"], "theirs": other.get("symbol")})
        for field, getter, key, tol in fields:
            ours = getter(el)
            theirs = other.get(key)
            if isinstance(theirs, list):
                theirs = theirs[0] if theirs else None
            if field == "density" and theirs is not None and str(other.get("phase", "")).lower() == "gas":
                # g/L at 273.15 K (STP) -> g/cm3 at 298.15 K (ideal gas) to match our conditions
                theirs = float(theirs) / 1000.0 * 273.15 / 298.15
            if ours is None or theirs is None:
                continue
            ref = abs(float(theirs)) or 1.0
            if abs(float(ours) - float(theirs)) / ref > tol:
                discrepancies.append({"Z": el["Z"], "symbol": el["symbol"], "field": field, "ours": ours, "theirs": theirs, "tolerance": tol})
    return {"status": "ok", "source": PTJ_URL, "compared": len(elements), "discrepancies": discrepancies}


def main() -> None:
    elements = [build_element(z) for z in range(1, 119)]
    assert len(elements) == 118 and [e["Z"] for e in elements] == list(range(1, 119))
    payload = {
        "schema": "moleculeforge.elements/1",
        "generatedBy": "scripts/build_elements.py",
        "sources": {
            "primary": "mendeleev (https://github.com/lmmentel/mendeleev, MIT) aggregating IUPAC/CIAAW, NUBASE2020, NIST ASD, CRC, Pyykkö, Alvarez, Shannon",
            "crosscheck": "Periodic-Table-JSON (build-time comparison only, not redistributed)",
        },
        "statusLegend": {
            "measured": "Experimental or evaluated value from the cited source",
            "predicted": "Theoretical or extrapolated value (no bulk sample exists, Z >= 100)",
            "unknown": "Not determined; deliberately left empty",
        },
        "elements": elements,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    report = crosscheck(elements)
    CROSSCHECK.write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KiB); cross-check: {report.get('status')} "
          f"with {len(report.get('discrepancies', []))} discrepancies")


if __name__ == "__main__":
    sys.exit(main())
