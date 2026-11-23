/**
 * Typed wrappers for every sidecar method (spec 4.3). Responses are schema-validated.
 */
import { z } from "zod";
import { type CallOptions, rpc } from "./client";
import {
  type Molecule,
  MoleculeSchema,
  PropertyValueSchema,
  RepairReportSchema,
  SanitizeResultSchema,
  SimulationResultSchema,
  ValidationResultSchema,
  WedgeSchema,
  type Wedge,
} from "./schema";

const Loose = z.record(z.unknown());

export const ElementQuantity = z.object({
  value: z.number().nullable(),
  unit: z.string(),
  status: z.enum(["measured", "predicted", "unknown"]),
  source: z.string().nullable(),
});

export const ElementSchema = z
  .object({
    Z: z.number(),
    symbol: z.string(),
    name: z.string(),
    nameEn: z.string(),
    atomicMass: z.object({
      value: z.number().nullable(),
      uncertainty: z.number().nullable(),
      unit: z.string(),
      isMassNumberOfLongestLived: z.boolean(),
    }),
    category: z.string(),
    group: z.number().nullable(),
    period: z.number(),
    block: z.string(),
    electronConfiguration: z.object({ full: z.string(), nobleGasShorthand: z.string() }),
    shellElectrons: z.array(z.number()),
    electronegativityPauling: ElementQuantity,
    electronegativityAllen: ElementQuantity.extend({ eV: z.number().nullable() }),
    radiusCovalent: z.object({ single: ElementQuantity, double: ElementQuantity, triple: ElementQuantity }),
    radiusVanDerWaals: ElementQuantity,
    radiusAtomic: ElementQuantity,
    ionicRadii: z.object({
      unit: z.string(),
      source: z.string(),
      entries: z.array(
        z.object({
          charge: z.number(),
          coordination: z.string(),
          spin: z.string().nullable(),
          crystalRadius: z.number().nullable(),
          ionicRadius: z.number().nullable(),
        }),
      ),
    }),
    ionizationEnergies: z.object({ unit: z.string(), values: z.array(z.number()), source: z.string().nullable() }),
    electronAffinity: ElementQuantity,
    oxidationStates: z.object({ common: z.array(z.number()), all: z.array(z.number()) }),
    isotopes: z.array(
      z.object({
        massNumber: z.number(),
        mass: z.object({ value: z.number().nullable(), uncertainty: z.number().nullable(), unit: z.string() }),
        abundance: z.object({ value: z.number().nullable(), unit: z.string() }),
        halfLife: z.object({
          value: z.number().nullable(),
          unit: z.string().nullable(),
          seconds: z.number().nullable(),
          stable: z.boolean(),
        }),
        decayMode: z.array(z.object({ mode: z.string(), intensityPercent: z.number().nullable(), relation: z.string().nullable() })),
        nuclearSpin: z.string().nullable(),
        gFactor: z.number().nullable(),
        quadrupoleMomentBarn: z.number().nullable(),
      }),
    ),
    density: ElementQuantity.extend({ conditions: z.string() }),
    meltingPointK: ElementQuantity,
    boilingPointK: ElementQuantity,
    heatOfFusion: ElementQuantity,
    heatOfVaporization: ElementQuantity,
    molarHeatCapacity: ElementQuantity,
    thermalConductivity: ElementQuantity,
    electricalType: z.object({ value: z.string().nullable(), status: z.string(), source: z.string().nullable() }),
    crystalStructure: z.object({ value: z.string().nullable(), status: z.string() }),
    discoveredBy: z.object({ value: z.string().nullable(), knownSinceAntiquity: z.boolean() }),
    yearDiscovered: z.object({ value: z.number().nullable(), knownSinceAntiquity: z.boolean() }),
    cpkColorHex: z.string(),
    commonUses: z.array(z.string()),
    dipolePolarizability: ElementQuantity,
    notes: z.record(z.string()),
  })
  .passthrough();

export type Element = z.infer<typeof ElementSchema>;

const ElementsAllSchema = z.object({
  elements: z.array(ElementSchema),
  statusLegend: z.record(z.string()),
  sources: z.record(z.string()),
});

