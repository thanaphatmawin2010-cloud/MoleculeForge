"""Curated local knowledge base with BM25 retrieval (data/knowledge/*.md; no network, no embeddings)."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from functools import lru_cache

from .. import paths

TOKEN = re.compile(r"[a-zA-Z][a-zA-Z0-9+-]*|\d+(?:\.\d+)?")
STOP = {"the", "a", "an", "of", "and", "or", "is", "are", "to", "in", "for", "on", "with", "as", "by", "at", "be", "it",
        "this", "that", "what", "how", "why", "which", "does", "do", "can", "i", "my", "me", "you"}


@dataclass(frozen=True)
class Passage:
    id: str
    title: str
    source: str
    text: str


def _tokens(text: str) -> list[str]:
    return [t for t in (m.group(0).lower() for m in TOKEN.finditer(text)) if t not in STOP]


@lru_cache(maxsize=1)
def passages() -> list[Passage]:
    out: list[Passage] = []
    for path in sorted((paths.data_dir() / "knowledge").glob("*.md")):
        title, source = "", ""
        body: list[str] = []
        for line in [*path.read_text(encoding="utf-8").splitlines(), "# end"]:
            if line.startswith("# "):
                if title and body:
                    out.append(Passage(f"{path.stem}#{len(out)}", title, source, " ".join(body).strip()))
                title, source, body = line[2:].strip(), "", []
            elif line.startswith("source:"):
                source = line.split(":", 1)[1].strip()
            elif line.strip():
                body.append(line.strip())
    return out


@lru_cache(maxsize=1)
def _index() -> tuple[list[list[str]], dict[str, int], float]:
    docs = [_tokens(p.title + " " + p.text) for p in passages()]
    df: dict[str, int] = {}
    for doc in docs:
        for term in set(doc):
            df[term] = df.get(term, 0) + 1
    avg = sum(len(d) for d in docs) / max(1, len(docs))
    return docs, df, avg


def search(query: str, k: int = 3, k1: float = 1.4, b: float = 0.75) -> list[Passage]:
    docs, df, avg = _index()
    terms = _tokens(query)
    n = len(docs)
    scored: list[tuple[float, Passage]] = []
    for passage, doc in zip(passages(), docs, strict=True):
        score = 0.0
        for term in terms:
            tf = doc.count(term)
            if not tf:
                continue
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len(doc) / avg))
        if score > 0:
            scored.append((score, passage))
    scored.sort(key=lambda x: -x[0])
    return [p for _, p in scored[:k]]
