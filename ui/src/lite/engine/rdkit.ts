/**
 * RDKit's official WebAssembly build (MinimalLib, the same RDKit release as the desktop sidecar)
 * and the bridge between it and the canonical molecule schema.
 *
 * MinimalLib exposes parsing, canonical SMILES/InChI, descriptors, substructure search and 2D
 * depiction, but not RDKit's internal atom properties. Those are read back exactly instead:
 * implicit hydrogens, radicals, aromaticity and Kekulé bond orders from RDKit's JSON output, and
 * hybridisation, total valence and ring sizes through RDKit's own SMARTS primitives (^n, v, r).
 */
import initRDKitModule, { type MainModule, type Mol } from "@rdkit/rdkit";
import type { Molecule } from "@/ipc/schema";
import { DEFAULT_VALENCE, SYMBOLS, VALENCE_LISTS } from "./tables.generated";

export type RDKit = MainModule;
export type RDMol = Mol;

let modulePromise: Promise<RDKit> | null = null;
let instance: RDKit | null = null;
let errorLog: { get_buffer(): string; clear_buffer(): void } | null = null;
let wasmLocation: string | undefined;

/** Where the browser finds RDKit_minimal.wasm (Node finds it next to the package). */
export function setRDKitWasmUrl(url: string): void {
  wasmLocation = url;
}

export function loadRDKit(): Promise<RDKit> {
  modulePromise ??= initRDKitModule(wasmLocation ? { locateFile: () => wasmLocation } : {}).then((mod) => {
    instance = mod as RDKit;
    errorLog = instance.set_log_capture("rdApp.*") as unknown as typeof errorLog;
    return instance;
  });
  return modulePromise;
}

/** RDKit's captured error log (rdApp.*), for reading why a call failed. */
export function captureLog(): { clear(): void; read(): string } {
  return { clear: () => errorLog?.clear_buffer(), read: () => errorLog?.get_buffer() ?? "" };
}

export function rdkit(): RDKit {
  if (!instance) throw new Error("RDKit is not loaded yet");
  return instance;
}

/**
 * A WebAssembly trap (RuntimeError) can leave the RDKit module unusable; drop it so the next
 * loadRDKit() starts a fresh instance. Returns true when the error was such a trap.
 */
export function recoverFromTrap(error: unknown): boolean {
  const trap = typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError;
  if (trap) {
    instance = null;
    modulePromise = null;
    errorLog = null;
  }
  return trap;
}

export const ATOMIC_NUMBER: Record<string, number> = Object.fromEntries(SYMBOLS.map((s, z) => [s, z]));

export function atomicNumber(symbol: string): number | undefined {
  const z = ATOMIC_NUMBER[symbol];
  return z !== undefined && z >= 1 && z <= 118 ? z : undefined;
}

// ---------------------------------------------------------------------------------------------
// RDKit's valence model (Atom.cpp calculateExplicitValence), needed to write the molfile valence
// field and to report which atom exceeds its valence, exactly as RDKit decides it.
// ---------------------------------------------------------------------------------------------

const CONTRIB: Record<string, number> = { single: 1, double: 2, triple: 3, aromatic: 1.5 };

export interface ValenceInfo {
  /** RDKit's explicit valence (bond order sum incl. aromatic rules, plus explicit H count). */
  explicit: number;
  /** Largest allowed valence for the element and charge, or null when RDKit accepts any. */
  max: number | null;
  /** RDKit's strict check (updatePropertyCache(strict=true)) raises an AtomValenceException. */
  exceeded: boolean;
}

function isAromaticAtom(m: Molecule, idx: number): boolean {
  return m.bonds.some((b) => b.order === "aromatic" && (b.a === idx || b.b === idx));
}

/**
 * Python's round(x, digits): the correctly rounded decimal of the exact binary value, ties to even.
 * (x * 10**d rounding in floating point would disagree in the last digit near halves.)
 */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x;
  const exact = x.toFixed(Math.min(100, digits + 40));
  const [intPart, frac = ""] = exact.split(".");
  const kept = frac.slice(0, digits);
  const rest = frac.slice(digits);
  const tie = rest.length > 0 && rest[0] === "5" && /^5?0*$/.test(rest);
  if (!tie) return Number(x.toFixed(digits));
  const lastDigit = Number((kept || intPart!).slice(-1));
  const truncated = Number(`${intPart}${digits ? "." + kept : ""}`);
  if (lastDigit % 2 === 0) return truncated;
  const step = 10 ** -digits;
  return Number((truncated + (x < 0 ? -step : step)).toFixed(digits));
}

