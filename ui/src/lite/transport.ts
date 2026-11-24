/**
 * The UI's transport to MoleculeForge Lite's engine: a module Web Worker served from the page's own
 * origin (ui/src/lite/worker.ts). It carries the same newline-free JSON-RPC strings as the desktop
 * shell's IPC; nothing leaves the device.
 */
import type { Transport } from "@/ipc/transport";

export function createLiteTransport(): Transport {
  const handlers = new Set<(line: string) => void>();
  const emit = (line: string) => {
    for (const handler of handlers) handler(line);
  };
  const failed = (message: string) => emit(JSON.stringify({ jsonrpc: "2.0", method: "engine.failed", params: { message } }));
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch (err) {
    // Browsers without module workers (very old Safari/Firefox) cannot run the engine.
    queueMicrotask(() => failed(err instanceof Error ? err.message : String(err)));
    return { kind: "lite", send: async () => undefined, onMessage: (h) => (handlers.add(h), () => handlers.delete(h)) };
  }
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") emit(event.data);
  });
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    failed(event.message || "The compute engine could not start in this browser.");
  });
  // The worker resolves its data files against the app's base URL (a sub-path on GitHub Pages, the
  // asset loader's origin on Android), which only the page knows.
  worker.postMessage({ type: "init", base: new URL(import.meta.env.BASE_URL, document.baseURI).href });
  return {
    kind: "lite",
    send: async (line) => worker.postMessage(line),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
