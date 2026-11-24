/**
 * Cheminformatics descriptors (chem.descriptors): a port of compute/mfcompute/chem/descriptors.py.
 * Molecular weight, logP, TPSA, H-bond counts, ring counts and stereocentres come from RDKit's
 * WebAssembly build itself; QED, Gasteiger–Marsili charges and the pKa lookup are ports of RDKit's
 * implementations (rdkit/Chem/QED.py, GraphMol/PartialCharges, ConjugHybrid.cpp) on top of it.
 */
import type { Molecule } from "@/ipc/schema";
import { formulaOf, REMOVE_HS, toRDKitStrict } from "./convert";
import { perceive, pyRound, rdkit, substructMatches, withMol, type Perception, type RDMol } from "./rdkit";
import { DEFAULT_VALENCE, GASTEIGER_PARAMS, OUTER_ELECTRONS, QED_PARAMS, SYMBOLS, VALENCE_LISTS } from "./tables.generated";

type PV = { value: unknown; unit: string; method: string; uncertainty?: number };

const pv = (value: unknown, unit: string, method: string, uncertainty?: number): PV =>
  uncertainty === undefined ? { value, unit, method } : { value, unit, method, uncertainty };

const round = pyRound;

export interface Graph {
  n: number;
  neighbours: number[][];
  bondOf: Map<string, number>;
  bonds: { a: number; b: number; order: number; aromatic: boolean }[];
  /** Atoms with a fixed hydrogen count (RDKit counts those hydrogens as explicit valence). */
  fixedH: boolean[];
}

export function graphOf(m: Molecule, perception: Perception): Graph {
  const neighbours = m.atoms.map(() => [] as number[]);
  const bondOf = new Map<string, number>();
  m.bonds.forEach((b, i) => {
    neighbours[b.a]!.push(b.b);
    neighbours[b.b]!.push(b.a);
    bondOf.set(`${b.a}-${b.b}`, i);
    bondOf.set(`${b.b}-${b.a}`, i);
  });
  return {
    n: m.atoms.length, neighbours, bondOf,
    bonds: m.bonds.map((b, i) => ({ a: b.a, b: b.b, order: perception.kekule[i] ?? 1, aromatic: perception.aromaticBonds.has(i) })),
    fixedH: m.atoms.map((a) => a.hCount !== null && a.hCount !== undefined),
  };
}

// ---------------------------------------------------------------------------------------------
// Conjugation (RDKit ConjugHybrid.cpp setConjugation) for the Gasteiger charge split
// ---------------------------------------------------------------------------------------------

function valenceContrib(g: Graph, bond: number): number {
  const b = g.bonds[bond]!;
  return b.aromatic ? 1.5 : b.order;
}

function countAtomElec(g: Graph, p: Perception, i: number): number {
  const a = p.atoms[i]!;
  const dv = DEFAULT_VALENCE[a.z] ?? -1;
  if (dv <= 1) return -1;
  const degree = g.neighbours[i]!.length + a.hs;
  if (degree > 3) return -1;
  const nlp = Math.max((OUTER_ELECTRONS[a.z] ?? 0) - dv - a.charge, 0);
  let res = dv - degree + nlp - a.radicals;
  if (res > 1) {
    const explicitValence = a.totalValence - (g.fixedH[i] ? 0 : a.hs);
    const unsaturations = explicitValence - g.neighbours[i]!.length;
    if (unsaturations > 1) res = 1;
  }
  return res;
}

function isConjugationCandidate(g: Graph, p: Perception, i: number): boolean {
  const a = p.atoms[i]!;
  const vals = VALENCE_LISTS[a.z] ?? [-1];
  if (!a.charge && vals[0]! >= 0 && a.totalValence > vals[0]!) return false;
  const nouter = OUTER_ELECTRONS[a.z] ?? 0;
  const totalDegree = g.neighbours[i]!.length + a.hs;
  return (a.z <= 10 || (nouter !== 5 && nouter !== 6) || (nouter === 6 && totalDegree < 2)) && countAtomElec(g, p, i) > 0;
}

