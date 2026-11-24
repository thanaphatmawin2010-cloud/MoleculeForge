/** Document-level commands shared by the Build view, the library and the command palette. */
import i18next from "i18next";
import { api } from "@/ipc/api";
import { RpcError } from "@/ipc/client";
import type { Molecule } from "@/ipc/schema";
import { MOLECULE_FILTERS, fileStem, formatFromName, openTextFile, saveFile } from "@/lib/files";
import { applyCorrected, type Doc, emptyDoc, insertFragment, layoutFrom3D, newId, normalizeLayout, stereoKnown, toRdkitLayout, type Vec2 } from "@/lib/molecule";
import { useApp } from "@/state/app";
import { useEditor } from "@/state/editor";
import { useValidation } from "@/state/validation";
import { commit, validate } from "./actions";

const toast = (...args: Parameters<ReturnType<typeof useApp.getState>["pushToast"]>) => useApp.getState().pushToast(...args);

export function newDocument(): void {
  useEditor.getState().load(emptyDoc());
  useValidation.getState().set({ status: "idle", issues: [], implicitH: [], hybridization: [], hideCarbonH: false });
  useApp.getState().setView("build");
}

/** Opened structures usually carry every hydrogen explicitly; draw them skeletal by default. */
function hasExplicitCarbonH(molecule: Molecule): boolean {
  return molecule.bonds.some((b) => {
    const a = molecule.atoms[b.a]?.el;
    const c = molecule.atoms[b.b]?.el;
    return (a === "H" && c === "C") || (a === "C" && c === "H");
  });
}

export function loadMolecule(molecule: Molecule, layout: Vec2[] | null): void {
  const doc: Doc = { molecule, layout: normalizeLayout(molecule, layout && layout.length === molecule.atoms.length ? layout : layoutFrom3D(molecule)) };
  useEditor.getState().load(doc);
  useValidation.getState().set({ hideCarbonH: hasExplicitCarbonH(molecule) });
  useApp.getState().setView("build");
  void validate({ atoms: [], bonds: [] }, false, { relax: false });
  if (!layout) void relayout();
}

export async function relayout(): Promise<void> {
  const doc = useEditor.getState().doc;
  if (doc.molecule.atoms.length === 0) return;
  const { layout2d } = await api.layout2d(doc.molecule);
  const current = useEditor.getState().doc;
  if (current.molecule.atoms.length !== layout2d.length) return;
  const flipped = layout2d.map(([x, y]) => [x, -y] as Vec2);
  useEditor.getState().execute(i18next.t("history.cleanLayout"), { ...current, layout: normalizeLayout(current.molecule, flipped) });
  window.dispatchEvent(new Event("mf:fit2d"));
}

export async function addHydrogens(): Promise<void> {
  const doc = useEditor.getState().doc;
  if (doc.molecule.atoms.length === 0) return;
  try {
    const { molecule } = await api.relax(doc.molecule, { addHydrogens: true });
    const next = applyCorrected(doc, molecule, doc.molecule.atoms.map((_a, i) => i));
    commit(i18next.t("history.addHydrogens"), next, { atoms: [], bonds: [] });
  } catch (err) {
    toast({ tone: "danger", title: i18next.t("canvas.addHydrogensFailed"), body: err instanceof RpcError ? err.message : String(err) });
  }
}

export async function openMoleculeFile(): Promise<void> {
  const file = await openTextFile(MOLECULE_FILTERS);
  if (!file) return;
  const format = formatFromName(file.name);
  if (!format) {
    toast({ tone: "warning", title: i18next.t("io.unsupported"), body: file.name });
    return;
  }
  try {
    const { molecules } = await api.convert({ source: format, target: "molecule", data: file.text, name: file.name.replace(/\.[^.]+$/, "") });
    const first = molecules?.[0];
    if (!first) throw new Error("empty");
    loadMolecule({ ...first, id: newId(), name: first.name || file.name.replace(/\.[^.]+$/, "") }, null);
    toast({
      tone: "success",
      title: i18next.t("io.opened", { name: file.name }),
      body: molecules!.length > 1 ? i18next.t("io.openedFirstOf", { count: molecules!.length }) : undefined,
    });
  } catch (err) {
    toast({ tone: "danger", title: i18next.t("io.openFailed"), body: err instanceof RpcError ? err.message : String(err) });
  }
}

export async function exportMolecule(format: "sdf" | "mol" | "smiles" | "inchi" | "xyz" | "pdb"): Promise<void> {
  const { molecule } = useEditor.getState().doc;
  if (molecule.atoms.length === 0) return;
  try {
    const { data } = await api.convert({ source: "molecule", target: format, molecule });
    const ext = format === "smiles" ? "smi" : format;
    const name = `${fileStem(molecule.name)}.${ext}`;
    if (await saveFile(name, data ?? "", [{ name: format.toUpperCase(), extensions: [ext] }])) {
      toast({ tone: "success", title: i18next.t("io.exported", { name }) });
    }
  } catch (err) {
    toast({ tone: "danger", title: i18next.t("io.exportFailed"), body: err instanceof RpcError ? err.message : String(err) });
  }
}

export async function saveToLibrary(overwrite = false): Promise<void> {
  const { doc } = useEditor.getState();
  if (doc.molecule.atoms.length === 0) return;
  try {
    const layout = toRdkitLayout(doc.layout);
    // Thumbnails are skeletal, so store the wedges chosen for implicit hydrogens.
    const wedges = stereoKnown(doc.molecule) ? (await api.wedges(doc.molecule, layout, false).catch(() => ({ wedges: [] }))).wedges : [];
    const result = await api.librarySave(doc.molecule, layout, overwrite, [], wedges);
    if (!result.saved && result.duplicateOf) {
      toast({
        tone: "warning",
        title: i18next.t("library.duplicateTitle"),
        body: i18next.t("library.duplicateBody", { name: result.duplicateOf.name }),
        action: { label: i18next.t("library.saveAnyway"), run: () => void saveToLibrary(true) },
      });
      return;
    }
    if (result.molecule) useEditor.getState().markSaved({ ...result.molecule });
    toast({
      tone: "success",
      title: i18next.t("library.saved"),
      body: i18next.t("library.savedInto", { category: i18next.t(`library.category.${result.category ?? "other"}`) }),
    });
  } catch (err) {
    toast({ tone: "danger", title: i18next.t("library.saveFailed"), body: err instanceof RpcError ? err.message : String(err) });
  }
}

export async function openFromLibrary(id: string, asFragment: boolean): Promise<void> {
  const entry = await api.libraryLoad(id);
  const layout = entry.layout2d?.map(([x, y]) => [x, -y] as Vec2) ?? null;
  if (asFragment) {
    const doc = useEditor.getState().doc;
    commit(i18next.t("history.insertFragment", { name: entry.name }), insertFragment(doc, entry.molecule, layout), { atoms: [], bonds: [] });
    useApp.getState().setView("build");
    window.dispatchEvent(new Event("mf:fit2d"));
    window.dispatchEvent(new Event("mf:fit3d"));
    return;
  }
  loadMolecule({ ...entry.molecule, id: entry.source === "user" ? entry.molecule.id : newId() }, layout);
}
