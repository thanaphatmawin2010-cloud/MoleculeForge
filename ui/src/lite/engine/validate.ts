/**
 * Structure validation (chem.sanitize / chem.validateBonds) and minimal auto-correction: a port of
 * compute/mfcompute/chem/validate.py. Valence and Kekulé problems are decided by RDKit's own rules
 * (the WebAssembly build's sanitiser and RDKit's valence model, clean-up rules included), and every
 * applied fix is logged as {before, reason, fix, after}, exactly as the desktop engine does.
 */
import type { Atom, Bond, Issue, Molecule } from "@/ipc/schema";
import { annotate } from "./convert";
import * as elements from "./elements";
import { CHEMISTRY_ERROR, RpcFailure } from "./errors";
import { describeFix, displayParams, makeIssue, type Params } from "./issues";
import { atomicNumber, captureLog, defaultValence, implicitHydrogens, isThreeD, parseWithLog, perceive, pyRound, rdkit, roundHalfEven, toMolfile, valenceInfo, type Perception, type RDMol } from "./rdkit";
import { KNOWN_ISOTOPES, OUTER_ELECTRONS, VALENCE_LISTS } from "./tables.generated";

export const CLASH_LIMIT = 0.7;
export const OVERLAP_LIMIT = 0.2;
export const BOND_TOLERANCE = 0.3;

const ONIUM_PLUS = new Set(["N", "P", "As", "Sb", "O", "S", "Se", "Te"]);
const ATE_MINUS = new Set(["B", "Al", "Ga"]);
const STEP_DOWN: Record<string, Bond["order"]> = { triple: "double", double: "single", aromatic: "single" };
const FIXABLE = new Set(["SELF_BOND", "DUPLICATE_BOND", "ISOTOPE_UNKNOWN", "VALENCE_EXCEEDED", "AROMATIC_INVALID", "UNDERSATURATED"]);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function maxValence(symbol: string, charge: number): number | null {
  const z = atomicNumber(symbol) ?? 0;
  let effective = (OUTER_ELECTRONS[z] ?? 0) >= 3 || charge < 0 ? z - charge : z;
  effective = Math.max(1, Math.min(118, effective));
  const valences = VALENCE_LISTS[effective] ?? [-1];
  if (!valences.length || valences.includes(-1)) return null;
  return Math.max(...valences);
}

export function graphIssues(m: Molecule): Issue[] {
  const issues: Issue[] = [];
  const seen = new Map<string, number>();
  m.bonds.forEach((bond, idx) => {
    if (bond.a === bond.b) {
      issues.push(makeIssue("SELF_BOND", { atoms: [bond.a], bonds: [idx] }, { atom: bond.a }));
      return;
    }
    const lo = Math.min(bond.a, bond.b);
    const hi = Math.max(bond.a, bond.b);
    const key = `${lo}-${hi}`;
    const first = seen.get(key);
    if (first !== undefined) issues.push(makeIssue("DUPLICATE_BOND", { atoms: [lo, hi], bonds: [first, idx] }, { a: lo, b: hi }));
    else seen.set(key, idx);
  });
  for (const atom of m.atoms) {
    const z = atomicNumber(atom.el);
    if (z === undefined) {
      issues.push(makeIssue("UNKNOWN_ELEMENT", { atoms: [atom.i] }, { element: atom.el }));
      continue;
    }
    if (atom.isotope && !(KNOWN_ISOTOPES[z] ?? []).includes(atom.isotope)) {
      issues.push(makeIssue("ISOTOPE_UNKNOWN", { atoms: [atom.i] }, { isotope: atom.isotope, element: atom.el }));
    }
  }
  return issues;
}

/** RDKit's clean-up (MolOps::cleanUp) applied before its valence checks: nitro, P=O ylides, halogen oxides. */
function rdkitCleanUp(m: Molecule): Molecule {
  const atoms = m.atoms.map((a) => ({ ...a }));
  const bonds = m.bonds.map((b) => ({ ...b }));
  const work: Molecule = { ...m, atoms, bonds };
  const bondBetween = (i: number, j: number) => bonds.find((b) => (b.a === i && b.b === j) || (b.a === j && b.b === i));
  const neighbours = (i: number) => bonds.filter((b) => b.a === i || b.b === i).map((b) => (b.a === i ? b.b : b.a));
  const considered: number[] = [];
  atoms.forEach((atom, i) => {
    if (atom.el !== "N" || atom.charge || valenceInfo(work, i).explicit !== 5) return;
    considered.push(i);
    for (const n of neighbours(i)) {
      const bond = bondBetween(i, n)!;
      if (atoms[n]!.el === "O" && atoms[n]!.charge === 0 && bond.order === "double") {
        bond.order = "single";
        atom.charge = 1;
        atoms[n]!.charge = -1;
        break;
      }
    }
  });
  for (const i of considered) {
    for (const n of neighbours(i)) {
      const bond = bondBetween(i, n)!;
      if (atoms[n]!.el === "N" && atoms[n]!.charge === 0 && bond.order === "triple") {
        bond.order = "double";
        atoms[i]!.charge = 1;
        atoms[n]!.charge = -1;
        break;
      }
    }
  }
  atoms.forEach((atom, i) => {
    if (atom.el === "P" && !atom.charge && valenceInfo(work, i).explicit === 5 && neighbours(i).length === 3) {
      let doubleToO: Bond | undefined;
      let oxygen: Atom | undefined;
      let doubleToCN = false;
      for (const n of neighbours(i)) {
        const bond = bondBetween(i, n)!;
        const nb = atoms[n]!;
        if (nb.el === "O" && nb.charge === 0 && bond.order === "double") {
          doubleToO = bond;
          oxygen = nb;
        } else if ((nb.el === "C" || nb.el === "N") && neighbours(n).length >= 2 && bond.order === "double") {
          doubleToCN = true;
        }
      }
      if (doubleToCN && doubleToO && oxygen) {
        oxygen.charge = -1;
        doubleToO.order = "single";
        atom.charge = 1;
      }
    }
    if ((atom.el === "Cl" || atom.el === "Br" || atom.el === "I") && atom.charge === 0) {
      const ev = valenceInfo(work, i).explicit;
      if ((ev === 7 || ev === 5 || ev === 3) && neighbours(i).every((n) => atoms[n]!.el === "O")) {
        let charge = 0;
        for (const bond of bonds) {
          if ((bond.a === i || bond.b === i) && bond.order === "double") {
            bond.order = "single";
            charge += 1;
            atoms[bond.a === i ? bond.b : bond.a]!.charge = -1;
          }
        }
        atom.charge = charge;
      }
    }
  });
  return work;
}

