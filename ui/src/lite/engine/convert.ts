/**
 * Conversion between the canonical molecule schema and file formats: a port of
 * compute/mfcompute/chem/convert.py on RDKit's WebAssembly build. MOL/SDF and SMILES are read and
 * written by RDKit itself; XYZ and PDB are written here. Reading XYZ, PDB and InChI needs RDKit
 * functions the WebAssembly build does not include, so those stay in the desktop app.
 */
import type { Atom, Bond, Molecule } from "@/ipc/schema";
import { CHEMISTRY_ERROR, RpcFailure } from "./errors";
import * as OCL from "openchemlib";
import { breakSymmetry, build, ForceField, hydrogenPositions, positions, type Vec3 } from "./ocl";
import { isThreeD, isWedgeSketch, parseWithLog, perceive, pyRound, rdkit, toMolfile, withMol, type Perception, type RDMol } from "./rdkit";
import { SYMBOLS } from "./tables.generated";

export const EMBED_SEED = 0x5eed;

let counter = 0;
export function newId(prefix = "mol"): string {
  counter = (counter + 1) % 0xffff;
  const random = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${prefix}-${random}${counter.toString(16).padStart(4, "0")}`;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

// ---------------------------------------------------------------------------------------------
// Annotation: formula, canonical SMILES, InChI and InChIKey
// ---------------------------------------------------------------------------------------------

/** RDKit CalcMolFormula: Hill order (C, H, then alphabetical; alphabetical without carbon) and charge. */
export function formulaOf(m: Molecule, perception: Perception): string {
  const counts = new Map<string, number>();
  const bump = (el: string, n: number) => counts.set(el, (counts.get(el) ?? 0) + n);
  m.atoms.forEach((atom, i) => {
    bump(atom.el, 1);
    const hs = perception.atoms[i]?.hs ?? 0;
    if (hs) bump("H", hs);
  });
  const keys = [...counts.keys()].sort();
  // RDKit lists carbon first, then hydrogen, then the rest alphabetically (H first without carbon).
  const ordered = [...(counts.has("C") ? ["C"] : []), ...(counts.has("H") ? ["H"] : []), ...keys.filter((k) => k !== "C" && k !== "H")];
  let formula = ordered.map((k) => `${k}${counts.get(k)! > 1 ? counts.get(k) : ""}`).join("");
  const charge = perception.atoms.reduce((s, a) => s + a.charge, 0);
  if (charge > 0) formula += `+${charge > 1 ? charge : ""}`;
  else if (charge < 0) formula += `-${charge < -1 ? -charge : ""}`;
  return formula;
}

/**
 * RDKit's own RemoveHsParameters defaults, as Chem.RemoveHs uses them on the desktop (MinimalLib's
 * remove_hs would otherwise also drop isotopic hydrogens and H2).
 */
export const REMOVE_HS = JSON.stringify({
  removeDegreeZero: false, removeHigherDegrees: false, removeOnlyHNeighbors: false, removeIsotopes: false,
  removeAndTrackIsotopes: false, removeDummyNeighbors: false, removeDefiningBondStereo: false, removeWithWedgedBond: true,
  removeWithQuery: false, removeMapped: true, removeInSGroups: false, showWarnings: false, removeNonimplicit: true,
  updateExplicitCount: false, removeHydrides: true, removeNontetrahedralNeighbors: false,
});

export function canonicalSmiles(mol: RDMol): string {
  const copy = mol.copy();
  if (!copy) return "";
  return withMol(copy, (c) => {
    try {
      c.remove_hs_in_place(REMOVE_HS);
      return c.get_smiles();
    } catch {
      return "";
    }
  });
}

export function inchiOf(mol: RDMol, options = "-w"): { inchi: string; inchikey: string } {
  try {
    const inchi = mol.get_inchi(options) || "";
    const inchikey = inchi ? rdkit().get_inchikey_for_inchi(inchi) : "";
    return { inchi, inchikey };
  } catch {
    return { inchi: "", inchikey: "" };
  }
}

/** Fill formula, SMILES, InChI and InChIKey from the structure (best effort, like the desktop). */
export function annotate(m: Molecule, mol?: RDMol | null): Molecule {
  const own = mol ? null : toRDKitStereo(m);
  const rd = mol ?? own;
  if (!rd) return m;
  try {
    const perception = perceive(rd);
    const formula = formulaOf(m, perception);
    const smiles = canonicalSmiles(rd);
    const { inchi, inchikey } = inchiOf(rd);
    return { ...m, formula, meta: { ...m.meta, smiles, inchi, inchikey } };
  } finally {
    own?.delete();
  }
}

/** RDKit molecule with stereo taken from the 3D coordinates (or from wedges in a flat sketch). */
export function toRDKitStereo(m: Molecule): RDMol | null {
  const parsed = parseWithLog(toMolfile(m));
  return parsed.ok ? parsed.mol : null;
}

export function toRDKitStrict(m: Molecule): RDMol {
  const parsed = parseWithLog(toMolfile(m));
  if (!parsed.ok) {
    throw new RpcFailure(CHEMISTRY_ERROR, `Structure is not chemically valid: ${parsed.errors.at(-1) ?? "RDKit rejected it"}`, { code: "SANITIZE_FAILED" });
  }
  return parsed.mol;
}

// ---------------------------------------------------------------------------------------------
// RDKit molecule -> canonical schema
// ---------------------------------------------------------------------------------------------

interface MolfileAtom {
  el: string;
  x: number;
  y: number;
  z: number;
}

/** Atom symbols and coordinates from an RDKit-written molfile (V2000 or V3000). */
export function molfileAtoms(block: string): { atoms: MolfileAtom[]; wedges: Map<string, number>; threeD: boolean } {
  const lines = block.split("\n");
  const threeD = (lines[1] ?? "").slice(20, 22) === "3D";
  const atoms: MolfileAtom[] = [];
  const wedges = new Map<string, number>();
  const counts = lines[3] ?? "";
  if (counts.includes("V3000")) {
    let section = "";
    for (const line of lines) {
      if (!line.startsWith("M  V30 ")) continue;
      const body = line.slice(7).trim();
      if (body.startsWith("BEGIN ")) section = body.slice(6);
      else if (body.startsWith("END ")) section = "";
      else if (section === "ATOM") {
        const f = body.split(/\s+/);
        atoms.push({ el: f[1]!, x: Number(f[2]), y: Number(f[3]), z: Number(f[4]) });
      } else if (section === "BOND") {
        const f = body.split(/\s+/);
        const cfg = /CFG=(\d)/.exec(body);
        if (cfg) wedges.set(`${Number(f[2]) - 1}-${Number(f[3]) - 1}`, cfg[1] === "1" ? 1 : 6);
      }
    }
    return { atoms, wedges, threeD };
  }
  const nAtoms = Number(counts.slice(0, 3));
  const nBonds = Number(counts.slice(3, 6));
  for (let i = 0; i < nAtoms; i++) {
    const line = lines[4 + i] ?? "";
    atoms.push({ x: Number(line.slice(0, 10)), y: Number(line.slice(10, 20)), z: Number(line.slice(20, 30)), el: line.slice(31, 34).trim() });
  }
  for (let i = 0; i < nBonds; i++) {
    const line = lines[4 + nAtoms + i] ?? "";
    const stereo = Number(line.slice(9, 12));
    if (stereo === 1 || stereo === 6) wedges.set(`${Number(line.slice(0, 3)) - 1}-${Number(line.slice(3, 6)) - 1}`, stereo);
  }
  return { atoms, wedges, threeD };
}

interface RdJsonBond {
  atoms: [number, number];
  stereo?: string;
}

export interface FromRDKitOptions {
  id?: string;
  name?: string;
  source?: "prebuilt" | "user";
  props?: Record<string, unknown>;
  category?: string;
  /** Atoms RDKit holds with a fixed hydrogen count (bracket atoms in SMILES). */
  noImplicit?: boolean[];
}

const r6 = (x: number) => pyRound(x, 6);

export function fromRDKit(mol: RDMol, options: FromRDKitOptions = {}): Molecule {
  const block = mol.get_num_atoms() > 999 ? mol.get_v3Kmolblock() : mol.get_molblock();
  const { atoms: raw, wedges } = molfileAtoms(block);
  const perception = perceive(mol);
  const json = JSON.parse(mol.get_json()) as { molecules: { bonds: RdJsonBond[] }[] };
  const jsonBonds = json.molecules[0]!.bonds;
  const atoms: Atom[] = raw.map((a, i) => {
    const p = perception.atoms[i]!;
    const fixed = options.noImplicit?.[i] && p.z !== 1;
    return {
      i, el: SYMBOLS[p.z] ?? a.el, x: r6(a.x), y: r6(a.y), z: r6(a.z), charge: p.charge,
      isotope: p.isotope || null, hCount: fixed ? p.hs : null,
    };
  });
  const bonds: Bond[] = jsonBonds.map((b, i) => {
    const [a, c] = b.atoms;
    const wedge = wedges.get(`${a}-${c}`);
    const stereo: Bond["stereo"] = wedge === 1 ? "wedge" : wedge === 6 ? "hash" : b.stereo === "trans" ? "trans" : b.stereo === "cis" ? "cis" : "none";
    const kek = perception.kekule[i] ?? 1;
    const order: Bond["order"] = perception.aromaticBonds.has(i) ? "aromatic" : kek === 2 ? "double" : kek === 3 ? "triple" : "single";
    return { a, b: c, order, stereo };
  });
  const molecule: Molecule = {
    id: options.id ?? newId(), name: options.name ?? "", formula: "", atoms, bonds, props: { ...(options.props ?? {}) },
    meta: { smiles: "", inchi: "", inchikey: "", category: options.category ?? "", source: options.source ?? "user", created: nowIso(), stereo: "" },
  };
  return annotate(molecule, mol);
}

// ---------------------------------------------------------------------------------------------
// 3D coordinates
// ---------------------------------------------------------------------------------------------

export interface ExplicitH {
  /** All atoms with hydrogens explicit: the input atoms first, then added hydrogens. */
  atoms: { z: number; charge: number; isotope: number; pos: Vec3 }[];
  bonds: { a: number; b: number; order: number }[];
  /** For each added hydrogen, the atom it is attached to. */
  parents: number[];
  nOriginal: number;
}

/** Make RDKit's implicit hydrogens explicit, seeding their positions around the parent atom. */
export function withExplicitHydrogens(m: Molecule, perception: Perception, coords?: Vec3[]): ExplicitH {
  const pos: Vec3[] = coords ?? m.atoms.map((a) => [a.x, a.y, a.z]);
  const atoms = m.atoms.map((a, i) => ({ z: perception.atoms[i]!.z, charge: perception.atoms[i]!.charge, isotope: a.isotope ?? 0, pos: pos[i]! }));
  const bonds = m.bonds.map((b, i) => ({ a: b.a, b: b.b, order: perception.kekule[i] ?? 1 }));
  const neighbours = m.atoms.map(() => [] as number[]);
  for (const b of m.bonds) {
    neighbours[b.a]!.push(b.b);
    neighbours[b.b]!.push(b.a);
  }
  const parents: number[] = [];
  perception.atoms.forEach((p, i) => {
    if (!p.hs) return;
    const placed = hydrogenPositions(pos[i]!, neighbours[i]!.map((n) => pos[n]!), p.hs);
    for (const h of placed) {
      const k = atoms.length;
      atoms.push({ z: 1, charge: 0, isotope: 0, pos: h });
      bonds.push({ a: i, b: k, order: 1 });
      parents.push(i);
    }
  });
  return { atoms, bonds, parents, nOriginal: m.atoms.length };
}

/** Molfile bonds as written by RDKit: atoms, Kekulé type and wedge flag (1 wedge, 6 hash). */
export function molfileBonds(block: string): { a: number; b: number; type: number; stereo: number }[] {
  const lines = block.split("\n");
  const counts = lines[3] ?? "";
  const out: { a: number; b: number; type: number; stereo: number }[] = [];
  if (counts.includes("V3000")) {
    let inBonds = false;
    for (const line of lines) {
      if (line.startsWith("M  V30 BEGIN BOND")) inBonds = true;
      else if (line.startsWith("M  V30 END BOND")) inBonds = false;
      else if (inBonds && line.startsWith("M  V30 ")) {
        const f = line.slice(7).trim().split(/\s+/);
        const cfg = /CFG=(\d)/.exec(line);
        out.push({ a: Number(f[2]) - 1, b: Number(f[3]) - 1, type: Number(f[1]), stereo: cfg ? (cfg[1] === "1" ? 1 : cfg[1] === "3" ? 6 : 0) : 0 });
      }
    }
    return out;
  }
  const nAtoms = Number(counts.slice(0, 3));
  const nBonds = Number(counts.slice(3, 6));
  for (let i = 0; i < nBonds; i++) {
    const line = lines[4 + nAtoms + i] ?? "";
    out.push({ a: Number(line.slice(0, 3)) - 1, b: Number(line.slice(3, 6)) - 1, type: Number(line.slice(6, 9)), stereo: Number(line.slice(9, 12)) || 0 });
  }
  return out;
}

/** Replace the coordinates in an RDKit-written molfile and mark it 3D. */
export function setMolfileCoords(block: string, coords: Vec3[]): string {
  const lines = block.split("\n");
  lines[1] = (lines[1] ?? "").padEnd(22).slice(0, 20) + "3D" + (lines[1] ?? "").slice(22);
  if ((lines[3] ?? "").includes("V3000")) {
    let inAtoms = false;
    return lines
      .map((line) => {
        if (line.startsWith("M  V30 BEGIN ATOM")) inAtoms = true;
        else if (line.startsWith("M  V30 END ATOM")) inAtoms = false;
        else if (inAtoms && line.startsWith("M  V30 ")) {
          const f = line.slice(7).trim().split(/\s+/);
          const [x, y, z] = coords[Number(f[0]) - 1]!;
          f.splice(2, 3, x.toFixed(4), y.toFixed(4), z.toFixed(4));
          return `M  V30 ${f.join(" ")}`;
        }
        return line;
      })
      .join("\n");
  }
  const nAtoms = Number((lines[3] ?? "").slice(0, 3));
  for (let i = 0; i < nAtoms; i++) {
    const line = lines[4 + i] ?? "";
    const [x, y, z] = coords[i]!;
    lines[4 + i] = x.toFixed(4).padStart(10) + y.toFixed(4).padStart(10) + z.toFixed(4).padStart(10) + line.slice(30);
  }
  return lines.join("\n");
}

/**
 * Hydrogen-complete 3D coordinates for an RDKit molecule whose hydrogens are all explicit atoms
 * (the role of ETKDGv3 + an MMFF94s polish in the desktop engine). The stereochemistry is handed
 * to OpenChemLib the way chemists draw it: RDKit's own 2D depiction with its wedge bonds, from
 * which OpenChemLib derives the parities its conformer generator honours.
 */
export function embedFromRDKit(mol: RDMol, seed = EMBED_SEED): Vec3[] {
  const copy = mol.copy();
  if (!copy) throw new RpcFailure(CHEMISTRY_ERROR, "Could not generate 3D coordinates for this structure", { code: "EMBED_FAILED" });
  const block = withMol(copy, (c) => {
    c.set_new_coords(true);
    return c.get_num_atoms() > 999 ? c.get_v3Kmolblock() : c.get_molblock();
  });
  const { atoms } = molfileAtoms(block);
  const bonds = molfileBonds(block);
  const charges = perceive(mol).atoms;
  const z = atoms.map((_, i) => charges[i]?.z ?? 6);
  const order = [...atoms.keys()].sort((i, j) => Number(z[i] === 1) - Number(z[j] === 1) || i - j);
  const oclMol = new OCL.Molecule(atoms.length, bonds.length);
  const toOcl = new Array<number>(atoms.length);
  for (const i of order) {
    const k = oclMol.addAtom(z[i]!);
    toOcl[i] = k;
    oclMol.setAtomX(k, atoms[i]!.x);
    oclMol.setAtomY(k, -atoms[i]!.y);
    oclMol.setAtomZ(k, 0);
    if (charges[i]?.charge) oclMol.setAtomCharge(k, charges[i]!.charge);
    if (charges[i]?.isotope) oclMol.setAtomMass(k, charges[i]!.isotope);
  }
  const plain = [OCL.Molecule.cBondTypeSingle, OCL.Molecule.cBondTypeSingle, OCL.Molecule.cBondTypeDouble, OCL.Molecule.cBondTypeTriple];
  for (const b of bonds) {
    const k = oclMol.addBond(toOcl[b.a]!, toOcl[b.b]!);
    // OpenChemLib's y axis points down, so an RDKit wedge (towards the viewer) stays a wedge.
    const type = b.type === 1 && b.stereo === 1 ? OCL.Molecule.cBondTypeUp : b.type === 1 && b.stereo === 6 ? OCL.Molecule.cBondTypeDown : plain[b.type] ?? OCL.Molecule.cBondTypeSingle;
    oclMol.setBondType(k, type);
  }
  oclMol.ensureHelperArrays(OCL.Molecule.cHelperParities);
  const generated = new OCL.ConformerGenerator(seed).getOneConformerAsMolecule(oclMol);
  if (!generated || generated.getAllAtoms() !== atoms.length) {
    throw new RpcFailure(CHEMISTRY_ERROR, "Could not generate 3D coordinates for this structure", { code: "EMBED_FAILED" });
  }
  const coords: Vec3[] = toOcl.map((k) => [generated.getAtomX(k), generated.getAtomY(k), generated.getAtomZ(k)]);
  try {
    const nudged = breakSymmetry(coords, 1e-3, seed);
    const polished = build(
      atoms.map((_, i) => ({ z: z[i]!, charge: charges[i]?.charge ?? 0, isotope: charges[i]?.isotope ?? 0, pos: nudged[i]! })),
      bonds.map((b) => ({ a: b.a, b: b.b, order: b.type >= 1 && b.type <= 3 ? b.type : 1 })),
    );
    const ff = new ForceField(polished, "MMFF94s");
    ff.minimise(500);
    return positions(ff.built);
  } catch {
    return coords;
  }
}

/** A molecule rebuilt from explicit-hydrogen coordinates, annotated (stereo read from the 3D structure). */
export function moleculeFromExplicit(m: Molecule, explicit: ExplicitH, coords: Vec3[], options: { keepHCount?: boolean } = {}): Molecule {
  const atoms: Atom[] = explicit.atoms.map((a, i) => ({
    i, el: SYMBOLS[a.z] ?? "C", x: r6(coords[i]![0]), y: r6(coords[i]![1]), z: r6(coords[i]![2]), charge: a.charge,
    isotope: a.isotope || null,
    hCount: i < explicit.nOriginal ? (options.keepHCount && m.atoms[i]!.hCount !== null && m.atoms[i]!.hCount !== undefined ? 0 : null) : null,
  }));
  const bonds: Bond[] = [...m.bonds.map((b) => ({ ...b, stereo: "none" as const })), ...explicit.parents.map((p, k) => ({ a: p, b: explicit.nOriginal + k, order: "single" as const, stereo: "none" as const }))];
  const draft: Molecule = { ...m, atoms, bonds };
  const rd = toRDKitStereo(draft);
  if (!rd) return draft;
  return withMol(rd, (mol) => {
    const json = JSON.parse(mol.get_json()) as { molecules: { bonds: RdJsonBond[] }[] };
    const stereoBonds = draft.bonds.map((b, i) => {
      const s = json.molecules[0]!.bonds[i]?.stereo;
      return { ...b, stereo: s === "trans" ? ("trans" as const) : s === "cis" ? ("cis" as const) : ("none" as const) };
    });
    return annotate({ ...draft, bonds: stereoBonds }, mol);
  });
}

// ---------------------------------------------------------------------------------------------
// File formats
// ---------------------------------------------------------------------------------------------

/** Atoms written in brackets in a SMILES string (RDKit gives them a fixed hydrogen count). */
export function smilesBracketAtoms(smiles: string): boolean[] {
  const out: boolean[] = [];
  let i = 0;
  while (i < smiles.length) {
    const ch = smiles[i]!;
    if (ch === "[") {
      const end = smiles.indexOf("]", i);
      out.push(true);
      i = end < 0 ? smiles.length : end + 1;
    } else if (/[A-Za-z*]/.test(ch)) {
      const two = smiles.slice(i, i + 2);
      i += two === "Cl" || two === "Br" ? 2 : 1;
      out.push(false);
    } else {
      i += 1;
    }
  }
  return out;
}

function stereoOrigin(mol: RDMol, threeD: boolean): Molecule["meta"]["stereo"] {
  if (threeD) return "coordinates";
  try {
    const d = JSON.parse(mol.get_descriptors()) as Record<string, number>;
    const centres = d["NumAtomStereoCenters"] ?? 0;
    if (!centres) return "none";
    return (d["NumUnspecifiedAtomStereoCenters"] ?? 0) > 0 ? "partial" : "defined";
  } catch {
    return "";
  }
}

function finish(mol: RDMol, name: string, embed: boolean, threeD: boolean, noImplicit?: boolean[]): Molecule {
  const origin = stereoOrigin(mol, threeD);
  let molecule = fromRDKit(mol, { name, noImplicit });
  if (!threeD) {
    if (embed) {
      molecule = embedMolecule(mol, { name, noImplicit, keepIds: molecule });
    } else if (molecule.atoms.every((a) => a.x === 0 && a.y === 0 && a.z === 0)) {
      const copy = mol.copy();
      if (copy) {
        molecule = withMol(copy, (c) => {
          c.set_new_coords(true);
          const { atoms } = molfileAtoms(c.get_molblock());
          return { ...molecule, atoms: molecule.atoms.map((a, i) => ({ ...a, x: r6(atoms[i]!.x), y: r6(atoms[i]!.y), z: 0 })) };
        });
      }
    }
  }
  return { ...molecule, meta: { ...molecule.meta, stereo: origin } };
}

/** Embed an RDKit molecule in 3D (hydrogens made explicit) and convert it, stereo read from the result. */
export function embedMolecule(mol: RDMol, options: { name?: string; noImplicit?: boolean[]; keepIds?: Molecule; seed?: number } = {}): Molecule {
  const h = mol.copy();
  if (!h) throw new RpcFailure(CHEMISTRY_ERROR, "Could not generate 3D coordinates for this structure", { code: "EMBED_FAILED" });
  return withMol(h, (withH) => {
    withH.add_hs_in_place();
    const coords = embedFromRDKit(withH, options.seed ?? EMBED_SEED);
    const block = withH.get_num_atoms() > 999 ? withH.get_v3Kmolblock() : withH.get_molblock();
    const parsed = parseWithLog(setMolfileCoords(block, coords));
    if (!parsed.ok) throw new RpcFailure(CHEMISTRY_ERROR, "Could not generate 3D coordinates for this structure", { code: "EMBED_FAILED" });
    const base = options.keepIds;
    return withMol(parsed.mol, (mol3d) =>
      fromRDKit(mol3d, {
        id: base?.id, name: options.name ?? base?.name ?? "", source: base?.meta.source, props: base?.props, category: base?.meta.category,
        noImplicit: options.noImplicit,
      }),
    );
  });
}

function failure(errors: string[], what: string): RpcFailure {
  const chemistry = errors.some((e) => /valence|kekulize|aromatic/i.test(e));
  return chemistry
    ? new RpcFailure(CHEMISTRY_ERROR, `${what} record is not chemically valid: ${errors.at(-1)}`, { code: "SANITIZE_FAILED" })
    : new RpcFailure(CHEMISTRY_ERROR, `Could not parse ${what}`, { code: "PARSE_FAILED", format: what.toLowerCase() });
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

const LITE_ONLY_FORMATS = new Set(["xyz", "pdb", "inchi"]);

export function parse(fmt: string, data: string, options: { charge?: number; embed3d?: boolean; name?: string } = {}): Molecule[] {
  const text = data.replace(/^\uFEFF/, "");
  const embed = options.embed3d ?? true;
  const name = options.name ?? "";
  if (!text.trim()) throw new RpcFailure(CHEMISTRY_ERROR, "No input data", { code: "EMPTY_INPUT" });
  if (LITE_ONLY_FORMATS.has(fmt)) {
    throw new RpcFailure(CHEMISTRY_ERROR, `Opening ${fmt.toUpperCase()} files needs the MoleculeForge desktop app`, { code: "DESKTOP_ONLY", format: fmt });
  }
  const out: Molecule[] = [];
  if (fmt === "sdf" || fmt === "mol") {
    const records = text.split(/^\$\$\$\$\s*$/m).map((r) => r.replace(/^\s*\n/, "")).filter((r) => r.includes("M  END"));
    for (const record of records) {
      const block = record.slice(0, record.indexOf("M  END") + 6);
      const parsed = parseWithLog(block);
      if (!parsed.ok) throw failure(parsed.errors, fmt.toUpperCase());
      const title = block.split("\n")[0]?.trim() ?? "";
      const threeD = molfileAtoms(block).threeD && !block.split("\n").slice(4).every((l) => !/\S/.test(l.slice(20, 30)) || Number(l.slice(20, 30)) === 0);
      out.push(withMol(parsed.mol, (mol) => finish(mol, title || name, embed, threeD)));
    }
    if (!out.length) throw new RpcFailure(CHEMISTRY_ERROR, "No molecules found in file", { code: "PARSE_FAILED", format: fmt });
  } else if (fmt === "smiles") {
    for (const line of lines(text)) {
      const [smiles, ...rest] = line.split(/\s+/);
      const parsed = parseWithLog(smiles!, JSON.stringify({ removeHs: false }));
      if (!parsed.ok) throw failure(parsed.errors, "SMILES");
      out.push(withMol(parsed.mol, (mol) => finish(mol, rest.join(" ") || name, embed, false, smilesBracketAtoms(smiles!))));
    }
  } else {
    throw new RpcFailure(CHEMISTRY_ERROR, `Unsupported input format ${fmt}`, { code: "UNSUPPORTED_FORMAT" });
  }
  return out;
}

function pdbBlock(m: Molecule): string {
  const counts = new Map<string, number>();
  const rows = m.atoms.map((a, i) => {
    const n = (counts.get(a.el) ?? 0) + 1;
    counts.set(a.el, n);
    const atomName = `${a.el}${n}`.slice(0, 4);
    const name = a.el.length === 1 && atomName.length < 4 ? ` ${atomName.padEnd(3)}` : atomName.padEnd(4);
    const charge = a.charge ? `${Math.abs(a.charge)}${a.charge > 0 ? "+" : "-"}` : "  ";
    return `HETATM${String(i + 1).padStart(5)} ${name} UNL     1    ${a.x.toFixed(3).padStart(8)}${a.y.toFixed(3).padStart(8)}${a.z.toFixed(3).padStart(8)}  1.00  0.00          ${a.el.toUpperCase().padStart(2)}${charge}`;
  });
  const conect = m.atoms.map((_, i) => {
    const partners: number[] = [];
    for (const b of m.bonds) {
      if (b.a !== i && b.b !== i) continue;
      const other = b.a === i ? b.b : b.a;
      const times = b.order === "double" ? 2 : b.order === "triple" ? 3 : 1;
      for (let t = 0; t < times; t++) partners.push(other + 1);
    }
    const out: string[] = [];
    for (let k = 0; k < partners.length; k += 4) {
      out.push(`CONECT${String(i + 1).padStart(5)}${partners.slice(k, k + 4).map((p) => String(p).padStart(5)).join("")}`);
    }
    return out.join("\n");
  });
  return [`COMPND    ${m.name || m.id}`, ...rows, ...conect.filter(Boolean), "END", ""].join("\n");
}

export function write(fmt: string, molecules: Molecule[]): string {
  if (!molecules.length) throw new RpcFailure(CHEMISTRY_ERROR, "Nothing to export", { code: "EMPTY_INPUT" });
  if (fmt === "sdf" || fmt === "mol") {
    let buf = "";
    for (const molecule of fmt === "sdf" ? molecules : molecules.slice(0, 1)) {
      buf += withMol(toRDKitStrict(molecule), (mol) => {
        mol.set_prop("_Name", molecule.name || molecule.id);
        let block = mol.get_num_atoms() > 999 ? mol.get_v3Kmolblock() : mol.get_molblock();
        if (!block.endsWith("\n")) block += "\n";
        if (fmt === "sdf") {
          for (const key of ["smiles", "inchikey", "category"] as const) {
            const value = molecule.meta[key];
            if (value) block += `>  <${key.toUpperCase()}>\n${value}\n\n`;
          }
          block += "$$$$\n";
        }
        return block;
      });
    }
    return buf;
  }
  if (fmt === "smiles") {
    return molecules.map((m) => withMol(toRDKitStrict(m), (mol) => `${canonicalSmiles(mol)} ${m.name}`.trimEnd() + "\n")).join("");
  }
  if (fmt === "inchi") {
    return molecules.map((m) => withMol(toRDKitStrict(m), (mol) => (inchiOf(mol, "").inchi || "") + "\n")).join("");
  }
  if (fmt === "xyz") {
    return molecules
      .map((m) => `${m.atoms.length}\n${m.name || m.id}\n${m.atoms.map((a) => `${a.el.padEnd(3)}${a.x.toFixed(8).padStart(15)}${a.y.toFixed(8).padStart(15)}${a.z.toFixed(8).padStart(15)}`).join("\n")}\n`)
      .join("");
  }
  if (fmt === "pdb") return molecules.map(pdbBlock).join("");
  throw new RpcFailure(CHEMISTRY_ERROR, `Unsupported output format ${fmt}`, { code: "UNSUPPORTED_FORMAT" });
}

export { isThreeD, isWedgeSketch };
