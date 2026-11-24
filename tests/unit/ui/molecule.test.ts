import { describe, expect, it } from "vitest";
import {
  addAtom,
  addBond,
  addBondedAtom,
  angle,
  BOND_2D,
  dihedral,
  distance,
  emptyDoc,
  forgetStereo,
  formulaOf,
  insertFragment,
  normalizeLayout,
  removeAtoms,
  setBondOrder,
  stereoKnown,
  toRdkitLayout,
} from "@/lib/molecule";

function water() {
  let doc = emptyDoc();
  const o = addAtom(doc, "O", [0, 0]);
  doc = o.doc;
  doc = addBondedAtom(doc, o.index, "H").doc;
  doc = addBondedAtom(doc, o.index, "H").doc;
  return doc;
}

describe("molecule graph operations", () => {
  it("builds water with consistent indices, bonds and layout", () => {
    const doc = water();
    expect(doc.molecule.atoms.map((a) => a.el)).toEqual(["O", "H", "H"]);
    expect(doc.molecule.atoms.map((a) => a.i)).toEqual([0, 1, 2]);
    expect(doc.molecule.bonds).toHaveLength(2);
    expect(doc.layout).toHaveLength(3);
    expect(formulaOf(doc.molecule)).toBe("H2O");
  });

  it("never places a second neighbour at 180 degrees (minimiser saddle point)", () => {
    const doc = water();
    const [o, h1, h2] = doc.molecule.atoms;
    const v1 = [h1!.x - o!.x, h1!.y - o!.y, h1!.z - o!.z];
    const v2 = [h2!.x - o!.x, h2!.y - o!.y, h2!.z - o!.z];
    const cos = (v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!) / (Math.hypot(...v1) * Math.hypot(...v2));
    expect(Math.acos(cos) * (180 / Math.PI)).toBeLessThan(170);
  });

  it("reindexes atoms and bonds after deletion", () => {
    const { doc, map } = removeAtoms(water(), new Set([1]));
    expect(doc.molecule.atoms.map((a) => a.i)).toEqual([0, 1]);
    expect(doc.molecule.bonds).toEqual([expect.objectContaining({ a: 0, b: 1 })]);
    expect(map).toEqual([0, -1, 1]);
  });

  it("changes bond order and reuses an existing bond instead of duplicating it", () => {
    const doc = water();
    const again = addBond(doc, 0, 1, "double");
    expect(again.doc.molecule.bonds).toHaveLength(2);
    expect(setBondOrder(doc, 0, "triple").doc.molecule.bonds[0]!.order).toBe("triple");
  });

  it("writes formulas in Hill order", () => {
    const mk = (els: string[]) => ({ ...emptyDoc().molecule, atoms: els.map((el, i) => ({ i, el, x: 0, y: 0, z: 0, charge: 0, isotope: null, hCount: null })) });
    expect(formulaOf(mk(["O", "C", "H", "H", "C"]))).toBe("C2H2O");
    expect(formulaOf(mk(["H", "Br"]))).toBe("BrH");
    expect(formulaOf(mk(["N", "H", "H", "H"]))).toBe("H3N");
    expect(formulaOf(mk(["C"]), [4])).toBe("CH4");
  });

  it("normalises any incoming layout to the sketch bond length, centred", () => {
    const doc = water();
    const scaled = normalizeLayout(doc.molecule, doc.layout.map(([x, y]) => [x * 0.37, y * 0.37]));
    const d = Math.hypot(scaled[0]![0] - scaled[1]![0], scaled[0]![1] - scaled[1]![1]);
    expect(d).toBeCloseTo(BOND_2D, 6);
    expect(scaled.reduce((s, p) => s + p[0], 0)).toBeCloseTo(0, 9);
  });

  it("mirrors y when converting to the RDKit (y-up) orientation, and back", () => {
    expect(toRdkitLayout([[1, 2], [-3, 4]])).toEqual([[1, -2], [-3, -4]]);
  });

  it("inserts a fragment beside the drawing, or centred where it was dropped", () => {
    const base = water();
    const frag = water().molecule;
    const beside = insertFragment(base, frag, null);
    expect(beside.molecule.atoms).toHaveLength(6);
    expect(beside.molecule.bonds.map((b) => [b.a, b.b])).toContainEqual([3, 4]);
    const maxBase = Math.max(...base.layout.map((p) => p[0]));
    expect(Math.min(...beside.layout.slice(3).map((p) => p[0]))).toBeGreaterThan(maxBase);
    const dropped = insertFragment(base, frag, null, [10, -4]);
    const added = dropped.layout.slice(3);
    const centre = [added.reduce((s, p) => s + p[0], 0) / added.length, added.reduce((s, p) => s + p[1], 0) / added.length];
    expect(centre[0]).toBeCloseTo(10, 6);
    expect(centre[1]).toBeCloseTo(-4, 6);
    // In 3D the fragment never overlaps the existing atoms.
    const maxBase3 = Math.max(...base.molecule.atoms.map((a) => a.x));
    expect(Math.min(...dropped.molecule.atoms.slice(3).map((a) => a.x))).toBeGreaterThan(maxBase3);
  });

  it("forgets the source's stereo after any structural edit", () => {
    const doc = water();
    const known = { ...doc, molecule: { ...doc.molecule, meta: { ...doc.molecule.meta, stereo: "defined" as const } } };
    expect(stereoKnown(known.molecule)).toBe(true);
    expect(stereoKnown(forgetStereo(known).molecule)).toBe(false);
  });

  it("measures distances, angles and signed dihedrals (§7.2 measure tool)", () => {
    const at = (coords: [number, number, number][]) => ({
      ...emptyDoc().molecule,
      atoms: coords.map(([x, y, z], i) => ({ i, el: "C", x, y, z, charge: 0, isotope: null, hCount: null })),
    });
    expect(distance(at([[0, 0, 0], [3, 4, 0]]), 0, 1)).toBeCloseTo(5, 10);
    const half = (104.5 * Math.PI) / 360;
    const water = at([[Math.sin(half), Math.cos(half), 0], [0, 0, 0], [-Math.sin(half), Math.cos(half), 0]]);
    expect(angle(water, 0, 1, 2)).toBeCloseTo(104.5, 8);
    for (const theta of [60, -60, 180, 0]) {
      const r = (theta * Math.PI) / 180;
      const chain = at([[1, 0, 0], [0, 0, 0], [0, 0, 1.5], [Math.cos(r), Math.sin(r), 1.5]]);
      expect(Math.abs(dihedral(chain, 0, 1, 2, 3) - theta) % 360).toBeCloseTo(0, 8);
    }
  });
});
