"""Repair report export (spec 7.4): Markdown and PDF renderings of a ``chem.repair`` report.

Human-readable labels arrive from the UI already localised (``strings``) so the locale files
stay the single source of truth; the English defaults below are used for anything missing
(and are checked against ``ui/src/locales`` by ``ui/scripts/check-i18n.mjs``). Numbers are
rendered from the report itself, never re-computed or rounded beyond the stated digits.

The PDF embeds IBM Plex Sans Thai (Latin + Thai, SIL OFL 1.1), shapes text with HarfBuzz so
Thai vowels and tone marks stack correctly, and includes a 2D depiction whose atom numbers
match the 1-based labels used throughout the report.
"""

from __future__ import annotations

import base64
import io
import re
import time
import unicodedata
from collections.abc import Iterable
from html import escape
from typing import Any

from .. import __version__, paths

DEFAULTS: dict[str, str] = {
    "title": "Repair report",
    "molecule": "Molecule",
    "formula": "Formula",
    "status": "Status",
    "generated": "Generated",
    "finalEnergy": "Final energy",
    "rmsd": "RMSD from input",
    "duration": "Duration",
    "fixes": "Connectivity fixes",
    "noFixes": "No connectivity fixes were needed.",
    "changesBonds": "Bond length changes",
    "changesAngles": "Bond angle changes",
    "changesDihedrals": "Dihedral changes",
    "noChanges": "No changes above the reporting threshold.",
    "shown": "Showing the {shown} largest of {total} changes.",
    "addedAtoms": "Implicit hydrogens made explicit",
    "removedAtoms": "Atoms removed by valence fixes",
    "geometryCheck": "Geometry check",
    "minContact": "Closest non-bonded contact",
    "methods": "Methods",
    "remainingIssues": "Remaining issues",
    "none": "None",
    "colAtoms": "Atoms",
    "colBefore": "Before",
    "colAfter": "After",
    "colDelta": "Change",
    "colMethod": "Method",
    "colBondType": "Bond type",
    "colCount": "Count",
    "colMean": "Mean",
    "colExpected": "Expected",
    "colStatus": "Status",
    "ok": "OK",
    "check": "Check",
    "footer": "Computed offline by MoleculeForge {version}.",
}
STATUS_DEFAULTS = {"repaired": "Repaired", "already-optimal": "Already optimal", "failed": "Repair failed"}
MAX_TABLE_ROWS = 200  # per change table; the totals are always stated
MAX_LINES = 500


def _text(value: Any, limit: int = 400) -> str:
    return str(value if value is not None else "")[:limit]


def _obj(value: Any) -> dict[str, Any]:
    """A nested object from the untrusted report, or an empty one."""
    return value if isinstance(value, dict) else {}


def _labels(strings: dict[str, Any] | None) -> dict[str, str]:
    out = dict(DEFAULTS)
    for key, value in (strings or {}).items():
        if key in DEFAULTS and isinstance(value, str) and value.strip():
            out[key] = value[:400]
    return out


def _lines(strings: dict[str, Any] | None, key: str) -> list[str]:
    value = (strings or {}).get(key)
    if not isinstance(value, list):
        return []
    return [_text(v) for v in value[:MAX_LINES] if isinstance(v, str)]


def _fmt(value: Any, digits: int = 4) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "—"
    return f"{value:.{digits}f}"


def _atoms_label(change: dict[str, Any]) -> str:
    elements = change.get("elements") or []
    atoms = change.get("atoms") or []
    return "–".join(f"{_text(el, 3)}{int(a) + 1}" for el, a in zip(elements, atoms, strict=False) if isinstance(a, int))


def _slug(name: str) -> str:
    """File-name stem: letters with their combining marks (Thai vowels), and digits; other runs -> "-"."""
    kept = "".join(ch if unicodedata.category(ch)[0] in "LMN" else "-" for ch in name)
    slug = re.sub(r"-+", "-", kept).strip("-").lower()
    return slug[:60] or "molecule"