export const CapabilitiesSchema = z
  .object({
    app: z.object({ computeVersion: z.string(), platform: z.string() }),
    os: z.object({ system: z.string(), release: z.string(), machine: z.string() }),
    cpu: z.object({
      model: z.string(),
      physicalCores: z.number().nullable(),
      logicalCores: z.number().nullable(),
      features: z.record(z.boolean()),
      recommendedThreads: z.number(),
    }),
    memory: z.object({ totalBytes: z.number(), availableBytes: z.number() }),
    gpu: z.object({
      adapters: z.array(Loose),
      openmmPlatforms: z.array(z.object({ name: z.string(), speed: z.number() })),
      llmDevices: z.array(z.string()),
      accelerated: z.boolean(),
    }),
    engines: z.object({
      libraries: z.record(z.string()),
      xtb: Loose,
      mopac: Loose,
      vina: Loose,
      llama: Loose,
      model: Loose,
    }),
    selected: z.object({ openmmPlatform: z.string().nullable(), threads: z.number(), llmOffload: z.string() }),
  })
  .passthrough();
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const LibraryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  formula: z.string(),
  inchikey: z.string().nullable(),
  smiles: z.string().nullable(),
  category: z.string(),
  source: z.enum(["prebuilt", "user"]),
  favorite: z.boolean(),
  tags: z.array(z.string()),
  created: z.string(),
  descriptors: z.record(z.unknown()).nullable(),
});
export type LibraryItem = z.infer<typeof LibraryItemSchema>;

const Layout2D = z.array(z.tuple([z.number(), z.number()]));

