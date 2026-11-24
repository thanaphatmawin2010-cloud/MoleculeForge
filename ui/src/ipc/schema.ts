/**
 * Zod schemas mirroring compute/mfcompute/models.py (spec section 6).
 * Every message crossing the IPC boundary is validated here.
 */
import { z } from "zod";

export const BondOrder = z.enum(["single", "double", "triple", "aromatic"]);
export const BondStereo = z.enum(["none", "wedge", "hash", "cis", "trans"]);

export const AtomSchema = z.object({
  i: z.number().int().nonnegative(),
  el: z.string().min(1).max(3),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  charge: z.number().int().min(-8).max(8),
  isotope: z.number().int().positive().nullable(),
  hCount: z.number().int().min(0).max(8).nullable(),
});

export const BondSchema = z.object({
  a: z.number().int().nonnegative(),
  b: z.number().int().nonnegative(),
  order: BondOrder,
  stereo: BondStereo,
});

export const MoleculeMetaSchema = z.object({
  smiles: z.string(),
  inchi: z.string(),
  inchikey: z.string(),
  category: z.string(),
  source: z.enum(["prebuilt", "user"]),
  created: z.string(),
  /** Origin of the 3D stereo: wedges are shown only for "coordinates" and "defined". */
  stereo: z.enum(["coordinates", "defined", "partial", "none", ""]).default(""),
});

/** A stereo bond drawn as a wedge (towards the viewer) or hash (away), narrow end at ``from``. */
export const WedgeSchema = z.object({
  bond: z.number().int().nonnegative(),
  kind: z.enum(["wedge", "hash"]),
  from: z.number().int().nonnegative(),
});
export type Wedge = z.infer<typeof WedgeSchema>;

export const MoleculeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  formula: z.string(),
  atoms: z.array(AtomSchema),
  bonds: z.array(BondSchema),
  props: z.record(z.string(), z.unknown()),
  meta: MoleculeMetaSchema,
});

export const PropertyValueSchema = z.object({
  value: z.unknown(),
  unit: z.string(),
  method: z.string(),
  uncertainty: z.number().nullable().optional(),
});

export const IssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  atoms: z.array(z.number().int()),
  bonds: z.array(z.number().int()),
  params: z.record(z.string(), z.unknown()),
});

export const SimulationResultSchema = z.object({
  jobId: z.string(),
  method: z.string(),
  engine: z.string(),
  forceField: z.string().nullable().optional(),
  hamiltonian: z.string().nullable().optional(),
  converged: z.boolean(),
  durationMs: z.number(),
  geometry: MoleculeSchema,
  properties: z.record(z.string(), PropertyValueSchema),
  /** English sentences (exports, the assistant); the UI shows warningCodes in the user's language. */
  warnings: z.array(z.string()),
  warningCodes: z
    .array(z.object({ code: z.string().max(64), params: z.record(z.string(), z.union([z.string(), z.number()])) }))
    .default([]),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const FixLogSchema = z.object({
  before: z.record(z.string(), z.unknown()),
  reason: z.string(),
  /** Parameters of the issue that triggered the fix (1-based atom numbers) for issues:code.<reason>. */
  reasonParams: z.record(z.string(), z.unknown()).default({}),
  // Operation-specific fields (bond, atom, order, …) plus the common description/op/params.
  fix: z.looseObject({ description: z.string(), op: z.string(), params: z.record(z.string(), z.unknown()).default({}) }),
  after: z.record(z.string(), z.unknown()),
});
export type FixLog = z.infer<typeof FixLogSchema>;

export const ValidationResultSchema = z.object({
  status: z.enum(["valid", "fixed", "invalid"]),
  messageKey: z.string(),
  message: z.string(),
  results: z.array(
    z.object({
      kind: z.enum(["bond", "atom"]),
      index: z.number().int(),
      valid: z.boolean(),
      reasons: z.array(z.string()),
      explanation: z.string(),
    }),
  ),
  issues: z.array(IssueSchema),
  initialIssues: z.array(IssueSchema).optional(),
  fixes: z.array(FixLogSchema),
  ops: z.array(z.record(z.string(), z.unknown())),
  molecule: MoleculeSchema,
  atomMap: z.array(z.number().int()),
  durationMs: z.number(),
});

export const SanitizeResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(IssueSchema),
  molecule: MoleculeSchema,
  atoms: z.array(z.object({ atom: z.number(), implicitH: z.number(), hybridization: z.string() })),
});

