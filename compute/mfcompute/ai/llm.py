"""Local LLM runtime: a bundled llama.cpp ``llama-server`` bound to 127.0.0.1.

* Started lazily on the first assistant request; stopped with the sidecar.
* Listens on a random loopback port and requires a per-session random API key.
* ``--offline`` and ``--no-webui`` ensure no network access and no exposed UI.
* GPU offload is enabled automatically when llama.cpp reports a GPU device.
"""

from __future__ import annotations

import http.client
import json
import secrets
import socket
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from .. import capabilities, paths
from ..jobs import JobContext, terminate_process
from ..models import AiConfigParams
from ..rpc import ENGINE_UNAVAILABLE, RpcError

_LOCK = threading.Lock()


class _Runtime:
    def __init__(self) -> None:
        self.proc: subprocess.Popen[bytes] | None = None
        self.port = 0
        self.token = ""
        self.model_path: Path | None = None
        self.context_size = 8192
        self.gpu_layers: int | None = None
        self.started_at = 0.0
        self.log_path: Path | None = None


RUNTIME = _Runtime()


def default_model() -> Path | None:
    info = capabilities.model_info()
    path = info.get("path")
    return Path(path) if path and info.get("available") else None


def status() -> dict[str, Any]:
    model = RUNTIME.model_path or default_model()
    running = RUNTIME.proc is not None and RUNTIME.proc.poll() is None
    devices = capabilities.llama_devices()
    return {
        "available": model is not None and model.exists() and paths.executable("llama", "llama-server") is not None,
        "running": running,
        "model": {"path": str(model) if model else None, "name": model.stem if model else None,
                  "sizeBytes": model.stat().st_size if model and model.exists() else None},
        "contextSize": RUNTIME.context_size,
        "accelerator": devices[0] if devices else "CPU",
        "offloadLayers": _gpu_layers(),
    }


def configure(params: AiConfigParams) -> dict[str, Any]:
    with _LOCK:
        if params.modelPath:
            candidate = Path(params.modelPath).expanduser().resolve()
            if not candidate.is_file() or candidate.suffix.lower() != ".gguf":
                raise RpcError(ENGINE_UNAVAILABLE, "Model must be an existing .gguf file", {"path": str(candidate)})
            RUNTIME.model_path = candidate
        RUNTIME.context_size = params.contextSize
        RUNTIME.gpu_layers = params.gpuLayers
        _stop_locked()
    return status()


