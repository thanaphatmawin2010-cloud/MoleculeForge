/**
 * One-click structure repair (chem.repairGeometry), live relaxation (chem.relax) and geometric
 * analysis: a port of compute/mfcompute/chem/geometry.py. Lite runs the same pipeline with the
 * MMFF94 force field (OpenChemLib); the GFN2-xTB and B3LYP refinements of the desktop app are
 * listed in the report as skipped.
 */
import type { Molecule } from "@/ipc/schema";
import { annotate, embedFromRDKit, moleculeFromExplicit, toRDKitStereo, toRDKitStrict, withExplicitHydrogens, EMBED_SEED, type ExplicitH } from "./convert";
import { CHEMISTRY_ERROR, RpcFailure } from "./errors";
import type { JobContext } from "./jobs";
import { breakSymmetry, build, ForceField, positions, type Variant, type Vec3 } from "./ocl";
import { isThreeD, perceive, pyRound, withMol, type Perception, type RDMol } from "./rdkit";
import { bondReference, CUMULATED_CO, VSEPR_ANGLES, vseprClass } from "./reference";
import { closePairs, detect, geometryIssues, validate } from "./validate";

const OPTIMAL_RMSD = 0.005;
const OPTIMAL_DE = 0.05;
const MAX_LISTED_CHANGES = 2000;
const HYBRID_STERIC: Record<string, number> = { sp: 2, sp2: 3, sp3: 4, sp3d: 5, sp3d2: 6 };

export const LITE_REFINE_NOTE = "skipped: available in the MoleculeForge desktop app";

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const deg = (rad: number) => (rad * 180) / Math.PI;
const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p: Vec3, q: Vec3): Vec3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const len = (p: Vec3) => Math.hypot(p[0], p[1], p[2]);

function angle(a: Vec3, b: Vec3, c: Vec3): number {
  const u = sub(a, b);
  const v = sub(c, b);
  const cos = dot(u, v) / (len(u) * len(v) + 1e-12);
  return deg(Math.acos(Math.max(-1, Math.min(1, cos))));
}

function dihedral(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): number {
  const b0 = sub(p0, p1);
  const b1 = sub(p2, p1);
  const b2 = sub(p3, p2);
  const n = len(b1) + 1e-12;
  const b1n: Vec3 = [b1[0] / n, b1[1] / n, b1[2] / n];
  const v = sub(b0, b1n.map((x) => x * dot(b0, b1n)) as Vec3);
  const w = sub(b2, b1n.map((x) => x * dot(b2, b1n)) as Vec3);
  return deg(Math.atan2(dot(cross(b1n, v), w), dot(v, w)));
}

export interface Measured {
  atoms: number[];
  elements: string[];
  value: number;
  order?: string;
}

export interface Measurements {
  bonds: Measured[];
  angles: Measured[];
  dihedrals: Measured[];
}

/** Bonds, angles and dihedrals. `orders` gives each bond's order (perceived aromaticity) when known. */
export function measure(m: Molecule, orders?: string[]): Measurements {
  const pos: Vec3[] = m.atoms.map((a) => [a.x, a.y, a.z]);
  const symbols = m.atoms.map((a) => a.el);
  const neighbours = m.atoms.map(() => [] as number[]);
  for (const b of m.bonds) {
    neighbours[b.a]!.push(b.b);
    neighbours[b.b]!.push(b.a);
  }
  const bonds: Measured[] = m.bonds.map((b, i) => ({
    atoms: [b.a, b.b], elements: [symbols[b.a]!, symbols[b.b]!], order: orders?.[i] ?? b.order, value: len(sub(pos[b.a]!, pos[b.b]!)),
  }));
  const angles: Measured[] = [];
  m.atoms.forEach((_, j) => {
    const nbrs = [...neighbours[j]!].sort((x, y) => x - y);
    for (let x = 0; x < nbrs.length; x++)
      for (let y = x + 1; y < nbrs.length; y++) {
        const i = nbrs[x]!;
        const k = nbrs[y]!;
        angles.push({ atoms: [i, j, k], elements: [symbols[i]!, symbols[j]!, symbols[k]!], value: angle(pos[i]!, pos[j]!, pos[k]!) });
      }
  });
  const dihedrals: Measured[] = [];
  for (const b of m.bonds) {
    const j = b.a;
    const k = b.b;
    for (const i of neighbours[j]!) {
      if (i === k) continue;
      for (const l of neighbours[k]!) {
        if (l === j || l === i) continue;
        dihedrals.push({ atoms: [i, j, k, l], elements: [symbols[i]!, symbols[j]!, symbols[k]!, symbols[l]!], value: dihedral(pos[i]!, pos[j]!, pos[k]!, pos[l]!) });
      }
    }
  }
  return { bonds, angles, dihedrals };
}

