"""Job contexts: progress streaming, cooperative cancellation and child-process control."""

from __future__ import annotations

import contextlib
import subprocess
import threading
import time
from collections.abc import Callable
from typing import Any

from .rpc import Cancelled

Emitter = Callable[[str, dict[str, Any]], None]


class JobContext:
    """Handed to every handler. Interactive calls get a context too (never cancelled)."""

    def __init__(self, job_id: str, emit: Emitter | None = None) -> None:
        self.job_id = job_id
        self._emit = emit
        self._cancel = threading.Event()
        self._children: list[subprocess.Popen[Any]] = []
        self._lock = threading.Lock()
        self._last_emit = 0.0
        self.started = time.perf_counter()

    def derive(self, emit: Emitter | None) -> JobContext:
        """A context with a different emitter that shares this job's id and cancellation flag."""
        child = JobContext(self.job_id, emit)
        child._cancel = self._cancel
        return child

    # -- cancellation -------------------------------------------------
    def cancel(self) -> None:
        self._cancel.set()
        with self._lock:
            children = list(self._children)
        for child in children:
            terminate_process(child)

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check(self) -> None:
        """Raise :class:`Cancelled` if a cancel was requested."""
        if self._cancel.is_set():
            raise Cancelled(self.job_id)

    # -- child processes ----------------------------------------------
    def adopt(self, proc: subprocess.Popen[Any]) -> None:
        with self._lock:
            self._children.append(proc)
        if self._cancel.is_set():
            terminate_process(proc)

    def release(self, proc: subprocess.Popen[Any]) -> None:
        with self._lock:
            if proc in self._children:
                self._children.remove(proc)

    # -- progress -----------------------------------------------------
    def progress(
        self,
        percent: float,
        stage: str,
        message: str = "",
        data: dict[str, Any] | None = None,
        *,
        force: bool = False,
    ) -> None:
        """Emit a progress notification (rate limited to ~30 Hz unless forced)."""
        if self._emit is None:
            return
        now = time.perf_counter()
        if not force and now - self._last_emit < 1 / 30 and percent < 100:
            return
        self._last_emit = now
        params: dict[str, Any] = {
            "jobId": self.job_id,
            "percent": round(max(0.0, min(100.0, percent)), 2),
            "stage": stage,
            "message": message,
        }
        if data is not None:
            params["data"] = data
        self._emit("progress", params)

    def notify(self, method: str, params: dict[str, Any]) -> None:
        if self._emit is not None:
            self._emit(method, {"jobId": self.job_id, **params})

    @property
    def elapsed_ms(self) -> int:
        return int((time.perf_counter() - self.started) * 1000)


def terminate_process(proc: subprocess.Popen[Any]) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=3)
    except Exception:  # escalate to kill on any failure
        with contextlib.suppress(Exception):
            proc.kill()


def run_process(
    ctx: JobContext,
    args: list[str],
    *,
    cwd: str,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
    on_line: Callable[[str], None] | None = None,
) -> tuple[int, str]:
    """Run an engine subprocess under job control, streaming stdout lines to ``on_line``."""
    ctx.check()
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(
        args,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
    )
    ctx.adopt(proc)
    deadline = None if timeout is None else time.monotonic() + timeout
    lines: list[str] = []
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.append(line)
            if on_line is not None:
                on_line(line)
            if deadline is not None and time.monotonic() > deadline:
                terminate_process(proc)
                break
        proc.wait()
    finally:
        ctx.release(proc)
    ctx.check()
    return proc.returncode, "".join(lines)
