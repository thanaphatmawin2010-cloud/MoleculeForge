"""Shared fixtures: a JSON-RPC client driving the real compute sidecar over stdio.

The sidecar under test is the same program the desktop shell spawns (``python -m
mfcompute.server``, or the frozen build when MF_SIDECAR_EXE points at it), with its user data
directory redirected to a temporary folder so tests never touch real user state.
"""

from __future__ import annotations

import contextlib
import itertools
import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from queue import Empty, Queue
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent


class RpcFailure(Exception):
    def __init__(self, error: dict[str, Any]) -> None:
        super().__init__(f"{error.get('code')}: {error.get('message')}")
        self.error = error


class Sidecar:
    def __init__(self, data_dir: Path) -> None:
        exe = os.environ.get("MF_SIDECAR_EXE")
        cmd = [exe] if exe else [sys.executable, "-m", "mfcompute.server"]
        env = dict(os.environ, MF_RESOURCE_DIR=str(ROOT), MF_DATA_DIR=str(data_dir), PYTHONUNBUFFERED="1")
        # Kept open for the sidecar's whole lifetime (its stderr log); closed in close().
        self.log = (data_dir / "sidecar.log").open("w")
        self.proc = subprocess.Popen(cmd, cwd=ROOT / "compute", stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.log, text=True, env=env, bufsize=1)
        self.ids = itertools.count()
        self.responses: dict[str, Queue[dict[str, Any]]] = {}
        self.notifications: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.ready = threading.Event()
        threading.Thread(target=self._reader, daemon=True).start()
        if not self.ready.wait(60):
            raise RuntimeError("sidecar did not become ready")

    def _reader(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            msg = json.loads(line)
            if "method" in msg:
                if msg["method"] == "ready":
                    self.ready.set()
                with self.lock:
                    self.notifications.append(msg)
                continue
            with self.lock:
                queue = self.responses.setdefault(str(msg.get("id")), Queue())
            queue.put(msg)

    def send(self, method: str, params: dict[str, Any] | None = None, *, job_id: str | None = None) -> str:
        req_id = f"t{next(self.ids)}"
        payload = dict(params or {})
        if job_id:
            payload["jobId"] = job_id
        with self.lock:
            self.responses.setdefault(req_id, Queue())
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": payload}) + "\n")
        self.proc.stdin.flush()
        return req_id

    def wait(self, req_id: str, timeout: float = 600) -> dict[str, Any]:
        try:
            msg = self.responses[req_id].get(timeout=timeout)
        except Empty as exc:
            raise TimeoutError(f"no response to {req_id} within {timeout}s") from exc
        if "error" in msg:
            raise RpcFailure(msg["error"])
        return msg["result"]

    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 600, job_id: str | None = None) -> Any:
        return self.wait(self.send(method, params, job_id=job_id), timeout)

    def progress_for(self, job_id: str) -> list[dict[str, Any]]:
        with self.lock:
            return [n["params"] for n in self.notifications if n["method"] == "progress" and n["params"].get("jobId") == job_id]

    def molecule(self, smiles: str, name: str = "") -> dict[str, Any]:
        return self.call("chem.convertFormat", {"source": "smiles", "target": "molecule", "data": smiles, "name": name})["molecules"][0]

    def close(self) -> None:
        if self.proc.poll() is None:
            with contextlib.suppress(Exception):
                self.call("system.shutdown", {}, timeout=10)
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.log.close()


@pytest.fixture(scope="session")
def sidecar(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Sidecar]:
    client = Sidecar(tmp_path_factory.mktemp("sidecar-data"))
    yield client
    client.close()


@pytest.fixture
def timer() -> Any:
    class Timer:
        def __enter__(self) -> Timer:
            self.start = time.perf_counter()
            return self

        def __exit__(self, *exc: object) -> None:
            self.seconds = time.perf_counter() - self.start

    return Timer


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "slow: runs the local language model on CPU (minutes)")
