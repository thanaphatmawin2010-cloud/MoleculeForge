/**
 * The Lite engine's JSON-RPC 2.0 server: the same protocol, method names, parameters, error codes
 * and progress notifications as the desktop sidecar (compute/mfcompute/server.py), answered by the
 * WebAssembly engine. Methods that need the desktop app's engines answer ENGINE_UNAVAILABLE with
 * code DESKTOP_ONLY, which the UI turns into a "desktop app" notice.
 */
import { MoleculeSchema, type Molecule } from "@/ipc/schema";
import { annotate, parse, write } from "./convert";
import { compute as computeDescriptors } from "./descriptors";
import { layout2d, wedges } from "./depict";
import * as elements from "./elements";
import { CHEMISTRY_ERROR, ENGINE_UNAVAILABLE, INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, JOB_CANCELLED, METHOD_NOT_FOUND, PARSE_ERROR, RpcFailure } from "./errors";
import { quickRelax, repair } from "./geometry";
import { JobContext } from "./jobs";
import { Library } from "./library";
import { LITE_VERSION, minimizeJob, properties } from "./properties";
import { recoverFromTrap, rdkit } from "./rdkit";
import { exportReport } from "./report";
import { sanitize, validate } from "./validate";

type Kind = "control" | "interactive" | "job";
type Handler = (params: Record<string, unknown>, ctx: JobContext) => unknown;

const MAX_ATOMS = 20_000;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

function desktopOnly(what: string, engine: string): never {
  throw new RpcFailure(ENGINE_UNAVAILABLE, `${what} runs in the MoleculeForge desktop app`, { engine, code: "DESKTOP_ONLY" });
}

function molecule(value: unknown, key = "molecule"): Molecule {
  const parsed = MoleculeSchema.safeParse(value);
  if (!parsed.success) {
    throw new RpcFailure(INVALID_PARAMS, "Invalid params", parsed.error.issues.slice(0, 20).map((i) => ({ loc: [key, ...i.path].join("."), msg: i.message })) as unknown as Record<string, unknown>);
  }
  const m = parsed.data;
  if (m.atoms.length > MAX_ATOMS) throw new RpcFailure(INVALID_PARAMS, "Invalid params", { loc: `${key}.atoms`, msg: `at most ${MAX_ATOMS} atoms` });
  m.atoms.forEach((a, i) => {
    if (a.i !== i) throw new RpcFailure(INVALID_PARAMS, "Invalid params", { loc: key, msg: `atom index ${a.i} at position ${i}: indices must be 0..n-1 in order` });
  });
  for (const b of m.bonds) {
    if (b.a >= m.atoms.length || b.b >= m.atoms.length) throw new RpcFailure(INVALID_PARAMS, "Invalid params", { loc: key, msg: `bond ${b.a}-${b.b} references a missing atom` });
  }
  return { ...m, atoms: m.atoms.map((a) => ({ ...a, el: a.el.trim().charAt(0).toUpperCase() + a.el.trim().slice(1).toLowerCase() })) };
}

const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

export interface Assets {
  elements: elements.ElementsPayload;
  library: { molecules: unknown[] };
}

export class LiteServer {
  readonly methods = new Map<string, { kind: Kind; handler: Handler }>();
  private active = new Map<string, JobContext>();
  private counter = 0;