function bondIndex(m: Molecule): Map<string, number> {
  const index = new Map<string, number>();
  m.bonds.forEach((b, i) => index.set(`${Math.min(b.a, b.b)}-${Math.max(b.a, b.b)}`, i));
  return index;
}

const ZERO_COORDS = (m: Molecule) => m.atoms.map(() => [0, 0, 0] as [number, number, number]);

/** Parse for chemistry checks the way the desktop builds its molecule: no coordinates, no stereo. */
export function parseForChemistry(m: Molecule): ReturnType<typeof parseWithLog> {
  return parseWithLog(toMolfile(m, { coords: ZERO_COORDS(m), dimension: "2D" }));
}

export interface ChemistryResult {
  issues: Issue[];
  /** The sanitised RDKit molecule (caller deletes it) and its perception, when RDKit accepts it. */
  mol: RDMol | null;
  perception: Perception | null;
}

function fragmentCount(m: Molecule): number {
  if (!m.atoms.length) return 0;
  const parent = m.atoms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const b of m.bonds) parent[find(b.a)] = find(b.b);
  return new Set(m.atoms.map((_, i) => find(i))).size;
}

function aromaticIssue(m: Molecule, atoms: number[]): Issue {
  const index = bondIndex(m);
  const bonds: number[] = [];
  for (let x = 0; x < atoms.length; x++)
    for (let y = x + 1; y < atoms.length; y++) {
      const key = `${Math.min(atoms[x]!, atoms[y]!)}-${Math.max(atoms[x]!, atoms[y]!)}`;
      if (index.has(key)) bonds.push(index.get(key)!);
    }
  bonds.sort((a, b) => a - b);
  return makeIssue("AROMATIC_INVALID", { atoms, bonds }, { atomList: atoms.map((a) => a + 1).join(", ") });
}

/** Elements RDKit's SMILES parser accepts as lowercase aromatic atoms. */
const AROMATIC_SMILES = new Set(["B", "C", "N", "O", "P", "S", "Se", "Te", "As"]);

/**
 * The molecule as an explicit SMILES for RDKit's Kekulé step: aromatic atoms bracketed with their
 * hydrogens and charges, every other atom a dummy ([*], no valence limit), so a valence problem
 * elsewhere cannot stop sanitisation before kekulisation. Returns RDKit's atom order.
 */
function explicitSmiles(m: Molecule): { smiles: string; order: number[] } | null {
  const aromaticAtoms = new Set<number>();
  for (const b of m.bonds) if (b.order === "aromatic") aromaticAtoms.add(b.a).add(b.b);
  if ([...aromaticAtoms].some((i) => !AROMATIC_SMILES.has(m.atoms[i]!.el))) return null;
  const adj = m.atoms.map(() => [] as [number, number][]);
  m.bonds.forEach((b, i) => {
    adj[b.a]!.push([b.b, i]);
    adj[b.b]!.push([b.a, i]);
  });
  const SYMBOL: Record<string, string> = { single: "-", double: "=", triple: "#", aromatic: ":" };
  const atomToken = (i: number) => {
    if (!aromaticAtoms.has(i)) return "[*]";
    const a = m.atoms[i]!;
    const h = implicitHydrogens(m, i);
    const sym = aromaticAtoms.has(i) ? a.el.toLowerCase() : a.el;
    const charge = a.charge ? `${a.charge > 0 ? "+" : "-"}${Math.abs(a.charge) > 1 ? Math.abs(a.charge) : ""}` : "";
    return `[${a.isotope ?? ""}${sym}${h ? `H${h > 1 ? h : ""}` : ""}${charge}]`;
  };
  const visited = new Array<boolean>(m.atoms.length).fill(false);
  const usedBond = new Array<boolean>(m.bonds.length).fill(false);
  const order: number[] = [];
  const ringLabel = new Map<number, number>();
  let nextLabel = 1;
  const closures = new Map<number, string[]>();
  // First pass: DFS tree, collecting ring-closure bonds.
  const parentBond = new Array<number>(m.atoms.length).fill(-1);
  const treeChildren = m.atoms.map(() => [] as [number, number][]);
  const ringBonds: number[] = [];
  const roots: number[] = [];
  for (let root = 0; root < m.atoms.length; root++) {
    if (visited[root]) continue;
    roots.push(root);
    const stack: number[] = [root];
    visited[root] = true;
    const seenOrder: number[] = [];
    while (stack.length) {
      const v = stack.pop()!;
      seenOrder.push(v);
      for (const [w, bond] of [...adj[v]!].reverse()) {
        if (usedBond[bond]) continue;
        usedBond[bond] = true;
        if (!visited[w]) {
          visited[w] = true;
          parentBond[w] = bond;
          treeChildren[v]!.push([w, bond]);
          stack.push(w);
        } else {
          ringBonds.push(bond);
        }
      }
    }
  }
  for (const bond of ringBonds) {
    const b = m.bonds[bond]!;
    const label = nextLabel++;
    ringLabel.set(bond, label);
    for (const end of [b.a, b.b]) closures.set(end, [...(closures.get(end) ?? []), `${SYMBOL[b.order] ?? "-"}${label < 10 ? label : `%${label}`}`]);
  }
  const write = (v: number): string => {
    order.push(v);
    let out = atomToken(v) + (closures.get(v) ?? []).join("");
    const children = treeChildren[v]!;
    children.forEach(([w, bond], k) => {
      const branch = `${SYMBOL[m.bonds[bond]!.order] ?? "-"}${write(w)}`;
      out += k < children.length - 1 ? `(${branch})` : branch;
    });
    return out;
  };
  const smiles = roots.map((r) => write(r)).join(".");
  return { smiles, order };
}

