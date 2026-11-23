/**
 * Editor actions: every structural edit is committed as an undoable command, then validated
 * by the sidecar (chem.validateBonds). Invalid edits are auto-corrected as a separate undoable
 * command and announced with localised, non-blocking toasts (spec 7.3). With live physics on,
 * the 3D coordinates are relaxed with a quick force-field pass whose frames stream in live.
 */
import i18next from "i18next";
import { api } from "@/ipc/api";
import { RpcError } from "@/ipc/client";
import type { FixLog, ValidationResult } from "@/ipc/schema";
import { applyCorrected, type Doc, forgetStereo, stereoKnown, toRdkitLayout, withCoordinates } from "@/lib/molecule";
import { useApp } from "@/state/app";
import { useEditor } from "@/state/editor";
import { useValidation } from "@/state/validation";

export interface Focus {
  atoms: number[];
  bonds: number[];
}

let validationSeq = 0;
let relaxTimer: number | undefined;
let relaxJob: AbortController | null = null;

/** Localised description of one applied fix ("Changed bond 1–2 from double to single."). */
export function fixText(f: FixLog): string {
  return i18next.t(`issues:fix.${f.fix.op}`, { defaultValue: f.fix.description, ...flatten(f.fix.params) });
}

/** Localised reason for a fix (the issue that triggered it). */
export function fixReasonText(f: FixLog): string {
  return issueText(f.reason, f.reasonParams, f.reason);
}

function describeFixes(result: ValidationResult): string[] {
  return result.fixes.map(fixText);
}

function flatten(record: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(record)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  return out;
}

export function issueText(code: string, params: Record<string, unknown>, fallback: string): string {
  return i18next.t(`issues:code.${code}`, { defaultValue: fallback, ...flatten(params) });
}

/** Commit an edit; ``announce`` shows the success/fix toast for bond-forming edits. */
export function commit(label: string, next: Doc, focus: Focus, announce = false): void {
  useEditor.getState().execute(label, forgetStereo(next));
  void validate(focus, announce);
}

let wedgeTimer: number | undefined;
let wedgeSeq = 0;

/** Recompute stereo wedges for the current layout (debounced); cleared when the stereo is not known. */
export function scheduleWedges(delay = 120): void {
  window.clearTimeout(wedgeTimer);
  wedgeTimer = window.setTimeout(() => void refreshWedges(), delay);
}

async function refreshWedges(): Promise<void> {
  const seq = ++wedgeSeq;
  const { doc } = useEditor.getState();
  const store = useValidation.getState();
  if (!stereoKnown(doc.molecule) || doc.molecule.atoms.length === 0 || doc.layout.length !== doc.molecule.atoms.length) {
    if (store.wedges.length) store.set({ wedges: [] });
    return;
  }
  try {
    const { wedges } = await api.wedges(doc.molecule, toRdkitLayout(doc.layout), !store.hideCarbonH);
    if (seq === wedgeSeq) useValidation.getState().set({ wedges });
  } catch {
    if (seq === wedgeSeq) useValidation.getState().set({ wedges: [] });
  }
}

export async function validate(focus: Focus, announce: boolean): Promise<void> {
  const seq = ++validationSeq;
  const doc = useEditor.getState().doc;
  const store = useValidation.getState();
  if (doc.molecule.atoms.length === 0) {
    store.set({ status: "idle", issues: [], implicitH: [], hybridization: [] });
    return;
  }
  store.set({ status: "checking" });
  const started = performance.now();
  try {
    const result = await api.validateBonds(doc.molecule, focus.atoms, focus.bonds, true);
    if (seq !== validationSeq) return; // a newer edit superseded this check
    const toast = useApp.getState().pushToast;
    let current = useEditor.getState().doc;
    if (result.status === "fixed") {
      const corrected = applyCorrected(current, result.molecule, result.atomMap);
      useEditor.getState().execute(i18next.t("history.autoFix"), corrected);
      current = corrected;
      toast({
        tone: "success",
        title: i18next.t("validation.fixed"),
        body: describeFixes(result)[0],
        details: describeFixes(result),
        action: { label: i18next.t("action.undo"), run: () => useEditor.getState().undo() },
      });
    } else if (result.status === "valid" && announce) {
      toast({ tone: "success", title: i18next.t("validation.valid") });
    } else if (result.status === "invalid") {
      const first = result.issues.find((i) => i.severity === "error");
      toast({
        tone: "danger",
        title: i18next.t("validation.invalid"),
        body: first ? issueText(first.code, first.params, first.message) : result.message,
      });
    }
    const sanitized = await api.sanitize(current.molecule).catch(() => null);
    if (seq !== validationSeq) return;
    const implicitH: number[] = [];
    const hybridization: string[] = [];
    sanitized?.atoms.forEach((a) => {
      implicitH[a.atom] = a.implicitH;
      hybridization[a.atom] = a.hybridization;
    });
    useValidation.getState().set({
      status: result.status,
      issues: sanitized ? sanitized.issues : result.issues,
      implicitH,
      hybridization,
      lastLatencyMs: Math.round(performance.now() - started),
    });
    if (useValidation.getState().livePhysics && result.status !== "invalid") scheduleRelax();
  } catch (err) {
    if (seq !== validationSeq) return;
    useValidation.getState().set({ status: "invalid" });
    if (err instanceof RpcError) {
      useApp.getState().pushToast({ tone: "danger", title: i18next.t("validation.error"), body: err.message });
    }
  }
}

export function scheduleRelax(delay = 350): void {
  window.clearTimeout(relaxTimer);
  relaxTimer = window.setTimeout(() => void relaxNow(), delay);
}

export async function relaxNow(): Promise<void> {
  relaxJob?.abort();
  const job = new AbortController();
  relaxJob = job;
  const start = useEditor.getState().doc;
  if (start.molecule.atoms.length < 2) return;
  useValidation.getState().set({ relaxing: true });
  try {
    const result = await api.relax(start.molecule, {
      signal: job.signal,
      onProgress: (progress) => {
        const frame = progress.data?.frame;
        const current = useEditor.getState().doc;
        if (Array.isArray(frame) && current.molecule.atoms === start.molecule.atoms) {
          useEditor.getState().preview(withCoordinates(current, frame as number[][]));
        }
      },
    });
    const current = useEditor.getState().doc;
    // Only fold the result in if the graph did not change meanwhile (same atom array identity or size).
    if (current.molecule.bonds === start.molecule.bonds && result.molecule.atoms.length === current.molecule.atoms.length) {
      useEditor.getState().amend(withCoordinates(current, result.molecule.atoms.map((a) => [a.x, a.y, a.z])));
    } else if (result.molecule.atoms.length > current.molecule.atoms.length && current.molecule.bonds === start.molecule.bonds) {
      // Relaxation made implicit hydrogens explicit: adopt them (2D positions derived from neighbours).
      useEditor.getState().amend(applyCorrected(current, result.molecule, current.molecule.atoms.map((_a, i) => i)));
    }
  } catch (err) {
    if (!(err instanceof RpcError && err.cancelled)) {
      // A failed relaxation leaves the user's coordinates untouched; nothing else to do.
    }
  } finally {
    if (relaxJob === job) {
      relaxJob = null;
      useValidation.getState().set({ relaxing: false });
    }
  }
}

export function cancelRelax(): void {
  relaxJob?.abort();
}
