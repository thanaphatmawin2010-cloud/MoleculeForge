"""Simulation warnings in two forms.

``warnings`` keeps an English sentence per warning (raw-data exports and the assistant read it);
``warningCodes`` carries the same warning as a code with parameters, which the UI renders in the
user's language (``simWarning.<code>`` in ``ui/src/locales/<locale>/common.json``).
"""

from __future__ import annotations

from typing import Any

TEXT: dict[str, str] = {
    "cached": "Result served from the local cache (same InChIKey and method).",
    "dockingEstimate": "Educational/research estimate: rigid receptor, empirical scoring (typical error ≈ 2–3 kcal/mol), no explicit solvent.",
    "mdGasPhase": "Gas-phase single-molecule dynamics; averages are canonical-ensemble estimates with block-averaged uncertainties.",
    "minimizeStepLimit": "Stopped after {steps} steps before reaching the gradient tolerance.",
    "imaginaryFrequencies": "Imaginary frequencies found: the structure is not a true minimum at the GFN2-xTB level.",
    "hessianSizeLimit": "Vibrational analysis skipped: {atoms} atoms exceed the {level} limit of {limit}.",
    "xtbFailed": "GFN2-xTB step skipped: {reason}",
    "xtbElements": "GFN2-xTB covers H–Rn only; tight-binding properties were not computed.",
    "pm7Failed": "PM7 heat of formation unavailable: {reason}",
    "dftNotConverged": "DFT SCF did not fully converge; DFT values are approximate.",
    "dftFailed": "DFT step skipped: {reason}",
    "dftUnavailable": "DFT skipped: PySCF is not available on this platform; tight-binding values are reported.",
    "dftSizeLimit": "DFT skipped: {heavy} heavy atoms exceed the {level} limit of {limit}; tight-binding values are reported.",
}


class Notes:
    """Collects warnings for one result."""

    def __init__(self) -> None:
        self.text: list[str] = []
        self.codes: list[dict[str, Any]] = []

    def add(self, code: str, **params: str | int | float) -> None:
        self.text.append(TEXT[code].format(**params))
        self.codes.append({"code": code, "params": params})

    def as_result(self) -> dict[str, Any]:
        return {"warnings": list(self.text), "warningCodes": [dict(c) for c in self.codes]}


def single(code: str, **params: str | int | float) -> dict[str, Any]:
    notes = Notes()
    notes.add(code, **params)
    return notes.as_result()
