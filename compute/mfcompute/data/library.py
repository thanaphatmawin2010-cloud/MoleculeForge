"""Persistent molecule library (SQLite + FTS5): bundled prebuilt molecules and user molecules."""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from .. import paths
from ..chem import convert
from ..jobs import JobContext
from ..models import LibraryExportParams, LibraryImportParams, LibraryListParams, LibrarySaveParams, Molecule
from ..rpc import CONFLICT, NOT_FOUND, RpcError
from .categorize import CATEGORIES, CATEGORY_IDS, categorize

SCHEMA = """
CREATE TABLE IF NOT EXISTS molecules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    formula TEXT NOT NULL,
    inchikey TEXT,
    smiles TEXT,
    category TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('prebuilt', 'user')),
    created TEXT NOT NULL,
    updated REAL NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    molecule TEXT NOT NULL,
    layout2d TEXT,
    descriptors TEXT,
    wedges TEXT
);
CREATE INDEX IF NOT EXISTS idx_molecules_inchikey ON molecules(inchikey);
CREATE INDEX IF NOT EXISTS idx_molecules_category ON molecules(category);
CREATE VIRTUAL TABLE IF NOT EXISTS molecules_fts USING fts5(id UNINDEXED, name, formula, smiles, tags, category, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def _valid_layout(layout: Any, n_atoms: int) -> bool:
    """A 2D layout is kept only if it has one finite (x, y) pair per atom; otherwise the UI lays it out."""
    return (isinstance(layout, list) and len(layout) == n_atoms and all(
        isinstance(p, list) and len(p) == 2 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in p) for p in layout))


class LibraryStore:
    def __init__(self, db_path: Path, bundle_path: Path) -> None:
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(molecules)")}
        if "wedges" not in columns:  # databases created before stereo wedges were stored
            with contextlib.suppress(sqlite3.OperationalError):  # another app instance migrated first
                self._conn.execute("ALTER TABLE molecules ADD COLUMN wedges TEXT")
            self._conn.execute("DELETE FROM meta WHERE key='prebuiltVersion'")
        self._bundle_path = bundle_path
        self._sync_prebuilt()

    # -- prebuilt molecules ----------------------------------------------------------------
    def _sync_prebuilt(self) -> None:
        if not self._bundle_path.exists():
            return
        raw = self._bundle_path.read_bytes()
        bundle = json.loads(raw.decode("utf-8"))
        # Keyed on the content hash, not just the version label, so any corrected bundle shipped
        # with an update replaces the stored prebuilt set (favourites are kept).
        version = f"{bundle.get('version')}+{hashlib.sha256(raw).hexdigest()[:16]}"
        row = self._conn.execute("SELECT value FROM meta WHERE key='prebuiltVersion'").fetchone()
        if row and row["value"] == version:
            return
        with self._lock, self._conn:
            favourites = {r["id"] for r in self._conn.execute("SELECT id FROM molecules WHERE source='prebuilt' AND favorite=1")}
            self._conn.execute("DELETE FROM molecules_fts WHERE id IN (SELECT id FROM molecules WHERE source='prebuilt')")
            self._conn.execute("DELETE FROM molecules WHERE source='prebuilt'")
            for entry in bundle["molecules"]:
                mol = entry["molecule"]
                self._insert(mol, layout=entry.get("layout2d"), tags=entry.get("tags", []), descriptors=entry.get("descriptors"),
                             favorite=mol["id"] in favourites, wedges=entry.get("wedges"))
            self._conn.execute("INSERT OR REPLACE INTO meta VALUES ('prebuiltVersion', ?)", (version,))

    def _insert(self, mol: dict[str, Any], *, layout: Any, tags: list[str], descriptors: Any, favorite: bool,
                wedges: Any = None) -> None:
        meta = mol.get("meta", {})
        layout = layout if _valid_layout(layout, len(mol.get("atoms", []))) else None
        wedges = wedges if layout is not None and isinstance(wedges, list) else None
        self._conn.execute(
            "INSERT OR REPLACE INTO molecules (id, name, formula, inchikey, smiles, category, source, created, updated, favorite,"
            " tags, molecule, layout2d, descriptors, wedges) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (mol["id"], mol.get("name", ""), mol.get("formula", ""), meta.get("inchikey"), meta.get("smiles"),
             meta.get("category") or "other", meta.get("source", "user"), meta.get("created", ""), time.time(),
             int(favorite), json.dumps(tags), json.dumps(mol), json.dumps(layout) if layout else None,
             json.dumps(descriptors) if descriptors else None, json.dumps(wedges) if wedges else None),
        )
        self._conn.execute("DELETE FROM molecules_fts WHERE id = ?", (mol["id"],))
        self._conn.execute("INSERT INTO molecules_fts VALUES (?,?,?,?,?,?)",
                           (mol["id"], mol.get("name", ""), mol.get("formula", ""), meta.get("smiles", ""), " ".join(tags),
                            meta.get("category", "")))

    # -- queries -------------------------------------------------------------------------------
    @staticmethod
    def _summary(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "name": row["name"], "formula": row["formula"], "inchikey": row["inchikey"],
                "smiles": row["smiles"], "category": row["category"], "source": row["source"], "favorite": bool(row["favorite"]),
                "tags": json.loads(row["tags"]), "created": row["created"],
                "descriptors": json.loads(row["descriptors"]) if row["descriptors"] else None}

    def list(self, params: LibraryListParams) -> dict[str, Any]:
        clauses, args = [], []
        if params.query.strip():
            terms = " ".join(f'"{t.replace(chr(34), "")}"*' for t in params.query.split())
            clauses.append("m.id IN (SELECT id FROM molecules_fts WHERE molecules_fts MATCH ?)")
            args.append(terms)
        if params.category:
            clauses.append("m.category = ?")
            args.append(params.category)
        if params.source != "all":
            clauses.append("m.source = ?")
            args.append(params.source)
        if params.favoritesOnly:
            clauses.append("m.favorite = 1")
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._lock:
            total = self._conn.execute(f"SELECT COUNT(*) FROM molecules m {where}", args).fetchone()[0]
            rows = self._conn.execute(
                f"SELECT * FROM molecules m {where} ORDER BY m.source DESC, m.name COLLATE NOCASE LIMIT ? OFFSET ?",
                [*args, params.limit, params.offset]).fetchall()
        return {"total": total, "items": [self._summary(r) for r in rows]}

    def load(self, mol_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM molecules WHERE id = ?", (mol_id,)).fetchone()
        if row is None:
            raise RpcError(NOT_FOUND, "Molecule not found", {"id": mol_id})
        return {**self._summary(row), "molecule": json.loads(row["molecule"]),
                "layout2d": json.loads(row["layout2d"]) if row["layout2d"] else None,
                "wedges": json.loads(row["wedges"]) if row["wedges"] else []}

    def categories(self) -> dict[str, Any]:
        with self._lock:
            counts = dict(self._conn.execute("SELECT category, COUNT(*) FROM molecules GROUP BY category").fetchall())
        return {"categories": [{"id": c.id, "row": c.row, "col": c.col, "family": c.family, "count": counts.get(c.id, 0)}
                               for c in CATEGORIES]}

    # -- mutations -----------------------------------------------------------------------------
    def save(self, params: LibrarySaveParams) -> dict[str, Any]:
        molecule = params.molecule
        rd = convert.to_rdkit(molecule)
        annotated = convert.annotate(molecule, rd)
        category = annotated.meta.category if annotated.meta.category in CATEGORY_IDS and annotated.meta.category != "other" else categorize(rd)
        mol_id = annotated.id if annotated.id.startswith("user-") else f"user-{annotated.meta.inchikey[:14] or annotated.id}-{int(time.time())}"
        with self._lock:
            existing = self._conn.execute("SELECT id, name, source FROM molecules WHERE id = ?", (annotated.id,)).fetchone()
            duplicate = None
            if annotated.meta.inchikey:
                duplicate = self._conn.execute("SELECT id, name, source FROM molecules WHERE inchikey = ? AND id != ?",
                                               (annotated.meta.inchikey, annotated.id)).fetchone()
        if existing is not None and existing["source"] == "prebuilt":
            existing = None  # editing a prebuilt molecule saves a user copy
        if duplicate is not None and not params.overwrite:
            return {"saved": False, "duplicateOf": {"id": duplicate["id"], "name": duplicate["name"], "source": duplicate["source"]},
                    "inchikey": annotated.meta.inchikey}
        if existing is not None:
            mol_id = existing["id"]
        meta = annotated.meta.model_copy(update={"category": category, "source": "user"})
        final = annotated.model_copy(update={"id": mol_id, "meta": meta})
        from ..chem import descriptors as desc

        summary = {k: v["value"] for k, v in desc.compute_rdkit(rd).items()
                   if k in ("molecularWeight", "logP", "tpsa", "hBondDonors", "hBondAcceptors", "qed")}
        with self._lock, self._conn:
            self._insert(final.model_dump(mode="json"), layout=params.layout2d, tags=params.tags, descriptors=summary,
                         favorite=params.favorite, wedges=params.wedges)
        return {"saved": True, "id": mol_id, "category": category, "molecule": final}

    def delete(self, mol_id: str) -> dict[str, Any]:
        with self._lock, self._conn:
            row = self._conn.execute("SELECT source FROM molecules WHERE id = ?", (mol_id,)).fetchone()
            if row is None:
                raise RpcError(NOT_FOUND, "Molecule not found", {"id": mol_id})
            if row["source"] == "prebuilt":
                raise RpcError(CONFLICT, "Prebuilt molecules are read-only", {"id": mol_id})
            self._conn.execute("DELETE FROM molecules WHERE id = ?", (mol_id,))
            self._conn.execute("DELETE FROM molecules_fts WHERE id = ?", (mol_id,))
        return {"deleted": True, "id": mol_id}

    def favorite(self, mol_id: str, favorite: bool) -> dict[str, Any]:
        with self._lock, self._conn:
            cur = self._conn.execute("UPDATE molecules SET favorite = ? WHERE id = ?", (int(favorite), mol_id))
            if cur.rowcount == 0:
                raise RpcError(NOT_FOUND, "Molecule not found", {"id": mol_id})
        return {"id": mol_id, "favorite": favorite}

    def import_data(self, params: LibraryImportParams, ctx: JobContext) -> dict[str, Any]:
        if params.format == "json":
            payload = json.loads(params.data)
            items = payload["molecules"] if isinstance(payload, dict) and "molecules" in payload else payload
            molecules = [Molecule.model_validate(item.get("molecule", item)) for item in items]
        else:
            molecules = convert.parse("sdf", params.data, embed3d=True)
        saved, duplicates = [], []
        for idx, molecule in enumerate(molecules):
            ctx.check()
            ctx.progress(100 * idx / max(1, len(molecules)), "import", molecule.name or molecule.id)
            fresh = molecule.model_copy(update={"id": f"user-import-{idx}-{int(time.time() * 1000)}"})
            layout, stereo = None, []
            try:  # imported files carry real stereo (3D, or 2D wedges kept through embedding)
                from ..chem import depict

                rd = convert.to_rdkit(fresh)
                layout = depict.layout_2d(rd)
                stereo = depict.wedges(rd, layout)
            except RpcError:
                pass
            result = self.save(LibrarySaveParams(molecule=fresh, layout2d=layout, wedges=stereo))
            (saved if result["saved"] else duplicates).append(result.get("id") or result.get("duplicateOf"))
        return {"imported": len(saved), "duplicates": duplicates, "ids": saved}

    def export_data(self, params: LibraryExportParams) -> dict[str, Any]:
        with self._lock:
            if params.ids:
                marks = ",".join("?" * len(params.ids))
                rows = self._conn.execute(f"SELECT * FROM molecules WHERE id IN ({marks})", params.ids).fetchall()
            else:
                rows = self._conn.execute("SELECT * FROM molecules WHERE source='user'").fetchall()
        molecules = [Molecule.model_validate(json.loads(r["molecule"])) for r in rows]
        if params.format == "json":
            data = json.dumps({"format": "moleculeforge.library/1",
                               "molecules": [{"molecule": m.model_dump(mode="json"), "layout2d": json.loads(r["layout2d"]) if r["layout2d"] else None,
                                              "tags": json.loads(r["tags"])} for m, r in zip(molecules, rows, strict=True)]},
                              ensure_ascii=False, indent=1)
        else:
            data = convert.write("sdf", molecules) if molecules else ""
        return {"format": params.format, "count": len(molecules), "data": data}


_STORE: LibraryStore | None = None
_STORE_LOCK = threading.Lock()


def STORE() -> LibraryStore:
    """The process-wide store. Created under a lock: requests arrive on several worker threads and
    the first construction migrates and seeds the database, which must happen exactly once."""
    global _STORE
    if _STORE is None:
        with _STORE_LOCK:
            if _STORE is None:
                _STORE = LibraryStore(paths.user_dir() / "library.sqlite", paths.data_dir() / "molecules" / "library.json")
    return _STORE