class _Model:
    """Everything both renderers need, extracted defensively from an untrusted report dict."""

    def __init__(self, report: dict[str, Any], strings: dict[str, Any] | None) -> None:
        self.label = _labels(strings)
        molecule = _obj(report.get("molecule"))
        self.molecule: dict[str, Any] = molecule
        self.name = _text(molecule.get("name") or "", 120) or "molecule"
        self.formula = _text(molecule.get("formula") or "", 120)
        status = _text(report.get("status") or "repaired", 40)
        status_text = (strings or {}).get("statusText")
        self.status = _text(status_text) if isinstance(status_text, str) and status_text else STATUS_DEFAULTS.get(status, status)
        self.reason = _text(report.get("reason") or "")
        residual = _obj(report.get("residualEnergy"))
        self.energy = (f"{_fmt(residual.get('value'), 6)} {_text(residual.get('unit'), 20)} ({_text(residual.get('method'), 120)})"
                       if isinstance(residual.get("value"), (int, float)) else "—")
        rmsd = _obj(report.get("rmsd"))
        self.rmsd = f"{_fmt(rmsd.get('value'), 4)} Å" if isinstance(rmsd.get("value"), (int, float)) else "—"
        self.duration = f"{int(report['durationMs'])} ms" if isinstance(report.get("durationMs"), (int, float)) else "—"
        self.fix_lines = _lines(strings, "fixLines") or [
            _text((f.get("fix") or {}).get("description")) for f in (report.get("fixesApplied") or [])[:MAX_LINES] if isinstance(f, dict)
        ]
        self.issue_lines = _lines(strings, "issueLines") or [
            _text(i.get("message")) for i in (report.get("finalIssues") or [])[:MAX_LINES]
            if isinstance(i, dict) and i.get("severity") in ("error", "warning")
        ]
        stage_names = (strings or {}).get("stageNames")
        self.stage_names: dict[str, str] = {k: _text(v, 80) for k, v in stage_names.items()} if isinstance(stage_names, dict) else {}
        changes = _obj(report.get("changes"))
        self.changes: list[tuple[str, list[dict[str, Any]], int]] = []
        for kind, label in (("bonds", "changesBonds"), ("angles", "changesAngles"), ("dihedrals", "changesDihedrals")):
            items = [c for c in (changes.get(kind) or []) if isinstance(c, dict)]
            total = changes.get(f"{kind}Total")
            self.changes.append((self.label[label], items[:MAX_TABLE_ROWS], int(total) if isinstance(total, int) else len(items)))
        self.added = [f"{_text(a.get('element'), 3)}{int(a['atom']) + 1}" for a in (changes.get("addedAtoms") or [])
                      if isinstance(a, dict) and isinstance(a.get("atom"), int)]
        self.removed = [str(int(a["atom"]) + 1) for a in (changes.get("removedAtoms") or [])
                        if isinstance(a, dict) and isinstance(a.get("atom"), int)]
        check = _obj(report.get("geometryCheck"))
        self.bond_rows = [r for r in (check.get("bondTable") or []) if isinstance(r, dict)][:MAX_TABLE_ROWS]
        self.angle_rows = [r for r in (check.get("angleTable") or []) if isinstance(r, dict)][:MAX_TABLE_ROWS]
        contact = _obj(check.get("minNonBondedDistance"))
        pair = contact.get("atoms") if isinstance(contact.get("atoms"), list) else None
        self.contact = (f"{_fmt(contact.get('value'), 3)} Å" + (f" ({pair[0] + 1}–{pair[1] + 1})" if pair and len(pair) == 2 else "")
                        if isinstance(contact.get("value"), (int, float)) else None)
        self.methods = [m for m in (report.get("methods") or []) if isinstance(m, dict)][:50]
        self.generated = time.strftime("%Y-%m-%d %H:%M")

    def stage(self, stage: str) -> str:
        return self.stage_names.get(stage, stage)

    def change_rows(self, items: Iterable[dict[str, Any]]) -> list[list[str]]:
        rows = []
        for c in items:
            unit = _text(c.get("unit"), 3)
            digits = 4 if unit == "Å" else 2
            delta = c.get("delta")
            sign = "+" if isinstance(delta, (int, float)) and delta > 0 else ""
            sep = "" if unit == "°" else " "
            rows.append([_atoms_label(c), f"{_fmt(c.get('old'), digits)}{sep}{unit}", f"{_fmt(c.get('new'), digits)}{sep}{unit}",
                         f"{sign}{_fmt(delta, digits)}{sep}{unit}", _text(c.get("rule"), 60)])
        return rows

    def check_rows(self) -> list[list[str]]:
        rows = []
        for r in self.bond_rows:
            ref = _obj(r.get("reference"))
            rows.append([_text(r.get("type"), 60), str(r.get("count", "")), f"{_fmt(r.get('mean'), 4)} Å",
                         f"{_fmt(ref.get('low'), 2)}–{_fmt(ref.get('high'), 2)} Å",
                         self.label["ok"] if r.get("withinTenPercent") else self.label["check"]])
        for r in self.angle_rows:
            ideal = r.get("ideal")
            rows.append([f"∠ {_text(r.get('class'), 40)}", str(r.get("count", "")), f"{_fmt(r.get('mean'), 2)}°",
                         f"{_fmt(ideal, 2)}°" if isinstance(ideal, (int, float)) else "—",
                         self.label["ok"] if r.get("withinTenPercent") else self.label["check"]])
        return rows

    def footer(self) -> str:
        return self.label["footer"].replace("{version}", __version__)


