/** Live validation results for the open document (drives halos, inspector and status bar). */
import { create } from "zustand";
import type { Issue, Wedge } from "@/ipc/schema";
import { readPreference, writePreference } from "@/lib/preferences";

export type ValidationStatus = "idle" | "checking" | "valid" | "fixed" | "invalid";

interface ValidationState {
  status: ValidationStatus;
  issues: Issue[];
  implicitH: number[];
  hybridization: string[];
  lastLatencyMs: number | null;
  livePhysics: boolean;
  showCarbon: boolean;
  /** Display-only: hide hydrogens bonded to carbon in the 2D sketch (they stay in the document). */
  hideCarbonH: boolean;
  /** Stereo wedges for the current 2D layout (empty unless the stereo came from the source). */
  wedges: Wedge[];
  relaxing: boolean;
  set: (patch: Partial<Omit<ValidationState, "set" | "toggleLivePhysics" | "toggleShowCarbon">>) => void;
  toggleLivePhysics: () => void;
  toggleShowCarbon: () => void;
}

export const useValidation = create<ValidationState>((set) => ({
  status: "idle",
  issues: [],
  implicitH: [],
  hybridization: [],
  lastLatencyMs: null,
  livePhysics: readPreference("livePhysics") !== "off",
  showCarbon: readPreference("showCarbon") === "on",
  hideCarbonH: false,
  wedges: [],
  relaxing: false,
  set: (patch) => set(patch),
  toggleLivePhysics: () =>
    set((s) => {
      writePreference("livePhysics", s.livePhysics ? "off" : "on");
      return { livePhysics: !s.livePhysics };
    }),
  toggleShowCarbon: () =>
    set((s) => {
      writePreference("showCarbon", s.showCarbon ? "off" : "on");
      return { showCarbon: !s.showCarbon };
    }),
}));

export function issueAtoms(issues: Issue[], severity: Issue["severity"]): Set<number> {
  return new Set(issues.filter((i) => i.severity === severity).flatMap((i) => i.atoms));
}

export function issueBonds(issues: Issue[], severity: Issue["severity"]): Set<number> {
  return new Set(issues.filter((i) => i.severity === severity).flatMap((i) => i.bonds));
}
