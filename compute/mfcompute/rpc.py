"""JSON-RPC 2.0 primitives shared by the sidecar dispatcher and its handlers."""

from __future__ import annotations

import math
from typing import Any

# Standard JSON-RPC 2.0 error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# Application error codes (reserved server range -32000..-32099).
JOB_CANCELLED = -32000
ENGINE_UNAVAILABLE = -32001
CHEMISTRY_ERROR = -32002
TIMEOUT = -32003
TOO_LARGE = -32004
NOT_FOUND = -32005
CONFLICT = -32006


class RpcError(Exception):
    """An error that is reported to the caller as a JSON-RPC error object."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            payload["data"] = jsonable(self.data)
        return payload


class Cancelled(RpcError):
    def __init__(self, job_id: str) -> None:
        super().__init__(JOB_CANCELLED, "Job cancelled", {"jobId": job_id})


def jsonable(value: Any) -> Any:
    """Convert numpy scalars/arrays, tuples and non-finite floats into strict JSON values."""
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return jsonable(model_dump(mode="json", by_alias=True, exclude_none=False))
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        return jsonable(tolist())
    item = getattr(value, "item", None)
    if callable(item):
        return jsonable(item())
    return str(value)
