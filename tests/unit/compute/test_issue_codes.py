"""§9.1 validation reason codes: every code is reachable, localised, and uses 1-based atom numbers."""

from __future__ import annotations

import json
from pathlib import Path

from mfcompute.chem import issues, validate
from mfcompute.models import Atom, Bond, Molecule

ROOT = Path(__file__).resolve().parents[3]


def _mol(atoms: list[tuple[str, float, float, float]], bonds: list[tuple[int, int, str]], charges: dict[int, int] | None = None) -> Molecule:
    charges = charges or {}
    return Molecule(id="t", atoms=[Atom(i=i, el=el, x=x, y=y, z=z, charge=charges.get(i, 0)) for i, (el, x, y, z) in enumerate(atoms)],
                    bonds=[Bond(a=a, b=b, order=o) for a, b, o in bonds])


def _codes(m: Molecule) -> set[str]:
    found, _ = validate.detect(m)
    return {i.code for i in found}


def test_every_code_has_english_and_thai_text() -> None:
    languages = sorted(p.name for p in (ROOT / "ui" / "src" / "locales").iterdir() if (p / "issues.json").exists())
    assert {"en", "th"} <= set(languages)
    for lang in languages:
        locale = json.loads((ROOT / "ui" / "src" / "locales" / lang / "issues.json").read_text(encoding="utf-8"))
        assert set(issues.CODES) <= set(locale["code"]), lang
        assert set(issues.FIX_DESCRIPTIONS) <= set(locale["fix"]), lang


def test_valence_exceeded_and_self_bond_and_duplicates() -> None:
    five = _mol([("C", 0, 0, 0)] + [("H", x, y, z) for x, y, z in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1)]],
                [(0, i, "single") for i in range(1, 6)])
    assert "VALENCE_EXCEEDED" in _codes(five)
    assert "SELF_BOND" in _codes(_mol([("C", 0, 0, 0)], [(0, 0, "single")]))
    assert "DUPLICATE_BOND" in _codes(_mol([("C", 0, 0, 0), ("O", 1.4, 0, 0)], [(0, 1, "single"), (1, 0, "single")]))


def test_geometry_codes() -> None:
    assert "ATOMS_OVERLAP" in _codes(_mol([("C", 0, 0, 0), ("O", 0.01, 0, 0)], []))
    assert "BOND_TOO_LONG" in _codes(_mol([("C", 0, 0, 0), ("C", 3.0, 0, 0)], [(0, 1, "single")]))


def test_messages_use_one_based_atom_numbers() -> None:
    five = _mol([("C", 0, 0, 0)] + [("H", x, y, z) for x, y, z in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1)]],
                [(0, i, "single") for i in range(1, 6)])
    found, _ = validate.detect(five)
    issue = next(i for i in found if i.code == "VALENCE_EXCEEDED")
    assert issue.params["atom"] == 1 and "atom 1 " in issue.message
    assert issue.atoms == [0], "machine-readable atom indices stay 0-based"


def test_valid_structure_reports_bond_connected_correctly() -> None:
    water = _mol([("O", 0, 0, 0), ("H", 0.96, 0, 0), ("H", -0.24, 0.93, 0)], [(0, 1, "single"), (0, 2, "single")])
    result = validate.validate(water, [0, 1], [0], True)
    assert result["status"] == "valid"
    assert result["message"] == "Bond connected correctly."


def test_auto_fix_reports_bond_connection_fixed_successfully() -> None:
    five = _mol([("C", 0, 0, 0)] + [("H", x, y, z) for x, y, z in [(1.09, 0, 0), (-1.09, 0, 0), (0, 1.09, 0), (0, -1.09, 0), (0, 0, 1.09)]],
                [(0, i, "single") for i in range(1, 6)])
    result = validate.validate(five, [0, 5], [4], True)
    assert result["status"] == "fixed"
    assert result["message"] == "Bond connection fixed successfully."
    fix = result["fixes"][0]
    assert {"before", "reason", "fix", "after"} <= set(fix), "§7.3: every fix logs {before, reason, fix, after}"
    assert fix["before"] != fix["after"]
    assert fix["fix"]["params"], "fixes carry display parameters for localisation"
    assert fix["reason"] == "VALENCE_EXCEEDED" and fix["reasonParams"]["atom"] == 1


def test_every_simulation_warning_is_localised_with_the_same_parameters() -> None:
    """Simulation warnings reach the UI as codes; each needs text in every locale using its parameters."""
    import re

    from mfcompute.sim import notes

    placeholder = re.compile(r"{(\w+)}")
    languages = sorted(p.name for p in (ROOT / "ui" / "src" / "locales").iterdir() if (p / "common.json").exists())
    assert {"en", "th"} <= set(languages)
    for lang in languages:
        locale = json.loads((ROOT / "ui" / "src" / "locales" / lang / "common.json").read_text(encoding="utf-8"))["simWarning"]
        assert set(notes.TEXT) == set(locale), lang
        for code, english in notes.TEXT.items():
            wanted = set(placeholder.findall(english))
            used = set(re.findall(r"{(\w+)[,}]", locale[code]))
            assert wanted <= used, (lang, code, wanted - used)


def test_warning_text_and_codes_stay_aligned() -> None:
    from mfcompute.sim.notes import Notes

    collected = Notes()
    collected.add("hessianSizeLimit", atoms=40, level="fast", limit=30)
    collected.add("dftUnavailable")
    result = collected.as_result()
    assert result["warnings"] == ["Vibrational analysis skipped: 40 atoms exceed the fast limit of 30.",
                                  "DFT skipped: PySCF is not available on this platform; tight-binding values are reported."]
    assert [c["code"] for c in result["warningCodes"]] == ["hessianSizeLimit", "dftUnavailable"]
    assert result["warningCodes"][0]["params"] == {"atoms": 40, "level": "fast", "limit": 30}