export function conjugatedBonds(g: Graph, p: Perception): boolean[] {
  const conj = g.bonds.map((b) => b.aromatic);
  const info = p.atoms.map((a, i) => {
    const candidate = isConjugationCandidate(g, p, i);
    return { candidate, substituents: candidate ? g.neighbours[i]!.length + a.hs : 0 };
  });
  p.atoms.forEach((_, i) => {
    const me = info[i]!;
    if (!me.candidate || me.substituents < 2 || me.substituents > 3) return;
    const incident = g.neighbours[i]!.map((n) => g.bondOf.get(`${i}-${n}`)!);
    for (const b1 of incident) {
      const other1 = g.bonds[b1]!.a === i ? g.bonds[b1]!.b : g.bonds[b1]!.a;
      if (valenceContrib(g, b1) < 1.5 || !info[other1]!.candidate) continue;
      for (const b2 of incident) {
        if (b1 === b2) continue;
        const other2 = g.bonds[b2]!.a === i ? g.bonds[b2]!.b : g.bonds[b2]!.a;
        if (info[other2]!.substituents > 3) continue;
        if (info[other2]!.candidate) {
          conj[b1] = true;
          conj[b2] = true;
        }
      }
    }
  });
  return conj;
}

// ---------------------------------------------------------------------------------------------
// Gasteiger–Marsili PEOE (RDKit GasteigerCharges.cpp)
// ---------------------------------------------------------------------------------------------

const IONXH = 20.02;
const DAMP = 0.5;
const DAMP_SCALE = 0.5;

function gasteigerParams(element: string, mode: string): [number, number, number] {
  return GASTEIGER_PARAMS[`${element}|${mode}`] ?? GASTEIGER_PARAMS["X|*"]!;
}

export function gasteigerCharges(m: Molecule, p: Perception, nIter = 12): (number | null)[] {
  const g = graphOf(m, p);
  const n = g.n;
  const charges = new Array<number>(n).fill(0);
  const conj = conjugatedBonds(g, p);
  // splitChargeConjugated
  p.atoms.forEach((atom, aix) => {
    let formal = atom.charge;
    if (Math.abs(formal) > 1e-12 && Math.abs(charges[aix]!) < 1e-12) {
      const marker = [aix];
      for (const aax of g.neighbours[aix]!) {
        const b1 = g.bondOf.get(`${aix}-${aax}`)!;
        if (!conj[b1]) continue;
        for (const yax of g.neighbours[aax]!) {
          const b2 = g.bondOf.get(`${aax}-${yax}`)!;
          if (b2 === b1 || !conj[b2]) continue;
          if (p.atoms[yax]!.z === atom.z) {
            formal += p.atoms[yax]!.charge;
            marker.push(yax);
          }
        }
      }
      for (const mci of marker) charges[mci] = formal / marker.length;
    }
  });
  const params = p.atoms.map((atom, i) => {
    const elem = SYMBOLS[atom.z] ?? "X";
    let mode = atom.hybridization === "sp3" ? "sp3" : atom.hybridization === "sp2" ? "sp2" : atom.hybridization === "sp" ? "sp" : "";
    if (!mode) {
      if (atom.z === 1) mode = "*";
      else if (atom.z === 16) {
        const no = g.neighbours[i]!.filter((nb) => p.atoms[nb]!.z === 8).length;
        mode = no === 2 ? "so2" : no === 1 ? "so" : "sp3";
      }
    }
    return gasteigerParams(elem, mode);
  });
  const ionX = p.atoms.map((atom, i) => (atom.z === 1 ? IONXH : params[i]![0] + params[i]![1] + params[i]![2]));
  const hParams = gasteigerParams("H", "*");
  const hChrg = new Array<number>(n).fill(0);
  const energ = new Array<number>(n).fill(0);
  let damp = DAMP;
  for (let it = 0; it < nIter; it++) {
    for (let a = 0; a < n; a++) energ[a] = params[a]![0] + charges[a]! * (params[a]![1] + params[a]![2] * charges[a]!);
    for (let aix = 0; aix < n; aix++) {
      let dq = 0;
      for (const nbr of g.neighbours[aix]!) {
        const dx = energ[nbr]! - energ[aix]!;
        const sgn = dx < 0 ? 0 : 1;
        dq += dx / (sgn * (ionX[aix]! - ionX[nbr]!) + ionX[nbr]!);
      }
      const niHs = p.atoms[aix]!.hs;
      if (niHs > 0) {
        const qHs = hChrg[aix]! / niHs;
        const enr = hParams[0] + qHs * (hParams[1] + hParams[2] * qHs);
        const dx = enr - energ[aix]!;
        const sgn = dx < 0 ? 0 : 1;
        const dqH = dx / (sgn * (ionX[aix]! - IONXH) + IONXH);
        dq += niHs * dqH;
        hChrg[aix]! -= niHs * dqH * damp;
      }
      charges[aix]! += damp * dq;
    }
    damp *= DAMP_SCALE;
  }
  return charges.map((q) => (Number.isFinite(q) ? round(q, 4) : null));
}