export interface HybridRow {
  atom: number;
  element: string;
  hybridization: string;
  stericNumber: number | null;
  sigmaBonds: number;
  lonePairs: number;
  vsepr: string | null;
  idealAngle: number | null;
  aromatic: boolean;
  smallestRing: number | null;
}

/** Hybridisation (RDKit's), steric number, lone pairs and VSEPR class for every heavy atom. */
export function perceiveHybridization(m: Molecule, perception: Perception): HybridRow[] {
  const degree = new Array<number>(m.atoms.length).fill(0);
  for (const b of m.bonds) {
    degree[b.a]! += 1;
    degree[b.b]! += 1;
  }
  const rows: HybridRow[] = [];
  m.atoms.forEach((atom, i) => {
    const p = perception.atoms[i]!;
    if (p.z === 1) return;
    const sigma = degree[i]!;
    const steric = HYBRID_STERIC[p.hybridization] ?? null;
    const lonePairs = steric !== null ? Math.max(0, steric - sigma) : 0;
    const vclass = sigma >= 2 ? vseprClass(sigma, lonePairs) : null;
    const ideal = vclass ? VSEPR_ANGLES[vclass] : undefined;
    rows.push({
      atom: i, element: atom.el, hybridization: p.hybridization || "unspecified", stericNumber: steric, sigmaBonds: sigma,
      lonePairs, vsepr: vclass, idealAngle: ideal ? ideal[0] : null, aromatic: p.aromatic, smallestRing: p.smallestRing || null,
    });
  });
  return rows;
}

/** Kabsch RMSD (proper rotations) via Horn's quaternion method. */
export function kabschRmsd(a: Vec3[], b: Vec3[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  const centre = (pts: Vec3[]): Vec3 => {
    const c: Vec3 = [0, 0, 0];
    for (const p of pts) for (let k = 0; k < 3; k++) c[k]! += p[k]! / pts.length;
    return c;
  };
  const ca = centre(a.slice(0, n));
  const cb = centre(b.slice(0, n));
  const pa = a.slice(0, n).map((p) => sub(p, ca));
  const pb = b.slice(0, n).map((p) => sub(p, cb));
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let ga = 0;
  let gb = 0;
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c]! += pa[i]![r]! * pb[i]![c]!;
    ga += dot(pa[i]!, pa[i]!);
    gb += dot(pb[i]!, pb[i]!);
  }
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S as [number, number, number, number, number, number, number, number, number];
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const lambda = Math.max(...jacobiEigenvalues(N));
  return Math.sqrt(Math.max(0, (ga + gb - 2 * lambda) / n));
}

function jacobiEigenvalues(input: number[][]): number[] {
  const a = input.map((row) => [...row]);
  const size = a.length;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < size; p++) for (let q = p + 1; q < size; q++) off += a[p]![q]! ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < size; p++)
      for (let q = p + 1; q < size; q++) {
        if (Math.abs(a[p]![q]!) < 1e-30) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < size; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < size; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
      }
  }
  return a.map((row, i) => row[i]!);
}

function usableGeometry(m: Molecule): boolean {
  if (!isThreeD(m)) return false;
  const issues = geometryIssues(m);
  if (issues.some((i) => i.code === "ATOMS_OVERLAP" || i.code === "CLASH")) return false;
  return !issues.some((i) => i.code === "BOND_TOO_LONG" || i.code === "BOND_TOO_SHORT");
}

interface Change {
  atoms: number[];
  elements: string[];
  old: number;
  new: number;
  delta: number;
  unit: string;
  rule: string;
  order?: string;
}

const r4 = (x: number) => pyRound(x, 4);

