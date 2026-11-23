"""JSON-RPC 2.0 endpoint over stdio (newline-delimited JSON).

Protocol
--------
* The shell writes one JSON-RPC request per line to stdin.
* The sidecar writes responses and notifications, one per line, to stdout.
* Long-running methods emit ``progress`` notifications
  ``{"method": "progress", "params": {jobId, percent, stage, message, data?}}``
  and can be cancelled with ``job.cancel`` (or ``ai.cancel``) using the jobId
  supplied in the request params.
* Library code that prints to stdout cannot corrupt the stream: file descriptor 1
  is re-pointed at stderr at start-up and the protocol writes to a private
  duplicate of the original stdout.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import multiprocessing
import os
import sys
import threading
import traceback
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import wait as wait_futures
from typing import Any, TextIO

from pydantic import ValidationError

from . import __version__
from .jobs import JobContext
from .registry import METHODS, MethodSpec
from .rpc import (
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    RpcError,
    jsonable,
)

log = logging.getLogger("mfcompute")

MAX_LINE_BYTES = 64 * 1024 * 1024


class Server:
    def __init__(self, out: TextIO) -> None:
        self._out = out
        self._write_lock = threading.Lock()
        cores = os.cpu_count() or 2
        self._interactive = ThreadPoolExecutor(max_workers=max(2, min(4, cores)), thread_name_prefix="rpc")
        self._jobs = ThreadPoolExecutor(max_workers=max(1, min(3, cores // 2)), thread_name_prefix="job")
        self._ai = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ai")
        self._active: dict[str, JobContext] = {}
        self._futures: set[Future[None]] = set()
        self._active_lock = threading.Lock()
        self.shutting_down = threading.Event()

    # -- output -------------------------------------------------------
    def send(self, message: dict[str, Any]) -> None:
        line = json.dumps(jsonable(message), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with self._write_lock:
            self._out.write(line + "\n")
            self._out.flush()

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def _respond(self, req_id: Any, result: Any) -> None:
        if req_id is not None:
            self.send({"jsonrpc": "2.0", "id": req_id, "result": result})

    def _error(self, req_id: Any, err: RpcError) -> None:
        if req_id is not None:
            self.send({"jsonrpc": "2.0", "id": req_id, "error": err.to_json()})

    # -- jobs -----------------------------------------------------------
    def cancel(self, job_id: str) -> bool:
        with self._active_lock:
            ctx = self._active.get(job_id)
        if ctx is None:
            return False
        ctx.cancel()
        return True

    def cancel_all(self) -> None:
        with self._active_lock:
            contexts = list(self._active.values())
        for ctx in contexts:
            ctx.cancel()

    # -- dispatch ---------------------------------------------------------
    def handle_line(self, raw: str) -> None:
        raw = raw.strip()
        if not raw:
            return
        if len(raw) > MAX_LINE_BYTES:
            self.send({"jsonrpc": "2.0", "id": None, "error": {"code": INVALID_REQUEST, "message": "Request too large"}})
            return
        try:
            message = json.loads(raw)
        except json.JSONDecodeError as exc:
            self.send({"jsonrpc": "2.0", "id": None, "error": {"code": PARSE_ERROR, "message": f"Parse error: {exc}"}})
            return
        if isinstance(message, list):
            for item in message:
                self._dispatch(item)
        else:
            self._dispatch(message)

    def _dispatch(self, message: Any) -> None:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            req_id = message.get("id") if isinstance(message, dict) else None
            self._error(req_id, RpcError(INVALID_REQUEST, "Invalid JSON-RPC 2.0 request"))
            return
        req_id = message.get("id")
        name: str = message["method"]
        spec = METHODS.get(name)
        if spec is None:
            self._error(req_id, RpcError(METHOD_NOT_FOUND, f"Method not found: {name}"))
            return
        raw_params = message.get("params", {})
        if raw_params is None:
            raw_params = {}
        if not isinstance(raw_params, dict):
            self._error(req_id, RpcError(INVALID_PARAMS, "params must be an object"))
            return
        try:
            params = spec.params.model_validate(raw_params) if spec.params is not None else raw_params
        except ValidationError as exc:
            details = [{"loc": ".".join(str(p) for p in e["loc"]), "msg": e["msg"]} for e in exc.errors()[:20]]
            self._error(req_id, RpcError(INVALID_PARAMS, "Invalid params", details))
            return
        job_id = raw_params.get("jobId") if isinstance(raw_params.get("jobId"), str) else None
        ctx = JobContext(job_id or f"job-{uuid.uuid4().hex[:12]}", self.notify)
        pool = {"interactive": self._interactive, "control": None, "job": self._jobs, "ai": self._ai}[spec.kind]
        if pool is None:
            self._run(spec, params, ctx, req_id)
        else:
            future = pool.submit(self._run, spec, params, ctx, req_id)
            self._futures.add(future)
            future.add_done_callback(self._futures.discard)

    def drain(self, timeout: float) -> None:
        """Wait for in-flight requests (used when stdin closes without an explicit shutdown)."""
        pending = list(self._futures)
        if pending:
            wait_futures(pending, timeout=timeout)

    def _run(self, spec: MethodSpec, params: Any, ctx: JobContext, req_id: Any) -> None:
        with self._active_lock:
            self._active[ctx.job_id] = ctx
        try:
            result = spec.handler(params, ctx)
            self._respond(req_id, jsonable(result))
        except RpcError as err:
            self._error(req_id, err)
        except Exception as exc:  # noqa: BLE001 - every failure becomes a typed RPC error
            log.error("method %s failed: %s\n%s", spec.name, exc, traceback.format_exc())
            self._error(req_id, RpcError(INTERNAL_ERROR, f"{type(exc).__name__}: {exc}", {"method": spec.name}))
        finally:
            with self._active_lock:
                self._active.pop(ctx.job_id, None)

    def shutdown(self) -> None:
        self.shutting_down.set()
        self.cancel_all()
        from .ai import llm  # local import: only shut down if loaded

        llm.shutdown_server()
        for pool in (self._interactive, self._jobs, self._ai):
            pool.shutdown(wait=False, cancel_futures=True)


SERVER: Server | None = None


def _configure_logging() -> None:
    from .paths import user_dir

    log_dir = user_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(log_dir / "compute.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    stderr = logging.StreamHandler(sys.stderr)
    stderr.setFormatter(logging.Formatter("[compute] %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    root.addHandler(stderr)


def _protocol_stream() -> TextIO:
    """Duplicate the real stdout for protocol use and redirect fd 1 to stderr."""
    sys.stdout.flush()
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1, newline="\n")


def main() -> None:
    multiprocessing.freeze_support()
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        from .workers import worker_main

        worker_main(sys.argv[2:])
        return
    out = _protocol_stream()
    _configure_logging()
    os.environ.setdefault("OMP_NUM_THREADS", str(max(1, (os.cpu_count() or 2) - 1)))

    from . import handlers  # noqa: F401 - registers all RPC methods

    global SERVER
    server = Server(out)
    SERVER = server
    server.notify("ready", {"version": __version__, "pid": os.getpid(), "methods": sorted(METHODS)})
    log.info("MoleculeForge compute %s ready (%d methods)", __version__, len(METHODS))
    try:
        for line in sys.stdin:
            server.handle_line(line)
            if server.shutting_down.is_set():
                break
        if not server.shutting_down.is_set():
            server.drain(timeout=float(os.environ.get("MF_DRAIN_SECONDS", "30")))
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        out.flush()
        os._exit(0)


if __name__ == "__main__":
    main()
