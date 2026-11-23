/** Global application state: navigation, theme, compute status, notifications. */
import { create } from "zustand";
import type { Capabilities, Element } from "@/ipc/api";
import { readPreference, writePreference } from "@/lib/preferences";

export type View = "build" | "elements" | "library" | "simulate";
export type Theme = "light" | "dark";
export type ToastTone = "success" | "info" | "warning" | "danger";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  details?: string[];
  action?: { label: string; run: () => void };
}

interface AppState {
  view: View;
  theme: Theme;
  sidecar: "starting" | "ready" | "error";
  sidecarError: string | null;
  capabilities: Capabilities | null;
  elements: Element[];
  assistantOpen: boolean;
  paletteOpen: boolean;
  toasts: Toast[];
  onboardingDone: boolean;
  setView: (view: View) => void;
  setTheme: (theme: Theme) => void;
  setSidecar: (state: AppState["sidecar"], error?: string) => void;
  setCapabilities: (caps: Capabilities) => void;
  setElements: (elements: Element[]) => void;
  toggleAssistant: (open?: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  pushToast: (toast: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
  completeOnboarding: () => void;
}

const initialTheme = (): Theme => {
  const saved = readPreference("theme");
  if (saved === "light" || saved === "dark") return saved;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

export const useApp = create<AppState>((set) => ({
  view: "build",
  theme: initialTheme(),
  sidecar: "starting",
  sidecarError: null,
  capabilities: null,
  elements: [],
  assistantOpen: false,
  paletteOpen: false,
  toasts: [],
  onboardingDone: readPreference("onboarding") === "done",
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    writePreference("theme", theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
  setSidecar: (sidecar, error) => set({ sidecar, sidecarError: error ?? null }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setElements: (elements) => set({ elements }),
  toggleAssistant: (open) => set((s) => ({ assistantOpen: open ?? !s.assistantOpen })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  pushToast: (toast) => {
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // An identical message already on screen is replaced (its timer restarts) instead of stacking.
    set((s) => {
      const others = s.toasts.filter((t) => t.action || t.tone !== toast.tone || t.title !== toast.title || t.body !== toast.body);
      return { toasts: [...others.slice(-3), { ...toast, id }] };
    });
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  completeOnboarding: () => {
    writePreference("onboarding", "done");
    set({ onboardingDone: true });
  },
}));