function diff(before: Measurements, after: Measurements, mapping: Map<number, number>, method: string) {
  const keyed = (items: Measured[], remap: boolean) => {
    const out = new Map<string, Measured>();
    for (const item of items) {
      const atoms = remap ? item.atoms.map((a) => mapping.get(a) ?? -1) : item.atoms;
      if (atoms.includes(-1)) continue;
      const key = atoms[0]! <= atoms[atoms.length - 1]! ? atoms : [...atoms].reverse();
      out.set(key.join(","), item);
    }
    return out;
  };
  const result: Record<string, unknown> = {};
  for (const [kind, unit, threshold] of [["bonds", "Å", 0.005], ["angles", "°", 0.5], ["dihedrals", "°", 2.0]] as const) {
    const old = keyed(before[kind], true);
    const fresh = keyed(after[kind], false);
    const changes: Change[] = [];
    for (const [key, item] of fresh) {
      const prior = old.get(key);
      if (!prior) continue;
      let delta = item.value - prior.value;
      if (kind === "dihedrals") delta = ((((delta + 180) % 360) + 360) % 360) - 180;
      if (Math.abs(delta) >= threshold) {
        changes.push({
          atoms: key.split(",").map(Number), elements: item.elements, old: r4(prior.value), new: r4(item.value), delta: r4(delta), unit, rule: method,
          ...(kind === "bonds" ? { order: item.order } : {}),
        });
      }
    }
    changes.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta));
    result[kind] = changes.slice(0, MAX_LISTED_CHANGES);
    result[`${kind}Total`] = changes.length;
  }
  return result as { bonds: Change[]; angles: Change[]; dihedrals: Change[]; bondsTotal: number; anglesTotal: number; dihedralsTotal: number };
}

/** Bond orders as RDKit perceives them (aromatic where RDKit finds aromaticity). */
export function perceivedOrders(m: Molecule, perception: Perception): string[] {
  return m.bonds.map((_, i) => {
    if (perception.aromaticBonds.has(i)) return "aromatic";
    const k = perception.kekule[i] ?? 1;
    return k === 2 ? "double" : k === 3 ? "triple" : "single";
  });
}

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const r3 = (x: number) => pyRound(x, 3);

