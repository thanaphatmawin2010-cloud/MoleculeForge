/**
 * File open/save. In the desktop shell, native dialogs run in Rust and only paths the user
 * picked can be read or written (see app-shell/src-tauri/src/files.rs). In the browser
 * (development / e2e) a hidden file input and a download link are used instead.
 */
export interface FileFilter {
  name: string;
  extensions: string[];
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

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

export async function saveFile(defaultName: string, data: string | Uint8Array, filters: FileFilter[]): Promise<boolean> {
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

export const MOLECULE_FILTERS: FileFilter[] = [
  { name: "Molecule files", extensions: ["sdf", "mol", "smi", "smiles", "inchi", "xyz", "pdb"] },
];

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
