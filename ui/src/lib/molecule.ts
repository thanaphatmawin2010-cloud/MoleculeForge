/**
 * Pure molecule-graph operations used by the editor. Every function returns a new
 * document; the editor store records them as undoable commands.
 */
import type { Atom, Bond, BondOrderT, Molecule } from "@/ipc/schema";

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Doc {
  molecule: Molecule;
  /** 2D sketch coordinates, index-aligned with molecule.atoms (view state, not chemistry). */
  layout: Vec2[];
}

export const BOND_2D = 1.5; // sketch units per bond

/** Pyykkö single-bond covalent radii (Å) for quick provisional 3D placement; refined by the sidecar. */
const COVALENT: Record<string, number> = {
  H: 0.32, He: 0.46, Li: 1.33, Be: 1.02, B: 0.85, C: 0.75, N: 0.71, O: 0.63, F: 0.64, Ne: 0.67, Na: 1.55, Mg: 1.39,
  Al: 1.26, Si: 1.16, P: 1.11, S: 1.03, Cl: 0.99, Ar: 0.96, K: 1.96, Ca: 1.71, Br: 1.14, I: 1.33, Se: 1.16, Fe: 1.16,
  Cu: 1.12, Zn: 1.18, Pt: 1.23, Au: 1.24, Ag: 1.28, Sn: 1.40, Ti: 1.36, Hg: 1.33, U: 1.70, Xe: 1.31, Kr: 1.17,
};
const ORDER_SHRINK: Record<BondOrderT, number> = { single: 1, aromatic: 0.93, double: 0.87, triple: 0.8 };

export const covalentRadius = (el: string) => COVALENT[el] ?? 1.3;
export const idealBondLength = (a: string, b: string, order: BondOrderT) =>
  (covalentRadius(a) + covalentRadius(b)) * ORDER_SHRINK[order];

export function emptyMolecule(id = newId()): Molecule {
  return {
    id,
    name: "",
    formula: "",
    atoms: [],
    bonds: [],
    props: {},
    meta: { smiles: "", inchi: "", inchikey: "", category: "", source: "user", created: new Date().toISOString(), stereo: "" },
  };
}

export function newId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `user-${Date.now().toString(36)}-${rand}`;
}

export const emptyDoc = (): Doc => ({ molecule: emptyMolecule(), layout: [] });

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 1e-9 ? scale(a, 1 / n) : [1, 0, 0];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export const pos3 = (atom: Atom): Vec3 => [atom.x, atom.y, atom.z];

export function neighbors(m: Molecule, i: number): number[] {
  const out: number[] = [];
  for (const b of m.bonds) {
    if (b.a === i) out.push(b.b);
    else if (b.b === i) out.push(b.a);
  }
  return out;
}

export function bondIndex(m: Molecule, a: number, b: number): number {
  return m.bonds.findIndex((bond) => (bond.a === a && bond.b === b) || (bond.a === b && bond.b === a));
}

