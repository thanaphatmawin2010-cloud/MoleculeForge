/** Readable messages for failed calls. */
import i18next from "i18next";
import { RpcError } from "@/ipc/client";

const LITE_FEATURES = new Set(["md", "dock", "assistant", "quantum", "mmff", "formats", "pdf"]);

/**
 * The message to show for an error. MoleculeForge Lite answers requests that need the desktop
 * engines with code DESKTOP_ONLY and the feature concerned; those get a translated explanation.
 */
export function errorText(err: unknown): string {
  if (err instanceof RpcError) {
    const data = (err.data ?? {}) as { code?: unknown; feature?: unknown; format?: unknown };
    if (data.code === "DESKTOP_ONLY") {
      const feature = typeof data.feature === "string" && LITE_FEATURES.has(data.feature) ? data.feature : "generic";
      return i18next.t(`lite.error.${feature}`, { format: String(data.format ?? "").toUpperCase() });
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
