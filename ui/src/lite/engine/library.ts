/**
 * The molecule library: bundled prebuilt molecules plus the user's own, kept on the device
 * (IndexedDB). A port of compute/mfcompute/data/library.py, with the same search, sorting,
 * duplicate detection by InChIKey and auto-categorisation.
 */
import type { Molecule } from "@/ipc/schema";
import { CATEGORIES, CATEGORY_IDS, categorize } from "./categorize";
import { annotate, nowIso, parse, toRDKitStrict, write } from "./convert";
import { computeRDKit } from "./descriptors";
import { layout2d, wedges as wedgesOf } from "./depict";
import { CONFLICT, NOT_FOUND, RpcFailure } from "./errors";
import type { JobContext } from "./jobs";
import { withMol } from "./rdkit";
import type { Store } from "./storage";

export interface LibraryRecord {
  id: string;
  name: string;
  formula: string;
  inchikey: string | null;
  smiles: string | null;
  category: string;
  source: "prebuilt" | "user";
  created: string;
  updated: number;
  favorite: boolean;
  tags: string[];
  molecule: Molecule;
  layout2d: [number, number][] | null;
  descriptors: Record<string, unknown> | null;
  wedges: Record<string, unknown>[] | null;
}

interface BundleEntry {
  molecule: Molecule;
  layout2d?: [number, number][];
  tags?: string[];
  descriptors?: Record<string, unknown>;
  wedges?: Record<string, unknown>[];
}

function validLayout(layout: unknown, nAtoms: number): layout is [number, number][] {
  return Array.isArray(layout) && layout.length === nAtoms && layout.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v)));
}

function record(mol: Molecule, options: { layout: unknown; tags: string[]; descriptors: Record<string, unknown> | null; favorite: boolean; wedges?: unknown }): LibraryRecord {
  const layout = validLayout(options.layout, mol.atoms.length) ? options.layout : null;
  const wedges = layout && Array.isArray(options.wedges) ? (options.wedges as Record<string, unknown>[]) : null;
  return {
    id: mol.id, name: mol.name ?? "", formula: mol.formula ?? "", inchikey: mol.meta.inchikey || null, smiles: mol.meta.smiles || null,
    category: mol.meta.category || "other", source: mol.meta.source ?? "user", created: mol.meta.created ?? "", updated: Date.now(),
    favorite: options.favorite, tags: options.tags, molecule: mol, layout2d: layout, descriptors: options.descriptors, wedges,
  };
}

/** Tokens as SQLite FTS5's unicode61 tokenizer sees them (letters and digits, case-folded). */
function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).map((t) => t.normalize("NFKD").replace(/\p{M}/gu, (m) => (/[฀-๿]/.test(m) ? m : "")));
}