  constructor(
    private readonly send: (line: string) => void,
    private readonly library: Library,
  ) {
    this.register();
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private on(name: string, kind: Kind, handler: Handler): void {
    this.methods.set(name, { kind, handler });
  }

  private register(): void {
    const lib = this.library;
    this.on("system.ping", "control", () => ({ pong: true, version: LITE_VERSION }));
    this.on("system.capabilities", "interactive", () => capabilities());
    this.on("system.shutdown", "control", () => ({ ok: true }));
    this.on("job.cancel", "control", (p) => ({ jobId: str(p["jobId"]), cancelled: this.cancel(str(p["jobId"])) }));
    this.on("ai.cancel", "control", (p) => ({ jobId: str(p["jobId"]), cancelled: this.cancel(str(p["jobId"])) }));

    this.on("chem.sanitize", "interactive", (p) => sanitize(molecule(p["molecule"])));
    this.on("chem.validateBonds", "interactive", (p) => validate(molecule(p["molecule"]), ints(p["focusAtoms"]), ints(p["focusBonds"]), p["autoFix"] !== false));
    this.on("chem.repairGeometry", "job", (p, ctx) => repair(molecule(p["molecule"]), str(p["refine"], "auto"), str(p["forceField"], "auto"), ctx));
    this.on("chem.relax", "job", async (p, ctx) => ({
      molecule: await quickRelax(molecule(p["molecule"]), ctx, Number(p["maxSteps"] ?? 300), p["addHydrogens"] === true),
    }));
    this.on("chem.descriptors", "interactive", (p) => ({ properties: computeDescriptors(molecule(p["molecule"])) }));
    this.on("chem.convertFormat", "interactive", (p) => {
      const source = str(p["source"]);
      const target = str(p["target"]);
      let molecules: Molecule[];
      if (source === "molecule") {
        const list = Array.isArray(p["molecules"]) ? (p["molecules"] as unknown[]).map((m, i) => molecule(m, `molecules.${i}`)) : p["molecule"] ? [molecule(p["molecule"])] : [];
        if (!list.length) throw new RpcFailure(CHEMISTRY_ERROR, "No molecule supplied", { code: "EMPTY_INPUT" });
        molecules = list;
      } else {
        if (typeof p["data"] !== "string") throw new RpcFailure(CHEMISTRY_ERROR, "No input data", { code: "EMPTY_INPUT" });
        molecules = parse(source, p["data"], { charge: Number(p["charge"] ?? 0), embed3d: p["embed3d"] !== false, name: str(p["name"]) });
      }
      if (target === "molecule") return { molecules };
      return { data: write(target, molecules), format: target, count: molecules.length };
    });
    this.on("chem.layout2d", "interactive", (p) => ({ layout2d: layout2d(molecule(p["molecule"])) }));
    this.on("chem.wedges", "interactive", (p) => {
      const m = molecule(p["molecule"]);
      const layout = Array.isArray(p["layout2d"]) ? (p["layout2d"] as [number, number][]) : [];
      if (layout.length !== m.atoms.length) throw new RpcFailure(INVALID_PARAMS, "Invalid params", { loc: "layout2d", msg: "layout2d must have one (x, y) pair per atom" });
      return { wedges: wedges(m, layout, p["explicitH"] === true) };
    });

    this.on("sim.minimize", "job", (p, ctx) => minimizeJob({ molecule: molecule(p["molecule"]), method: str(p["method"], "auto"), maxSteps: Number(p["maxSteps"] ?? 2000), streamFrames: p["streamFrames"] !== false }, ctx));
    this.on("sim.properties", "job", (p, ctx) => properties({ molecule: molecule(p["molecule"]), level: str(p["level"], "standard"), md: p["md"] === true }, ctx));
    this.on("sim.md", "job", () => desktopOnly("Molecular dynamics", "openmm"));
    this.on("sim.dock", "job", () => desktopOnly("Docking", "vina"));

    this.on("elements.get", "interactive", (p) => elements.get(p["z"] as number | undefined, p["symbol"] as string | undefined));
    this.on("elements.all", "interactive", () => {
      const data = elements.dataset();
      return { elements: data.elements, statusLegend: data.statusLegend, sources: data.sources };
    });

    this.on("library.list", "interactive", (p) => lib.list(p as Parameters<Library["list"]>[0]));
    this.on("library.load", "interactive", (p) => lib.loadOne(str(p["id"])));
    this.on("library.save", "interactive", (p) => lib.save({
      molecule: molecule(p["molecule"]), layout2d: (p["layout2d"] as [number, number][] | null) ?? null,
      wedges: (p["wedges"] as Record<string, unknown>[]) ?? [], tags: (p["tags"] as string[]) ?? [], favorite: p["favorite"] === true, overwrite: p["overwrite"] === true,
    }));
    this.on("library.delete", "interactive", (p) => lib.delete(str(p["id"])));
    this.on("library.favorite", "interactive", (p) => lib.favorite(str(p["id"]), p["favorite"] === true));
    this.on("library.categories", "interactive", () => lib.categories());
    this.on("library.import", "job", (p, ctx) => lib.importData({ format: p["format"] === "json" ? "json" : "sdf", data: str(p["data"]) }, ctx));
    this.on("library.export", "interactive", (p) => lib.exportData({ format: p["format"] === "json" ? "json" : "sdf", ids: (p["ids"] as string[]) ?? [] }));

    this.on("report.export", "job", (p) => exportReport((p["report"] as Record<string, unknown>) ?? {}, str(p["format"], "markdown"), str(p["locale"], "en"), (p["strings"] as Record<string, unknown>) ?? {}));

    this.on("ai.status", "interactive", () => ({
      available: false, running: false, model: { path: null, name: null, sizeBytes: null, bundled: false }, bundledModel: null,
      contextSize: 0, accelerator: "none", offloadLayers: 0, edition: "lite",
    }));
    this.on("ai.query", "job", () => desktopOnly("The AI assistant", "llama"));
    this.on("ai.configure", "interactive", () => desktopOnly("The AI assistant", "llama"));
  }

  ready(): void {
    this.notify("ready", { version: LITE_VERSION, pid: 0, methods: [...this.methods.keys()].sort(), edition: "lite" });
  }

  cancel(jobId: string): boolean {
    const ctx = this.active.get(jobId);
    ctx?.cancel();
    return ctx !== undefined;
  }

  private respond(id: unknown, result: unknown): void {
    if (id === undefined) return;
    this.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private error(id: unknown, err: RpcFailure): void {
    const body: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.data && (Array.isArray(err.data) || Object.keys(err.data).length)) body["data"] = err.data;
    this.send(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: body }));
  }

  /** Handle one JSON-RPC line (or batch). Jobs run concurrently, interleaving at their yields. */
  handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    if (line.length > MAX_LINE_BYTES) {
      this.error(null, new RpcFailure(INVALID_REQUEST, "Request too large"));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (exc) {
      this.error(null, new RpcFailure(PARSE_ERROR, `Parse error: ${String((exc as Error).message)}`));
      return;
    }
    for (const item of Array.isArray(message) ? message : [message]) void this.dispatch(item);
  }

  private async dispatch(message: unknown): Promise<void> {
    if (!message || typeof message !== "object" || (message as Record<string, unknown>)["jsonrpc"] !== "2.0" || typeof (message as Record<string, unknown>)["method"] !== "string") {
      const id = message && typeof message === "object" ? (message as Record<string, unknown>)["id"] : null;
      this.error(id, new RpcFailure(INVALID_REQUEST, "Invalid JSON-RPC 2.0 request"));
      return;
    }
    const { id, method: name } = message as { id?: unknown; method: string };
    const spec = this.methods.get(name);
    if (!spec) {
      this.error(id, new RpcFailure(METHOD_NOT_FOUND, `Method not found: ${name}`));
      return;
    }
    const rawParams = (message as Record<string, unknown>)["params"] ?? {};
    if (typeof rawParams !== "object" || Array.isArray(rawParams)) {
      this.error(id, new RpcFailure(INVALID_PARAMS, "params must be an object"));
      return;
    }
    const params = { ...(rawParams as Record<string, unknown>) };
    const jobField = params["jobId"];
    const jobId = typeof jobField === "string" && jobField.length > 0 && jobField.length <= 128 ? jobField : null;
    if (spec.kind !== "control") delete params["jobId"];
    const ownId = spec.kind === "control" ? `ctl-${++this.counter}` : jobId ?? `job-${++this.counter}`;
    const ctx = new JobContext(ownId, (method, p) => this.notify(method, p));
    if (spec.kind !== "control") this.active.set(ownId, ctx);
    try {
      const result = await spec.handler(params, ctx);
      this.respond(id, result);
    } catch (err) {
      if (err instanceof RpcFailure) this.error(id, err);
      else if (recoverFromTrap(err)) {
        this.error(id, new RpcFailure(INTERNAL_ERROR, "The chemistry engine hit an internal error and restarted; please try again", { method: name }));
        await reload();
      } else this.error(id, new RpcFailure(INTERNAL_ERROR, `${(err as Error)?.name ?? "Error"}: ${(err as Error)?.message ?? String(err)}`, { method: name }));
    } finally {
      if (this.active.get(ownId) === ctx) this.active.delete(ownId);
    }
  }
}

