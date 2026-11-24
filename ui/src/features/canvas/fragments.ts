/** Ring templates: inserted by clicking their toolbar button or by dragging it onto the sketch. */
import i18next from "i18next";
import { api } from "@/ipc/api";
import { insertFragment, type Vec2 } from "@/lib/molecule";
import { useEditor } from "@/state/editor";
import { commit } from "./actions";

/** Drag-and-drop payload type; the value is the template key. */
export const FRAGMENT_MIME = "application/x-moleculeforge-fragment";

export interface RingTemplate {
  key: string;
  smiles: string;
  sides: number;
  aromatic?: boolean;
}

export const RING_TEMPLATES: readonly RingTemplate[] = [
  { key: "benzene", smiles: "c1ccccc1", sides: 6, aromatic: true },
  { key: "cyclohexane", smiles: "C1CCCCC1", sides: 6 },
  { key: "cyclopentane", smiles: "C1CCCC1", sides: 5 },
];

/**
 * Insert a template as a new fragment. With `at` (sketch coordinates, from a drop) it is centred
 * there and the view stays put; otherwise it goes beside the drawing and both views refit.
 */
export async function insertTemplate(key: string, at?: Vec2): Promise<void> {
  const template = RING_TEMPLATES.find((tpl) => tpl.key === key);
  if (!template) return;
  const { molecules } = await api.convert({ source: "smiles", target: "molecule", data: template.smiles });
  const frag = molecules?.[0];
  if (!frag) return;
  const heavy = {
    ...frag,
    atoms: frag.atoms.filter((a) => a.el !== "H"),
    bonds: frag.bonds.filter((b) => frag.atoms[b.a]!.el !== "H" && frag.atoms[b.b]!.el !== "H"),
  };
  const { layout2d } = await api.layout2d(heavy);
  const name = i18next.t(`canvas.template.${key}`);
  const layout = layout2d.map(([x, y]) => [x, -y] as Vec2);
  commit(i18next.t("history.insertFragment", { name }), insertFragment(useEditor.getState().doc, heavy, layout, at), { atoms: [], bonds: [] });
  if (!at) {
    window.dispatchEvent(new Event("mf:fit2d"));
    window.dispatchEvent(new Event("mf:fit3d"));
  }
}
