/**
 * sim.properties and sim.minimize for MoleculeForge Lite. The desktop battery's first stages run
 * here unchanged in method: RDKit descriptors, Gasteiger charges, drug-likeness and pKa lookup;
 * MMFF94 geometry and energy; shape (radius of gyration, principal moments, rotational constants,
 * symmetry number) and a solvent-accessible surface. Tight-binding, semi-empirical and DFT
 * properties, vibrations and molecular dynamics need the desktop app's engines; results say so.
 */
import type { Molecule } from "@/ipc/schema";
import * as elements from "./elements";
import { embedMolecule, toRDKitStrict, withExplicitHydrogens, moleculeFromExplicit } from "./convert";
import { computeRDKit } from "./descriptors";
import { ENGINE_UNAVAILABLE, RpcFailure } from "./errors";
import { chooseForceField, kabschRmsd, minimize as runMinimize } from "./geometry";
import type { JobContext } from "./jobs";
import type { Vec3 } from "./ocl";
import { isThreeD, perceive, pyRound, rdkit, withMol } from "./rdkit";
import { ATOMIC_WEIGHTS, ISOTOPE_MASSES } from "./tables.generated";

type PV = { value: unknown; unit: string; method: string; uncertainty?: number };
const pv = (value: unknown, unit: string, method: string): PV => ({ value, unit, method });

export const LITE_VERSION = "1.0.0-lite";

/** Warnings with codes, as compute/mfcompute/sim/notes.py writes them (the UI localises the codes). */
const TEXT: Record<string, string> = {
  liteEngines: "MoleculeForge Lite computes descriptors, MMFF94 geometry and shape in the browser; GFN2-xTB, PM7, DFT, vibrations and molecular dynamics run in the desktop app.",
  minimizeStepLimit: "Stopped after {steps} steps before reaching the gradient tolerance.",
};

class Notes {
  text: string[] = [];
  codes: { code: string; params: Record<string, string | number> }[] = [];
  add(code: string, params: Record<string, string | number> = {}): void {
    this.text.push(TEXT[code]!.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? "")));
    this.codes.push({ code, params });
  }
}

/** The structure with every hydrogen explicit and 3D coordinates (embedding a flat structure). */
function prepare(molecule: Molecule): Molecule {
  if (!isThreeD(molecule)) return withMol(toRDKitStrict(molecule), (mol) => embedMolecule(mol, { keepIds: molecule }));
  const perception = withMol(toRDKitStrict(molecule), (mol) => perceive(mol));
  const explicit = withExplicitHydrogens(molecule, perception);
  if (!explicit.parents.length) return molecule;
  return moleculeFromExplicit(molecule, explicit, explicit.atoms.map((a) => a.pos), { keepHCount: true });
}

function masses(m: Molecule): number[] {
  return m.atoms.map((a) => {
    const z = rdkitZ(a.el);
    if (a.isotope) return ISOTOPE_MASSES[`${z}-${a.isotope}`] ?? a.isotope;
    return ATOMIC_WEIGHTS[z] ?? 0;
  });
}

function rdkitZ(symbol: string): number {
  const rec = elements.record(symbol);
  return rec ? rec.Z : 0;
}

function symmetricEigenvalues(a: number[][]): number[] {
  const m = a.map((r) => [...r]);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += m[p]![q]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(m[p]![q]!) < 1e-40) continue;
        const theta = (m[q]![q]! - m[p]![p]!) / (2 * m[p]![q]!);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const kp = m[k]![p]!;
          const kq = m[k]![q]!;
          m[k]![p] = c * kp - s * kq;
          m[k]![q] = s * kp + c * kq;
        }
        for (let k = 0; k < 3; k++) {
          const pk = m[p]![k]!;
          const qk = m[q]![k]!;
          m[p]![k] = c * pk - s * qk;
          m[q]![k] = s * pk + c * qk;
        }
      }
  }
  return [m[0]![0]!, m[1]![1]!, m[2]![2]!].sort((x, y) => x - y);
}

const H = 6.62607015e-34;
const AMU = 1.6605390666e-27;