/** Python-style round() (half to even), used where the desktop engine formats valence counts. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const effectiveZ = (z: number, charge: number) => Math.min(118, Math.max(0, z - charge));
const canBeHypervalent = (z: number, effective: number) => (effective > 16 && (z === 15 || z === 16)) || (effective > 34 && (z === 33 || z === 34));

/** RDKit Atom.cpp calculateExplicitValence(strict=true, checkIt=false). */
function explicitValence(m: Molecule, idx: number): { value: number; violation: boolean; max: number | null } {
  const atom = m.atoms[idx]!;
  const z = atomicNumber(atom.el) ?? 0;
  let accum = atom.hCount ?? 0;
  let minAccum = atom.hCount ?? 0;
  for (const b of m.bonds) {
    if (b.a !== idx && b.b !== idx) continue;
    const contrib = CONTRIB[b.order] ?? 1;
    accum += contrib;
    minAccum += b.order === "aromatic" ? 1 : contrib;
  }
  const ovalens = VALENCE_LISTS[z] ?? [-1];
  const effective = ovalens.length > 1 || ovalens[0] !== -1 ? effectiveZ(z, atom.charge) : z;
  const dv = DEFAULT_VALENCE[effective] ?? -1;
  const valens = VALENCE_LISTS[effective] ?? [-1];
  if (accum > dv && isAromaticAtom(m, idx)) {
    let pval = dv;
    for (const v of valens) {
      if (v === -1 || v > accum) break;
      pval = v;
    }
    if (minAccum - pval <= 0.1 && accum - pval <= 1.5) accum = pval;
  }
  const value = Math.round(accum + 0.1);
  let maxValence = valens[valens.length - 1] ?? -1;
  let offset = 0;
  if (canBeHypervalent(z, effective)) {
    maxValence = ovalens[ovalens.length - 1] ?? -1;
    offset -= atom.charge;
  }
  if (z === 1 && atom.charge === -1) maxValence = 2;
  const limited = maxValence >= 0 && (ovalens[ovalens.length - 1] ?? -1) >= 0;
  return { value, violation: limited && value + offset > maxValence, max: limited ? maxValence : null };
}

/** RDKit Atom.cpp calculateImplicitValence(strict): the implicit H count, or a violation. */
function implicitValence(m: Molecule, idx: number, explicit: number): { value: number; violation: boolean } {
  const atom = m.atoms[idx]!;
  if (atom.hCount !== null && atom.hCount !== undefined) return { value: 0, violation: false };
  const z = atomicNumber(atom.el) ?? 0;
  if (z === 0) return { value: 0, violation: false };
  if (explicit === 0 && z === 1) {
    if (atom.charge === 1 || atom.charge === -1) return { value: 0, violation: false };
    if (atom.charge === 0) return { value: 1, violation: false };
    return { value: 0, violation: true }; // "Unreasonable formal charge"
  }
  let explicitPlusRad = explicit;
  const ovalens = VALENCE_LISTS[z] ?? [-1];
  let effective = ovalens.length > 1 || ovalens[0] !== -1 ? effectiveZ(z, atom.charge) : z;
  if (effective === 0) return { value: 0, violation: false };
  const dv = DEFAULT_VALENCE[effective] ?? -1;
  if (dv === -1) return { value: 0, violation: false };
  if (canBeHypervalent(z, effective)) {
    effective = z;
    explicitPlusRad -= atom.charge;
  }
  const valens = VALENCE_LISTS[effective] ?? [-1];
  if (isAromaticAtom(m, idx)) {
    if (explicitPlusRad <= dv) return { value: dv - explicitPlusRad, violation: false };
    const satisfied = valens.some((v) => v > 0 && v === explicitPlusRad);
    return { value: 0, violation: !satisfied };
  }
  for (const v of valens) {
    if (v < 0) break;
    if (explicitPlusRad <= v) return { value: v - explicitPlusRad, violation: false };
  }
  if ((valens[valens.length - 1] ?? -1) !== -1 && (ovalens[ovalens.length - 1] ?? -1) > 0) return { value: 0, violation: true };
  return { value: 0, violation: false };
}