export function geometryTables(m: Molecule, perception: Perception) {
  const orders = perceivedOrders(m, perception);
  const data = measure(m, orders);
  const doubleOnly = m.atoms.map((_, i) => {
    const incident = m.bonds.map((b, k) => [b, k] as const).filter(([b]) => b.a === i || b.b === i);
    return incident.length === 2 && incident.every(([, k]) => orders[k] === "double");
  });
  const cumulated = new Set(m.atoms.map((a, i) => (a.el === "C" && doubleOnly[i] ? i : -1)).filter((i) => i >= 0));
  const groups = new Map<string, { type: string; values: number[]; reference: ReturnType<typeof bondReference> }>();
  for (const bond of data.bonds) {
    const [elA, elB] = bond.elements as [string, string];
    const isCum = cumulated.has(bond.atoms[0]!) || cumulated.has(bond.atoms[1]!);
    const ref = bondReference(elA, elB, bond.order!, isCum);
    const [a, b] = elA < elB ? [elA, elB] : [elB, elA];
    const label = `${a}–${b} (${bond.order}${isCum && ref === CUMULATED_CO ? ", cumulated" : ""})`;
    const g = groups.get(label) ?? { type: label, values: [], reference: ref };
    g.values.push(bond.value);
    groups.set(label, g);
  }
  const bondTable = [...groups.values()].map((g) => {
    const v = g.values;
    const ref = g.reference;
    return {
      type: g.type, count: v.length, mean: r4(mean(v)), min: r4(Math.min(...v)), max: r4(Math.max(...v)), unit: "Å",
      reference: { typical: ref.typical, low: ref.low, high: ref.high, source: ref.source },
      withinTenPercent: v.every((x) => Math.abs(x - ref.typical) <= 0.1 * ref.typical),
      withinRange: v.every((x) => x >= ref.low - 0.02 && x <= ref.high + 0.02),
    };
  });
  bondTable.sort((p, q) => (p.type < q.type ? -1 : p.type > q.type ? 1 : 0));
  const perceived = new Map(perceiveHybridization(m, perception).map((p) => [p.atom, p]));
  const angleGroups = new Map<string, number[]>();
  const strained: number[] = [];
  for (const ang of data.angles) {
    const info = perceived.get(ang.atoms[1]!);
    if (!info || info.vsepr === null) continue;
    if (info.smallestRing && info.smallestRing <= 4) {
      strained.push(ang.value);
      continue;
    }
    if (["AX5", "AX6", "AX4E", "AX3E2", "AX4E2"].includes(info.vsepr)) continue;
    angleGroups.set(info.vsepr, [...(angleGroups.get(info.vsepr) ?? []), ang.value]);
  }
  const angleTable: Record<string, unknown>[] = [...angleGroups.entries()]
    .sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))
    .map(([cls, v]) => {
      const [ideal, low, high] = VSEPR_ANGLES[cls]!;
      return {
        class: cls, count: v.length, mean: r3(mean(v)), min: r3(Math.min(...v)), max: r3(Math.max(...v)), unit: "°", ideal, range: [low, high],
        withinTenPercent: v.every((x) => Math.abs(x - ideal) <= 0.1 * ideal),
      };
    });
  if (strained.length) {
    angleTable.push({
      class: "small-ring (strained)", count: strained.length, mean: r3(mean(strained)), min: r3(Math.min(...strained)), max: r3(Math.max(...strained)),
      unit: "°", ideal: null, range: null, withinTenPercent: true,
    });
  }
  const minNb: { value: number | null; unit: string; atoms: number[] | null } = { value: null, unit: "Å", atoms: null };
  if (m.atoms.length > 1) {
    const excluded = new Set<string>();
    const neighbours = m.atoms.map(() => [] as number[]);
    for (const b of m.bonds) {
      excluded.add(`${Math.min(b.a, b.b)},${Math.max(b.a, b.b)}`);
      neighbours[b.a]!.push(b.b);
      neighbours[b.b]!.push(b.a);
    }
    for (const nbrs of neighbours)
      for (let x = 0; x < nbrs.length; x++) for (let y = x + 1; y < nbrs.length; y++) excluded.add(`${Math.min(nbrs[x]!, nbrs[y]!)},${Math.max(nbrs[x]!, nbrs[y]!)}`);
    const pts: Vec3[] = m.atoms.map((a) => [a.x, a.y, a.z]);
    let best = Infinity;
    for (const [i, j] of closePairs(pts, 3.0)) {
      if (excluded.has(`${i},${j}`)) continue;
      const d = len(sub(pts[i]!, pts[j]!));
      if (d < best) {
        best = d;
        minNb.atoms = [i, j];
      }
    }
    if (Number.isFinite(best)) minNb.value = r4(best);
  }
  return { bondTable, angleTable, minNonBondedDistance: minNb };
}

// ---------------------------------------------------------------------------
// Force field
// ---------------------------------------------------------------------------

export interface MinimizationResult {
  method: string;
  converged: boolean;
  iterations: number;
  energyInitial: number;
  energyFinal: number;
  durationMs: number;
  frames: number;
  coords: Vec3[];
}

export function minimizationDict(r: MinimizationResult) {
  const r6 = (x: number) => pyRound(x, 6);
  return {
    method: r.method, converged: r.converged, iterations: r.iterations, energyInitial: r6(r.energyInitial), energyFinal: r6(r.energyFinal),
    energyUnit: "kcal/mol", gradientRms: null, gradientUnit: "kcal/(mol·Å)", durationMs: r.durationMs, notes: [] as string[],
  };
}

/** Which MMFF variant covers the structure (MoleculeForge Lite has no UFF), or null. */
export function chooseForceField(explicit: ExplicitH, preference: string = "auto"): Variant | null {
  const variants: Variant[] = preference === "MMFF94s" ? ["MMFF94s", "MMFF94"] : ["MMFF94", "MMFF94s"];
  for (const variant of variants) {
    try {
      const ff = new ForceField(build(explicit.atoms, explicit.bonds), variant);
      if (Number.isFinite(ff.energy())) return preference === "auto" || preference === "UFF" ? "MMFF94" : variant;
    } catch {
      /* no MMFF type for some atom */
    }
  }
  return null;
}

const r5 = (x: number) => pyRound(x, 5);