export const api = {
  ping: () => rpc().call("system.ping", {}, z.object({ pong: z.literal(true), version: z.string() }), { timeoutMs: 1500 }),
  capabilities: (refresh = false) => rpc().call("system.capabilities", { refresh }, CapabilitiesSchema),
  sanitize: (molecule: Molecule) => rpc().call("chem.sanitize", { molecule }, SanitizeResultSchema),
  validateBonds: (molecule: Molecule, focusAtoms: number[], focusBonds: number[], autoFix = true) =>
    rpc().call("chem.validateBonds", { molecule, focusAtoms, focusBonds, autoFix }, ValidationResultSchema),
  repairGeometry: (molecule: Molecule, options: CallOptions & { refine?: "auto" | "none" | "gfn2-xtb" } = {}) =>
    rpc().call("chem.repairGeometry", { molecule, refine: options.refine ?? "auto" }, RepairReportSchema, options),
  relax: (molecule: Molecule, options: CallOptions & { addHydrogens?: boolean } = {}) =>
    rpc().call(
      "chem.relax",
      { molecule, maxSteps: options.addHydrogens ? 500 : 300, addHydrogens: options.addHydrogens ?? false },
      z.object({ molecule: MoleculeSchema }),
      options,
    ),
  descriptors: (molecule: Molecule) =>
    rpc().call("chem.descriptors", { molecule }, z.object({ properties: z.record(PropertyValueSchema) })),
  layout2d: (molecule: Molecule) => rpc().call("chem.layout2d", { molecule }, z.object({ layout2d: Layout2D })),
  convert: (params: Record<string, unknown>) =>
    rpc().call(
      "chem.convertFormat",
      params,
      z.object({ molecules: z.array(MoleculeSchema).optional(), data: z.string().optional(), format: z.string().optional() }),
    ),
  minimize: (molecule: Molecule, method: string, options: CallOptions = {}) =>
    rpc().call("sim.minimize", { molecule, method }, SimulationResultSchema, options),
  md: (molecule: Molecule, settings: Record<string, unknown>, options: CallOptions = {}) =>
    rpc().call("sim.md", { molecule, ...settings }, SimulationResultSchema, options),
  properties: (molecule: Molecule, level: "fast" | "standard" | "thorough", md: boolean, options: CallOptions = {}) =>
    rpc().call("sim.properties", { molecule, level, md }, SimulationResultSchema, options),
  dock: (receptor: Molecule, ligand: Molecule, exhaustiveness: number, options: CallOptions = {}) =>
    rpc().call("sim.dock", { receptor, ligand, exhaustiveness }, SimulationResultSchema, options),
  elementsAll: () => rpc().call("elements.all", {}, ElementsAllSchema),
  /** Wedge/hash bonds for the 3D stereocentres; ``layout2d`` in RDKit orientation (y up). */
  wedges: (molecule: Molecule, layout2d: [number, number][], explicitH: boolean) =>
    rpc().call("chem.wedges", { molecule, layout2d, explicitH }, z.object({ wedges: z.array(WedgeSchema) })),
  libraryList: (params: Record<string, unknown>) =>
    rpc().call("library.list", params, z.object({ total: z.number(), items: z.array(LibraryItemSchema) })),
  libraryLoad: (id: string) =>
    rpc().call(
      "library.load",
      { id },
      LibraryItemSchema.extend({ molecule: MoleculeSchema, layout2d: Layout2D.nullable(), wedges: z.array(WedgeSchema).default([]) }),
    ),
  librarySave: (molecule: Molecule, layout2d: [number, number][] | null, overwrite = false, tags: string[] = [], wedges: Wedge[] = []) =>
    rpc().call(
      "library.save",
      { molecule, layout2d, overwrite, tags, wedges },
      z.object({
        saved: z.boolean(),
        id: z.string().optional(),
        category: z.string().optional(),
        molecule: MoleculeSchema.optional(),
        duplicateOf: z.object({ id: z.string(), name: z.string(), source: z.string() }).optional(),
        inchikey: z.string().optional(),
      }),
    ),
  libraryDelete: (id: string) => rpc().call("library.delete", { id }, z.object({ deleted: z.boolean(), id: z.string() })),
  libraryFavorite: (id: string, favorite: boolean) =>
    rpc().call("library.favorite", { id, favorite }, z.object({ id: z.string(), favorite: z.boolean() })),
  libraryCategories: () =>
    rpc().call(
      "library.categories",
      {},
      z.object({
        categories: z.array(z.object({ id: z.string(), row: z.number(), col: z.number(), family: z.string(), count: z.number() })),
      }),
    ),
  libraryImport: (format: "sdf" | "json", data: string, options: CallOptions = {}) =>
    rpc().call("library.import", { format, data }, z.object({ imported: z.number(), duplicates: z.array(z.unknown()), ids: z.array(z.string()) }), options),
  libraryExport: (format: "sdf" | "json", ids: string[]) =>
    rpc().call("library.export", { format, ids }, z.object({ format: z.string(), count: z.number(), data: z.string() })),
  reportExport: (report: unknown, format: "markdown" | "pdf", locale: string, strings: Record<string, string | string[] | Record<string, string>>) =>
    rpc().call(
      "report.export",
      { report, format, locale, strings },
      z.object({ format: z.string(), data: z.string(), encoding: z.enum(["utf-8", "base64"]), filename: z.string() }),
    ),
  aiStatus: () =>
    rpc().call(
      "ai.status",
      {},
      z.object({
        available: z.boolean(),
        running: z.boolean(),
        model: z.object({ path: z.string().nullable(), name: z.string().nullable(), sizeBytes: z.number().nullable() }),
        contextSize: z.number(),
        accelerator: z.string(),
        offloadLayers: z.number(),
      }),
    ),
};

export const AiAnswerSchema = z.object({
  answer: z.string(),
  toolCalls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      arguments: z.record(z.unknown()),
      ok: z.boolean(),
      durationMs: z.number(),
      summary: z.string(),
      result: z.unknown(),
    }),
  ),
  sources: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  /** Numbers in the answer that no tool result supports (shown as a warning badge). */
  unsupportedNumbers: z.array(z.string()).default([]),
  model: z.string(),
  durationMs: z.number(),
  refused: z.boolean(),
});
export type AiAnswer = z.infer<typeof AiAnswerSchema>;

export const askAssistant = (
  prompt: string,
  history: { role: string; content: string }[],
  molecule: Molecule | null,
  context: Record<string, unknown>,
  locale: string,
  options: CallOptions,
) => rpc().call("ai.query", { prompt, history, molecule, context, locale }, AiAnswerSchema, options);