def _gpu_layers() -> int:
    if RUNTIME.gpu_layers is not None:
        return RUNTIME.gpu_layers
    return 999 if capabilities.llama_devices() else 0


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def ensure_running(ctx: JobContext | None = None, timeout: float = 300.0) -> None:
    with _LOCK:
        if RUNTIME.proc is not None and RUNTIME.proc.poll() is None:
            return
        exe = paths.executable("llama", "llama-server")
        model = RUNTIME.model_path or default_model()
        if exe is None or model is None or not model.exists():
            raise RpcError(ENGINE_UNAVAILABLE, "The local language model is not installed", {"engine": "llama", "model": str(model)})
        RUNTIME.port = _free_port()
        RUNTIME.token = secrets.token_urlsafe(24)
        RUNTIME.model_path = model
        threads = capabilities.recommended_threads()
        args = [
            str(exe), "-m", str(model), "--host", "127.0.0.1", "--port", str(RUNTIME.port),
            "--api-key", RUNTIME.token, "-c", str(RUNTIME.context_size), "-t", str(threads),
            "-ngl", str(_gpu_layers()), "--jinja", "--no-webui", "--offline", "-np", "1",
            "--reasoning-format", "deepseek",
        ]
        log_dir = paths.user_dir() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        RUNTIME.log_path = log_dir / "llama-server.log"
        log_file = RUNTIME.log_path.open("wb")
        env = capabilities.engine_env("llama")
        RUNTIME.proc = subprocess.Popen(
            args, stdout=log_file, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        RUNTIME.started_at = time.time()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if ctx is not None:
            ctx.check()
            ctx.progress(5, "ai.loading", "Loading the local model into memory")
        if RUNTIME.proc is None or RUNTIME.proc.poll() is not None:
            tail = RUNTIME.log_path.read_text(errors="replace")[-1500:] if RUNTIME.log_path else ""
            raise RpcError(ENGINE_UNAVAILABLE, "The local model runtime exited during start-up", {"log": tail})
        try:
            code, _ = _request("GET", "/health", None, timeout=2.0)
            if code == 200:
                return
        except OSError:
            pass
        time.sleep(0.4)
    raise RpcError(ENGINE_UNAVAILABLE, "The local model did not become ready in time", {"timeoutSeconds": timeout})


def _request(method: str, path: str, body: dict[str, Any] | None, timeout: float = 600.0) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", RUNTIME.port, timeout=timeout)
    try:
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": f"Bearer {RUNTIME.token}", "Content-Type": "application/json"}
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def stream_chat(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    ctx: JobContext,
    on_text: Callable[[str], None],
    *,
    temperature: float = 0.2,
    max_tokens: int = 1200,
) -> dict[str, Any]:
    """Stream one assistant turn. Returns {"content", "tool_calls", "finish_reason", "usage"}."""
    ensure_running(ctx)
    body: dict[str, Any] = {
        "messages": messages, "stream": True, "temperature": temperature, "top_p": 0.9,
        "max_tokens": max_tokens, "cache_prompt": True,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
        body["parallel_tool_calls"] = True
    conn = http.client.HTTPConnection("127.0.0.1", RUNTIME.port, timeout=900)
    content: list[str] = []
    calls: dict[int, dict[str, Any]] = {}
    finish = None
    usage: dict[str, Any] = {}
    try:
        conn.request("POST", "/v1/chat/completions", body=json.dumps(body).encode("utf-8"),
                     headers={"Authorization": f"Bearer {RUNTIME.token}", "Content-Type": "application/json"})
        resp = conn.getresponse()
        if resp.status != 200:
            raise RpcError(ENGINE_UNAVAILABLE, f"Local model request failed ({resp.status})", {"body": resp.read()[:800].decode(errors="replace")})
        for event in _sse(resp):
            ctx.check()
            if event == "[DONE]":
                break
            chunk = json.loads(event)
            if chunk.get("usage"):
                usage = chunk["usage"]
            for choice in chunk.get("choices", []):
                delta = choice.get("delta") or {}
                text = delta.get("content")
                if text:
                    content.append(text)
                    on_text(text)
                for call in delta.get("tool_calls") or []:
                    slot = calls.setdefault(int(call.get("index", 0)), {"id": "", "name": "", "arguments": ""})
                    if call.get("id"):
                        slot["id"] = call["id"]
                    fn = call.get("function") or {}
                    if fn.get("name"):
                        slot["name"] += fn["name"]
                    if fn.get("arguments"):
                        slot["arguments"] += fn["arguments"]
                if choice.get("finish_reason"):
                    finish = choice["finish_reason"]
    finally:
        conn.close()
    return {"content": "".join(content), "tool_calls": [calls[k] for k in sorted(calls)], "finish_reason": finish, "usage": usage}


def _sse(resp: http.client.HTTPResponse) -> Iterator[str]:
    buffer = b""
    while True:
        chunk = resp.read1(8192) if hasattr(resp, "read1") else resp.read(8192)
        if not chunk:
            break
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            text = line.decode("utf-8", errors="replace").strip()
            if text.startswith("data:"):
                yield text[5:].strip()


def _stop_locked() -> None:
    if RUNTIME.proc is not None:
        terminate_process(RUNTIME.proc)
    RUNTIME.proc = None


def shutdown_server() -> None:
    with _LOCK:
        _stop_locked()