let reload: () => Promise<void> = async () => undefined;
export function setReload(fn: () => Promise<void>): void {
  reload = fn;
}

export function capabilities() {
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : null;
  const memory = typeof navigator !== "undefined" && "deviceMemory" in navigator ? Number((navigator as unknown as { deviceMemory: number }).deviceMemory) * 2 ** 30 : 0;
  const unavailable = { available: false, reason: "desktop-only" };
  return {
    app: { computeVersion: LITE_VERSION, platform: "web" },
    os: { system: typeof navigator !== "undefined" ? navigator.platform || "web" : "web", release: "", machine: "wasm32" },
    cpu: { model: "browser", physicalCores: cores, logicalCores: cores, features: { WASM: true }, recommendedThreads: 1 },
    memory: { totalBytes: memory, availableBytes: memory },
    gpu: { adapters: [], openmmPlatforms: [], llmDevices: [], accelerated: false },
    engines: {
      libraries: { rdkit: rdkit().version(), openchemlib: "9.26.0" },
      xtb: unavailable, mopac: unavailable, vina: unavailable, llama: unavailable, model: { available: false, reason: "desktop-only" },
    },
    selected: { openmmPlatform: null, threads: 1, llmOffload: "none" },
    edition: "lite",
  };
}

export { annotate, JOB_CANCELLED };
