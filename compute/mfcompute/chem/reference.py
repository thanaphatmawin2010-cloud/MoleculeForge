"""Reference geometry for repair reports and validation.

Bond-length ranges (Å) are the interquartile-to-extreme ranges for common organic
fragments compiled from Allen et al., "Tables of bond lengths determined by X-ray and
neutron diffraction", J. Chem. Soc., Perkin Trans. 2 (1987) S1–S19, and gas-phase
microwave/electron-diffraction values from the CRC Handbook (section 9). VSEPR angle
expectations follow Gillespie & Hargittai, "The VSEPR Model of Molecular Geometry".
"""

from __future__ import annotations

from dataclasses import dataclass

from ..data import elements


@dataclass(frozen=True)
class BondRef:
    typical: float
    low: float
    high: float
    source: str = "Allen et al. 1987 / CRC Handbook"


# Keyed by alphabetically sorted element pair and bond order.
BOND_REFS: dict[tuple[str, str, str], BondRef] = {
    ("C", "H", "single"): BondRef(1.09, 1.05, 1.12),
    ("C", "C", "single"): BondRef(1.53, 1.45, 1.58),
    ("C", "C", "double"): BondRef(1.33, 1.30, 1.36),
    ("C", "C", "triple"): BondRef(1.20, 1.17, 1.22),
    ("C", "C", "aromatic"): BondRef(1.39, 1.36, 1.42),
    ("C", "N", "single"): BondRef(1.47, 1.33, 1.50),
    ("C", "N", "double"): BondRef(1.28, 1.25, 1.31),
    ("C", "N", "triple"): BondRef(1.15, 1.13, 1.17),
    ("C", "N", "aromatic"): BondRef(1.34, 1.31, 1.39),
    ("C", "O", "single"): BondRef(1.43, 1.30, 1.47),
    ("C", "O", "double"): BondRef(1.21, 1.15, 1.25),
    ("C", "O", "aromatic"): BondRef(1.36, 1.33, 1.39),
    ("C", "S", "single"): BondRef(1.82, 1.74, 1.86),
    ("C", "S", "double"): BondRef(1.67, 1.59, 1.71),
    ("C", "S", "aromatic"): BondRef(1.71, 1.68, 1.75),
    ("C", "F", "single"): BondRef(1.36, 1.32, 1.40),
    ("C", "Cl", "single"): BondRef(1.76, 1.71, 1.80),
    ("Br", "C", "single"): BondRef(1.94, 1.88, 1.98),
    ("C", "I", "single"): BondRef(2.14, 2.08, 2.18),
    ("H", "N", "single"): BondRef(1.01, 0.98, 1.04),
    ("H", "O", "single"): BondRef(0.96, 0.93, 0.99),
    ("H", "S", "single"): BondRef(1.34, 1.32, 1.37),
    ("H", "P", "single"): BondRef(1.42, 1.38, 1.45),
    ("H", "Si", "single"): BondRef(1.48, 1.46, 1.50),
    ("B", "H", "single"): BondRef(1.19, 1.15, 1.22),
    ("H", "H", "single"): BondRef(0.74, 0.72, 0.76),
    ("N", "N", "single"): BondRef(1.43, 1.38, 1.47),
    ("N", "N", "double"): BondRef(1.24, 1.21, 1.27),
    ("N", "N", "triple"): BondRef(1.10, 1.08, 1.12),
    ("N", "N", "aromatic"): BondRef(1.34, 1.30, 1.38),
    ("N", "O", "single"): BondRef(1.40, 1.36, 1.45),
    ("N", "O", "double"): BondRef(1.21, 1.18, 1.25),
    ("N", "O", "aromatic"): BondRef(1.38, 1.34, 1.42),
    ("O", "O", "single"): BondRef(1.47, 1.44, 1.50),
    ("O", "O", "double"): BondRef(1.21, 1.20, 1.23),
    ("O", "P", "single"): BondRef(1.60, 1.55, 1.65),
    ("O", "P", "double"): BondRef(1.48, 1.44, 1.52),
    ("O", "S", "single"): BondRef(1.58, 1.52, 1.64),
    ("O", "S", "double"): BondRef(1.44, 1.41, 1.48),
    ("S", "S", "single"): BondRef(2.05, 2.01, 2.09),
    ("C", "P", "single"): BondRef(1.84, 1.79, 1.88),
    ("C", "Si", "single"): BondRef(1.87, 1.84, 1.90),
    ("N", "S", "single"): BondRef(1.65, 1.60, 1.70),
    ("C", "C", "single-ring3"): BondRef(1.51, 1.48, 1.53),
}

# CO2 and other cumulated C=O are shorter than ketone C=O; carbon monoxide-like triple.
CUMULATED_CO = BondRef(1.16, 1.15, 1.18, "CRC Handbook (CO2 gas phase 1.160 Å)")

VSEPR_ANGLES: dict[str, tuple[float, float, float]] = {
    # class: (ideal, low, high) in degrees
    "AX2": (180.0, 175.0, 180.0),
    "AX2E": (117.0, 105.0, 125.0),
    "AX2E2": (104.5, 100.0, 109.5),
    "AX2E3": (180.0, 175.0, 180.0),
    "AX3": (120.0, 110.0, 125.0),
    "AX3E": (107.0, 100.0, 110.0),
    "AX3E2": (87.5, 80.0, 95.0),
    "AX4": (109.47, 104.0, 115.0),
    "AX4E": (102.0, 85.0, 120.0),
    "AX4E2": (90.0, 85.0, 95.0),
    "AX5": (90.0, 85.0, 120.0),
    "AX6": (90.0, 85.0, 95.0),
}


def bond_reference(el_a: str, el_b: str, order: str, *, cumulated: bool = False) -> BondRef:
    a, b = sorted((el_a, el_b))
    if cumulated and (a, b) == ("C", "O") and order == "double":
        return CUMULATED_CO
    ref = BOND_REFS.get((a, b, order))
    if ref is not None:
        return ref
    expected = elements.expected_bond_length(el_a, el_b, order)
    return BondRef(round(expected, 3), round(expected * 0.9, 3), round(expected * 1.1, 3), "Pyykkö covalent radii ±10%")


def vsepr_class(steric_bonds: int, lone_pairs: int) -> str:
    return f"AX{steric_bonds}" + (f"E{lone_pairs}" if lone_pairs == 1 else (f"E{lone_pairs}" if lone_pairs > 1 else "")).replace("E1", "E")
