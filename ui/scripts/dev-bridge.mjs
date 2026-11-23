#!/usr/bin/env node
/**
 * Development / end-to-end test bridge (never shipped).
 *
 * Spawns the real Python compute sidecar and relays newline-delimited JSON-RPC between it
 * and a browser over a WebSocket bound to 127.0.0.1 only. Connections must present the
 * per-session random token printed at start-up (and written to BRIDGE_INFO_FILE if set).
 *
 *   node scripts/dev-bridge.mjs [--port 8765]
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.BRIDGE_PORT ?? 8765);
const token = process.env.BRIDGE_TOKEN ?? randomBytes(18).toString("base64url");

const python = process.env.MF_PYTHON ?? resolve(repo, "compute", ".venv", "bin", "python");
const sidecar = spawn(python, ["-m", "mfcompute.server"], {
  cwd: resolve(repo, "compute"),
  env: { ...process.env, MF_RESOURCE_DIR: repo, PYTHONUNBUFFERED: "1" },
  stdio: ["pipe", "pipe", "inherit"],
});

const clients = new Set();
const backlog = [];
createInterface({ input: sidecar.stdout }).on("line", (line) => {
  if (line.includes('"method":"ready"')) backlog.push(line);
  for (const client of clients) client.send(line);
});
sidecar.on("exit", (code) => {
  console.error(`[bridge] sidecar exited with ${code}`);
  process.exit(code ?? 1);
});

const http = createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
http.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const remote = req.socket.remoteAddress ?? "";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (url.pathname !== "/rpc" || url.searchParams.get("token") !== token || !loopback) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    for (const line of backlog) ws.send(line);
    ws.on("message", (data) => {
      const line = String(data).replace(/\n/g, " ");
      sidecar.stdin.write(line + "\n");
    });
    ws.on("close", () => clients.delete(ws));
  });
});

http.listen(port, "127.0.0.1", () => {
  const info = { port, token };
  if (process.env.BRIDGE_INFO_FILE) writeFileSync(process.env.BRIDGE_INFO_FILE, JSON.stringify(info));
  console.log(`[bridge] ws://127.0.0.1:${port}/rpc  token=${token}`);
  console.log(`[bridge] open http://127.0.0.1:5173/?bridgePort=${port}&bridgeToken=${token}`);
});

const shutdown = () => {
  sidecar.stdin.end();
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