/** Minimise in chunks, streaming frames like the desktop engine (25 steps per frame below 200 atoms). */
export async function minimize(
  explicit: ExplicitH,
  coords: Vec3[],
  variant: Variant,
  ctx: JobContext,
  options: { maxSteps?: number; stream?: boolean; stage?: string; percentFrom?: number; percentTo?: number; frameAtoms?: number } = {},
): Promise<MinimizationResult> {
  const started = performance.now();
  const maxSteps = options.maxSteps ?? 2000;
  const stage = options.stage ?? "minimize";
  const from = options.percentFrom ?? 0;
  const to = options.percentTo ?? 100;
  const built = build(explicit.atoms.map((a, i) => ({ ...a, pos: coords[i]! })), explicit.bonds);
  const ff = new ForceField(built, variant);
  const e0 = ff.energy();
  const chunk = explicit.atoms.length < 200 ? 25 : 10;
  let done = 0;
  let converged = false;
  let frames = 0;
  while (done < maxSteps) {
    await ctx.tick();
    const steps = Math.min(chunk, maxSteps - done);
    converged = ff.minimise(steps, 1e-4, 1e-7);
    done += steps;
    const fraction = converged ? 1 : Math.min(1, done / maxSteps);
    let data: Record<string, unknown> | undefined;
    if (options.stream !== false) {
      const frame = positions(built).slice(0, options.frameAtoms ?? explicit.atoms.length).map((p) => p.map(r5));
      data = { frame, energy: r5(ff.energy()), unit: "kcal/mol", method: variant, step: done };
      frames += 1;
    }
    ctx.progress(from + (to - from) * fraction, stage, `${variant}: step ${done}`, data);
    if (converged) break;
  }
  return {
    method: variant, converged, iterations: done, energyInitial: e0, energyFinal: ff.energy(),
    durationMs: Math.round(performance.now() - started), frames, coords: positions(built),
  };
}

export function energyOf(explicit: ExplicitH, coords: Vec3[], variant: Variant): number {
  return new ForceField(build(explicit.atoms.map((a, i) => ({ ...a, pos: coords[i]! })), explicit.bonds), variant).energy();
}

/** The structure with all hydrogens explicit as an RDKit molecule (for embedding). */
function explicitAsRDKit(m: Molecule, explicit: ExplicitH, coords: Vec3[]): RDMol {
  const draft = moleculeFromExplicitDraft(m, explicit, coords);
  return toRDKitStrict(draft);
}

function moleculeFromExplicitDraft(m: Molecule, explicit: ExplicitH, coords: Vec3[]): Molecule {
  return {
    ...m,
    atoms: explicit.atoms.map((a, i) => ({
      i, el: i < explicit.nOriginal ? m.atoms[i]!.el : "H", x: coords[i]![0], y: coords[i]![1], z: coords[i]![2], charge: a.charge,
      isotope: a.isotope || null, hCount: i < explicit.nOriginal && m.atoms[i]!.hCount !== null && m.atoms[i]!.hCount !== undefined ? 0 : null,
    })),
    bonds: [...m.bonds, ...explicit.parents.map((p, k) => ({ a: p, b: explicit.nOriginal + k, order: "single" as const, stereo: "none" as const }))],
  };
}

// ---------------------------------------------------------------------------
// Repair pipeline
// ---------------------------------------------------------------------------

