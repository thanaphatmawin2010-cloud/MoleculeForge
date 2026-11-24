/** Functional-group auto-categorisation and the library grid: a port of compute/mfcompute/data/categorize.py. */
import type { Molecule } from "@/ipc/schema";
import { qed, withoutHydrogens } from "./descriptors";
import { matchAtoms, perceive, substructMatches, withMol, type RDMol } from "./rdkit";

export interface Category {
  id: string;
  row: number;
  col: number;
  family: string;
}

export const CATEGORIES: Category[] = [
  { id: "inorganic", row: 1, col: 1, family: "s-block" },
  { id: "ions", row: 2, col: 1, family: "s-block" },
  { id: "hydrocarbons", row: 1, col: 3, family: "p-block" },
  { id: "aromatics", row: 2, col: 3, family: "p-block" },
  { id: "halogenated", row: 3, col: 3, family: "p-block" },
  { id: "alcohols-ethers", row: 1, col: 4, family: "p-block" },
  { id: "carbonyls", row: 2, col: 4, family: "p-block" },
  { id: "acids-derivatives", row: 3, col: 4, family: "p-block" },
  { id: "nitrogen-compounds", row: 1, col: 5, family: "p-block" },
  { id: "sulfur-phosphorus", row: 2, col: 5, family: "p-block" },
  { id: "biomolecules", row: 1, col: 2, family: "d-block" },
  { id: "drugs-actives", row: 2, col: 2, family: "d-block" },
  { id: "monomers-polymers", row: 3, col: 2, family: "d-block" },
  { id: "solvents", row: 3, col: 1, family: "s-block" },
  { id: "coordination", row: 3, col: 5, family: "f-block" },
  { id: "other", row: 4, col: 5, family: "f-block" },
];
export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

const range = (a: number, b: number) => Array.from({ length: b - a }, (_, k) => a + k);
const METALS = new Set([...range(3, 5), ...range(11, 14), ...range(19, 32), ...range(37, 51), ...range(55, 85), ...range(87, 119)]);

const PATTERNS: Record<string, string> = {
  amino_acid: "[NX3,NX4+][CX4][CX3](=O)[OX2H1,OX1-]",
  nucleobase: "[#6]1[#7][#6](=[#8])[#7][#6][#6,#7]1",
  carboxylic: "[CX3](=O)[OX2H1,OX1-]",
  ester: "[#6][CX3](=O)[OX2][#6]",
  amide: "[CX3](=O)[NX3]",
  anhydride: "[CX3](=O)[OX2][CX3](=O)",
  acyl_halide: "[CX3](=O)[F,Cl,Br,I]",
  aldehyde: "[CX3H1](=O)[#6,#1]",
  formaldehyde: "[CX3H2]=O",
  ketone: "[#6][CX3](=O)[#6]",
  alcohol: "[CX4][OX2H1]",
  ether: "[OD2]([#6])[#6]",
  amine: "[NX3;!$(N-C=[O,N,S]);!$(N-[a])]",
  nitrile: "[CX2]#[NX1]",
  nitro: "[NX3+](=O)[O-]",
  aromatic: "a",
  halide: "[#6][F,Cl,Br,I]",
  sp: "[#16,#15]",
};

function fragmentCount(m: Molecule): number {
  const parent = m.atoms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const b of m.bonds) parent[find(b.a)] = find(b.b);
  return new Set(m.atoms.map((_, i) => find(i))).size;
}

export function categorize(m: Molecule, mol: RDMol): string {
  const has = (name: string) => matchAtoms(mol, PATTERNS[name]!).length > 0;
  const p = perceive(mol);
  const heavyAtoms = p.atoms.map((a, i) => (a.z !== 1 ? i : -1)).filter((i) => i >= 0);
  const zs = new Set(heavyAtoms.map((i) => p.atoms[i]!.z));
  const nHeavy = heavyAtoms.length;
  const charge = p.atoms.reduce((s, a) => s + a.charge, 0);
  if (fragmentCount(m) === 1 && charge !== 0 && nHeavy <= 12) return "ions";
  if ([...zs].some((z) => METALS.has(z))) return "coordination";
  const subset = (allowed: number[]) => [...zs].every((z) => allowed.includes(z));
  // GetTotalNumHs on the hydrogen-stripped molecule: implicit plus removed hydrogen atoms.
  const carbonHasH = heavyAtoms.some((i) => p.atoms[i]!.z === 6 && p.atoms[i]!.totalHs > 0);
  if (!zs.has(6) || (subset([6, 8]) && nHeavy <= 3 && !carbonHasH)) return "inorganic";
  if (has("amino_acid") || has("nucleobase")) return "biomolecules";
  const hydroxyls = substructMatches(mol, PATTERNS["alcohol"]!).length;
  if (hydroxyls >= 4 && zs.has(8) && subset([1, 6, 8])) return "biomolecules";
  let q = 0;
  try {
    q = withMol(withoutHydrogens(mol), (heavy) => qed(heavy, m, p, JSON.parse(mol.get_descriptors()) as Record<string, number>)) ?? 0;
  } catch {
    q = 0;
  }
  const hbd = (JSON.parse(mol.get_descriptors()) as Record<string, number>)["NumHBD"] ?? 0;
  if (nHeavy >= 10 && has("aromatic") && (zs.has(7) || zs.has(8)) && q >= 0.55 && hbd <= 5) return "drugs-actives";
  if (has("acyl_halide") || has("anhydride") || has("carboxylic") || has("ester") || has("amide")) return "acids-derivatives";
  if (has("aldehyde") || has("formaldehyde") || has("ketone")) return "carbonyls";
  if (has("nitro") || has("nitrile") || has("amine") || (zs.has(7) && !has("aromatic"))) return "nitrogen-compounds";
  if (has("halide")) return "halogenated";
  if (zs.has(15) || zs.has(16)) return "sulfur-phosphorus";
  if (has("aromatic")) return "aromatics";
  if (has("alcohol") || has("ether")) return "alcohols-ethers";
  if (subset([1, 6])) return "hydrocarbons";
  return "other";
}