function shape(m: Molecule): Record<string, PV> {
  const props: Record<string, PV> = {};
  const pos: Vec3[] = m.atoms.map((a) => [a.x, a.y, a.z]);
  const w = masses(m);
  const total = w.reduce((s, x) => s + x, 0);
  if (m.atoms.length > 1 && total > 0) {
    const com: Vec3 = [0, 0, 0];
    pos.forEach((p, i) => [0, 1, 2].forEach((k) => (com[k]! += (w[i]! * p[k]!) / total)));
    const rel = pos.map((p) => [p[0] - com[0], p[1] - com[1], p[2] - com[2]] as Vec3);
    const rg = Math.sqrt(rel.reduce((s, r, i) => s + w[i]! * (r[0] ** 2 + r[1] ** 2 + r[2] ** 2), 0) / total);
    props["radiusOfGyration"] = pv(pyRound(rg, 4), "Å", "mass-weighted (RDKit)");
    const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    rel.forEach((r, i) => {
      const r2 = r[0] ** 2 + r[1] ** 2 + r[2] ** 2;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) I[a]![b]! += w[i]! * ((a === b ? r2 : 0) - r[a]! * r[b]!);
    });
    const momentsAmuA2 = symmetricEigenvalues(I);
    const momentsSI = momentsAmuA2.map((x) => x * AMU * 1e-20);
    const ghz = momentsSI.map((x) => (x > 1e-50 ? H / (8 * Math.PI ** 2 * x) / 1e9 : null));
    props["rotationalConstants"] = pv(ghz.map((x) => (x ? pyRound(x, 6) : null)), "GHz", "rigid rotor from principal moments");
    props["principalMoments"] = pv(momentsAmuA2.map((x) => pyRound(x, 4)), "amu·Å²", "inertia tensor eigenvalues");
  }
  props["rotationalSymmetryNumber"] = pv(symmetryNumber(m), "", "proper rotations of the 3D structure");
  const sasa = shrakeRupley(m);
  props["sasa"] = pv(pyRound(sasa.total, 2), "Å²", "Shrake–Rupley (960 points), Alvarez/Bondi vdW radii, 1.4 Å probe");
  props["polarSasa"] = pv(pyRound(sasa.polar, 2), "Å²", "Shrake–Rupley SASA of N, O, S, P atoms");
  return props;
}

/** Number of proper rotations mapping the 3D structure onto itself (graph automorphisms + RMSD). */
function symmetryNumber(m: Molecule, tol = 0.15): number {
  return withMol(toRDKitStrict(m), (mol) => {
    let perms: number[][] = [];
    try {
      const raw = JSON.parse(mol.get_substruct_matches(mol, JSON.stringify({ uniquify: false, maxMatches: 5000, useChirality: false })) || "[]") as { atoms: number[] }[] | Record<string, never>;
      perms = Array.isArray(raw) ? raw.map((r) => r.atoms) : [];
    } catch {
      return 1;
    }
    const pos: Vec3[] = m.atoms.map((a) => [a.x, a.y, a.z]);
    let count = 0;
    for (const perm of perms) {
      const target = perm.map((i) => pos[i]!);
      if (kabschRmsd(pos, target) < tol) count += 1;
    }
    return Math.max(1, count);
  });
}

