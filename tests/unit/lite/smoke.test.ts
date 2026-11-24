// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Molecule } from "@/ipc/schema";
import { parse } from "@/lite/engine/convert";
import { setElements, type ElementsPayload } from "@/lite/engine/elements";
import { loadOCL } from "@/lite/engine/ocl";
import { loadRDKit, perceive, toRDKit } from "@/lite/engine/rdkit";
import { validate } from "@/lite/engine/validate";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

beforeAll(async () => {
  await loadRDKit();
  await loadOCL();
  setElements(JSON.parse(readFileSync(`${ROOT}data/elements.json`, "utf8")) as ElementsPayload);
});

function mol(atoms: [string, number, number, number][], bonds: [number, number, string][]): Molecule {
  return {
    id: "t", name: "", formula: "",
    atoms: atoms.map(([el, x, y, z], i) => ({ i, el, x, y, z, charge: 0, isotope: null, hCount: null })),
    bonds: bonds.map(([a, b, order]) => ({ a, b, order: order as Molecule["bonds"][number]["order"], stereo: "none" })),
    props: {}, meta: { smiles: "", inchi: "", inchikey: "", category: "", source: "user", created: "", stereo: "" },
  };
}

describe("lite engine smoke", () => {
  it("water is valid", () => {
    const r = validate(mol([["O", 0, 0, 0], ["H", 0.96, 0, 0], ["H", -0.24, 0.93, 0]], [[0, 1, "single"], [0, 2, "single"]]), [], [1], true);
    expect(r.status).toBe("valid");
    expect(r.message).toBe("Bond connected correctly.");
    expect(r.molecule.formula).toBe("H2O");
  });
  it("a fifth bond on carbon is fixed", () => {
    const atoms: [string, number, number, number][] = [["C", 0, 0, 0], ["C", 1.5, 0, 0], ["C", -1.5, 0, 0], ["C", 0, 1.5, 0], ["C", 0, -1.5, 0], ["C", 0, 0, 1.5]];
    const r = validate(mol(atoms, [[0, 1, "single"], [0, 2, "single"], [0, 3, "single"], [0, 4, "single"], [0, 5, "single"]]), [], [4], true);
    expect(r.status).toBe("fixed");
    expect(r.initialIssues?.map((i) => i.code)).toContain("VALENCE_EXCEEDED");
    expect(r.fixes[0]?.fix.op).toBe("removeBond");
  });
  it("pyrrole drawn aromatic gets [nH]", () => {
    const ring = ["N", "C", "C", "C", "C"].map((el, i) => [el, Math.cos(i * 1.2566) * 1.2, Math.sin(i * 1.2566) * 1.2, 0] as [string, number, number, number]);
    const r = validate(mol(ring, [[0, 1, "aromatic"], [1, 2, "aromatic"], [2, 3, "aromatic"], [3, 4, "aromatic"], [4, 0, "aromatic"]]), [], [], true);
    expect(r.initialIssues?.map((i) => i.code)).toContain("AROMATIC_INVALID");
    expect(r.status).toBe("fixed");
    expect(r.molecule.atoms[0]!.hCount).toBe(1);
    expect(r.molecule.meta.smiles).toBe("c1cc[nH]c1");
  });
  it("L-alanine keeps its configuration through 3D embedding", () => {
    const [m] = parse("smiles", "C[C@@H](C(=O)O)N L-alanine");
    expect(m!.name).toBe("L-alanine");
    expect(m!.atoms.length).toBe(13);
    const rd = toRDKit(m!)!;
    const cip = perceive(rd).cip;
    rd.delete();
    expect([...cip.values()]).toEqual(["S"]);
    expect(m!.meta.smiles).toBe("C[C@H](N)C(=O)O");
  });
});

describe("stereo through embedding", () => {
  for (const [smiles, expected] of [
    ["C[C@@H](C(=O)O)N", "C[C@H](N)C(=O)O"],
    ["C[C@H](C(=O)O)N", "C[C@@H](N)C(=O)O"],
    ["F[C@](Cl)(Br)I", "F[C@](Cl)(Br)I"],
    ["C/C=C/C", "C/C=C/C"],
    ["C/C=C\\C", "C/C=C\\C"],
    ["O[C@@H]1CC[C@H](C)CC1", "C[C@H]1CC[C@@H](O)CC1"],
  ] as const) {
    it(`${smiles} survives`, () => {
      const [m] = parse("smiles", smiles);
      expect(m!.meta.smiles).toBe(expected);
    });
  }
});
