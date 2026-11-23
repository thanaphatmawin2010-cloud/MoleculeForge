/**
 * Editor store: the open document, selection, tool, and an unbounded undo/redo history
 * implemented with the command pattern over immutable snapshots.
 */
import { create } from "zustand";
import type { BondOrderT, Molecule } from "@/ipc/schema";
import { type Doc, emptyDoc, type Vec2 } from "@/lib/molecule";

export type Tool = "select" | "atom" | "bond" | "erase" | "charge" | "measure";

export interface Selection {
  atoms: number[];
  bonds: number[];
}

export interface Command {
  label: string;
  before: Doc;
  after: Doc;
  at: number;
}

interface EditorState {
  doc: Doc;
  past: Command[];
  future: Command[];
  selection: Selection;
  tool: Tool;
  element: string;
  bondOrder: BondOrderT;
  dirty: boolean;
  /** Apply a change as one undoable command. */
  execute: (label: string, next: Doc, selection?: Selection) => void;
  /** Replace coordinates without recording history (streamed minimisation frames). */
  preview: (next: Doc) => void;
  /** Fold a follow-up result (e.g. relaxed coordinates) into the most recent command. */
  amend: (next: Doc) => void;
  undo: () => void;
  redo: () => void;
  load: (doc: Doc) => void;
  setSelection: (selection: Selection) => void;
  setTool: (tool: Tool) => void;
  setElement: (element: string) => void;
  setBondOrder: (order: BondOrderT) => void;
  rename: (name: string) => void;
  markSaved: (molecule?: Molecule) => void;
}

const EMPTY_SELECTION: Selection = { atoms: [], bonds: [] };

export const useEditor = create<EditorState>((set, get) => ({
  doc: emptyDoc(),
  past: [],
  future: [],
  selection: EMPTY_SELECTION,
  tool: "atom",
  element: "C",
  bondOrder: "single",
  dirty: false,
  execute: (label, next, selection) => {
    const before = get().doc;
    if (before === next) return;
    set((s) => ({
      doc: next,
      past: [...s.past, { label, before, after: next, at: Date.now() }],
      future: [],
      selection: selection ?? clampSelection(s.selection, next),
      dirty: true,
    }));
  },
  preview: (next) => set({ doc: next }),
  amend: (next) =>
    set((s) => {
      const last = s.past[s.past.length - 1];
      if (!last) return { doc: next };
      return { doc: next, past: [...s.past.slice(0, -1), { ...last, after: next }] };
    }),
  undo: () => {
    const { past } = get();
    const last = past[past.length - 1];
    if (!last) return;
    set((s) => ({
      doc: last.before,
      past: s.past.slice(0, -1),
      future: [last, ...s.future],
      selection: clampSelection(s.selection, last.before),
      dirty: true,
    }));
  },
  redo: () => {
    const { future } = get();
    const next = future[0];
    if (!next) return;
    set((s) => ({
      doc: next.after,
      past: [...s.past, next],
      future: s.future.slice(1),
      selection: clampSelection(s.selection, next.after),
      dirty: true,
    }));
  },
  load: (doc) => set({ doc, past: [], future: [], selection: EMPTY_SELECTION, dirty: false }),
  setSelection: (selection) => set({ selection }),
  setTool: (tool) => set({ tool }),
  setElement: (element) => set({ element, tool: "atom" }),
  setBondOrder: (bondOrder) => set({ bondOrder, tool: "bond" }),
  rename: (name) => {
    const doc = get().doc;
    get().execute("rename", { ...doc, molecule: { ...doc.molecule, name } });
  },
  markSaved: (molecule) =>
    set((s) => ({ dirty: false, doc: molecule ? { ...s.doc, molecule: { ...molecule } } : s.doc })),
}));

function clampSelection(selection: Selection, doc: Doc): Selection {
  return {
    atoms: selection.atoms.filter((i) => i < doc.molecule.atoms.length),
    bonds: selection.bonds.filter((i) => i < doc.molecule.bonds.length),
  };
}

export const layoutOf = (doc: Doc): Vec2[] => doc.layout;
