/// <reference lib="webworker" />
/**
 * MoleculeForge Lite's compute engine, run in a Web Worker so the UI thread never blocks. It speaks
 * the desktop sidecar's newline-free JSON-RPC lines over postMessage and loads everything from the
 * app's own origin (no third-party servers): RDKit's WebAssembly build, OpenChemLib's force-field
 * tables (emitted by the build next to the library), the element data and the prebuilt library.
 */
import wasmUrl from "@rdkit/rdkit/RDKit_minimal.wasm?url";
import { setElements, type ElementsPayload } from "./engine/elements";
import { Library } from "./engine/library";
import { loadOCL } from "./engine/ocl";
import { loadRDKit, setRDKitWasmUrl } from "./engine/rdkit";
import { LiteServer, setReload } from "./engine/server";
import { openStore } from "./engine/storage";

declare const self: DedicatedWorkerGlobalScope;

const queue: string[] = [];
let server: LiteServer | null = null;
let base: URL | null = null;
const asset = (path: string) => new URL(path, base ?? self.location.href).toString();

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data === "string") {
    if (server) server.handleLine(data);
    else queue.push(data);
    return;
  }
  // The page sends its base URL once; loading starts then.
  if (!base && data && typeof data === "object" && (data as { type?: unknown }).type === "init") {
    base = new URL(String((data as { base?: unknown }).base ?? "./"), self.location.href);
    start().catch((err: unknown) => {
      send(JSON.stringify({ jsonrpc: "2.0", method: "engine.failed", params: { message: String((err as Error)?.message ?? err) } }));
    });
  }
});

const send = (line: string) => self.postMessage(line);
const loading = (percent: number, stage: string) => send(JSON.stringify({ jsonrpc: "2.0", method: "engine.loading", params: { percent, stage } }));

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(asset(path));
  if (!response.ok) throw new Error(`could not load ${path} (${response.status})`);
  return (await response.json()) as T;
}

async function start(): Promise<void> {
  loading(5, "rdkit");
  setRDKitWasmUrl(wasmUrl);
  const rdkitReady = loadRDKit();
  const oclReady = loadOCL();
  const [elementsData, libraryData, store] = await Promise.all([
    fetchJson<ElementsPayload>("data/elements.json"),
    fetchJson<{ molecules: unknown[] }>("data/molecules/library.json"),
    openStore("moleculeforge-lite"),
  ]);
  loading(40, "data");
  setElements(elementsData);
  await rdkitReady;
  loading(75, "forcefield");
  await oclReady;
  const library = new Library(store);
  await library.load(libraryData as Parameters<Library["load"]>[0]);
  setReload(async () => {
    await loadRDKit();
  });
  server = new LiteServer(send, library);
  loading(100, "ready");
  server.ready();
  for (const line of queue.splice(0)) server.handleLine(line);
}
