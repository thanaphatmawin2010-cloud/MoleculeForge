/**
 * File open/save. In the desktop shell, native dialogs run in Rust and only paths the user
 * picked can be read or written (see app-shell/src-tauri/src/files.rs). In the browser
 * (MoleculeForge Lite, development, e2e) a file input and a download link are used instead, and
 * the Android app saves through its own bridge (the system "save as" picker).
 */
import { IS_LITE } from "./edition";

export interface FileFilter {
  name: string;
  extensions: string[];
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

/** A file-name stem from a molecule name: letters (with their combining marks, e.g. Thai vowels),
 * digits, "_" and "-" are kept; every other run of characters becomes "_". */
export function fileStem(name: string): string {
  return (name || "molecule").replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "_");
}

export async function openTextFile(filters: FileFilter[]): Promise<{ name: string; text: string } | null> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<{ name: string; text: string } | null>("open_text_file", { filters });
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(",");
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (file.size > 64 * 1024 * 1024) return resolve(null);
      resolve({ name: file.name, text: await file.text() });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** The model chooser needs the desktop shell: it remembers the pick so only that file can be loaded. */
export const canChooseModel = (): boolean => isTauri();

export async function chooseModelFile(): Promise<{ name: string; path: string; sizeBytes: number } | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ name: string; path: string; sizeBytes: number } | null>("choose_model");
}

declare global {
  interface Window {
    /** The Android app's bridge (android/.../MainActivity.kt): saves through the system file picker
     * and answers with window.mfAndroidSaved(requestId, saved). */
    MoleculeForgeAndroid?: { saveFile(requestId: string, name: string, mime: string, base64: string): void };
    mfAndroidSaved?: (requestId: string, saved: boolean) => void;
  }
}

const MIME: Record<string, string> = {
  sdf: "chemical/x-mdl-sdfile", mol: "chemical/x-mdl-molfile", smi: "chemical/x-daylight-smiles", smiles: "chemical/x-daylight-smiles",
  inchi: "chemical/x-inchi", xyz: "chemical/x-xyz", pdb: "chemical/x-pdb", json: "application/json", csv: "text/csv",
  md: "text/markdown", pdf: "application/pdf", png: "image/png", svg: "image/svg+xml",
};
const pendingSaves = new Map<string, (saved: boolean) => void>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function saveOnAndroid(bridge: NonNullable<Window["MoleculeForgeAndroid"]>, name: string, bytes: Uint8Array): Promise<boolean> {
  window.mfAndroidSaved ??= (requestId, saved) => {
    pendingSaves.get(requestId)?.(saved);
    pendingSaves.delete(requestId);
  };
  const requestId = `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return new Promise((resolve) => {
    pendingSaves.set(requestId, resolve);
    bridge.saveFile(requestId, name, MIME[ext] ?? "application/octet-stream", bytesToBase64(bytes));
  });
}

export async function saveFile(defaultName: string, data: string | Uint8Array, filters: FileFilter[]): Promise<boolean> {
  if (window.MoleculeForgeAndroid) {
    return saveOnAndroid(window.MoleculeForgeAndroid, defaultName, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = typeof data === "string" ? Array.from(new TextEncoder().encode(data)) : Array.from(data);
    return invoke<boolean>("save_file", { defaultName, bytes, filters });
  }
  const blob = new Blob([typeof data === "string" ? data : new Uint8Array(data)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = defaultName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

/** Files the app can open. MoleculeForge Lite reads SDF, MOL and SMILES; InChI, XYZ (bond
 * perception) and PDB need the desktop app's RDKit build. */
export const MOLECULE_FILTERS: FileFilter[] = IS_LITE
  ? [{ name: "Molecule files", extensions: ["sdf", "mol", "smi", "smiles"] }]
  : [{ name: "Molecule files", extensions: ["sdf", "mol", "smi", "smiles", "inchi", "xyz", "pdb"] }];

export function formatFromName(name: string): "sdf" | "mol" | "smiles" | "inchi" | "xyz" | "pdb" | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "sdf" || ext === "mol" || ext === "xyz" || ext === "pdb" || ext === "inchi") return ext;
  if (ext === "smi" || ext === "smiles") return "smiles";
  return null;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
