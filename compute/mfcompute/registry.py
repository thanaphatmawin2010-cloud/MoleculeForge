"""Method registry: maps JSON-RPC method names to typed handlers."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel

from .jobs import JobContext

Kind = Literal["interactive", "job", "ai", "control"]
Handler = Callable[[Any, JobContext], Any]


@dataclass(frozen=True)
class MethodSpec:
    name: str
    params: type[BaseModel] | None
    handler: Handler
    kind: Kind
    summary: str


METHODS: dict[str, MethodSpec] = {}


def method(
    name: str,
    params: type[BaseModel] | None = None,
    *,
    kind: Kind = "interactive",
    summary: str = "",
) -> Callable[[Handler], Handler]:
    """Register ``handler`` under ``name``. ``params`` validates the request's params object."""

    def decorate(handler: Handler) -> Handler:
        if name in METHODS:
            raise RuntimeError(f"duplicate RPC method {name}")
        METHODS[name] = MethodSpec(name, params, handler, kind, summary or (handler.__doc__ or "").strip())
        return handler

    return decorate