// ---------------------------------------------------------------------------------------------
// QED (rdkit/Chem/QED.py, weights_mean)
// ---------------------------------------------------------------------------------------------

function ads(x: number, p: readonly number[]): number {
  const [a, b, c, d, e, f, dmax] = p as [number, number, number, number, number, number, number];
  return (a + b / (1 + Math.exp(-1 * (x - c + d / 2) / e)) * (1 - 1 / (1 + Math.exp(-1 * (x - c - d / 2) / f)))) / dmax;
}

/** Number of SSSR rings (cyclomatic number) of the graph after deleting the given atoms. */
function cyclomatic(g: Graph, removed: Set<number>, heavy: boolean[]): number {
  const keep = (i: number) => heavy[i] && !removed.has(i);
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    const pi = parent.get(i)!;
    if (pi === i) return i;
    const r = find(pi);
    parent.set(i, r);
    return r;
  };
  let nodes = 0;
  for (let i = 0; i < g.n; i++) if (keep(i)) {
    parent.set(i, i);
    nodes += 1;
  }
  let edges = 0;
  for (const b of g.bonds) {
    if (!keep(b.a) || !keep(b.b)) continue;
    edges += 1;
    parent.set(find(b.a), find(b.b));
  }
  const components = new Set([...parent.keys()].map(find)).size;
  return edges - nodes + components;
}

