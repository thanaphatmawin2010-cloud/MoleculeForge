/**
 * Transports carry newline-free JSON-RPC strings between the UI and the compute sidecar.
 *
 * - TauriTransport: the desktop shell relays messages over its IPC (no sockets at all).
 * - BridgeTransport: development/e2e only; a loopback WebSocket to scripts/dev-bridge.mjs,
 *   authenticated with a per-session random token. Never used in packaged builds.
 */

export interface Transport {
  send(line: string): Promise<void>;
  onMessage(handler: (line: string) => void): () => void;
  readonly kind: "tauri" | "bridge";
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

class TauriTransport implements Transport {
  readonly kind = "tauri" as const;
  private handlers = new Set<(line: string) => void>();
  private ready: Promise<void>;

  constructor() {
    this.ready = (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<string>("sidecar://message", (event) => {
        for (const handler of this.handlers) handler(event.payload);
      });
    })();
  }

  async send(line: string): Promise<void> {
    await this.ready;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("rpc_send", { line });
  }

  onMessage(handler: (line: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

class BridgeTransport implements Transport {
  readonly kind = "bridge" as const;
  private handlers = new Set<(line: string) => void>();
  private socket: WebSocket | null = null;
  private opened: Promise<WebSocket>;

  constructor(url: string) {
    this.opened = new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", () => reject(new Error("bridge connection failed")));
      socket.addEventListener("message", (event) => {
        for (const handler of this.handlers) handler(String(event.data));
      });
      this.socket = socket;
    });
  }

  async send(line: string): Promise<void> {
    const socket = await this.opened;
    socket.send(line);
  }

  onMessage(handler: (line: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.socket?.close();
  }
}

/** The WebSocket bridge exists only in development and explicit test builds. */
const BRIDGE_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_BRIDGE === "1";

export function createTransport(): Transport {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    return new TauriTransport();
  }
  if (!BRIDGE_ENABLED) throw new Error("MoleculeForge's compute engine is only reachable from the desktop app.");
  const params = new URLSearchParams(window.location.search);
  const port = params.get("bridgePort") ?? import.meta.env.VITE_BRIDGE_PORT ?? "8765";
  const token = params.get("bridgeToken") ?? import.meta.env.VITE_BRIDGE_TOKEN ?? "";
  return new BridgeTransport(`ws://127.0.0.1:${port}/rpc?token=${encodeURIComponent(token)}`);
}