export async function repair(molecule: Molecule, refine: string, forceField: string, ctx: JobContext): Promise<Record<string, unknown>> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const methods: { stage: string; method: string; details: string }[] = [];
  ctx.progress(2, "detect", "Checking valence, charges and aromaticity", undefined, true);
  const initial = detect(molecule);
  initial.mol?.delete();
  const initialIssues = initial.issues;
  const fix = validate(molecule, [], [], true);
  const fixed = fix.molecule;
  if (fix.status === "invalid") {
    return {
      status: "failed", reason: fix.message, issuesFound: initialIssues, fixesApplied: fix.fixes,
      remainingIssues: fix.issues.filter((i) => i.severity === "error"), molecule: fixed, durationMs: elapsed(),
    };
  }
  methods.push({ stage: "sanitize", method: "RDKit sanitisation + MoleculeForge minimal-fix rules", details: `${fix.fixes.length} automatic correction(s)` });
  const atomMap = new Map<number, number>();
  fix.atomMap.forEach((n, old) => n >= 0 && atomMap.set(old, n));

  ctx.progress(8, "perceive", "Perceiving hybridisation and VSEPR geometry", undefined, true);
  const rd = toRDKitStrict(fixed);
  const perception = withMol(rd, (mol) => perceive(mol));
  let beforeMeasure: Measurements = { bonds: [], angles: [], dihedrals: [] };
  if (molecule.atoms.length && !initialIssues.some((i) => ["SELF_BOND", "DUPLICATE_BOND", "UNKNOWN_ELEMENT"].includes(i.code))) {
    try {
      beforeMeasure = measure(molecule);
    } catch {
      /* an unmeasurable input simply yields no "before" values */
    }
  }
  const usable = usableGeometry(fixed);
  const threeD = isThreeD(fixed);
  const explicit = withExplicitHydrogens(fixed, perception, threeD ? undefined : fixed.atoms.map(() => [0, 0, 0]));
  const added = explicit.parents.map((_, k) => explicit.nOriginal + k);
  methods.push({ stage: "perceive", method: "RDKit hybridisation + VSEPR (Gillespie) domain counting", details: "" });
  const chemicallyClean = !initialIssues.some((i) => i.severity === "error");
  const ffName = chooseForceField(explicit, forceField);
  if (ffName === null) {
    return {
      status: "failed",
      reason: "MMFF94 has no parameters for every atom in this structure. The MoleculeForge desktop app repairs it with UFF or GFN2-xTB.",
      issuesFound: initialIssues, fixesApplied: fix.fixes, remainingIssues: [], molecule: fixed, durationMs: elapsed(),
    };
  }
  if (refine === "gfn2-xtb" || refine === "auto") {
    methods.push({ stage: "refine", method: "GFN2-xTB / B3LYP refinement", details: LITE_REFINE_NOTE });
  }
  let coords: Vec3[] = explicit.atoms.map((a) => [...a.pos] as Vec3);
  const startCoords = coords.map((p) => [...p] as Vec3);
  let embedded = false;
  if (!(usable && !added.length) && (!usable || !threeD)) {
    ctx.progress(15, "embed", "Generating 3D coordinates (OpenChemLib conformer generator)", undefined, true);
    const mol = explicitAsRDKit(fixed, explicit, coords);
    coords = withMol(mol, (m) => embedFromRDKit(m, EMBED_SEED));
    embedded = true;
    methods.push({ stage: "embed", method: "OpenChemLib conformer generator + MMFF94s", details: `random seed ${EMBED_SEED}` });
  }
  const candidateOptimal = chemicallyClean && usable && !added.length && !embedded;
  const ffResult = await minimize(explicit, coords, ffName, ctx, { maxSteps: 5000, stage: "minimize", percentFrom: 25, percentTo: 70 });
  coords = ffResult.coords;
  methods.push({ stage: "minimize", method: ffName, details: `${ffResult.iterations} steps, converged=${ffResult.converged ? "True" : "False"}` });
  const common = Math.min(startCoords.length, coords.length);
  const rmsd = embedded ? null : kabschRmsd(startCoords.slice(0, common), coords.slice(0, common));
  const energyChange = Math.abs(ffResult.energyFinal - ffResult.energyInitial);
  const alreadyOptimal = candidateOptimal && rmsd !== null && (rmsd < OPTIMAL_RMSD || energyChange < OPTIMAL_DE);
  let finalMolecule: Molecule;
  let reportMolecule: Molecule;
  let reportCoords: Vec3[];
  if (alreadyOptimal) {
    finalMolecule = molecule;
    reportMolecule = molecule;
    reportCoords = startCoords;
  } else {
    const built = moleculeFromExplicit(fixed, explicit, coords, { keepHCount: true });
    const kept = fix.fixes.length ? "" : molecule.meta.stereo;
    finalMolecule = { ...built, id: molecule.id, name: molecule.name, props: molecule.props, meta: { ...built.meta, source: molecule.meta.source, category: molecule.meta.category, stereo: kept } };
    reportMolecule = finalMolecule;
    reportCoords = coords;
  }
  ctx.progress(97, "report", "Writing repair report", undefined, true);
  const reportPerception = withMol(toRDKitStrict(reportMolecule), (mol) => perceive(mol));
  const afterMeasure = measure(reportMolecule, perceivedOrders(reportMolecule, reportPerception));
  let changes = { bonds: [] as Change[], angles: [] as Change[], dihedrals: [] as Change[], bondsTotal: 0, anglesTotal: 0, dihedralsTotal: 0 };
  if (!alreadyOptimal && beforeMeasure.bonds.length) changes = diff(beforeMeasure, afterMeasure, atomMap, ffName);
  const tables = geometryTables(reportMolecule, reportPerception);
  const finalDetect = detect(finalMolecule);
  finalDetect.mol?.delete();
  const residualExplicit = alreadyOptimal ? withExplicitHydrogens(reportMolecule, reportPerception) : explicit;
  let residualValue: number | null = null;
  try {
    residualValue = pyRound(energyOf(residualExplicit, alreadyOptimal ? residualExplicit.atoms.map((a) => a.pos) : reportCoords, ffName), 6);
  } catch {
    residualValue = null;
  }
  const report = {
    status: alreadyOptimal ? "already-optimal" : "repaired",
    molecule: finalMolecule,
    issuesFound: initialIssues,
    fixesApplied: fix.fixes,
    hybridization: perceiveHybridization(reportMolecule, reportPerception),
    changes: {
      ...changes,
      addedAtoms: alreadyOptimal ? [] : added.filter((i) => i < reportMolecule.atoms.length).map((i) => ({ atom: i, element: reportMolecule.atoms[i]!.el, reason: "implicit hydrogen made explicit" })),
      removedAtoms: fix.atomMap.map((n, old) => [old, n] as const).filter(([, n]) => n < 0).map(([old]) => ({ atom: old, reason: "removed by valence fix" })),
    },
    methods,
    convergence: { forceField: minimizationDict(ffResult), xtb: null, dft: null },
    residualEnergy: { value: residualValue, unit: "kcal/mol", method: `${ffName} potential energy` },
    rmsd: {
      value: rmsd !== null ? r4(rmsd) : null, unit: "Å",
      note: rmsd !== null ? "Kabsch-aligned RMSD between input and output coordinates" : "new coordinates generated",
    },
    geometryCheck: tables,
    finalIssues: finalDetect.issues,
    atomMap: fix.atomMap,
    durationMs: elapsed(),
  };
  ctx.progress(100, "done", "Repair complete", undefined, true);
  return report;
}