const ChangeSchema = z.object({
  atoms: z.array(z.number()),
  elements: z.array(z.string()),
  old: z.number(),
  new: z.number(),
  delta: z.number(),
  unit: z.string(),
  rule: z.string(),
  order: z.string().optional(),
});

export const RepairReportSchema = z.object({
  status: z.enum(["repaired", "already-optimal", "failed"]),
  reason: z.string().optional(),
  molecule: MoleculeSchema,
  issuesFound: z.array(IssueSchema),
  fixesApplied: z.array(FixLogSchema),
  remainingIssues: z.array(IssueSchema).optional(),
  hybridization: z
    .array(
      z.object({
        atom: z.number(),
        element: z.string(),
        hybridization: z.string(),
        stericNumber: z.number().nullable(),
        sigmaBonds: z.number(),
        lonePairs: z.number(),
        vsepr: z.string().nullable(),
        idealAngle: z.number().nullable(),
        aromatic: z.boolean(),
        smallestRing: z.number().nullable(),
      }),
    )
    .optional(),
  changes: z
    .object({
      bonds: z.array(ChangeSchema),
      angles: z.array(ChangeSchema),
      dihedrals: z.array(ChangeSchema),
      bondsTotal: z.number(),
      anglesTotal: z.number(),
      dihedralsTotal: z.number(),
      addedAtoms: z.array(z.object({ atom: z.number(), element: z.string(), reason: z.string() })),
      removedAtoms: z.array(z.object({ atom: z.number(), reason: z.string() })),
    })
    .optional(),
  methods: z.array(z.object({ stage: z.string(), method: z.string(), details: z.string() })).optional(),
  convergence: z.record(z.string(), z.unknown()).optional(),
  residualEnergy: z.object({ value: z.number().nullable(), unit: z.string(), method: z.string() }).optional(),
  rmsd: z.object({ value: z.number().nullable(), unit: z.string(), note: z.string() }).optional(),
  geometryCheck: z
    .object({
      bondTable: z.array(
        z.object({
          type: z.string(),
          count: z.number(),
          mean: z.number(),
          min: z.number(),
          max: z.number(),
          unit: z.string(),
          reference: z.object({ typical: z.number(), low: z.number(), high: z.number(), source: z.string() }),
          withinTenPercent: z.boolean(),
          withinRange: z.boolean(),
        }),
      ),
      angleTable: z.array(
        z.object({
          class: z.string(),
          count: z.number(),
          mean: z.number(),
          min: z.number(),
          max: z.number(),
          unit: z.string(),
          ideal: z.number().nullable(),
          range: z.array(z.number()).nullable(),
          withinTenPercent: z.boolean(),
        }),
      ),
      minNonBondedDistance: z.object({ value: z.number().nullable(), unit: z.string(), atoms: z.array(z.number()).nullable() }),
    })
    .optional(),
  finalIssues: z.array(IssueSchema).optional(),
  atomMap: z.array(z.number().int()).optional(),
  durationMs: z.number(),
});

export const ProgressSchema = z.object({
  jobId: z.string(),
  percent: z.number(),
  stage: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const RpcErrorSchema = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });

// Order matters: z.union returns the first match, and `result: z.unknown()` would also accept an
// error response (result undefined), turning engine errors into confusing validation failures.
export const RpcMessageSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]), error: RpcErrorSchema }),
  z.object({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.record(z.string(), z.unknown()) }),
  z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), result: z.unknown() }),
]);

export type Atom = z.infer<typeof AtomSchema>;
export type Bond = z.infer<typeof BondSchema>;
export type Molecule = z.infer<typeof MoleculeSchema>;
export type PropertyValue = z.infer<typeof PropertyValueSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type SimulationResult = z.infer<typeof SimulationResultSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type SanitizeResult = z.infer<typeof SanitizeResultSchema>;
export type RepairReport = z.infer<typeof RepairReportSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
export type RpcErrorBody = z.infer<typeof RpcErrorSchema>;
export type BondOrderT = z.infer<typeof BondOrder>;