def _md_escape(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def to_markdown(model: _Model) -> str:
    L = model.label
    out = [f"# {L['title']}: {_md_escape(model.name)}", ""]
    out += ["| | |", "|---|---|"]
    for key, value in (("molecule", model.name), ("formula", model.formula or "—"), ("status", model.status),
                       ("finalEnergy", model.energy), ("rmsd", model.rmsd), ("duration", model.duration),
                       ("generated", model.generated)):
        out.append(f"| {_md_escape(L[key])} | {_md_escape(value)} |")
    if model.reason:
        out += ["", f"> {_md_escape(model.reason)}"]
    out += ["", f"## {L['fixes']}", ""]
    out += [f"- {_md_escape(line)}" for line in model.fix_lines] or [L["noFixes"]]
    for title, items, total in model.changes:
        out += ["", f"## {title} ({total})", ""]
        if not items:
            out.append(L["noChanges"])
            continue
        if total > len(items):
            out += [L["shown"].replace("{shown}", str(len(items))).replace("{total}", str(total)), ""]
        out += [f"| {L['colAtoms']} | {L['colBefore']} | {L['colAfter']} | {L['colDelta']} | {L['colMethod']} |",
                "|---|---:|---:|---:|---|"]
        out += ["| " + " | ".join(_md_escape(cell) for cell in row) + " |" for row in model.change_rows(items)]
    if model.added:
        out += ["", f"## {L['addedAtoms']}", "", ", ".join(model.added)]
    if model.removed:
        out += ["", f"## {L['removedAtoms']}", "", ", ".join(model.removed)]
    rows = model.check_rows()
    if rows or model.contact:
        out += ["", f"## {L['geometryCheck']}", ""]
        if rows:
            out += [f"| {L['colBondType']} | {L['colCount']} | {L['colMean']} | {L['colExpected']} | {L['colStatus']} |",
                    "|---|---:|---:|---:|---|"]
            out += ["| " + " | ".join(_md_escape(cell) for cell in row) + " |" for row in rows]
        if model.contact:
            out += ["", f"{L['minContact']}: {model.contact}"]
    if model.methods:
        out += ["", f"## {L['methods']}", ""]
        for i, m in enumerate(model.methods, 1):
            details = _text(m.get("details"))
            out.append(f"{i}. **{_md_escape(model.stage(_text(m.get('stage'), 40)))}** — {_md_escape(_text(m.get('method')))}"
                       + (f" ({_md_escape(details)})" if details else ""))
    out += ["", f"## {L['remainingIssues']}", ""]
    out += [f"- {_md_escape(line)}" for line in model.issue_lines] or [L["none"]]
    out += ["", "---", "", model.footer(), ""]
    return "\n".join(out)


def _depiction_png(molecule: dict[str, Any], width: int = 520, height: int = 300) -> bytes | None:
    """2D depiction with 1-based atom numbers, or None when the structure cannot be drawn."""
    try:
        from rdkit import Chem
        from rdkit.Chem.Draw import rdMolDraw2D

        from ..models import Molecule
        from . import convert, depict

        rd = convert.to_rdkit(Molecule.model_validate(molecule), sanitize=False)
        rd.UpdatePropertyCache(strict=False)
        layout = depict.layout_2d(rd)
        mol = Chem.Mol(rd)
        mol.RemoveAllConformers()
        conf = Chem.Conformer(mol.GetNumAtoms())
        for i, (x, y) in enumerate(layout):
            conf.SetAtomPosition(i, (x, y, 0.0))
        conf.Set3D(False)
        mol.AddConformer(conf, assignId=True)
        for atom in mol.GetAtoms():
            atom.SetProp("atomNote", str(atom.GetIdx() + 1))
        drawer = rdMolDraw2D.MolDraw2DCairo(width, height)
        opts = drawer.drawOptions()
        opts.annotationFontScale = 0.6
        opts.clearBackground = True
        drawer.DrawMolecule(mol)
        drawer.FinishDrawing()
        return bytes(drawer.GetDrawingText())
    except Exception:
        return None


_FONTS_READY = False


def _register_fonts() -> tuple[str, str]:
    global _FONTS_READY
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    regular, bold = "PlexSansThai", "PlexSansThai-SemiBold"
    if not _FONTS_READY:
        font_dir = paths.data_dir() / "fonts"
        pdfmetrics.registerFont(TTFont(regular, str(font_dir / "IBMPlexSansThai-Regular.ttf")))
        pdfmetrics.registerFont(TTFont(bold, str(font_dir / "IBMPlexSansThai-SemiBold.ttf")))
        pdfmetrics.registerFontFamily(regular, normal=regular, bold=bold, italic=regular, boldItalic=bold)
        _FONTS_READY = True
    return regular, bold


def to_pdf(model: _Model) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Image,
        KeepTogether,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    regular, bold = _register_fonts()
    ink, muted, line, accent = colors.HexColor("#1B1F24"), colors.HexColor("#5B636E"), colors.HexColor("#D9DDE3"), colors.HexColor("#C2410C")
    base = ParagraphStyle("base", fontName=regular, fontSize=9.5, leading=14, textColor=ink, shaping=1)
    small = ParagraphStyle("small", parent=base, fontSize=8, leading=11, textColor=muted)
    cell = ParagraphStyle("cell", parent=base, fontSize=8, leading=10.5)
    cell_r = ParagraphStyle("cellR", parent=cell, alignment=TA_RIGHT)
    head = ParagraphStyle("head", parent=cell, fontName=bold, textColor=muted)
    head_r = ParagraphStyle("headR", parent=head, alignment=TA_RIGHT)
    h1 = ParagraphStyle("h1", parent=base, fontName=bold, fontSize=17, leading=22, spaceAfter=2)
    h2 = ParagraphStyle("h2", parent=base, fontName=bold, fontSize=11.5, leading=15, spaceBefore=10, spaceAfter=4, textColor=accent)
    def p(text: str, style: Any = base) -> Any:
        return Paragraph(escape(text), style)

    L = model.label

    def table(header: list[str], rows: list[list[str]], widths: list[float], right: set[int]) -> Table:
        data = [[p(h, head_r if i in right else head) for i, h in enumerate(header)]]
        data += [[p(c, cell_r if i in right else cell) for i, c in enumerate(row)] for row in rows]
        t = Table(data, colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, ink),
            ("LINEBELOW", (0, 1), (-1, -1), 0.3, line),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ]))
        return t

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title=f"{L['title']}: {model.name}", author="MoleculeForge", subject=L["title"], creator=f"MoleculeForge {__version__}")
    width = A4[0] - 36 * mm
    story: list[Any] = [p(f"{L['title']}: {model.name}", h1), p(f"{L['generated']} {model.generated}", small), Spacer(1, 6)]
    formula = re.sub(r"(\d+)", r"<sub>\1</sub>", escape(model.formula)) if model.formula else "—"
    summary = [[p(L["formula"], head), Paragraph(formula, base)]]
    summary += [[p(L[k], head), p(v)] for k, v in (("status", model.status), ("finalEnergy", model.energy), ("rmsd", model.rmsd),
                                                   ("duration", model.duration))]
    summary_table = Table(summary, colWidths=[38 * mm, width - 38 * mm - 62 * mm])
    summary_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.3, line)]))
    png = _depiction_png(model.molecule)
    if png:
        picture = Image(io.BytesIO(png), width=62 * mm, height=62 * mm * 300 / 520)
        top = Table([[summary_table, picture]], colWidths=[width - 62 * mm, 62 * mm])
        top.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
        story.append(top)
    else:
        story.append(summary_table)
    if model.reason:
        story += [Spacer(1, 4), p(model.reason)]
    story.append(p(L["fixes"], h2))
    story += [p(f"• {line}") for line in model.fix_lines] or [p(L["noFixes"], small)]
    for title, items, total in model.changes:
        block: list[Any] = [p(f"{title} ({total})", h2)]
        if not items:
            block.append(p(L["noChanges"], small))
        else:
            if total > len(items):
                block.append(p(L["shown"].replace("{shown}", str(len(items))).replace("{total}", str(total)), small))
            block.append(table([L["colAtoms"], L["colBefore"], L["colAfter"], L["colDelta"], L["colMethod"]], model.change_rows(items),
                               [0.26 * width, 0.17 * width, 0.17 * width, 0.17 * width, 0.23 * width], {1, 2, 3}))
        if len(items) <= 25:
            story.append(KeepTogether(block))  # keep a short table with its heading
        else:
            story += block
    if model.added:
        story += [p(L["addedAtoms"], h2), p(", ".join(model.added))]
    if model.removed:
        story += [p(L["removedAtoms"], h2), p(", ".join(model.removed))]
    rows = model.check_rows()
    if rows or model.contact:
        story.append(p(L["geometryCheck"], h2))
        if rows:
            story.append(table([L["colBondType"], L["colCount"], L["colMean"], L["colExpected"], L["colStatus"]], rows,
                               [0.34 * width, 0.1 * width, 0.18 * width, 0.22 * width, 0.16 * width], {1, 2, 3}))
        if model.contact:
            story += [Spacer(1, 4), p(f"{L['minContact']}: {model.contact}")]
    if model.methods:
        story.append(p(L["methods"], h2))
        for i, m in enumerate(model.methods, 1):
            details = _text(m.get("details"))
            text = f"{i}. {model.stage(_text(m.get('stage'), 40))} — {_text(m.get('method'))}" + (f" ({details})" if details else "")
            story.append(p(text))
    story.append(p(L["remainingIssues"], h2))
    story += [p(f"• {line}") for line in model.issue_lines] or [p(L["none"], small)]
    story += [Spacer(1, 10), p(model.footer(), small)]
    doc.build(story)
    return buf.getvalue()


def export(report: dict[str, Any], fmt: str, locale: str = "en", strings: dict[str, Any] | None = None) -> dict[str, Any]:
    model = _Model(report, strings)
    stem = f"{_slug(model.name)}-repair-report"
    if fmt == "markdown":
        return {"format": "markdown", "data": to_markdown(model), "encoding": "utf-8", "filename": f"{stem}.md", "locale": locale}
    pdf = to_pdf(model)
    return {"format": "pdf", "data": base64.b64encode(pdf).decode("ascii"), "encoding": "base64", "filename": f"{stem}.pdf",
            "locale": locale, "bytes": len(pdf)}