/**
 * Fast local relaxation for live editing (no report). Implicit hydrogens take part in the force
 * field so heavy-atom geometry is realistic, then are dropped again unless `addHydrogens` is set,
 * so the document's atom list never changes underneath the editor.
 */
export async function quickRelax(molecule: Molecule, ctx: JobContext, maxSteps = 300, addHydrogens = false): Promise<Molecule> {
  const nOriginal = molecule.atoms.length;
  const rd = toRDKitStrict(molecule);
  const perception = withMol(rd, (mol) => perceive(mol));
  const hasCoords = isThreeD(molecule);
  let explicit = withExplicitHydrogens(molecule, perception, hasCoords ? undefined : molecule.atoms.map(() => [0, 0, 0]));
  let coords: Vec3[] = explicit.atoms.map((a) => [...a.pos] as Vec3);
  if (!hasCoords) {
    const mol = explicitAsRDKit(molecule, explicit, coords);
    coords = withMol(mol, (m) => embedFromRDKit(m));
  }
  const variant = chooseForceField(explicit);
  if (variant === null) return molecule;
  coords = breakSymmetry(coords);
  const result = await minimize(explicit, coords, variant, ctx, { maxSteps, stage: "relax", frameAtoms: addHydrogens ? undefined : nOriginal });
  if (!addHydrogens) {
    const r6 = (x: number) => pyRound(x, 6);
    return { ...molecule, atoms: molecule.atoms.map((a, i) => ({ ...a, x: r6(result.coords[i]![0]), y: r6(result.coords[i]![1]), z: r6(result.coords[i]![2]) })) };
  }
  explicit = { ...explicit, atoms: explicit.atoms.map((a, i) => ({ ...a, pos: result.coords[i]! })) };
  const built = moleculeFromExplicit(molecule, explicit, result.coords, { keepHCount: true });
  return { ...built, id: molecule.id, name: molecule.name, props: molecule.props, meta: { ...built.meta, source: molecule.meta.source, category: molecule.meta.category } };
}

export { annotate, toRDKitStereo };
export function assertCovered(variant: Variant | null): asserts variant is Variant {
  if (variant === null) throw new RpcFailure(CHEMISTRY_ERROR, "MMFF94 has no parameters for every atom in this structure", { code: "NO_FF_PARAMS" });
}
