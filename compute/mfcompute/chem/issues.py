"""Machine-readable validation reason codes with English explanations.

The UI localises every code through ``ui/src/locales/<lang>/issues.json`` using the
same parameter names, so this table and the locale files must stay in sync
(enforced by tests/unit/compute/test_issue_codes.py and the i18n coverage check).
"""

from __future__ import annotations

from typing import Any

from ..models import Issue

CODES: dict[str, tuple[str, str]] = {
    "VALID": ("info", "Bond connected correctly."),
    "UNKNOWN_ELEMENT": ("error", "'{element}' is not an element symbol."),
    "SELF_BOND": ("error", "Atom {atom} is bonded to itself."),
    "DUPLICATE_BOND": ("error", "Atoms {a} and {b} are bonded twice."),
    "ISOTOPE_UNKNOWN": ("error", "Mass number {isotope} is not a known isotope of {element}."),
    "VALENCE_EXCEEDED": ("error", "{element} atom {atom} has {valence} bonds; at most {allowed} are allowed with charge {charge}."),
    "AROMATIC_INVALID": ("error", "The ring containing atoms {atomList} cannot be aromatic as drawn (no valid Kekulé structure)."),
    "UNDERSATURATED": ("error", "{element} atom {atom} has an unpaired electron (radical); hydrogen count is too low."),
    "RADICAL": ("warning", "{element} atom {atom} carries {radicals} unpaired electron(s)."),
    "HYPERVALENT": ("info", "{element} atom {atom} uses an expanded valence ({valence}); this is allowed for period-3+ elements."),
    "CHARGE_UNUSUAL": ("warning", "{element} atom {atom} has an unusual formal charge of {charge}."),
    "FRAGMENTS": ("info", "The structure has {count} disconnected fragments."),
    "ATOMS_OVERLAP": ("error", "Atoms {a} and {b} occupy the same position ({distance} Å apart)."),
    "CLASH": ("error", "Non-bonded atoms {a} and {b} are only {distance} Å apart (minimum {limit} Å)."),
    "BOND_TOO_LONG": ("warning", "Bond {a}–{b} is {length} Å; expected about {expected} Å."),
    "BOND_TOO_SHORT": ("warning", "Bond {a}–{b} is {length} Å; expected about {expected} Å."),
    "EMPTY": ("info", "The canvas is empty."),
}

FIX_DESCRIPTIONS: dict[str, str] = {
    "removeBond": "Removed bond {a}–{b}.",
    "removeAtom": "Removed hydrogen atom {atom} to free a valence.",
    "setBondOrder": "Changed bond {a}–{b} from {from} to {to}.",
    "setCharge": "Set formal charge of {element} atom {atom} to {charge:+d}.",
    "setHCount": "Set hydrogen count of {element} atom {atom} to {hCount}.",
    "kekulize": "Assigned a valid Kekulé structure to atoms {atoms}.",
    "clearIsotope": "Cleared invalid isotope on atom {atom}.",
    "moveAtom": "Moved atom {atom} to a bond length of {length} Å.",
}


DISPLAY_INDEX_KEYS = ("atom", "a", "b")


def display_params(params: dict[str, Any]) -> dict[str, Any]:
    """Atom numbers shown to people are 1-based, matching the editor labels."""
    return {k: (v + 1 if k in DISPLAY_INDEX_KEYS and isinstance(v, int) else v) for k, v in params.items()}


def make_issue(code: str, *, atoms: list[int] | None = None, bonds: list[int] | None = None, **params: Any) -> Issue:
    severity, template = CODES[code]
    params = display_params(params)
    try:
        message = template.format(**params)
    except (KeyError, IndexError, ValueError):
        message = template
    return Issue(code=code, severity=severity, message=message, atoms=atoms or [], bonds=bonds or [], params=params)


def describe_fix(op: str, **params: Any) -> str:
    template = FIX_DESCRIPTIONS.get(op, op)
    params = display_params(params)
    try:
        return template.format(**params)
    except (KeyError, IndexError, ValueError):
        return template