export function qed(heavyMol: RDMol, m: Molecule, p: Perception, descriptorsJson: Record<string, number>): number | null {
  try {
    const g = graphOf(m, p);
    const heavy = p.atoms.map((a) => a.z !== 1);
    const count = (smarts: string) => substructMatches(heavyMol, smarts).length;
    const hba = QED_PARAMS.acceptors.reduce((s, sm) => s + count(sm), 0);
    const alerts = QED_PARAMS.alerts.reduce((s, sm) => s + (count(sm) > 0 ? 1 : 0), 0);
    const aliphatic = new Set(substructMatches(heavyMol, QED_PARAMS.aliphaticRings).map((mt) => mt[0]!));
    // heavyMol has hydrogens removed; map its atoms back onto heavy atoms of m in order.
    const heavyIndex = p.atoms.map((a, i) => (a.z !== 1 ? i : -1)).filter((i) => i >= 0);
    const removed = new Set([...aliphatic].map((k) => heavyIndex[k]!));
    const arom = cyclomatic(g, removed, heavy);
    // QED reads its properties from the hydrogen-stripped molecule (rotatable bonds differ otherwise).
    const hd = JSON.parse(heavyMol.get_descriptors()) as Record<string, number>;
    const props: Record<string, number> = {
      MW: hd["amw"] ?? descriptorsJson["amw"]!,
      ALOGP: hd["CrippenClogP"] ?? descriptorsJson["CrippenClogP"]!,
      HBA: hba,
      HBD: hd["NumHBD"] ?? descriptorsJson["NumHBD"]!,
      PSA: hd["tpsa"] ?? descriptorsJson["tpsa"]!,
      ROTB: hd["NumRotatableBonds"] ?? descriptorsJson["NumRotatableBonds"]!,
      AROM: arom,
      ALERTS: alerts,
    };
    const names = QED_PARAMS.names as readonly string[];
    const weights = QED_PARAMS.weightsMean as readonly number[];
    const d = names.map((name) => ads(props[name]!, (QED_PARAMS.ads as Record<string, readonly number[]>)[name]!));
    const t = names.reduce((s, _, i) => s + weights[i]! * Math.log(d[i]!), 0);
    return Math.exp(t / weights.reduce((s, w) => s + w, 0));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// pKa lookup (compute/mfcompute/chem/pka.py)
// ---------------------------------------------------------------------------------------------

export const PKA_METHOD = "Functional-group lookup of parent-compound aqueous pKa (CRC Handbook); ±1.5 units";

const PKA_RULES: [string, string, string, string, number, string][] = [
  ["sulfonic acid", "sulfonicAcid", "acid", "[SX4](=O)(=O)[OX2H1]", -1.9, "methanesulfonic acid"],
  ["phosphate/phosphonic acid", "phosphateAcid", "acid", "[PX4](=O)[OX2H1]", 2.1, "phosphoric acid (first)"],
  ["aromatic carboxylic acid", "aromaticCarboxylicAcid", "acid", "a[CX3](=O)[OX2H1]", 4.2, "benzoic acid"],
  ["carboxylic acid", "carboxylicAcid", "acid", "[CX3;!$(Ca)](=O)[OX2H1]", 4.76, "acetic acid"],
  ["tetrazole", "tetrazole", "acid", "[nH]1nnnc1", 4.9, "5-methyltetrazole"],
  ["thiophenol", "thiophenol", "acid", "c[SX2H1]", 6.6, "thiophenol"],
  ["1,3-dicarbonyl C–H", "dicarbonylCH", "acid", "[CX3](=O)[CH2][CX3](=O)", 8.9, "acetylacetone"],
  ["imide", "imide", "acid", "[CX3](=O)[NX3H1][CX3](=O)", 9.6, "succinimide"],
  ["phenol", "phenol", "acid", "c[OX2H1]", 9.95, "phenol"],
  ["sulfonamide", "sulfonamide", "acid", "[SX4](=O)(=O)[NX3H2,NX3H1]", 10.1, "benzenesulfonamide"],
  ["aliphatic thiol", "aliphaticThiol", "acid", "[CX4][SX2H1]", 10.5, "ethanethiol"],
  ["aliphatic alcohol", "aliphaticAlcohol", "acid", "[CX4][OX2H1]", 15.9, "ethanol"],
  ["water", "water", "acid", "[OX2H2]", 15.7, "water"],
  ["guanidine", "guanidine", "base", "[NX3][CX3](=[NX2;!$(N-a)])[NX3]", 13.6, "guanidine"],
  ["amidine", "amidine", "base", "[CX3;!$(C(N)(N)=N)](=[NX2;!$(N-a)])[NX3;H1,H2]", 12.4, "acetamidine"],
  ["secondary aliphatic amine", "secondaryAmine", "base", "[NX3;H1;!$(N-[!#6;!#1]);!$(N-C=[O,N,S]);!$(N-a)]([CX4])[CX4]", 11.0, "diethylamine"],
  ["primary aliphatic amine", "primaryAmine", "base", "[NX3;H2;!$(N-[!#6;!#1]);!$(N-C=[O,N,S]);!$(N-a)][CX4]", 10.6, "ethylamine"],
  ["tertiary aliphatic amine", "tertiaryAmine", "base", "[NX3;H0;!$(N-[!#6]);!$(N-C=[O,N,S]);!$(N-a)]([CX4])([CX4])[CX4]", 9.8, "trimethylamine"],
  ["ammonia", "ammonia", "base", "[NX3H3]", 9.25, "ammonia"],
  ["imidazole", "imidazole", "base", "[nX2;r5]:c:[nX3H1;r5]", 6.95, "imidazole"],
  ["pyridine", "pyridine", "base", "[nX2;r6]", 5.23, "pyridine"],
  ["aniline", "aniline", "base", "c[NX3;H2,H1;!$(N-C=[O,N,S])]", 4.6, "aniline"],
];

export function pkaEstimates(mol: RDMol, p: Perception): Record<string, unknown>[] {
  const claimed = new Set<number>();
  const sites: Record<string, unknown>[] = [];
  for (const [name, groupId, kind, smarts, value, parent] of PKA_RULES) {
    for (const match of substructMatches(mol, smarts)) {
      const heavy = match.filter((i) => p.atoms[i]!.z !== 1);
      const anchor = pkaAnchor(p, heavy, kind);
      if (claimed.has(anchor)) continue;
      claimed.add(anchor);
      sites.push({ group: name, groupId, kind, pKa: value, uncertainty: 1.5, atoms: heavy, site: anchor, parentCompound: parent });
    }
  }
  return sites.sort((a, b) => (a["pKa"] as number) - (b["pKa"] as number));
}

function pkaAnchor(p: Perception, atoms: number[], kind: string): number {
  const sym = (i: number) => SYMBOLS[p.atoms[i]!.z];
  const hetero = atoms.filter((i) => ["O", "S", "N"].includes(sym(i)!));
  if (kind === "acid") {
    // GetTotalNumHs() without neighbours, as the desktop engine calls it.
    const withH = hetero.filter((i) => p.atoms[i]!.hs > 0);
    if (withH.length) return withH[withH.length - 1]!;
    const carbons = atoms.filter((i) => sym(i) === "C" && p.atoms[i]!.hs > 0);
    return carbons.length ? carbons[0]! : atoms[0]!;
  }
  const nitrogens = atoms.filter((i) => sym(i) === "N");
  return nitrogens.length ? nitrogens[0]! : atoms[0]!;
}

// ---------------------------------------------------------------------------------------------

/** Heavy-atom copy of an RDKit molecule (RemoveHs), deleted by the caller. */
export function withoutHydrogens(mol: RDMol): RDMol {
  const copy = mol.copy()!;
  copy.remove_hs_in_place(REMOVE_HS);
  return copy;
}

export function computeRDKit(m: Molecule, mol: RDMol): Record<string, PV> {
  const p = perceive(mol);
  const d = JSON.parse(mol.get_descriptors()) as Record<string, number>;
  const mw = d["amw"]!;
  const logp = d["CrippenClogP"]!;
  const hbd = d["NumHBD"]!;
  const hba = d["NumHBA"]!;
  const nhoh = d["lipinskiHBD"]!;
  const noCount = d["lipinskiHBA"]!;
  const tpsa = d["tpsa"]!;
  const rot = d["NumRotatableBonds"]!;
  const lipinskiChecks = { "molecularWeight≤500": mw <= 500, "logP≤5": logp <= 5, "hBondDonors(NH+OH)≤5": nhoh <= 5, "hBondAcceptors(N+O)≤10": noCount <= 10 };
  const violations = Object.values(lipinskiChecks).filter((ok) => !ok).length;
  const veberChecks = { "rotatableBonds≤10": rot <= 10, "tpsa≤140": tpsa <= 140 };
  const heavy = withoutHydrogens(mol);
  const heavyCount = heavy.get_num_atoms();
  const qedValue = withMol(heavy, (h) => qed(h, m, p, d));
  return {
    formula: pv(formulaOf(m, p), "", "RDKit CalcMolFormula"),
    molecularWeight: pv(round(mw, 4), "g/mol", "IUPAC standard atomic weights (RDKit MolWt)"),
    exactMass: pv(round(d["exactmw"]!, 6), "Da", "Monoisotopic mass (RDKit ExactMolWt)"),
    atomCount: pv(m.atoms.length, "", "Atoms in the structure, hydrogens included (RDKit)"),
    heavyAtomCount: pv(heavyCount, "", "Non-hydrogen atoms (RDKit)"),
    netCharge: pv(p.atoms.reduce((s, a) => s + a.charge, 0), "e", "sum of formal charges"),
    radicalElectrons: pv(p.atoms.reduce((s, a) => s + a.radicals, 0), "", "Unpaired electrons from valence analysis (RDKit)"),
    logP: pv(round(logp, 3), "", "Wildman–Crippen atomic contributions (RDKit)", 0.68),
    molarRefractivity: pv(round(d["CrippenMR"]!, 3), "cm³/mol", "Wildman–Crippen (RDKit)"),
    tpsa: pv(round(tpsa, 2), "Å²", "Ertl topological polar surface area (N,O)"),
    hBondDonors: pv(hbd, "", "RDKit Lipinski.NumHDonors"),
    hBondAcceptors: pv(hba, "", "RDKit Lipinski.NumHAcceptors"),
    rotatableBonds: pv(rot, "", "RDKit strict rotatable-bond definition"),
    ringCount: pv(d["NumRings"]!, "", "SSSR ring count"),
    aromaticRingCount: pv(d["NumAromaticRings"]!, "", "RDKit aromaticity model"),
    fractionCsp3: pv(round(d["FractionCSP3"]!, 4), "", "RDKit"),
    stereocenters: pv(d["NumAtomStereoCenters"]!, "", "RDKit CIP stereocentre perception"),
    gasteigerCharges: pv(gasteigerCharges(m, p), "e", "Gasteiger–Marsili PEOE"),
    lipinski: pv(
      { checks: lipinskiChecks, violations, passes: violations <= 1, values: { molecularWeight: round(mw, 3), logP: round(logp, 3), nhOhCount: nhoh, noCount } },
      "", "Lipinski rule of five (≤1 violation allowed)",
    ),
    veber: pv({ checks: veberChecks, passes: Object.values(veberChecks).every(Boolean), values: { rotatableBonds: rot, tpsa: round(tpsa, 2) } }, "", "Veber et al. 2002 oral bioavailability rules"),
    qed: pv(qedValue !== null ? round(qedValue, 4) : null, "", "Bickerton et al. 2012 quantitative estimate of drug-likeness"),
    pKaEstimates: pv(pkaEstimates(mol, p), "", PKA_METHOD),
  };
}

export function compute(m: Molecule): Record<string, PV> {
  return withMol(toRDKitStrict(m), (mol) => computeRDKit(m, mol));
}

export { rdkit };
