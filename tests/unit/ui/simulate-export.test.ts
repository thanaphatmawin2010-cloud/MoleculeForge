import { describe, expect, it } from "vitest";
import { exportFileName, resultToCsv, resultToJson } from "@/features/simulate/export";
import { emptyMolecule } from "@/lib/molecule";
import type { SimulationResult } from "@/ipc/schema";

const result: SimulationResult = {
  jobId: "job-1",
  method: "property battery (standard)",
  engine: "MoleculeForge 1.0.0",
  converged: true,
  durationMs: 1200,
  geometry: emptyMolecule(),
  properties: {
    molecularWeight: { value: 18.015, unit: "g/mol", method: "IUPAC standard atomic weights (RDKit MolWt)" },
    dipoleVector: { value: [0, 1.848, 0], unit: "D", method: "B3LYP/def2-SVPD (PySCF)" },
    heatOfFormation: { value: -241.83, unit: "kJ/mol", method: 'PM7 "heat of formation"', uncertainty: 4.2 },
  },
  warnings: [],
  warningCodes: [],
};

describe("simulation raw-data export (§7.8)", () => {
  it("writes one quoted CSV row per property with unit, method and uncertainty", () => {
    const rows = resultToCsv(result).split("\n");
    expect(rows[0]).toBe('"property","value","unit","method","uncertainty"');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toBe('"molecularWeight","18.015","g/mol","IUPAC standard atomic weights (RDKit MolWt)",""');
    expect(rows[2]).toBe('"dipoleVector","[0,1.848,0]","D","B3LYP/def2-SVPD (PySCF)",""');
    expect(rows[3]).toBe('"heatOfFormation","-241.83","kJ/mol","PM7 ""heat of formation""","4.2"');
  });

  it("exports JSON that reads back to the same result", () => {
    expect(JSON.parse(resultToJson(result))).toEqual(result);
  });

  it("builds a safe file name from the molecule and the method", () => {
    expect(exportFileName("Acetic acid / glacial", result.method, "csv")).toBe("Acetic_acid_glacial-property-battery-standard-.csv");
    expect(exportFileName("", "md", "json")).toBe("molecule-md.json");
    expect(exportFileName("กรดแอซีติก", "md", "json")).toBe("กรดแอซีติก-md.json");
  });
});