/**
 * RDKit's Kekulé check on the drawn structure, independent of valence problems (as
 * detectChemistryProblems runs it): the failing atoms, null if none, undefined if not testable.
 */
function kekulizeProblem(m: Molecule): number[] | null | undefined {
  if (!m.bonds.some((b) => b.order === "aromatic")) return null;
  const written = explicitSmiles(m);
  const R = rdkit();
  const log = captureLog();
  if (!written) {
    // Elements SMILES cannot write as aromatic (exotic, e.g. an aromatic bond to Br): only the
    // non-ring check is possible here. (Parsing an unsanitised molfile can crash RDKit's
    // WebAssembly build, so it is not used.)
    const nonRing = nonRingAromaticAtom(m);
    return nonRing !== null ? [nonRing] : null;
  }
  // A sanitising parse: RDKit catches its own errors (no exception reaches JavaScript, which would
  // leak memory inside the WebAssembly module) and logs why.
  log.clear();
  const mol = R.get_mol(written.smiles, JSON.stringify({ removeHs: false }));
  if (mol) {
    mol.delete();
    return null;
  }
  const text = log.read();
  const kek = /Can't kekulize mol\.\s+Unkekulized atoms:\s*([\d\s]+)/.exec(text);
  const nonRing = /non-ring atom (\d+) marked aromatic/.exec(text);
  // RDKit names the atoms in its own (here: the desktop's) index order.
  if (kek) return kek[1]!.trim().split(/\s+/).map((i) => written.order[Number(i)]!).sort((a, b) => a - b);
  if (nonRing) {
    const first = nonRingAromaticAtom(m);
    return [first ?? written.order[Number(nonRing[1])]!];
  }
  // Sanitisation stopped earlier (an aromatic atom's own valence): ring systems cannot be tested
  // here, but RDKit's next check, aromatic atoms outside any ring, can.
  const first = nonRingAromaticAtom(m);
  return first !== null ? [first] : null;
}

/** Atoms in at least one ring (an edge on a cycle), by removing bridges. */
function ringAtoms(m: Molecule): Set<number> {
  const n = m.atoms.length;
  const adj = m.atoms.map(() => [] as [number, number][]);
  m.bonds.forEach((b, i) => {
    if (b.a === b.b) return;
    adj[b.a]!.push([b.b, i]);
    adj[b.b]!.push([b.a, i]);
  });
  const disc = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const bridges = new Set<number>();
  let time = 0;
  for (let root = 0; root < n; root++) {
    if (disc[root] !== -1) continue;
    const stack: [number, number, number][] = [[root, -1, 0]];
    disc[root] = low[root] = time++;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const [v, viaBond, k] = top;
      if (k < adj[v]!.length) {
        top[2] += 1;
        const [w, bond] = adj[v]![k]!;
        if (bond === viaBond) continue;
        if (disc[w] === -1) {
          disc[w] = low[w] = time++;
          stack.push([w, bond, 0]);
        } else low[v] = Math.min(low[v]!, disc[w]!);
      } else {
        stack.pop();
        if (stack.length) {
          const parent = stack[stack.length - 1]![0];
          low[parent] = Math.min(low[parent]!, low[v]!);
          if (low[v]! > disc[parent]!) bridges.add(viaBond);
        }
      }
    }
  }
  const inRing = new Set<number>();
  m.bonds.forEach((b, i) => {
    if (b.a !== b.b && !bridges.has(i)) {
      inRing.add(b.a);
      inRing.add(b.b);
    }
  });
  return inRing;
}

function nonRingAromaticAtom(m: Molecule): number | null {
  const aromatic = new Set<number>();
  for (const b of m.bonds) if (b.order === "aromatic") aromatic.add(b.a).add(b.b);
  if (!aromatic.size) return null;
  const ring = ringAtoms(m);
  const offenders = [...aromatic].filter((i) => !ring.has(i)).sort((a, b) => a - b);
  return offenders.length ? offenders[0]! : null;
}

