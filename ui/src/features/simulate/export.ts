/** Raw-data export of a simulation result (§7.8): JSON as returned, or one CSV row per property. */
import type { SimulationResult } from "@/ipc/schema";
import { fileStem } from "@/lib/files";

const cell = (text: string) => `"${text.replace(/"/g, '""')}"`;

export function resultToJson(result: SimulationResult): string {
  return JSON.stringify(result, null, 2);
}

export function resultToCsv(result: SimulationResult): string {
  const rows = [["property", "value", "unit", "method", "uncertainty"]];
  for (const [key, pv] of Object.entries(result.properties)) {
    const value = typeof pv.value === "object" ? JSON.stringify(pv.value) : String(pv.value);
    rows.push([key, value, pv.unit, pv.method, pv.uncertainty != null ? String(pv.uncertainty) : ""]);
  }
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}

export function exportFileName(moleculeName: string, method: string, format: "json" | "csv"): string {
  return `${fileStem(moleculeName)}-${method.replace(/\W+/g, "-")}.${format}`;
}
