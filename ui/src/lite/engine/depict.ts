/**
 * 2D depiction coordinates (chem.layout2d) and stereo wedges (chem.wedges): a port of
 * compute/mfcompute/chem/depict.py on RDKit's WebAssembly build (CoordGen, WedgeMolBonds).
 */
import type { Molecule } from "@/ipc/schema";
import { molfileAtoms, molfileBonds, REMOVE_HS, toRDKitStrict } from "./convert";
import { parseWithLog, perceive, pyRound, rdkit, toMolfile, withMol, type RDMol } from "./rdkit";

type XY = [number, number];

function finite(points: XY[]): boolean {
  return points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

/** 2D coordinates via CoordGen, then RDKit's own depictor; null if both give non-finite values. */
function depict(mol: RDMol): XY[] | null {
  for (const coordgen of [true, false]) {
    const copy = mol.copy();
    if (!copy) continue;
    const points = withMol(copy, (c) => {
      try {
        c.set_new_coords(coordgen);
        return molfileAtoms(c.get_num_atoms() > 999 ? c.get_v3Kmolblock() : c.get_molblock()).atoms.map((a) => [a.x, a.y] as XY);
      } catch {
        return null;
      }
    });
    if (points && finite(points)) return points;
  }
  return null;
}

/**
 * Textbook 2D layout: depict the heavy-atom skeleton, then place each hydrogen around it (laying
 * out with every hydrogen present lets CoordGen bend the skeleton to make room for them). Index
 * order matches the molecule exactly.
 */
export function layout2d(m: Molecule): XY[] {
  const n = m.atoms.length;
  const heavy = m.atoms.map((a, i) => (a.el !== "H" ? i : -1)).filter((i) => i >= 0);
  const r4 = (x: number) => pyRound(x, 4);
  if (heavy.length && heavy.length < n) {
    const removedH = m.atoms.map(() => 0);
    for (const b of m.bonds) {
      if (m.atoms[b.a]!.el === "H" && m.atoms[b.b]!.el !== "H") removedH[b.b]! += 1;
      if (m.atoms[b.b]!.el === "H" && m.atoms[b.a]!.el !== "H") removedH[b.a]! += 1;
    }
    const index = new Map(heavy.map((i, k) => [i, k]));
    // The heavy-atom skeleton; a fixed hydrogen count absorbs the removed hydrogen atoms (RemoveHs).
    const skeleton: Molecule = {
      ...m,
      atoms: heavy.map((i, k) => {
        const a = m.atoms[i]!;
        return { ...a, i: k, hCount: a.hCount === null || a.hCount === undefined ? null : a.hCount + removedH[i]! };
      }),
      bonds: m.bonds.filter((b) => index.has(b.a) && index.has(b.b)).map((b) => ({ ...b, a: index.get(b.a)!, b: index.get(b.b)!, stereo: "none" as const })),
    };
    const parsed = parseWithLog(toMolfile(skeleton, { coords: skeleton.atoms.map(() => [0, 0, 0]), dimension: "2D" }));
    const points = parsed.ok ? withMol(parsed.mol, (mol) => depict(mol)) : null;
    if (points) {
      const placed = parseWithLog(toMolfile(skeleton, { coords: points.map(([x, y]) => [x, y, 0]), dimension: "2D" }));
      if (placed.ok) {
        const block = withMol(placed.mol, (mol) => {
          mol.add_hs_in_place();
          return mol.get_num_atoms() > 999 ? mol.get_v3Kmolblock() : mol.get_molblock();
        });
        const all = molfileAtoms(block).atoms;
        const coords = new Map<number, XY>();
        heavy.forEach((orig, k) => coords.set(orig, [r4(points[k]![0]), r4(points[k]![1])]));
        // Hydrogens re-added by RDKit belong to their single heavy neighbour.
        const added = new Map<number, number[]>();
        for (const b of molfileBonds(block)) {
          const [hIdx, parent] = b.a >= heavy.length ? [b.a, b.b] : b.b >= heavy.length ? [b.b, b.a] : [-1, -1];
          if (hIdx < 0 || parent >= heavy.length) continue;
          const anchor = heavy[parent]!;
          added.set(anchor, [...(added.get(anchor) ?? []), hIdx]);
        }
        for (const [anchor, hs] of added) {
          const originals = m.bonds
            .filter((b) => (b.a === anchor && m.atoms[b.b]!.el === "H") || (b.b === anchor && m.atoms[b.a]!.el === "H"))
            .map((b) => (b.a === anchor ? b.b : b.a))
            .filter((i) => !coords.has(i))
            .sort((p, q) => p - q);
          originals.forEach((orig, k) => {
            const idx = hs[k];
            if (idx !== undefined) coords.set(orig, [r4(all[idx]!.x), r4(all[idx]!.y)]);
          });
        }
        if (coords.size === n && finite([...coords.values()])) return m.atoms.map((_, i) => coords.get(i)!);
      }
    }
  }
  const parsed = parseWithLog(toMolfile(m, { coords: m.atoms.map(() => [0, 0, 0]), dimension: "2D" }));
  if (parsed.ok) {
    const points = withMol(parsed.mol, (mol) => depict(mol));
    if (points) return points.map(([x, y]) => [r4(x), r4(y)]);
  }
  return m.atoms.map((_, i) => [r4(1.5 * i), 0]);
}

interface JsonMol {
  molecules: { atoms: Record<string, unknown>[]; bonds: Record<string, unknown>[]; conformers?: unknown[]; extensions?: unknown[] }[];
  [key: string]: unknown;
}

function isomericSmilesOf(json: JsonMol): string {
  const mol = rdkit().get_mol(JSON.stringify(json), JSON.stringify({ removeHs: false }));
  if (!mol) return "";
  return withMol(mol, (m) => {
    m.remove_hs_in_place(REMOVE_HS);
    return m.get_smiles();
  });
}

/**
 * Wedge/hash bonds showing the 3D structure's tetrahedral stereocentres in a 2D layout. Chirality is
 * read from the 3D coordinates; centres whose inversion does not change the canonical SMILES (cage
 * bridgeheads) are dropped; RDKit's WedgeMolBonds then picks the bonds using the given layout, on
 * the hydrogen-suppressed skeleton unless hydrogens are drawn.
 */
export function wedges(m: Molecule, layout: XY[], explicitH = false): { bond: number; kind: "wedge" | "hash"; from: number }[] {
  const n = m.atoms.length;
  if (!n || layout.length !== n) return [];
  const rd = toRDKitStrict(m);
  return withMol(rd, (mol) => {
    const p = perceive(mol);
    const tagged = p.atoms.map((a, i) => (a.chirality ? i : -1)).filter((i) => i >= 0);
    if (!tagged.length) return [];
    const json = JSON.parse(mol.get_json()) as JsonMol;
    const record = json.molecules[0]!;
    const reference = isomericSmilesOf(json);
    const keep = tagged.filter((idx) => {
      const flipped = JSON.parse(JSON.stringify(json)) as JsonMol;
      const atom = flipped.molecules[0]!.atoms[idx]!;
      atom["stereo"] = atom["stereo"] === "cw" ? "ccw" : "cw";
      return isomericSmilesOf(flipped) !== reference;
    });
    if (!keep.length) return [];
    for (const idx of tagged) if (!keep.includes(idx)) delete record.atoms[idx]!["stereo"];
    record.conformers = [{ dim: 2, coords: layout.map(([x, y]) => [x, y]) }];
    // Atom map numbers carry each atom's original index through hydrogen removal.
    const flat = rdkit().get_mol(JSON.stringify(json), JSON.stringify({ removeHs: false }));
    if (!flat) return [];
    return withMol(flat, (f) => {
      const original = (() => {
        if (explicitH) return m.atoms.map((_, i) => i);
        const before = f.get_num_atoms();
        f.remove_hs_in_place(REMOVE_HS);
        const heavy = m.atoms.map((a, i) => (a.el !== "H" ? i : -1)).filter((i) => i >= 0);
        return f.get_num_atoms() === heavy.length && before === n ? heavy : null;
      })();
      if (!original) return [];
      const block = f.get_num_atoms() > 999 ? f.get_v3Kmolblock() : f.get_molblock();
      const out: { bond: number; kind: "wedge" | "hash"; from: number }[] = [];
      for (const b of molfileBonds(block)) {
        if (b.stereo !== 1 && b.stereo !== 6) continue;
        const a = original[b.a]!;
        const c = original[b.b]!;
        const bond = m.bonds.findIndex((x) => (x.a === a && x.b === c) || (x.a === c && x.b === a));
        if (bond >= 0) out.push({ bond, kind: b.stereo === 1 ? "wedge" : "hash", from: a });
      }
      return out;
    });
  });
}
