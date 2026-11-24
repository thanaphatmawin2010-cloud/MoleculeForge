/** Element dataset access and radii helpers: a port of compute/mfcompute/data/elements.py. */
import { RpcFailure, NOT_FOUND } from "./errors";

interface Quantity {
  value: number | null;
}

export interface ElementRecord {
  Z: number;
  symbol: string;
  category: string;
  atomicMass: { value: number | null };
  radiusCovalent: { single: Quantity; double: Quantity; triple: Quantity };
  radiusVanDerWaals: Quantity;
  cpkColorHex: string;
  [key: string]: unknown;
}

export interface ElementsPayload {
  elements: ElementRecord[];
  statusLegend: Record<string, string>;
  sources: Record<string, string>;
  [key: string]: unknown;
}

let payload: ElementsPayload | null = null;
let bySymbol = new Map<string, ElementRecord>();

export function setElements(data: ElementsPayload): void {
  if (data.elements.length !== 118) throw new Error("elements.json must contain exactly 118 elements");
  payload = data;
  bySymbol = new Map(data.elements.map((e) => [e.symbol, e]));
}

export function dataset(): ElementsPayload {
  if (!payload) throw new Error("element data not loaded");
  return payload;
}

export function get(z?: number | null, symbol?: string | null): ElementRecord {
  const data = dataset();
  if (z !== undefined && z !== null) {
    if (z >= 1 && z <= 118) return { ...data.elements[z - 1]! };
  } else if (symbol) {
    const s = symbol.trim();
    const sym = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    const record = bySymbol.get(sym);
    if (record) return { ...record };
  }
  throw new RpcFailure(NOT_FOUND, "Element not found", { z: z ?? null, symbol: symbol ?? null });
}

export function record(symbol: string): ElementRecord | undefined {
  return bySymbol.get(symbol);
}

const PM_TO_ANGSTROM = 0.01;

export function covalentRadius(symbol: string, order = 1): number {
  const rec = bySymbol.get(symbol);
  if (!rec) return 0.75;
  const radii = rec.radiusCovalent;
  const key = order === 2 ? "double" : order === 3 ? "triple" : "single";
  const value = radii[key].value !== null ? radii[key].value : radii.single.value;
  return value !== null ? value * PM_TO_ANGSTROM : 1.5;
}

export function vdwRadius(symbol: string): number {
  const rec = bySymbol.get(symbol);
  if (!rec || rec.radiusVanDerWaals.value === null) return 2.0;
  return rec.radiusVanDerWaals.value * PM_TO_ANGSTROM;
}

/** Expected bond length (Å) from Pyykkö additive covalent radii; aromatic = mean of single and double. */
export function expectedBondLength(a: string, b: string, order: string): number {
  if (order === "aromatic") return 0.5 * (expectedBondLength(a, b, "single") + expectedBondLength(a, b, "double"));
  const n = order === "double" ? 2 : order === "triple" ? 3 : 1;
  return covalentRadius(a, n) + covalentRadius(b, n);
}

const METAL_CATEGORIES = new Set([
  "alkali-metal", "alkaline-earth-metal", "transition-metal", "post-transition-metal", "lanthanide", "actinide",
]);

export function isMetal(symbol: string): boolean {
  return METAL_CATEGORIES.has(bySymbol.get(symbol)?.category ?? "");
}

export function atomicMass(symbol: string): number {
  return bySymbol.get(symbol)?.atomicMass.value ?? 0;
}