export function chemistryIssues(m: Molecule): ChemistryResult {
  const issues: Issue[] = [];
  const weights: Record<string, number> = { single: 1, double: 2, triple: 3, aromatic: 1.5 };
  const valenceSum = new Array<number>(m.atoms.length).fill(0);
  for (const b of m.bonds) {
    valenceSum[b.a]! += weights[b.order] ?? 1;
    valenceSum[b.b]! += weights[b.order] ?? 1;
  }
  const cleaned = rdkitCleanUp(m);
  const valenceProblems = new Set<number>();
  cleaned.atoms.forEach((_, idx) => {
    if (valenceInfo(cleaned, idx).exceeded) valenceProblems.add(idx);
  });
  const valenceIssue = (idx: number) => {
    const atom = m.atoms[idx]!;
    const allowed = maxValence(atom.el, atom.charge);
    return makeIssue("VALENCE_EXCEEDED", { atoms: [idx] }, {
      element: atom.el, atom: idx, valence: roundHalfEven(valenceSum[idx]!) + (atom.hCount ?? 0),
      allowed: allowed ?? "?", charge: atom.charge,
    });
  };
  for (const idx of [...valenceProblems].sort((a, b) => a - b)) issues.push(valenceIssue(idx));
  // RDKit kekulises after the valence checks whatever they found (detectChemistryProblems).
  const kekule = kekulizeProblem(cleaned);
  if (kekule === undefined) {
    const nonRing = nonRingAromaticAtom(m);
    if (nonRing !== null) issues.push(makeIssue("AROMATIC_INVALID", { atoms: [nonRing], bonds: [] }, { atomList: String(nonRing + 1) }));
  } else if (kekule !== null) {
    issues.push(aromaticIssue(m, kekule));
  }
  if (issues.length) return { issues, mol: null, perception: null };
  const parsed = parseForChemistry(m);
  if (!parsed.ok) {
    const index = bondIndex(m);
    for (const line of parsed.errors) {
      const kek = /Can't kekulize mol\.\s+Unkekulized atoms:\s*([\d\s]+)/.exec(line);
      const nonRing = /non-ring atom (\d+) marked aromatic/.exec(line);
      const valence = /Explicit valence for atom # (\d+)/.exec(line);
      if (kek || nonRing) {
        const atoms = kek ? kek[1]!.trim().split(/\s+/).map(Number) : [Number(nonRing![1])];
        if (issues.some((i) => i.code === "AROMATIC_INVALID" && i.atoms.join() === atoms.join())) continue;
        void index;
        issues.push(aromaticIssue(m, atoms));
      } else if (valence && !issues.some((i) => i.code === "VALENCE_EXCEEDED")) {
        issues.push(valenceIssue(Number(valence[1])));
      }
    }
    if (!issues.length) {
      throw new RpcFailure(CHEMISTRY_ERROR, `Structure could not be sanitized: ${parsed.errors.at(-1) ?? "unknown error"}`, { code: "SANITIZE_FAILED" });
    }
    return { issues, mol: null, perception: null };
  }
  const perception = perceive(parsed.mol);
  perception.atoms.forEach((rd, idx) => {
    const atom = m.atoms[idx]!;
    if (rd.radicals) {
      if (atom.hCount !== null && atom.hCount !== undefined && rd.z > 1) {
        issues.push(makeIssue("UNDERSATURATED", { atoms: [idx] }, { element: atom.el, atom: idx }));
      } else {
        issues.push(makeIssue("RADICAL", { atoms: [idx] }, { element: atom.el, atom: idx, radicals: rd.radicals }));
      }
    }
    const dv = defaultValence(rd.z);
    if (dv > 0 && rd.charge === 0 && rd.totalValence > dv && (OUTER_ELECTRONS[rd.z] ?? 0) >= 5 && rd.z > 10) {
      issues.push(makeIssue("HYPERVALENT", { atoms: [idx] }, { element: atom.el, atom: idx, valence: rd.totalValence }));
    }
    if (Math.abs(atom.charge) >= 3 && rd.z <= 54 && !elements.isMetal(atom.el)) {
      issues.push(makeIssue("CHARGE_UNUSUAL", { atoms: [idx] }, { element: atom.el, atom: idx, charge: atom.charge }));
    }
  });
  const fragments = fragmentCount(m);
  if (fragments > 1) issues.push(makeIssue("FRAGMENTS", {}, { count: fragments }));
  return { issues, mol: parsed.mol, perception };
}

const dist = (p: Atom, q: Atom) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

