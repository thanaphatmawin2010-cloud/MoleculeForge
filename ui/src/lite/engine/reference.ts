/**
 * Reference geometry for repair reports: a port of compute/mfcompute/chem/reference.py (Allen et al.
 * 1987 / CRC Handbook bond lengths; Gillespie & Hargittai VSEPR angles).
 */
import { expectedBondLength } from "./elements";

export interface BondRef {
  typical: number;
  low: number;
  high: number;
  source: string;
}

const ALLEN = "Allen et al. 1987 / CRC Handbook";
const ref = (typical: number, low: number, high: number, source = ALLEN): BondRef => ({ typical, low, high, source });

const BOND_REFS: Record<string, BondRef> = {
  "C|H|single": ref(1.09, 1.05, 1.12),
  "C|C|single": ref(1.53, 1.45, 1.58),
  "C|C|double": ref(1.33, 1.3, 1.36),
  "C|C|triple": ref(1.2, 1.17, 1.22),
  "C|C|aromatic": ref(1.39, 1.36, 1.42),
  "C|N|single": ref(1.47, 1.33, 1.5),
  "C|N|double": ref(1.28, 1.25, 1.31),
  "C|N|triple": ref(1.15, 1.13, 1.17),
  "C|N|aromatic": ref(1.34, 1.31, 1.39),
  "C|O|single": ref(1.43, 1.3, 1.47),
  "C|O|double": ref(1.21, 1.15, 1.25),
  "C|O|aromatic": ref(1.36, 1.33, 1.39),
  "C|S|single": ref(1.82, 1.74, 1.86),
  "C|S|double": ref(1.67, 1.59, 1.71),
  "C|S|aromatic": ref(1.71, 1.68, 1.75),
  "C|F|single": ref(1.36, 1.32, 1.4),
  "C|Cl|single": ref(1.76, 1.71, 1.8),
  "Br|C|single": ref(1.94, 1.88, 1.98),
  "C|I|single": ref(2.14, 2.08, 2.18),
  "H|N|single": ref(1.01, 0.98, 1.04),
  "H|O|single": ref(0.96, 0.93, 0.99),
  "H|S|single": ref(1.34, 1.32, 1.37),
  "H|P|single": ref(1.42, 1.38, 1.45),
  "H|Si|single": ref(1.48, 1.46, 1.5),
  "B|H|single": ref(1.19, 1.15, 1.22),
  "H|H|single": ref(0.74, 0.72, 0.76),
  "N|N|single": ref(1.43, 1.38, 1.47),
  "N|N|double": ref(1.24, 1.21, 1.27),
  "N|N|triple": ref(1.1, 1.08, 1.12),
  "N|N|aromatic": ref(1.34, 1.3, 1.38),
  "N|O|single": ref(1.4, 1.36, 1.45),
  "N|O|double": ref(1.21, 1.18, 1.25),
  "N|O|aromatic": ref(1.38, 1.34, 1.42),
  "O|O|single": ref(1.47, 1.44, 1.5),
  "O|O|double": ref(1.21, 1.2, 1.23),
  "O|P|single": ref(1.6, 1.55, 1.65),
  "O|P|double": ref(1.48, 1.44, 1.52),
  "O|S|single": ref(1.58, 1.52, 1.64),
  "O|S|double": ref(1.44, 1.41, 1.48),
  "S|S|single": ref(2.05, 2.01, 2.09),
  "C|P|single": ref(1.84, 1.79, 1.88),
  "C|Si|single": ref(1.87, 1.84, 1.9),
  "N|S|single": ref(1.65, 1.6, 1.7),
  "C|C|single-ring3": ref(1.51, 1.48, 1.53),
};

export const CUMULATED_CO = ref(1.16, 1.15, 1.18, "CRC Handbook (CO2 gas phase 1.160 Å)");

export const VSEPR_ANGLES: Record<string, [number, number, number]> = {
  AX2: [180.0, 175.0, 180.0],
  AX2E: [117.0, 105.0, 125.0],
  AX2E2: [104.5, 100.0, 109.5],
  AX2E3: [180.0, 175.0, 180.0],
  AX3: [120.0, 110.0, 125.0],
  AX3E: [107.0, 100.0, 110.0],
  AX3E2: [87.5, 80.0, 95.0],
  AX4: [109.47, 104.0, 115.0],
  AX4E: [102.0, 85.0, 120.0],
  AX4E2: [90.0, 85.0, 95.0],
  AX5: [90.0, 85.0, 120.0],
  AX6: [90.0, 85.0, 95.0],
};

/** Python's sorted() order for element symbols (code-point order, as the desktop sorts them). */
export function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function bondReference(elA: string, elB: string, order: string, cumulated = false): BondRef {
  const [a, b] = sortedPair(elA, elB);
  if (cumulated && a === "C" && b === "O" && order === "double") return CUMULATED_CO;
  const known = BOND_REFS[`${a}|${b}|${order}`];
  if (known) return known;
  const expected = expectedBondLength(elA, elB, order);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { typical: r3(expected), low: r3(expected * 0.9), high: r3(expected * 1.1), source: "Pyykkö covalent radii ±10%" };
}

export function vseprClass(stericBonds: number, lonePairs: number): string {
  return `AX${stericBonds}${lonePairs === 1 ? "E" : lonePairs > 1 ? `E${lonePairs}` : ""}`;
}