function goldenSpherePoints(n: number): Vec3[] {
  const pts: Vec3[] = [];
  const inc = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < n; k++) {
    const y = 1 - (2 * (k + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const phi = k * inc;
    pts.push([Math.cos(phi) * r, y, Math.sin(phi) * r]);
  }
  return pts;
}

function shrakeRupley(m: Molecule, probe = 1.4, points = 960): { total: number; polar: number } {
  const sphere = goldenSpherePoints(points);
  const radii = m.atoms.map((a) => elements.vdwRadius(a.el) + probe);
  const pos: Vec3[] = m.atoms.map((a) => [a.x, a.y, a.z]);
  let total = 0;
  let polar = 0;
  m.atoms.forEach((atom, i) => {
    const ri = radii[i]!;
    const nearby = m.atoms.map((_, j) => j).filter((j) => j !== i && Math.hypot(pos[j]![0] - pos[i]![0], pos[j]![1] - pos[i]![1], pos[j]![2] - pos[i]![2]) < ri + radii[j]!);
    let exposed = 0;
    for (const s of sphere) {
      const p: Vec3 = [pos[i]![0] + ri * s[0], pos[i]![1] + ri * s[1], pos[i]![2] + ri * s[2]];
      if (nearby.every((j) => (p[0] - pos[j]![0]) ** 2 + (p[1] - pos[j]![1]) ** 2 + (p[2] - pos[j]![2]) ** 2 >= radii[j]! ** 2)) exposed += 1;
    }
    const area = (4 * Math.PI * ri * ri * exposed) / points;
    total += area;
    if (["N", "O", "S", "P"].includes(atom.el)) polar += area;
  });
  return { total, polar };
}

export async function properties(params: { molecule: Molecule; level?: string; md?: boolean }, ctx: JobContext) {
  const started = performance.now();
  const notes = new Notes();
  ctx.progress(1, "prepare", "Preparing structure", undefined, true);
  let molecule = prepare(params.molecule);
  ctx.progress(4, "descriptors", "Cheminformatics descriptors");
  const props: Record<string, PV> = withMol(toRDKitStrict(molecule), (mol) => computeRDKit(molecule, mol));
  ctx.progress(8, "forcefield", "Force-field optimisation");
  const perception = withMol(toRDKitStrict(molecule), (mol) => perceive(mol));
  const explicit = withExplicitHydrogens(molecule, perception);
  const ff = chooseForceField(explicit);
  let converged = true;
  if (ff) {
    const result = await runMinimize(explicit, explicit.atoms.map((a) => a.pos), ff, ctx, { maxSteps: 4000, stage: "forcefield", percentFrom: 8, percentTo: 80 });
    converged = result.converged;
    props["potentialEnergy"] = pv(pyRound(result.energyFinal, 4), "kcal/mol", `${ff} (OpenChemLib)`);
    molecule = { ...molecule, atoms: molecule.atoms.map((a, i) => ({ ...a, x: pyRound(result.coords[i]![0], 6), y: pyRound(result.coords[i]![1], 6), z: pyRound(result.coords[i]![2], 6) })) };
  }
  ctx.progress(85, "surface", "Surface area and shape");
  Object.assign(props, shape(molecule));
  notes.add("liteEngines");
  ctx.progress(100, "done", "Properties complete", undefined, true);
  return {
    jobId: ctx.jobId,
    method: `property battery (${params.level ?? "standard"})`,
    engine: `MoleculeForge Lite ${LITE_VERSION} (RDKit ${rdkit().version()} WebAssembly, OpenChemLib)`,
    forceField: ff,
    hamiltonian: null,
    converged,
    durationMs: Math.round(performance.now() - started),
    geometry: molecule,
    properties: props,
    warnings: notes.text,
    warningCodes: notes.codes,
    data: { methods: ["RDKit descriptors", ...(ff ? [ff] : [])], geometryMethod: ff ?? "input" },
  };
}

export async function minimizeJob(params: { molecule: Molecule; method?: string; maxSteps?: number; streamFrames?: boolean }, ctx: JobContext) {
  const started = performance.now();
  const method = params.method ?? "auto";
  if (["GFN2-xTB", "GFN-FF", "UFF"].includes(method)) {
    throw new RpcFailure(ENGINE_UNAVAILABLE, `${method} runs in the MoleculeForge desktop app`, { engine: method === "UFF" ? "uff" : "xtb", feature: "quantum", code: "DESKTOP_ONLY" });
  }
  const molecule = prepare(params.molecule);
  const perception = withMol(toRDKitStrict(molecule), (mol) => perceive(mol));
  const explicit = withExplicitHydrogens(molecule, perception);
  const ff = chooseForceField(explicit, method === "auto" ? "auto" : method);
  if (!ff) throw new RpcFailure(ENGINE_UNAVAILABLE, "MMFF94 has no parameters for every atom in this structure; the desktop app adds UFF and GFN2-xTB", { engine: "mmff", feature: "mmff", code: "DESKTOP_ONLY" });
  const maxSteps = params.maxSteps ?? 2000;
  const result = await runMinimize(explicit, explicit.atoms.map((a) => a.pos), ff, ctx, { maxSteps, stream: params.streamFrames ?? true, stage: "minimize" });
  const notes = new Notes();
  if (!result.converged) notes.add("minimizeStepLimit", { steps: maxSteps });
  const geometry = { ...molecule, atoms: molecule.atoms.map((a, i) => ({ ...a, x: pyRound(result.coords[i]![0], 6), y: pyRound(result.coords[i]![1], 6), z: pyRound(result.coords[i]![2], 6) })) };
  ctx.progress(100, "done", "Minimisation complete", undefined, true);
  return {
    jobId: ctx.jobId,
    method: "energy minimisation",
    engine: "OpenChemLib",
    forceField: ff,
    hamiltonian: null,
    converged: result.converged,
    durationMs: Math.round(performance.now() - started),
    geometry,
    properties: {
      potentialEnergy: pv(pyRound(result.energyFinal, 5), "kcal/mol", ff),
      initialEnergy: pv(pyRound(result.energyInitial, 5), "kcal/mol", ff),
      iterations: pv(result.iterations, "", "OpenChemLib MMFF94 minimiser"),
      rmsdFromInput: pv(pyRound(kabschRmsd(explicit.atoms.map((a) => a.pos), result.coords), 4), "Å", "Kabsch-aligned"),
    },
    warnings: notes.text,
    warningCodes: notes.codes,
  };
}