/** Pairs of atoms closer than `cutoff`, via a uniform grid (the desktop uses a k-d tree). */
export function closePairs(points: [number, number, number][], cutoff: number): [number, number][] {
  const cell = (v: number) => Math.floor(v / cutoff);
  const grid = new Map<string, number[]>();
  points.forEach(([x, y, z], i) => {
    const key = `${cell(x)},${cell(y)},${cell(z)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });
  const pairs: [number, number][] = [];
  points.forEach(([x, y, z], i) => {
    const cx = cell(x), cy = cell(y), cz = cell(z);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j <= i) continue;
            const [px, py, pz] = points[j]!;
            if (Math.hypot(px - x, py - y, pz - z) <= cutoff) pairs.push([i, j]);
          }
        }
  });
  return pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

const round3 = (x: number) => pyRound(x, 3);

export function geometryIssues(m: Molecule): Issue[] {
  if (m.atoms.length < 2 || !isThreeD(m)) return [];
  const issues: Issue[] = [];
  const neighbours = m.atoms.map(() => new Set<number>());
  for (const b of m.bonds) {
    if (b.a !== b.b) {
      neighbours[b.a]!.add(b.b);
      neighbours[b.b]!.add(b.a);
    }
  }
  m.bonds.forEach((bond, idx) => {
    if (bond.a === bond.b) return;
    const a = m.atoms[bond.a]!;
    const b = m.atoms[bond.b]!;
    const length = dist(a, b);
    const expected = elements.expectedBondLength(a.el, b.el, bond.order);
    if (length < OVERLAP_LIMIT) {
      issues.push(makeIssue("ATOMS_OVERLAP", { atoms: [bond.a, bond.b], bonds: [idx] }, { a: bond.a, b: bond.b, distance: round3(length) }));
    } else if (length > expected * (1 + BOND_TOLERANCE)) {
      issues.push(makeIssue("BOND_TOO_LONG", { atoms: [bond.a, bond.b], bonds: [idx] }, { a: bond.a, b: bond.b, length: round3(length), expected: round3(expected) }));
    } else if (length < expected * (1 - BOND_TOLERANCE)) {
      issues.push(makeIssue("BOND_TOO_SHORT", { atoms: [bond.a, bond.b], bonds: [idx] }, { a: bond.a, b: bond.b, length: round3(length), expected: round3(expected) }));
    }
  });
  if (m.atoms.length <= 4000) {
    const points = m.atoms.map((a) => [a.x, a.y, a.z] as [number, number, number]);
    for (const [i, j] of closePairs(points, CLASH_LIMIT)) {
      if (neighbours[i]!.has(j) || [...neighbours[i]!].some((n) => neighbours[j]!.has(n))) continue;
      const distance = dist(m.atoms[i]!, m.atoms[j]!);
      const code = distance < OVERLAP_LIMIT ? "ATOMS_OVERLAP" : "CLASH";
      issues.push(makeIssue(code, { atoms: [i, j] }, { a: i, b: j, distance: round3(distance), limit: CLASH_LIMIT }));
    }
  }
  return issues;
}

export interface Detection {
  issues: Issue[];
  mol: RDMol | null;
  perception: Perception | null;
}

/** All issues; the caller owns (and must delete) the returned RDKit molecule. */
export function detect(m: Molecule, geometry = true): Detection {
  const issues = graphIssues(m);
  let mol: RDMol | null = null;
  let perception: Perception | null = null;
  if (!issues.some((i) => ["SELF_BOND", "DUPLICATE_BOND", "UNKNOWN_ELEMENT"].includes(i.code))) {
    const chem = chemistryIssues(m);
    issues.push(...chem.issues);
    mol = chem.mol;
    perception = chem.perception;
  }
  if (geometry && !issues.some((i) => ["SELF_BOND", "UNKNOWN_ELEMENT"].includes(i.code))) issues.push(...geometryIssues(m));
  return { issues, mol, perception };
}

function detectIssues(m: Molecule, geometry = true): Issue[] {
  const d = detect(m, geometry);
  d.mol?.delete();
  return d.issues;
}

// ---------------------------------------------------------------------------
// Auto-correction
// ---------------------------------------------------------------------------

interface FixState {
  molecule: Molecule;
  atomMap: number[];
  log: Record<string, unknown>[];
  ops: Record<string, unknown>[];
}

function snapshotAtom(m: Molecule, idx: number): Record<string, unknown> {
  const atom = m.atoms[idx]!;
  const bonds = m.bonds.filter((b) => b.a === idx || b.b === idx).map((b) => ({ to: b.a === idx ? b.b : b.a, order: b.order }));
  return { atom: idx, element: atom.el, charge: atom.charge, hCount: atom.hCount ?? null, bonds };
}

function snapshotBond(m: Molecule, idx: number): Record<string, unknown> {
  const bond = m.bonds[idx]!;
  return { bond: idx, a: bond.a, b: bond.b, order: bond.order };
}

function setBondOrder(m: Molecule, idx: number, order: Bond["order"]): Molecule {
  return { ...m, bonds: m.bonds.map((b, i) => (i === idx ? { ...b, order } : b)) };
}

function removeBond(m: Molecule, idx: number): Molecule {
  return { ...m, bonds: m.bonds.filter((_, i) => i !== idx) };
}

function setAtom(m: Molecule, idx: number, changes: Partial<Atom>): Molecule {
  return { ...m, atoms: m.atoms.map((a, i) => (i === idx ? { ...a, ...changes } : a)) };
}

function removeAtom(m: Molecule, idx: number): [Molecule, number[]] {
  const mapping = m.atoms.map((_, i) => (i < idx ? i : i === idx ? -1 : i - 1));
  const atoms = m.atoms.filter((a) => a.i !== idx).map((a) => ({ ...a, i: mapping[a.i]! }));
  const bonds = m.bonds.filter((b) => b.a !== idx && b.b !== idx).map((b) => ({ ...b, a: mapping[b.a]!, b: mapping[b.b]! }));
  return [{ ...m, atoms, bonds }, mapping];
}

function errorCount(m: Molecule): number {
  return detectIssues(m, false).filter((i) => i.severity === "error").length;
}

function atomErrors(m: Molecule, idx: number): boolean {
  return detectIssues(m, false).some((i) => i.severity === "error" && i.atoms.includes(idx));
}

function record(
  state: FixState,
  reason: Issue | string,
  op: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Molecule,
  afterRef: ["atom" | "bond" | "removed", number] | null,
  describe: Params,
  reasonParams?: Params,
): void {
  const code = typeof reason === "string" ? reason : reason.code;
  const params = reasonParams ?? (typeof reason === "string" ? {} : { ...reason.params });
  let afterSnapshot: Record<string, unknown> = {};
  if (afterRef) {
    const [kind, ref] = afterRef;
    if (kind === "atom" && ref >= 0 && ref < after.atoms.length) afterSnapshot = snapshotAtom(after, ref);
    else if (kind === "bond" && ref >= 0 && ref < after.bonds.length) afterSnapshot = snapshotBond(after, ref);
    else if (kind === "removed") afterSnapshot = { removed: true };
  }
  state.ops.push(op);
  state.log.push({
    before, reason: code, reasonParams: params, after: afterSnapshot,
    fix: { ...op, description: describeFix(String(op["op"]), describe), params: displayParams(describe) },
  });
}

const orderRank = (order: string) => ({ triple: 3, double: 2, aromatic: 1.5 } as Record<string, number>)[order] ?? 1;

function bondLength(m: Molecule, idx: number): number {
  const b = m.bonds[idx]!;
  return dist(m.atoms[b.a]!, m.atoms[b.b]!);
}

function fixValence(state: FixState, issue: Issue, focusBonds: Set<number>): boolean {
  const m = state.molecule;
  const idx = issue.atoms[0]!;
  const atom = m.atoms[idx]!;
  const before = snapshotAtom(m, idx);
  const incident = m.bonds.map((b, i) => [b, i] as const).filter(([b]) => b.a === idx || b.b === idx).map(([, i]) => i);
  const focus = incident.filter((i) => focusBonds.has(i));

  // 1. Free a valence by removing a terminal explicit hydrogen.
  if (atom.el !== "H") {
    const hBonds = incident.filter((i) => {
      const b = m.bonds[i]!;
      return m.atoms[b.b === idx ? b.a : b.b]!.el === "H" && !focusBonds.has(i);
    });
    for (const bondIdx of [...hBonds].reverse()) {
      const bond = m.bonds[bondIdx]!;
      const hIdx = bond.a === idx ? bond.b : bond.a;
      if (m.bonds.filter((b) => b.a === hIdx || b.b === hIdx).length !== 1) continue;
      const [candidate, mapping] = removeAtom(m, hIdx);
      const newIdx = mapping[idx]!;
      if (!atomErrors(candidate, newIdx)) {
        state.molecule = candidate;
        state.atomMap = state.atomMap.map((i) => (i >= 0 ? mapping[i]! : -1));
        record(state, issue, { op: "removeAtom", atom: hIdx }, before, candidate, ["atom", newIdx], { atom: hIdx });
        return true;
      }
      break;
    }
  }

  // 2. Reduce an explicitly specified hydrogen count.
  if (atom.hCount) {
    const candidate = setAtom(m, idx, { hCount: atom.hCount - 1 });
    if (!atomErrors(candidate, idx)) {
      state.molecule = candidate;
      record(state, issue, { op: "setHCount", atom: idx, hCount: atom.hCount - 1 }, before, candidate, ["atom", idx],
        { element: atom.el, atom: idx, hCount: atom.hCount - 1 });
      return true;
    }
  }

  // 3. Lower the order of the bond that was just drawn.
  for (const bondIdx of focus) {
    const bond = m.bonds[bondIdx]!;
    let order = bond.order;
    while (STEP_DOWN[order]) {
      order = STEP_DOWN[order]!;
      const candidate = setBondOrder(m, bondIdx, order);
      if (!atomErrors(candidate, idx)) {
        state.molecule = candidate;
        record(state, issue, { op: "setBondOrder", bond: bondIdx, order }, snapshotBond(m, bondIdx), candidate, ["bond", bondIdx],
          { a: bond.a, b: bond.b, from: bond.order, to: order });
        return true;
      }
    }
  }

  // 4. Standard onium / -ate charge (e.g. NR4+, BF4-) when exactly one bond too many.
  const charges = [...(ONIUM_PLUS.has(atom.el) ? [1] : []), ...(ATE_MINUS.has(atom.el) ? [-1] : [])];
  for (const charge of charges) {
    if (atom.charge !== 0) break;
    const candidate = setAtom(m, idx, { charge });
    if (!atomErrors(candidate, idx)) {
      state.molecule = candidate;
      record(state, issue, { op: "setCharge", atom: idx, charge }, before, candidate, ["atom", idx], { element: atom.el, atom: idx, charge });
      return true;
    }
  }

  // 5. Lower the highest-order bond on the atom.
  const ranked = [...incident].sort((p, q) => orderRank(m.bonds[q]!.order) - orderRank(m.bonds[p]!.order));
  for (const bondIdx of ranked) {
    const bond = m.bonds[bondIdx]!;
    const order = STEP_DOWN[bond.order];
    if (!order) continue;
    const candidate = setBondOrder(m, bondIdx, order);
    if (errorCount(candidate) < errorCount(m)) {
      state.molecule = candidate;
      record(state, issue, { op: "setBondOrder", bond: bondIdx, order }, snapshotBond(m, bondIdx), candidate, ["bond", bondIdx],
        { a: bond.a, b: bond.b, from: bond.order, to: order });
      return true;
    }
  }

  // 6. Remove the newest offending bond (focus first, otherwise the longest bond).
  const removal = focus.length ? focus : [...incident].sort((p, q) => bondLength(m, q) - bondLength(m, p));
  for (const bondIdx of removal) {
    const bond = m.bonds[bondIdx]!;
    const candidate = removeBond(m, bondIdx);
    if (errorCount(candidate) < errorCount(m)) {
      state.molecule = candidate;
      record(state, issue, { op: "removeBond", bond: bondIdx }, snapshotBond(m, bondIdx), candidate, ["removed", bondIdx], { a: bond.a, b: bond.b });
      return true;
    }
  }
  return false;
}

/** Single/double orders for the given aromatic bonds giving every atom at most one double bond, maximising doubles. */
function kekuleAssignment(m: Molecule, bondIds: number[]): Map<number, Bond["order"]> | null {
  const ids = [...bondIds].sort((a, b) => a - b);
  if (ids.length > 22) return null;
  let best: [number, Map<number, Bond["order"]>] | null = null;
  const chosen = new Map<number, Bond["order"]>();
  const search = (k: number, used: Set<number>, doubles: number) => {
    if (k === ids.length) {
      if (best === null || doubles > best[0]) best = [doubles, new Map(chosen)];
      return;
    }
    const bond = m.bonds[ids[k]!]!;
    if (!used.has(bond.a) && !used.has(bond.b)) {
      chosen.set(ids[k]!, "double");
      search(k + 1, new Set([...used, bond.a, bond.b]), doubles + 1);
    }
    chosen.set(ids[k]!, "single");
    search(k + 1, used, doubles);
  };
  search(0, new Set(), 0);
  return best ? (best as [number, Map<number, Bond["order"]>])[1] : null;
}

function fixAromatic(state: FixState, issue: Issue): boolean {
  const m = state.molecule;
  const atoms = issue.atoms;
  // 1. Pyrrole-type nitrogen needs an explicit hydrogen ([nH]).
  for (const idx of atoms) {
    const atom = m.atoms[idx]!;
    if (atom.el === "N" && (atom.hCount === null || atom.hCount === undefined) && atom.charge === 0) {
      const degree = m.bonds.filter((b) => b.a === idx || b.b === idx).length;
      if (degree === 2) {
        const candidate = setAtom(m, idx, { hCount: 1 });
        if (errorCount(candidate) < errorCount(m)) {
          state.molecule = candidate;
          record(state, issue, { op: "setHCount", atom: idx, hCount: 1 }, snapshotAtom(m, idx), candidate, ["atom", idx], { element: "N", atom: idx, hCount: 1 });
          return true;
        }
      }
    }
  }
  // 2. Replace the aromatic flags with an explicit Kekulé structure.
  const aromaticBonds = m.bonds.map((b, i) => [b, i] as const).filter(([b]) => b.order === "aromatic" && (atoms.includes(b.a) || atoms.includes(b.b))).map(([, i]) => i);
  const assignment = kekuleAssignment(m, aromaticBonds);
  if (!assignment) return false;
  let candidate = m;
  for (const [bondIdx, order] of assignment) candidate = setBondOrder(candidate, bondIdx, order);
  if (errorCount(candidate) < errorCount(m)) {
    const before = { bonds: aromaticBonds.map((i) => snapshotBond(m, i)) };
    state.molecule = candidate;
    const op = { op: "kekulize", bonds: Object.fromEntries([...assignment].map(([k, v]) => [String(k), v])) };
    const numbers = [...atoms].sort((a, b) => a - b).map((a) => a + 1).join(", ");
    state.ops.push(op);
    state.log.push({
      before, reason: issue.code, reasonParams: { ...issue.params },
      fix: { ...op, description: describeFix("kekulize", { atoms: numbers }), params: { atoms: numbers } },
      after: { bonds: aromaticBonds.map((i) => snapshotBond(candidate, i)) },
    });
    return true;
  }
  return false;
}

function applyFix(state: FixState, issue: Issue, focusBonds: Set<number>): boolean {
  const m = state.molecule;
  if (issue.code === "SELF_BOND" || issue.code === "DUPLICATE_BOND") {
    const idx = issue.code === "SELF_BOND" ? issue.bonds[0]! : issue.bonds[issue.bonds.length - 1]!;
    const bond = m.bonds[idx]!;
    state.molecule = removeBond(m, idx);
    record(state, issue, { op: "removeBond", bond: idx }, snapshotBond(m, idx), state.molecule, ["removed", idx], { a: bond.a, b: bond.b });
    return true;
  }
  if (issue.code === "ISOTOPE_UNKNOWN") {
    const idx = issue.atoms[0]!;
    const before = snapshotAtom(m, idx);
    state.molecule = setAtom(m, idx, { isotope: null });
    record(state, issue, { op: "clearIsotope", atom: idx }, before, state.molecule, ["atom", idx], { atom: idx });
    return true;
  }
  if (issue.code === "UNDERSATURATED") {
    const idx = issue.atoms[0]!;
    const before = snapshotAtom(m, idx);
    state.molecule = setAtom(m, idx, { hCount: null });
    record(state, issue, { op: "setHCount", atom: idx, hCount: null }, before, state.molecule, ["atom", idx], { element: m.atoms[idx]!.el, atom: idx, hCount: "auto" });
    return true;
  }
  if (issue.code === "VALENCE_EXCEEDED") return fixValence(state, issue, focusBonds);
  if (issue.code === "AROMATIC_INVALID") return fixAromatic(state, issue);
  return false;
}

const round6 = (x: number) => pyRound(x, 6);

function snapFocusGeometry(state: FixState, focusBonds: number[]): void {
  let m = state.molecule;
  if (!isThreeD(m)) return;
  const degree = new Array<number>(m.atoms.length).fill(0);
  for (const b of m.bonds) {
    degree[b.a]! += 1;
    degree[b.b]! += 1;
  }
  for (const idx of [...focusBonds].sort((a, b) => a - b)) {
    if (idx >= m.bonds.length) continue;
    const bond = m.bonds[idx]!;
    const endA = m.atoms[bond.a]!;
    const endB = m.atoms[bond.b]!;
    const expected = elements.expectedBondLength(endA.el, endB.el, bond.order);
    const length = bondLength(m, idx);
    if (Math.abs(length - expected) / expected <= BOND_TOLERANCE) continue;
    const [move, anchor] = degree[bond.b] === 1 ? [endB, endA] : degree[bond.a] === 1 ? [endA, endB] : [null, null];
    if (!move || !anchor) continue;
    const vec = [move.x - anchor.x, move.y - anchor.y, move.z - anchor.z];
    const norm = Math.hypot(vec[0]!, vec[1]!, vec[2]!);
    const dir = norm > 1e-6 ? vec.map((v) => v / norm) : [1, 0, 0];
    const target = [anchor.x + dir[0]! * expected, anchor.y + dir[1]! * expected, anchor.z + dir[2]! * expected];
    const before = snapshotAtom(m, move.i);
    m = setAtom(m, move.i, { x: round6(target[0]!), y: round6(target[1]!), z: round6(target[2]!) });
    state.molecule = m;
    record(state, length > expected ? "BOND_TOO_LONG" : "BOND_TOO_SHORT",
      { op: "moveAtom", atom: move.i, x: target[0], y: target[1], z: target[2] }, before, m, ["atom", move.i],
      { atom: move.i, length: round3(expected) },
      displayParams({ a: bond.a, b: bond.b, length: round3(length), expected: round3(expected) }));
  }
}

function entityResults(m: Molecule, issues: Issue[], focusAtoms: number[], focusBonds: number[]) {
  const bonds = focusBonds.length ? focusBonds : m.bonds.map((_, i) => i);
  const atoms = focusAtoms.length ? focusAtoms : m.atoms.map((_, i) => i);
  const results: { kind: "bond" | "atom"; index: number; valid: boolean; reasons: string[]; explanation: string }[] = [];
  for (const idx of bonds) {
    if (idx >= m.bonds.length) continue;
    const bond = m.bonds[idx]!;
    const related = issues.filter((i) => i.severity !== "info" && (i.bonds.includes(idx) || i.atoms.includes(bond.a) || i.atoms.includes(bond.b)));
    results.push({
      kind: "bond", index: idx, valid: !related.some((i) => i.severity === "error"),
      reasons: related.length ? related.map((i) => i.code) : ["VALID"],
      explanation: related.map((i) => i.message).join("; ") || "Bond connected correctly.",
    });
  }
  for (const idx of atoms) {
    if (idx >= m.atoms.length) continue;
    const related = issues.filter((i) => i.severity !== "info" && i.atoms.includes(idx));
    results.push({
      kind: "atom", index: idx, valid: !related.some((i) => i.severity === "error"),
      reasons: related.length ? related.map((i) => i.code) : ["VALID"],
      explanation: related.map((i) => i.message).join("; ") || "Atom valence is valid.",
    });
  }
  return results;
}

const issueKey = (i: Issue) => JSON.stringify([i.code, i.severity, i.message, i.atoms, i.bonds, i.params]);

export function validate(molecule: Molecule, focusAtoms: number[], focusBonds: number[], autoFix: boolean) {
  const started = performance.now();
  if (!molecule.atoms.length) {
    return {
      status: "valid" as const, messageKey: "validation.empty", message: "The canvas is empty.", results: [],
      issues: [makeIssue("EMPTY")], fixes: [], ops: [], molecule, atomMap: [], durationMs: 0,
    };
  }
  const issues = detectIssues(molecule);
  const focusB = new Set(focusBonds);
  const state: FixState = { molecule, atomMap: molecule.atoms.map((_, i) => i), log: [], ops: [] };
  const errors = issues.filter((i) => i.severity === "error");
  const unfixable = new Set<string>();
  if (autoFix && errors.length) {
    for (let n = 0; n < 24; n++) {
      const current = detectIssues(state.molecule, false);
      const fixable = current.filter((i) => i.severity === "error" && FIXABLE.has(i.code) && !unfixable.has(issueKey(i)));
      if (!fixable.length) break;
      const focused = (i: Issue) => i.bonds.some((b) => focusB.has(b)) || i.atoms.some((a) => focusAtoms.includes(a));
      fixable.sort((p, q) => (focused(p) ? 0 : 1) - (focused(q) ? 0 : 1));
      const issue = fixable[0]!;
      if (!applyFix(state, issue, focusB)) unfixable.add(issueKey(issue));
    }
  }
  if (autoFix) snapFocusGeometry(state, [...focusB].filter((b) => b < state.molecule.bonds.length));
  const final = detect(state.molecule);
  const finalErrors = final.issues.filter((i) => i.severity === "error");
  let status: "valid" | "fixed" | "invalid";
  let key: string;
  let message: string;
  if (state.log.length && !finalErrors.length) [status, key, message] = ["fixed", "validation.fixed", "Bond connection fixed successfully."];
  else if (finalErrors.length) [status, key, message] = ["invalid", "validation.invalid", finalErrors[0]!.message];
  else [status, key, message] = ["valid", "validation.valid", "Bond connected correctly."];
  const results = entityResults(molecule, issues, focusAtoms, focusBonds);
  let resultMolecule = state.molecule;
  if (final.mol) {
    resultMolecule = annotate(state.molecule, final.mol);
    final.mol.delete();
  }
  return {
    status, messageKey: key, message, results, issues: final.issues, initialIssues: issues, fixes: state.log, ops: state.ops,
    molecule: resultMolecule, atomMap: state.atomMap, durationMs: Math.round(performance.now() - started),
  };
}

const HYBRID_LABEL: Record<string, string> = { s: "S", sp: "SP", sp2: "SP2", sp3: "SP3", sp3d: "SP3D", sp3d2: "SP3D2", "": "UNSPECIFIED" };

/** Report every issue and return the sanitised molecule (aromaticity perceived, metadata filled). */
export function sanitize(molecule: Molecule) {
  const d = detect(molecule);
  const valid = !d.issues.some((i) => i.severity === "error");
  let sanitized = molecule;
  let atoms: { atom: number; implicitH: number; hybridization: string }[] = [];
  if (d.mol && d.perception) {
    const perception = d.perception;
    const bonds = molecule.bonds.map((bond, i) => ({
      ...bond,
      order: perception.aromaticBonds.has(i) ? ("aromatic" as const) : bond.order !== "aromatic" ? bond.order : ("single" as const),
    }));
    sanitized = annotate({ ...molecule, bonds }, d.mol);
    atoms = perception.atoms.map((a, i) => ({ atom: i, implicitH: molecule.atoms[i]!.hCount === null || molecule.atoms[i]!.hCount === undefined ? a.hs : 0, hybridization: HYBRID_LABEL[a.hybridization] ?? "UNSPECIFIED" }));
    d.mol.delete();
  }
  return { valid, issues: d.issues, molecule: sanitized, atoms };
}
