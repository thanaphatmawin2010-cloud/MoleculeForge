import type { Element } from "@/ipc/api";

/** Grid position (1-based row/column) in the 18-column table with a detached f-block (rows 9–10). */
export function position(el: Pick<Element, "Z" | "period" | "group">): { row: number; col: number } {
  if (el.Z >= 57 && el.Z <= 71) return { row: 9, col: el.Z - 57 + 3 };
  if (el.Z >= 89 && el.Z <= 103) return { row: 10, col: el.Z - 89 + 3 };
  return { row: el.period, col: el.group ?? 3 };
}

export type HeatProperty =
  | "electronegativityPauling"
  | "atomicMass"
  | "radiusAtomic"
  | "radiusCovalent"
  | "firstIonization"
  | "electronAffinity"
  | "density"
  | "meltingPointK"
  | "boilingPointK"
  | "thermalConductivity"
  | "dipolePolarizability";

export const HEAT_PROPERTIES: HeatProperty[] = [
  "electronegativityPauling",
  "atomicMass",
  "radiusAtomic",
  "radiusCovalent",
  "firstIonization",
  "electronAffinity",
  "density",
  "meltingPointK",
  "boilingPointK",
  "thermalConductivity",
  "dipolePolarizability",
];

export function heatValue(el: Element, prop: HeatProperty): { value: number | null; unit: string } {
  switch (prop) {
    case "atomicMass":
      return { value: el.atomicMass.value, unit: el.atomicMass.unit };
    case "radiusCovalent":
      return { value: el.radiusCovalent.single.value, unit: "pm" };
    case "firstIonization":
      return { value: el.ionizationEnergies.values[0] ?? null, unit: el.ionizationEnergies.unit };
    default: {
      const q = el[prop];
      return { value: q.value, unit: q.unit };
    }
  }
}

export type TemperatureUnit = "K" | "C" | "F";
export type EnergyUnit = "kJ/mol" | "eV";

export function convertTemperature(kelvin: number, unit: TemperatureUnit): number {
  if (unit === "C") return kelvin - 273.15;
  if (unit === "F") return (kelvin - 273.15) * 1.8 + 32;
  return kelvin;
}

export const KJMOL_PER_EV = 96.48533212331002;

export function convertEnergy(kjmol: number, unit: EnergyUnit): number {
  return unit === "eV" ? kjmol / KJMOL_PER_EV : kjmol;
}