export function valenceInfo(m: Molecule, idx: number): ValenceInfo {
  const ex = explicitValence(m, idx);
  if (ex.violation) return { explicit: ex.value, max: ex.max, exceeded: true };
  const im = implicitValence(m, idx, ex.value);
  return { explicit: ex.value, max: ex.max, exceeded: im.violation };
}

/** Hydrogens RDKit would attach implicitly (non-strict), for writing explicit SMILES. */
export function implicitHydrogens(m: Molecule, idx: number): number {
  const atom = m.atoms[idx]!;
  if (atom.hCount !== null && atom.hCount !== undefined) return atom.hCount;
  const ex = explicitValence(m, idx);
  return implicitValence(m, idx, ex.value).value;
}

// ---------------------------------------------------------------------------------------------
// Molecule -> MDL molfile
// ---------------------------------------------------------------------------------------------

const BOND_TYPE: Record<string, number> = { single: 1, double: 2, triple: 3, aromatic: 4 };

function f(x: number): string {
  return (Number.isFinite(x) ? x : 0).toFixed(4).padStart(10);
}

export function isThreeD(m: Molecule): boolean {
  if (m.atoms.length === 1) return true;
  const anyNonZero = m.atoms.some((a) => Math.abs(a.x) + Math.abs(a.y) + Math.abs(a.z) > 1e-6);
  const distinct = new Set(m.atoms.map((a) => `${a.x},${a.y},${a.z}`)).size > 1;
  return anyNonZero && distinct;
}

export function isWedgeSketch(m: Molecule): boolean {
  return m.atoms.every((a) => Math.abs(a.z) < 1e-6) && m.bonds.some((b) => b.stereo === "wedge" || b.stereo === "hash");
}

export interface MolfileOptions {
  /** Coordinates to write instead of the molecule's own (e.g. a 2D layout). */
  coords?: [number, number, number][];
  dimension?: "2D" | "3D";
  title?: string;
}

/**
 * Write the molecule as a V2000 molfile (V3000 above 999 atoms or bonds). Atoms with an explicit
 * hydrogen count get the valence field, which RDKit turns into exactly that many hydrogens and no
 * implicit ones, the same as SetNumExplicitHs + SetNoImplicit in the desktop engine.
 */
