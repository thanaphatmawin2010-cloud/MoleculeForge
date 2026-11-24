/**
 * OpenChemLib (BSD-3-Clause) supplies what RDKit's WebAssembly build lacks: 3D conformers and the
 * MMFF94/MMFF94s force fields. Molecules are handed over with every hydrogen explicit and with
 * heavy atoms first, because OpenChemLib moves hydrogens to the end of its atom list; the index
 * maps below translate between the two orders.
 */
import * as OCL from "openchemlib";

type OclMolecule = InstanceType<typeof OCL.Molecule>;

let resourcesReady: Promise<void> | null = null;

/** Register OpenChemLib's force-field and torsion tables (a URL in the browser, the package in Node). */
export function loadOCL(resourcesUrl?: string): Promise<void> {
  resourcesReady ??= (async () => {
    if (resourcesUrl) {
      const response = await fetch(resourcesUrl);
      if (!response.ok) throw new Error(`could not load OpenChemLib resources (${response.status})`);
      OCL.Resources.register(await response.text());
    } else {
      OCL.Resources.registerFromNodejs();
    }
  })();
  return resourcesReady;
}

export type Vec3 = [number, number, number];

export interface OclAtom {
  z: number;
  charge: number;
  isotope: number;
  pos: Vec3;
}

export interface OclBond {
  a: number;
  b: number;
  /** Kekulé order: 1, 2 or 3. */
  order: number;
}

export interface OclBuild {
  mol: OclMolecule;
  /** input atom index -> OpenChemLib atom index */
  toOcl: number[];
}

const BOND_TYPE = () => [OCL.Molecule.cBondTypeSingle, OCL.Molecule.cBondTypeSingle, OCL.Molecule.cBondTypeDouble, OCL.Molecule.cBondTypeTriple];

export function build(atoms: OclAtom[], bonds: OclBond[]): OclBuild {
  const mol = new OCL.Molecule(atoms.length, bonds.length);
  const order = [...atoms.keys()].sort((i, j) => Number(atoms[i]!.z === 1) - Number(atoms[j]!.z === 1) || i - j);
  const toOcl = new Array<number>(atoms.length);
  for (const i of order) {
    const a = atoms[i]!;
    const k = mol.addAtom(a.z);
    toOcl[i] = k;
    mol.setAtomX(k, a.pos[0]);
    mol.setAtomY(k, a.pos[1]);
    mol.setAtomZ(k, a.pos[2]);
    if (a.charge) mol.setAtomCharge(k, a.charge);
    if (a.isotope) mol.setAtomMass(k, a.isotope);
  }
  const types = BOND_TYPE();
  for (const b of bonds) {
    const k = mol.addBond(toOcl[b.a]!, toOcl[b.b]!);
    mol.setBondType(k, types[b.order] ?? OCL.Molecule.cBondTypeSingle);
  }
  return { mol, toOcl };
}

export function positions(b: OclBuild): Vec3[] {
  return b.toOcl.map((k) => [b.mol.getAtomX(k), b.mol.getAtomY(k), b.mol.getAtomZ(k)]);
}

export function setPositions(b: OclBuild, pos: Vec3[]): void {
  pos.forEach(([x, y, z], i) => {
    const k = b.toOcl[i]!;
    b.mol.setAtomX(k, x);
    b.mol.setAtomY(k, y);
    b.mol.setAtomZ(k, z);
  });
}

export type Variant = "MMFF94" | "MMFF94s";

export class ForceField {
  private ff: InstanceType<typeof OCL.ForceFieldMMFF94>;

  constructor(
    readonly built: OclBuild,
    readonly variant: Variant,
  ) {
    // Throws when MMFF has no atom type for some atom (e.g. most metals).
    this.ff = new OCL.ForceFieldMMFF94(built.mol, variant === "MMFF94s" ? OCL.ForceFieldMMFF94.MMFF94S : OCL.ForceFieldMMFF94.MMFF94);
  }

  energy(): number {
    return this.ff.getTotalEnergy();
  }

  /** Minimise for at most `steps` iterations; returns true when converged. */
  minimise(steps: number, gradTol = 1e-4, funcTol = 1e-7): boolean {
    return this.ff.minimise({ maxIts: steps, gradTol, funcTol }) === 0;
  }
}

/** Whether MMFF can type every atom of the structure. */
export function mmffCovers(b: OclBuild, variant: Variant = "MMFF94"): boolean {
  try {
    const ff = new ForceField(b, variant);
    return Number.isFinite(ff.energy());
  } catch {
    return false;
  }
}

/** One 3D conformer (OpenChemLib's torsion-library generator, fixed seed); null if none is found. */
export function conformer(b: OclBuild, seed = 0x5eed): Vec3[] | null {
  const generator = new OCL.ConformerGenerator(seed);
  const result = generator.getOneConformerAsMolecule(b.mol);
  if (!result || result.getAllAtoms() !== b.mol.getAllAtoms()) return null;
  return b.toOcl.map((k) => [result.getAtomX(k), result.getAtomY(k), result.getAtomZ(k)]);
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const add = (p: Vec3, q: Vec3): Vec3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const scale = (p: Vec3, s: number): Vec3 => [p[0] * s, p[1] * s, p[2] * s];
const norm = (p: Vec3) => Math.hypot(p[0], p[1], p[2]);
const unit = (p: Vec3): Vec3 => {
  const n = norm(p);
  return n > 1e-9 ? scale(p, 1 / n) : [1, 0, 0];
};
const cross = (p: Vec3, q: Vec3): Vec3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];

function perpendicular(v: Vec3): Vec3 {
  const trial: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(cross(v, trial));
}

/**
 * Starting positions for hydrogens added to an atom: spread away from its existing bonds at
 * roughly tetrahedral angles. They only seed the force field, which then places them properly
 * (RDKit's AddHs(addCoords=True) plays the same role in the desktop engine).
 */
export function hydrogenPositions(center: Vec3, neighbours: Vec3[], count: number, length = 1.05): Vec3[] {
  if (count <= 0) return [];
  const dirs = neighbours.map((p) => unit(sub(p, center)));
  let base: Vec3;
  if (!dirs.length) base = [0, 0, 1];
  else {
    const sum = dirs.reduce(add, [0, 0, 0] as Vec3);
    base = norm(sum) > 1e-3 ? unit(scale(sum, -1)) : perpendicular(dirs[0]!);
  }
  if (count === 1 && dirs.length) return [add(center, scale(base, length))];
  const u = perpendicular(base);
  const v = cross(base, u);
  const cone = dirs.length === 0 ? (count === 1 ? 0 : (109.47 * Math.PI) / 180 / 2 + 0.6) : (70.5 * Math.PI) / 180;
  const out: Vec3[] = [];
  for (let k = 0; k < count; k++) {
    const phi = (2 * Math.PI * k) / count + 0.137;
    const around = add(scale(u, Math.cos(phi)), scale(v, Math.sin(phi)));
    const dir = unit(add(scale(base, Math.cos(cone)), scale(around, Math.sin(cone))));
    out.push(add(center, scale(dir, length)));
  }
  return out;
}

/** Small seeded PRNG (mulberry32), so nudges and conformers are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nudge every atom by a tiny reproducible amount: exactly planar or linear sketches sit on saddle points. */
export function breakSymmetry(pos: Vec3[], amplitude = 0.02, seed = 0x5eed): Vec3[] {
  const r = rng(seed);
  const gauss = () => {
    const u = Math.max(r(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  return pos.map((p) => [p[0] + amplitude * gauss(), p[1] + amplitude * gauss(), p[2] + amplitude * gauss()]);
}
