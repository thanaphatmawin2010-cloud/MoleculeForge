/**
 * Desktop builds resolve "@/lite/transport" here (see vite.config.ts) so the WebAssembly engine,
 * its worker and its data files never enter the desktop bundle.
 */
import type { Transport } from "@/ipc/transport";

export function createLiteTransport(): Transport {
  throw new Error("MoleculeForge Lite's engine is not part of the desktop build.");
}