export function toMolfile(m: Molecule, options: MolfileOptions = {}): string {
  const threeD = options.dimension ? options.dimension === "3D" : isThreeD(m) && !isWedgeSketch(m);
  const coords = options.coords ?? m.atoms.map((a) => [a.x, a.y, a.z] as [number, number, number]);
  const title = (options.title ?? m.name ?? "").replace(/[\r\n]+/g, " ").slice(0, 80);
  const header = [title, `  MFLite          ${threeD ? "3D" : "2D"}`, ""];
  const valence = (idx: number): number => {
    const atom = m.atoms[idx]!;
    if (atom.hCount === null || atom.hCount === undefined) return 0;
    const total = valenceInfo({ ...m, atoms: m.atoms.map((a, i) => (i === idx ? { ...a, hCount: 0 } : a)) }, idx).explicit + atom.hCount;
    return total === 0 ? 15 : total;
  };
  const stereoFlag = (stereo: string) => (threeD ? 0 : stereo === "wedge" ? 1 : stereo === "hash" ? 6 : 0);
  if (m.atoms.length > 999 || m.bonds.length > 999) {
    const lines = [...header, "  0  0  0     0  0            999 V3000", "M  V30 BEGIN CTAB", `M  V30 COUNTS ${m.atoms.length} ${m.bonds.length} 0 0 0`, "M  V30 BEGIN ATOM"];
    m.atoms.forEach((a, i) => {
      const [x, y, z] = coords[i]!;
      let line = `M  V30 ${i + 1} ${a.el} ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} 0`;
      if (a.charge) line += ` CHG=${a.charge}`;
      if (a.isotope) line += ` MASS=${a.isotope}`;
      const v = valence(i);
      if (v) line += ` VAL=${v === 15 ? -1 : v}`;
      lines.push(line);
    });
    lines.push("M  V30 END ATOM", "M  V30 BEGIN BOND");
    m.bonds.forEach((b, i) => {
      const cfg = stereoFlag(b.stereo);
      lines.push(`M  V30 ${i + 1} ${BOND_TYPE[b.order] ?? 1} ${b.a + 1} ${b.b + 1}${cfg ? ` CFG=${cfg === 1 ? 1 : 3}` : ""}`);
    });
    lines.push("M  V30 END BOND", "M  V30 END CTAB", "M  END");
    return lines.join("\n");
  }
  const lines = [...header, `${String(m.atoms.length).padStart(3)}${String(m.bonds.length).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`];
  m.atoms.forEach((a, i) => {
    const [x, y, z] = coords[i]!;
    lines.push(`${f(x)}${f(y)}${f(z)} ${a.el.padEnd(3)} 0  0  0  0  0${String(valence(i)).padStart(3)}  0  0  0  0  0  0`);
  });
  m.bonds.forEach((b) => {
    lines.push(`${String(b.a + 1).padStart(3)}${String(b.b + 1).padStart(3)}${String(BOND_TYPE[b.order] ?? 1).padStart(3)}${String(stereoFlag(b.stereo)).padStart(3)}`);
  });
  const charged = m.atoms.map((a, i) => [i + 1, a.charge] as const).filter(([, c]) => c);
  for (let k = 0; k < charged.length; k += 8) {
    const chunk = charged.slice(k, k + 8);
    lines.push(`M  CHG${String(chunk.length).padStart(3)}${chunk.map(([i, c]) => `${String(i).padStart(4)}${String(c).padStart(4)}`).join("")}`);
  }
  const isotopes = m.atoms.map((a, i) => [i + 1, a.isotope ?? 0] as const).filter(([, iso]) => iso);
  for (let k = 0; k < isotopes.length; k += 8) {
    const chunk = isotopes.slice(k, k + 8);
    lines.push(`M  ISO${String(chunk.length).padStart(3)}${chunk.map(([i, iso]) => `${String(i).padStart(4)}${String(iso).padStart(4)}`).join("")}`);
  }
  lines.push("M  END");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Parsing with RDKit and reading its perception back
// ---------------------------------------------------------------------------------------------

export interface ParseFailure {
  ok: false;
  /** RDKit's own error lines (valence / kekulisation), as the desktop's DetectChemistryProblems sees them. */
  errors: string[];
}

export interface ParseSuccess {
  ok: true;
  mol: RDMol;
}

const MOL_OPTIONS = JSON.stringify({ removeHs: false });

/** Parse a molfile/SMILES/InChI with sanitisation; on failure return RDKit's error log. */
export function parseWithLog(input: string, options: string = MOL_OPTIONS): ParseSuccess | ParseFailure {
  const R = rdkit();
  errorLog?.clear_buffer();
  let mol: RDMol | null = null;
  try {
    mol = R.get_mol(input, options);
  } catch {
    mol = null;
  }
  if (mol && mol.is_valid()) return { ok: true, mol };
  mol?.delete();
  const errors = (errorLog?.get_buffer() ?? "")
    .split("\n")
    .map((l) => l.replace(/^\[[\d:]+\]\s*/, "").trim())
    .filter(Boolean);
  return { ok: false, errors };
}

/** Build an RDKit molecule from the canonical schema, or null if RDKit rejects it. */
export function toRDKit(m: Molecule): RDMol | null {
  const parsed = parseWithLog(toMolfile(m));
  return parsed.ok ? parsed.mol : null;
}

export function withMol<T>(mol: RDMol, fn: (mol: RDMol) => T): T {
  try {
    return fn(mol);
  } finally {
    mol.delete();
  }
}

export interface AtomPerception {
  z: number;
  charge: number;
  isotope: number;
  /** Hydrogens RDKit attaches implicitly or as an explicit count (not hydrogen atoms in the graph). */
  hs: number;
  radicals: number;
  aromatic: boolean;
  /** "sp", "sp2", "sp3", "sp3d", "sp3d2", "s" or "" (RDKit's hybridisation). */
  hybridization: string;
  totalValence: number;
  /** Hydrogen neighbours in the graph plus attached hydrogens (RDKit GetTotalNumHs(includeNeighbors)). */
  totalHs: number;
  smallestRing: number;
  chirality: "cw" | "ccw" | "";
}

export interface Perception {
  atoms: AtomPerception[];
  /** Kekulé bond orders (1, 2, 3) in RDKit's bond order. */
  kekule: number[];
  aromaticBonds: Set<number>;
  rings: number[][];
  cip: Map<number, string>;
}

interface RdJson {
  defaults?: { atom?: Record<string, unknown>; bond?: Record<string, unknown> };
  molecules: { atoms: Record<string, unknown>[]; bonds: { bo?: number; atoms: [number, number] }[]; extensions?: Record<string, unknown>[] }[];
}

/** Atom indices matched by a SMARTS query (each match's first atom). */
export function matchAtoms(mol: RDMol, smarts: string): number[] {
  const q = rdkit().get_qmol(smarts);
  if (!q) return [];
  try {
    const raw = JSON.parse(mol.get_substruct_matches(q) || "[]") as { atoms: number[] }[] | Record<string, never>;
    return Array.isArray(raw) ? raw.map((m) => m.atoms[0]!).filter((x) => x !== undefined) : [];
  } finally {
    q.delete();
  }
}

/** Every match of a SMARTS pattern as atom index lists (unique matches, as RDKit's default). */
export function substructMatches(mol: RDMol, smarts: string): number[][] {
  const q = rdkit().get_qmol(smarts);
  if (!q) return [];
  try {
    const raw = JSON.parse(mol.get_substruct_matches(q) || "[]") as { atoms: number[] }[] | Record<string, never>;
    return Array.isArray(raw) ? raw.map((m) => m.atoms) : [];
  } finally {
    q.delete();
  }
}

const HYBRID = ["s", "sp", "sp2", "sp3", "sp3d", "sp3d2"];

export function perceive(mol: RDMol): Perception {
  const json = JSON.parse(mol.get_json()) as RdJson;
  const record = json.molecules[0]!;
  const atomDefaults = json.defaults?.atom ?? {};
  const ext = (record.extensions ?? []).find((e) => e["name"] === "rdkitRepresentation") ?? {};
  const aromaticAtoms = new Set((ext["aromaticAtoms"] as number[] | undefined) ?? []);
  const n = record.atoms.length;
  const valence = new Array<number>(n).fill(0);
  const hyb = new Array<string>(n).fill("");
  const totalH = new Array<number>(n).fill(0);
  const ring = new Array<number>(n).fill(0);
  for (let v = 0; v <= 8; v++) for (const i of matchAtoms(mol, `[v${v}]`)) valence[i] = v;
  for (let h = 0; h < HYBRID.length; h++) for (const i of matchAtoms(mol, `[^${h}]`)) hyb[i] = HYBRID[h]!;
  for (let k = 1; k <= 8; k++) for (const i of matchAtoms(mol, `[*;H${k}]`)) totalH[i] = k;
  const rings = (ext["atomRings"] as number[][] | undefined) ?? [];
  for (const r of rings) for (const i of r) ring[i] = ring[i] ? Math.min(ring[i]!, r.length) : r.length;
  const atoms = record.atoms.map((raw, i): AtomPerception => {
    const a = { ...atomDefaults, ...raw } as Record<string, unknown>;
    const stereo = String(a["stereo"] ?? "");
    return {
      z: Number(a["z"] ?? 6),
      charge: Number(a["chg"] ?? 0),
      isotope: Number(a["isotope"] ?? 0),
      hs: Number(a["impHs"] ?? 0),
      radicals: Number(a["nRad"] ?? 0),
      aromatic: aromaticAtoms.has(i),
      hybridization: hyb[i]!,
      totalValence: valence[i]!,
      totalHs: totalH[i]!,
      smallestRing: ring[i]!,
      chirality: stereo === "cw" || stereo === "ccw" ? stereo : "",
    };
  });
  const bondDefault = Number(json.defaults?.bond?.["bo"] ?? 1);
  return {
    atoms,
    kekule: record.bonds.map((b) => Number(b.bo ?? bondDefault)),
    aromaticBonds: new Set((ext["aromaticBonds"] as number[] | undefined) ?? []),
    rings,
    cip: new Map(((ext["cipCodes"] as [number, string][] | undefined) ?? []).map(([i, c]) => [i, c])),
  };
}

export function defaultValence(z: number): number {
  return DEFAULT_VALENCE[z] ?? -1;
}