/** A free direction around ``center`` pointing away from its existing bonds (VSEPR-like guess). */
export function freeDirection3D(m: Molecule, center: number): Vec3 {
  const c = pos3(m.atoms[center]!);
  const vecs = neighbors(m, center).map((n) => unit(sub(pos3(m.atoms[n]!), c)));
  if (vecs.length === 0) return [1, 0, 0];
  const sum = vecs.reduce<Vec3>((acc, v) => add(acc, v), [0, 0, 0]);
  const ref: Vec3 = Math.abs(vecs[0]![0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  if (vecs.length === 1) {
    // Tetrahedral-ish start (109.5°) rather than 180°: a perfectly linear guess is a saddle
    // point that a force-field minimiser cannot bend out of.
    const u = vecs[0]!;
    const p = unit(cross(u, ref));
    return unit(add(scale(u, -Math.cos((70.53 * Math.PI) / 180)), scale(p, Math.sin((70.53 * Math.PI) / 180))));
  }
  if (norm(sum) > 0.15) return unit(scale(sum, -1));
  // Opposing bonds (linear) or a symmetric set: choose a perpendicular direction.
  return unit(cross(vecs[0]!, ref));
}

export function freeDirection2D(doc: Doc, center: number): Vec2 {
  const c = doc.layout[center]!;
  const nbrs = neighbors(doc.molecule, center).map((n) => doc.layout[n]!);
  if (nbrs.length === 0) return [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const angles = nbrs.map((p) => Math.atan2(p[1] - c[1], p[0] - c[0])).sort((x, y) => x - y);
  if (angles.length === 1) {
    const out = angles[0]! + (2 * Math.PI) / 3;
    return [Math.cos(out), Math.sin(out)];
  }
  let bestGap = -1;
  let bestAngle = 0;
  for (let k = 0; k < angles.length; k++) {
    const a = angles[k]!;
    const b = k + 1 < angles.length ? angles[k + 1]! : angles[0]! + 2 * Math.PI;
    if (b - a > bestGap) {
      bestGap = b - a;
      bestAngle = a + (b - a) / 2;
    }
  }
  return [Math.cos(bestAngle), Math.sin(bestAngle)];
}

function withAtoms(doc: Doc, atoms: Atom[], bonds: Bond[], layout: Vec2[]): Doc {
  return { molecule: { ...doc.molecule, atoms, bonds }, layout };
}

export function addAtom(doc: Doc, el: string, at2d: Vec2, at3d?: Vec3): { doc: Doc; index: number } {
  const index = doc.molecule.atoms.length;
  const p3 = at3d ?? ([at2d[0], -at2d[1], 0] as Vec3);
  const atom: Atom = { i: index, el, x: p3[0], y: p3[1], z: p3[2], charge: 0, isotope: null, hCount: null };
  return {
    doc: withAtoms(doc, [...doc.molecule.atoms, atom], doc.molecule.bonds, [...doc.layout, at2d]),
    index,
  };
}

export function addBondedAtom(doc: Doc, from: number, el: string, order: BondOrderT = "single", at2d?: Vec2): { doc: Doc; index: number; bond: number } {
  const anchor = doc.molecule.atoms[from]!;
  const dir2 = at2d ? null : freeDirection2D(doc, from);
  const p2: Vec2 = at2d ?? [doc.layout[from]![0] + dir2![0] * BOND_2D, doc.layout[from]![1] + dir2![1] * BOND_2D];
  // A sketch-only document (every z = 0) mirrors the 2D drawing in 3D, as addAtom does; a real 3D
  // structure grows into the free space around the anchor instead.
  const flat = doc.molecule.atoms.every((a) => Math.abs(a.z) < 1e-6);
  const d2: Vec3 = [p2[0] - doc.layout[from]![0], -(p2[1] - doc.layout[from]![1]), 0];
  const dir3 = flat && norm(d2) > 1e-6 ? unit(d2) : freeDirection3D(doc.molecule, from);
  const p3 = add(pos3(anchor), scale(dir3, idealBondLength(anchor.el, el, order)));
  const added = addAtom(doc, el, p2, p3);
  const bonded = addBond(added.doc, from, added.index, order);
  return { doc: bonded.doc, index: added.index, bond: bonded.bond };
}

export function addBond(doc: Doc, a: number, b: number, order: BondOrderT = "single"): { doc: Doc; bond: number } {
  const existing = bondIndex(doc.molecule, a, b);
  if (existing >= 0) return setBondOrder(doc, existing, order);
  const bond: Bond = { a, b, order, stereo: "none" };
  return { doc: withAtoms(doc, doc.molecule.atoms, [...doc.molecule.bonds, bond], doc.layout), bond: doc.molecule.bonds.length };
}

export function setBondOrder(doc: Doc, index: number, order: BondOrderT): { doc: Doc; bond: number } {
  const bonds = doc.molecule.bonds.map((b, i) => (i === index ? { ...b, order } : b));
  return { doc: withAtoms(doc, doc.molecule.atoms, bonds, doc.layout), bond: index };
}

export const NEXT_ORDER: Record<BondOrderT, BondOrderT> = { single: "double", double: "triple", triple: "single", aromatic: "single" };

export function updateAtom(doc: Doc, index: number, patch: Partial<Atom>): Doc {
  const atoms = doc.molecule.atoms.map((a) => (a.i === index ? { ...a, ...patch, i: a.i } : a));
  return withAtoms(doc, atoms, doc.molecule.bonds, doc.layout);
}

/** Remove atoms (and their bonds); returns old→new index map (-1 = removed). */
export function removeAtoms(doc: Doc, remove: Set<number>): { doc: Doc; map: number[] } {
  const map: number[] = [];
  let next = 0;
  doc.molecule.atoms.forEach((_a, i) => {
    map[i] = remove.has(i) ? -1 : next++;
  });
  const atoms = doc.molecule.atoms.filter((a) => !remove.has(a.i)).map((a) => ({ ...a, i: map[a.i]! }));
  const bonds = doc.molecule.bonds
    .filter((b) => !remove.has(b.a) && !remove.has(b.b))
    .map((b) => ({ ...b, a: map[b.a]!, b: map[b.b]! }));
  const layout = doc.layout.filter((_p, i) => !remove.has(i));
  return { doc: withAtoms(doc, atoms, bonds, layout), map };
}

export function removeBonds(doc: Doc, remove: Set<number>): Doc {
  return withAtoms(doc, doc.molecule.atoms, doc.molecule.bonds.filter((_b, i) => !remove.has(i)), doc.layout);
}

export function moveLayout(doc: Doc, indices: Set<number>, delta: Vec2): Doc {
  const layout = doc.layout.map((p, i) => (indices.has(i) ? ([p[0] + delta[0], p[1] + delta[1]] as Vec2) : p));
  return { ...doc, layout };
}

/** Apply a corrected molecule from the sidecar, remapping the 2D layout with its atom map. */
export function applyCorrected(doc: Doc, molecule: Molecule, atomMap: number[]): Doc {
  const layout: Vec2[] = new Array(molecule.atoms.length);
  atomMap.forEach((newIndex, oldIndex) => {
    if (newIndex >= 0 && doc.layout[oldIndex]) layout[newIndex] = doc.layout[oldIndex]!;
  });
  for (let i = 0; i < molecule.atoms.length; i++) {
    if (!layout[i]) {
      const nbr = neighbors(molecule, i).find((n) => layout[n]);
      const base = nbr !== undefined ? layout[nbr]! : ([0, 0] as Vec2);
      layout[i] = [base[0] + BOND_2D * Math.cos(i), base[1] + BOND_2D * Math.sin(i)];
    }
  }
  return { molecule: { ...molecule, id: doc.molecule.id, name: doc.molecule.name || molecule.name }, layout };
}

/** Replace 3D coordinates (e.g. streamed minimisation frames) without touching the graph. */
export function withCoordinates(doc: Doc, coords: number[][]): Doc {
  if (coords.length !== doc.molecule.atoms.length) return doc;
  const atoms = doc.molecule.atoms.map((a, i) => ({ ...a, x: coords[i]![0]!, y: coords[i]![1]!, z: coords[i]![2]! }));
  return { ...doc, molecule: { ...doc.molecule, atoms } };
}

/** Merge a fragment (e.g. a library molecule) into the document, offset to the right. */
/**
 * Rescale an incoming 2D layout (library, file import, sidecar depiction) so its median bond is
 * BOND_2D long and it is centred on the origin. Every source uses a different unit (CoordGen 1.0,
 * RDKit 1.5, Å from 3D), so without this, opened molecules and freshly drawn bonds disagree.
 */
export function normalizeLayout(m: Molecule, layout: Vec2[]): Vec2[] {
  if (layout.length === 0) return layout;
  const lengths = m.bonds
    .map((b) => (layout[b.a] && layout[b.b] ? Math.hypot(layout[b.a]![0] - layout[b.b]![0], layout[b.a]![1] - layout[b.b]![1]) : 0))
    .filter((d) => d > 1e-6)
    .sort((x, y) => x - y);
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)]! : BOND_2D;
  const k = BOND_2D / median;
  const cx = layout.reduce((sum, p) => sum + p[0], 0) / layout.length;
  const cy = layout.reduce((sum, p) => sum + p[1], 0) / layout.length;
  return layout.map(([x, y]) => [(x - cx) * k, (y - cy) * k] as Vec2);
}

/**
 * Append a fragment as a separate component. In 2D it goes to the right of the drawing, or is
 * centred on `at` (sketch coordinates) when it was dropped there; in 3D it is placed beside the
 * existing atoms so the two never overlap before they are bonded and relaxed.
 */
export function insertFragment(doc: Doc, fragment: Molecule, layout: Vec2[] | null, at?: Vec2): Doc {
  const offset = doc.molecule.atoms.length;
  const maxX = doc.layout.reduce((m, p) => Math.max(m, p[0]), -Infinity);
  const maxX3 = doc.molecule.atoms.reduce((m, a) => Math.max(m, a.x), -Infinity);
  const fragMin3 = fragment.atoms.reduce((m, a) => Math.min(m, a.x), Infinity);
  const shift3 = Number.isFinite(maxX3) ? maxX3 - fragMin3 + 3 : 0;
  const fragLayout = normalizeLayout(fragment, layout ?? fragment.atoms.map((a) => [a.x, -a.y] as Vec2));
  let place: (p: Vec2) => Vec2;
  if (at && fragLayout.length > 0) {
    const cx = fragLayout.reduce((s, p) => s + p[0], 0) / fragLayout.length;
    const cy = fragLayout.reduce((s, p) => s + p[1], 0) / fragLayout.length;
    place = (p) => [p[0] - cx + at[0], p[1] - cy + at[1]];
  } else {
    const minX2 = fragLayout.reduce((m, p) => Math.min(m, p[0]), Infinity);
    const shift2 = Number.isFinite(maxX) ? maxX + 3 : 0;
    place = (p) => [p[0] - minX2 + shift2, p[1]];
  }
  const atoms = [
    ...doc.molecule.atoms,
    ...fragment.atoms.map((a) => ({ ...a, i: a.i + offset, x: a.x + shift3 })),
  ];
  const bonds = [...doc.molecule.bonds, ...fragment.bonds.map((b) => ({ ...b, a: b.a + offset, b: b.b + offset }))];
  const newLayout = [...doc.layout, ...fragLayout.map(place)];
  return withAtoms(doc, atoms, bonds, newLayout);
}

/** Hill-order formula of the drawn atoms, plus implicit hydrogens when their counts are known. */
export function formulaOf(m: Molecule, implicitH?: readonly number[]): string {
  const counts = new Map<string, number>();
  for (const a of m.atoms) counts.set(a.el, (counts.get(a.el) ?? 0) + 1);
  if (implicitH && implicitH.length === m.atoms.length) {
    const extra = implicitH.reduce((sum, h) => sum + (h ?? 0), 0);
    if (extra > 0) counts.set("H", (counts.get("H") ?? 0) + extra);
  }
  // Hill system: with carbon, C then H then the rest alphabetically; without carbon, all alphabetical.
  const hasCarbon = counts.has("C");
  const keys = [...counts.keys()].sort((a, b) => {
    const rank = (k: string) => (!hasCarbon ? 0 : k === "C" ? 0 : k === "H" ? 1 : 2);
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  return keys.map((k) => `${k}${counts.get(k)! > 1 ? counts.get(k) : ""}`).join("");
}

export function distance(m: Molecule, a: number, b: number): number {
  return norm(sub(pos3(m.atoms[a]!), pos3(m.atoms[b]!)));
}

export function angle(m: Molecule, a: number, b: number, c: number): number {
  const u = unit(sub(pos3(m.atoms[a]!), pos3(m.atoms[b]!)));
  const v = unit(sub(pos3(m.atoms[c]!), pos3(m.atoms[b]!)));
  const cos = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function dihedral(m: Molecule, a: number, b: number, c: number, d: number): number {
  const p0 = pos3(m.atoms[a]!);
  const p1 = pos3(m.atoms[b]!);
  const p2 = pos3(m.atoms[c]!);
  const p3 = pos3(m.atoms[d]!);
  const b0 = sub(p0, p1);
  const b1 = unit(sub(p2, p1));
  const b2 = sub(p3, p2);
  const dot = (x: Vec3, y: Vec3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const v = sub(b0, scale(b1, dot(b0, b1)));
  const w = sub(b2, scale(b1, dot(b2, b1)));
  const x = dot(v, w);
  const y = dot(cross(b1, v), w);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Fit 2D layout from 3D coordinates (used when a molecule arrives without a sketch layout). */
export function layoutFrom3D(m: Molecule): Vec2[] {
  return m.atoms.map((a) => [a.x * (BOND_2D / 1.4), -a.y * (BOND_2D / 1.4)] as Vec2);
}

/** Screen layouts are y-down; RDKit (sidecar, library files) is y-up. Converting is a mirror in y. */
export function toRdkitLayout(layout: Vec2[]): [number, number][] {
  return layout.map(([x, y]) => [x, -y]);
}

/** True when the 3D stereo came from the source (a 3D file or fully specified stereo), not from guessing. */
export function stereoKnown(m: Molecule): boolean {
  return m.meta.stereo === "coordinates" || m.meta.stereo === "defined";
}

/** Any edit to the graph makes the source's stereo statement no longer authoritative. */
export function forgetStereo(doc: Doc): Doc {
  if (!doc.molecule.meta.stereo) return doc;
  return { ...doc, molecule: { ...doc.molecule, meta: { ...doc.molecule.meta, stereo: "" } } };
}