/** SQLite's COLLATE NOCASE: ASCII letters fold, everything else compares by code point. */
function nocase(a: string, b: string): number {
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const x = fold(a);
  const y = fold(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface ListParams {
  query?: string;
  category?: string | null;
  source?: "prebuilt" | "user" | "all";
  favoritesOnly?: boolean;
  sort?: "default" | "name" | "recent" | "weight";
  limit?: number;
  offset?: number;
}

export class Library {
  private prebuilt: LibraryRecord[] = [];
  private favourites = new Set<string>();

  constructor(private readonly store: Store) {}

  async load(bundle: { molecules: BundleEntry[] }): Promise<void> {
    this.favourites = new Set((await this.store.get<string[]>("meta:prebuiltFavorites")) ?? []);
    this.prebuilt = bundle.molecules.map((e) =>
      record(e.molecule, { layout: e.layout2d, tags: e.tags ?? [], descriptors: e.descriptors ?? null, favorite: false, wedges: e.wedges }),
    );
    this.prebuilt.forEach((r) => (r.updated = 0));
  }

  private async users(): Promise<LibraryRecord[]> {
    return (await this.store.values<LibraryRecord | string[]>()).filter((v): v is LibraryRecord => !Array.isArray(v) && typeof v === "object" && v !== null && "molecule" in v);
  }

  private async all(): Promise<LibraryRecord[]> {
    const prebuilt = this.prebuilt.map((r) => ({ ...r, favorite: this.favourites.has(r.id) }));
    return [...prebuilt, ...(await this.users())];
  }

  private static summary(r: LibraryRecord) {
    return {
      id: r.id, name: r.name, formula: r.formula, inchikey: r.inchikey, smiles: r.smiles, category: r.category, source: r.source,
      favorite: r.favorite, tags: r.tags, created: r.created, descriptors: r.descriptors,
    };
  }

  async list(params: ListParams) {
    let rows = await this.all();
    const query = (params.query ?? "").trim();
    if (query) {
      const terms = query.split(/\s+/).map((t) => tokens(t.replace(/"/g, "")).join("")).filter(Boolean);
      rows = rows.filter((r) => {
        const fields = tokens([r.name, r.formula, r.smiles ?? "", r.tags.join(" "), r.category].join(" "));
        return terms.every((term) => fields.some((tok) => tok.startsWith(term)));
      });
    }
    if (params.category) rows = rows.filter((r) => r.category === params.category);
    if (params.source && params.source !== "all") rows = rows.filter((r) => r.source === params.source);
    if (params.favoritesOnly) rows = rows.filter((r) => r.favorite);
    const weight = (r: LibraryRecord) => {
      const v = r.descriptors?.["molecularWeight"];
      return typeof v === "number" ? v : null;
    };
    const sort = params.sort ?? "default";
    rows.sort((a, b) => {
      if (sort === "default" && a.source !== b.source) return a.source === "user" ? -1 : 1;
      if (sort === "recent" && a.updated !== b.updated) return b.updated - a.updated;
      if (sort === "weight") {
        const wa = weight(a);
        const wb = weight(b);
        if ((wa === null) !== (wb === null)) return wa === null ? 1 : -1;
        if (wa !== null && wb !== null && wa !== wb) return wa - wb;
      }
      return nocase(a.name, b.name);
    });
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 500;
    return { total: rows.length, items: rows.slice(offset, offset + limit).map(Library.summary) };
  }

  async get(id: string): Promise<LibraryRecord> {
    const prebuilt = this.prebuilt.find((r) => r.id === id);
    if (prebuilt) return { ...prebuilt, favorite: this.favourites.has(id) };
    const user = await this.store.get<LibraryRecord>(`mol:${id}`);
    if (!user) throw new RpcFailure(NOT_FOUND, "Molecule not found", { id });
    return user;
  }

  async loadOne(id: string) {
    const r = await this.get(id);
    return { ...Library.summary(r), molecule: r.molecule, layout2d: r.layout2d, wedges: r.wedges ?? [] };
  }

  async categories() {
    const counts = new Map<string, number>();
    for (const r of await this.all()) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    return { categories: CATEGORIES.map((c) => ({ ...c, count: counts.get(c.id) ?? 0 })) };
  }

  async save(params: { molecule: Molecule; layout2d?: [number, number][] | null; wedges?: Record<string, unknown>[]; tags?: string[]; favorite?: boolean; overwrite?: boolean }) {
    const molecule = params.molecule;
    // Everything RDKit computes happens before the first await: the WebAssembly molecule is freed here.
    const { annotated, category, props } = withMol(toRDKitStrict(molecule), (rd) => {
      const annotated = annotate(molecule, rd);
      const category = CATEGORY_IDS.has(annotated.meta.category) && annotated.meta.category !== "other" ? annotated.meta.category : categorize(annotated, rd);
      return { annotated, category, props: computeRDKit(annotated, rd) };
    });
    let molId = annotated.id.startsWith("user-") ? annotated.id : `user-${annotated.meta.inchikey.slice(0, 14) || annotated.id}-${Math.floor(Date.now() / 1000)}`;
    const everything = await this.all();
    let existing = everything.find((r) => r.id === annotated.id) ?? null;
    const duplicate = annotated.meta.inchikey ? everything.find((r) => r.inchikey === annotated.meta.inchikey && r.id !== annotated.id) ?? null : null;
    if (existing?.source === "prebuilt") existing = null;
    if (duplicate && !params.overwrite) {
      return { saved: false, duplicateOf: { id: duplicate.id, name: duplicate.name, source: duplicate.source }, inchikey: annotated.meta.inchikey };
    }
    if (existing) molId = existing.id;
    const final: Molecule = { ...annotated, id: molId, meta: { ...annotated.meta, category, source: "user" } };
    const summary = Object.fromEntries(["molecularWeight", "logP", "tpsa", "hBondDonors", "hBondAcceptors", "qed"].map((k) => [k, props[k]!.value]));
    await this.store.set(`mol:${molId}`, record(final, { layout: params.layout2d, tags: params.tags ?? [], descriptors: summary, favorite: params.favorite ?? false, wedges: params.wedges }));
    return { saved: true, id: molId, category, molecule: final };
  }

  async delete(id: string) {
    if (this.prebuilt.some((r) => r.id === id)) throw new RpcFailure(CONFLICT, "Prebuilt molecules are read-only", { id });
    if (!(await this.store.get(`mol:${id}`))) throw new RpcFailure(NOT_FOUND, "Molecule not found", { id });
    await this.store.delete(`mol:${id}`);
    return { deleted: true, id };
  }

  async favorite(id: string, favorite: boolean) {
    if (this.prebuilt.some((r) => r.id === id)) {
      if (favorite) this.favourites.add(id);
      else this.favourites.delete(id);
      await this.store.set("meta:prebuiltFavorites", [...this.favourites]);
      return { id, favorite };
    }
    const r = await this.store.get<LibraryRecord>(`mol:${id}`);
    if (!r) throw new RpcFailure(NOT_FOUND, "Molecule not found", { id });
    await this.store.set(`mol:${id}`, { ...r, favorite });
    return { id, favorite };
  }

  async importData(params: { format: "sdf" | "json"; data: string }, ctx: JobContext) {
    let molecules: Molecule[];
    if (params.format === "json") {
      const payload = JSON.parse(params.data) as unknown;
      const items = (payload && typeof payload === "object" && "molecules" in payload ? (payload as { molecules: unknown[] }).molecules : payload) as Record<string, unknown>[];
      molecules = items.map((item) => ((item["molecule"] as Molecule | undefined) ?? (item as unknown as Molecule)));
    } else {
      molecules = parse("sdf", params.data, { embed3d: true });
    }
    const saved: string[] = [];
    const duplicates: unknown[] = [];
    for (const [idx, molecule] of molecules.entries()) {
      await ctx.tick();
      ctx.progress((100 * idx) / Math.max(1, molecules.length), "import", molecule.name || molecule.id);
      const fresh = { ...molecule, id: `user-import-${idx}-${Date.now()}` };
      let layout: [number, number][] | null = null;
      let stereo: Record<string, unknown>[] = [];
      try {
        layout = layout2d(fresh);
        stereo = wedgesOf(fresh, layout);
      } catch (err) {
        if (!(err instanceof RpcFailure)) throw err;
      }
      const result = await this.save({ molecule: fresh, layout2d: layout, wedges: stereo });
      if (result.saved) saved.push(result.id!);
      else duplicates.push(result.duplicateOf);
    }
    return { imported: saved.length, duplicates, ids: saved };
  }

  async exportData(params: { format: "sdf" | "json"; ids?: string[] }) {
    const rows = params.ids?.length ? await Promise.all(params.ids.map((id) => this.get(id).catch(() => null))) : await this.users();
    const records = rows.filter((r): r is LibraryRecord => r !== null);
    const molecules = records.map((r) => r.molecule);
    const data = params.format === "json"
      ? JSON.stringify({ format: "moleculeforge.library/1", molecules: records.map((r) => ({ molecule: r.molecule, layout2d: r.layout2d, tags: r.tags })) }, null, 1)
      : molecules.length ? write("sdf", molecules) : "";
    return { format: params.format, count: molecules.length, data };
  }
}

export { nowIso };
