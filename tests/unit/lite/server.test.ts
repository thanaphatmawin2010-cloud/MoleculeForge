// @vitest-environment node
/**
 * The Lite server answers every method the UI calls with responses that pass the UI's own schemas
 * (ui/src/ipc/api.ts, ui/src/ipc/schema.ts): the same contract the desktop sidecar meets.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AiStatusSchema, CapabilitiesSchema, ElementSchema, LibraryItemSchema } from "@/ipc/api";
import { MoleculeSchema, ProgressSchema, PropertyValueSchema, RepairReportSchema, SanitizeResultSchema, SimulationResultSchema, ValidationResultSchema, WedgeSchema, type Molecule } from "@/ipc/schema";
import { setElements, type ElementsPayload } from "@/lite/engine/elements";
import { Library } from "@/lite/engine/library";
import { loadOCL } from "@/lite/engine/ocl";
import { loadRDKit } from "@/lite/engine/rdkit";
import { LiteServer } from "@/lite/engine/server";
import { MemoryStore } from "@/lite/engine/storage";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
let server: LiteServer;
const lines: Record<string, unknown>[] = [];
let counter = 0;

beforeAll(async () => {
  await loadRDKit();
  await loadOCL();
  setElements(JSON.parse(readFileSync(`${ROOT}data/elements.json`, "utf8")) as ElementsPayload);
  const library = new Library(new MemoryStore());
  await library.load(JSON.parse(readFileSync(`${ROOT}data/molecules/library.json`, "utf8")));
  server = new LiteServer((line) => lines.push(JSON.parse(line) as Record<string, unknown>), library);
  server.ready();
});

async function call(method: string, params: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: { code: number; message: string; data?: Record<string, unknown> }; progress: Record<string, unknown>[] }> {
  const id = `t${counter++}`;
  const jobId = `job-${id}`;
  server.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, jobId } }));
  for (let i = 0; i < 6000; i++) {
    const response = lines.find((l) => l["id"] === id);
    if (response) {
      const progress = lines.filter((l) => l["method"] === "progress" && (l["params"] as Record<string, unknown>)["jobId"] === jobId).map((l) => l["params"] as Record<string, unknown>);
      return { result: response["result"], error: response["error"] as never, progress };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no response to ${method}`);
}

const water = (): Molecule => ({
  id: "w", name: "water", formula: "",
  atoms: [
    { i: 0, el: "O", x: 0, y: 0, z: 0, charge: 0, isotope: null, hCount: null },
    { i: 1, el: "H", x: 1.4, y: 0, z: 0, charge: 0, isotope: null, hCount: null },
    { i: 2, el: "H", x: -1.4, y: 0.05, z: 0, charge: 0, isotope: null, hCount: null },
  ],
  bonds: [{ a: 0, b: 1, order: "single", stereo: "none" }, { a: 0, b: 2, order: "single", stereo: "none" }],
  props: {}, meta: { smiles: "", inchi: "", inchikey: "", category: "", source: "user", created: "2026-01-01T00:00:00+00:00", stereo: "" },
});

describe("lite server: system and data", () => {
  it("announces readiness with its methods", () => {
    const ready = lines.find((l) => l["method"] === "ready")!;
    expect((ready["params"] as { methods: string[] }).methods).toContain("chem.validateBonds");
  });
  it("capabilities and AI status match the UI schemas", async () => {
    expect(CapabilitiesSchema.safeParse((await call("system.capabilities")).result).success).toBe(true);
    expect(AiStatusSchema.safeParse((await call("ai.status")).result).success).toBe(true);
  });
  it("all 118 elements", async () => {
    const { result } = await call("elements.all");
    const parsed = z.object({ elements: z.array(ElementSchema) }).safeParse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.elements).toHaveLength(118);
  });
});

describe("lite server: chemistry", () => {
  it("validates and sanitises", async () => {
    const v = await call("chem.validateBonds", { molecule: water(), focusAtoms: [], focusBonds: [1], autoFix: true });
    expect(ValidationResultSchema.safeParse(v.result).success).toBe(true);
    const s = await call("chem.sanitize", { molecule: water() });
    expect(SanitizeResultSchema.safeParse(s.result).success).toBe(true);
  });
  it("repairs a stretched water to a realistic geometry and reports it", async () => {
    const r = await call("chem.repairGeometry", { molecule: water(), refine: "auto" });
    const parsed = RepairReportSchema.safeParse(r.result);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    const report = parsed.data!;
    expect(report.status).toBe("repaired");
    const [o, h1, h2] = report.molecule.atoms;
    const d = (a: typeof o, b: typeof o) => Math.hypot(a!.x - b!.x, a!.y - b!.y, a!.z - b!.z);
    expect(d(o, h1)).toBeCloseTo(0.969, 2);
    const angle = (Math.acos(((h1!.x - o!.x) * (h2!.x - o!.x) + (h1!.y - o!.y) * (h2!.y - o!.y) + (h1!.z - o!.z) * (h2!.z - o!.z)) / (d(o, h1) * d(o, h2))) * 180) / Math.PI;
    expect(angle).toBeGreaterThan(102);
    expect(angle).toBeLessThan(106);
    expect(r.progress.every((p) => ProgressSchema.safeParse(p).success)).toBe(true);
    const md = await call("report.export", { report: r.result, format: "markdown", locale: "en", strings: {} });
    expect((md.result as { data: string }).data).toContain("# Repair report: water");
  });
  it("relaxes live with frames for the drawn atoms only", async () => {
    const r = await call("chem.relax", { molecule: water(), maxSteps: 300, addHydrogens: false });
    expect(z.object({ molecule: MoleculeSchema }).safeParse(r.result).success).toBe(true);
    const frames = r.progress.map((p) => (p["data"] as { frame?: unknown[] } | undefined)?.frame).filter(Boolean);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f!.length === 3)).toBe(true);
  });
  it("descriptors, conversions, 2D layout and wedges", async () => {
    const conv = await call("chem.convertFormat", { source: "smiles", target: "molecule", data: "C[C@@H](C(=O)O)N", name: "L-alanine" });
    const [ala] = (conv.result as { molecules: Molecule[] }).molecules;
    expect(MoleculeSchema.safeParse(ala).success).toBe(true);
    const desc = await call("chem.descriptors", { molecule: ala });
    expect(z.object({ properties: z.record(z.string(), PropertyValueSchema) }).safeParse(desc.result).success).toBe(true);
    for (const target of ["sdf", "mol", "smiles", "xyz", "pdb", "inchi"]) {
      const out = await call("chem.convertFormat", { source: "molecule", target, molecule: ala });
      expect((out.result as { data: string }).data.length, target).toBeGreaterThan(10);
    }
    const layout = await call("chem.layout2d", { molecule: ala });
    const points = (layout.result as { layout2d: [number, number][] }).layout2d;
    expect(points).toHaveLength(ala!.atoms.length);
    const wedges = await call("chem.wedges", { molecule: ala, layout2d: points, explicitH: false });
    const parsed = z.object({ wedges: z.array(WedgeSchema) }).safeParse(wedges.result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.wedges).toHaveLength(1);
  });
  it("properties and minimisation match the simulation schema; desktop-only jobs say so", async () => {
    const props = await call("sim.properties", { molecule: water(), level: "fast", md: false });
    const parsed = SimulationResultSchema.safeParse(props.result);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    expect(parsed.data!.properties["molecularWeight"]!.value).toBeCloseTo(18.015, 3);
    expect(parsed.data!.warningCodes.map((w) => w.code)).toContain("liteEngines");
    const min = await call("sim.minimize", { molecule: water(), method: "auto" });
    expect(SimulationResultSchema.safeParse(min.result).success).toBe(true);
    const md = await call("sim.md", { molecule: water() });
    expect(md.error?.data?.["code"]).toBe("DESKTOP_ONLY");
    const ai = await call("ai.query", { prompt: "hi" });
    expect(ai.error?.data?.["code"]).toBe("DESKTOP_ONLY");
  });
});

describe("lite server: library", () => {
  it("lists, saves, finds duplicates, favourites, exports and deletes", async () => {
    const list = await call("library.list", { query: "", limit: 400 });
    const parsed = z.object({ total: z.number(), items: z.array(LibraryItemSchema) }).safeParse(list.result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.total).toBe(187);
    const byWeight = await call("library.list", { sort: "weight", limit: 3 });
    expect((byWeight.result as { items: { name: string }[] }).items[0]!.name).toBe("Hydrogen");
    const search = await call("library.list", { query: "caff" });
    expect((search.result as { items: { name: string }[] }).items.map((i) => i.name)).toContain("Caffeine");
    const dup = await call("library.save", { molecule: water(), layout2d: null });
    expect((dup.result as { saved: boolean }).saved).toBe(false);
    const conv = await call("chem.convertFormat", { source: "smiles", target: "molecule", data: "CC(C)(C)CO", name: "neopentyl alcohol" });
    const neo = (conv.result as { molecules: Molecule[] }).molecules[0]!;
    const saved = await call("library.save", { molecule: neo, layout2d: null });
    const { id, category } = saved.result as { saved: boolean; id: string; category: string };
    expect(category).toBe("alcohols-ethers");
    expect((await call("library.favorite", { id, favorite: true })).result).toEqual({ id, favorite: true });
    const mine = await call("library.list", { source: "user", favoritesOnly: true });
    expect((mine.result as { total: number }).total).toBe(1);
    const exported = await call("library.export", { format: "sdf", ids: [] });
    expect((exported.result as { data: string }).data).toContain("$$$$");
    const cats = await call("library.categories");
    expect((cats.result as { categories: { id: string; count: number }[] }).categories.find((c) => c.id === "alcohols-ethers")!.count).toBeGreaterThan(1);
    expect((await call("library.delete", { id })).result).toEqual({ deleted: true, id });
    expect((await call("library.delete", { id: "prebuilt-water" })).error?.code).toBeDefined();
  });
});
