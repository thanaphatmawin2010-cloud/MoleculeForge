/** Build view: synchronized 2D sketcher + 3D viewer, tool rail, inspector and status bar (spec 7.2–7.4). */
import {
  Atom as AtomIcon,
  Box,
  Columns2,
  Eraser,
  FlaskConical,
  Hexagon,
  Maximize,
  MousePointer2,
  PlusCircle,
  Redo2,
  Ruler,
  Save,
  Sparkles,
  Square,
  Undo2,
  Wand2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Formula } from "@/design-system/formula";
import { Badge, Button, IconButton, Kbd, Segmented, Switch, Tooltip, cx } from "@/design-system/primitives";
import { Quantity } from "@/design-system/quantity";
import { api } from "@/ipc/api";
import type { BondOrderT, Molecule, PropertyValue } from "@/ipc/schema";
import { ELEMENT_KEYS, QUICK_ELEMENTS, elementInk } from "@/lib/chemistry";
import { angle, dihedral, distance, formulaOf, removeAtoms, removeBonds, updateAtom } from "@/lib/molecule";
import { useApp } from "@/state/app";
import { type Tool, useEditor } from "@/state/editor";
import { issueAtoms, useValidation } from "@/state/validation";
import { ElementPicker } from "../periodic/ElementPicker";
import { commit, issueText, relaxNow, scheduleWedges } from "./actions";
import { FRAGMENT_MIME, insertTemplate, RING_TEMPLATES } from "./fragments";
import { addHydrogens, relayout, saveToLibrary } from "./io";
import { RepairDialog } from "./RepairDialog";
import { Sketch2D } from "./Sketch2D";
import { type RenderStyle, Viewer3D } from "./Viewer3D";

type Layout = "split" | "2d" | "3d";

function RingIcon({ sides, aromatic }: { sides: number; aromatic?: boolean }) {
  const points = Array.from({ length: sides }, (_, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / sides;
    return `${(12 + 8.5 * Math.cos(a)).toFixed(2)},${(12.6 + 8.5 * Math.sin(a)).toFixed(2)}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" aria-hidden>
      <polygon points={points} />
      {aromatic && <circle cx="12" cy="12.6" r="4.3" />}
    </svg>
  );
}

export function CanvasView() {
  const { t } = useTranslation();
  const doc = useEditor((s) => s.doc);
  const tool = useEditor((s) => s.tool);
  const element = useEditor((s) => s.element);
  const bondOrder = useEditor((s) => s.bondOrder);
  const selection = useEditor((s) => s.selection);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const issues = useValidation((s) => s.issues);
  const status = useValidation((s) => s.status);
  const latency = useValidation((s) => s.lastLatencyMs);
  const livePhysics = useValidation((s) => s.livePhysics);
  const showCarbon = useValidation((s) => s.showCarbon);
  const hideCarbonH = useValidation((s) => s.hideCarbonH);
  const docForWedges = useEditor((s) => s.doc);
  useEffect(() => scheduleWedges(), [docForWedges, hideCarbonH]);
  const relaxing = useValidation((s) => s.relaxing);
  const hybridization = useValidation((s) => s.hybridization);
  const implicitH = useValidation((s) => s.implicitH);
  const [layout, setLayout] = useState<Layout>("split");
  const [renderStyle, setRenderStyle] = useState<RenderStyle>("ball-and-stick");
  const [repairOpen, setRepairOpen] = useState(false);
  // Descriptors are tagged with the exact structure they describe and never shown for another one.
  const [quickFor, setQuickFor] = useState<{ molecule: Molecule; props: Record<string, PropertyValue> } | null>(null);
  const m = doc.molecule;

  const errorAtoms = useMemo(() => issueAtoms(issues, "error"), [issues]);
  const warningAtoms = useMemo(() => issueAtoms(issues, "warning"), [issues]);

  // Quick descriptors for the inspector (debounced, cheap).
  useEffect(() => {
    if (m.atoms.length === 0 || status === "invalid" || status === "checking") return;
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .descriptors(m)
        .then((r) => live && setQuickFor({ molecule: m, props: r.properties }))
        .catch(() => live && setQuickFor(null));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [m, status]);
  const quick = quickFor && quickFor.molecule === m ? quickFor.props : null;

  const deleteSelection = useCallback(() => {
    const sel = useEditor.getState().selection;
    if (sel.atoms.length) {
      const { doc: next } = removeAtoms(useEditor.getState().doc, new Set(sel.atoms));
      commit(t("history.deleteAtom"), next, { atoms: [], bonds: [] });
    } else if (sel.bonds.length) {
      commit(t("history.deleteBond"), removeBonds(useEditor.getState().doc, new Set(sel.bonds)), { atoms: [], bonds: [] });
    }
    useEditor.getState().setSelection({ atoms: [], bonds: [] });
  }, [t]);

  // Keyboard shortcuts (ignored while typing in inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable=true], [role=dialog]")) return;
      const editor = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        editor.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        editor.setSelection({ atoms: editor.doc.molecule.atoms.map((a) => a.i), bonds: editor.doc.molecule.bonds.map((_b, i) => i) });
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (e.key === "Escape") {
        editor.setSelection({ atoms: [], bonds: [] });
        return;
      }
      const key = e.key.toLowerCase();
      if (e.shiftKey) {
        if (key === "r") setRepairOpen(true);
        if (key === "h") void addHydrogens();
        return;
      }
      if (ELEMENT_KEYS[key]) editor.setElement(ELEMENT_KEYS[key]!);
      else if (key === "v") editor.setTool("select");
      else if (key === "e") editor.setTool("erase");
      else if (key === "q") editor.setTool("charge");
      else if (key === "m") editor.setTool("measure");
      else if (key === "1") editor.setBondOrder("single");
      else if (key === "2") editor.setBondOrder("double");
      else if (key === "3") editor.setBondOrder("triple");
      else if (key === "4") editor.setBondOrder("aromatic");
      else if (key === "f") {
        window.dispatchEvent(new Event("mf:fit2d"));
        window.dispatchEvent(new Event("mf:fit3d"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelection]);

  const tools: { id: Tool; icon: JSX.Element; label: string; key: string }[] = [
    { id: "select", icon: <MousePointer2 className="size-4" />, label: t("tool.select"), key: "V" },
    { id: "atom", icon: <AtomIcon className="size-4" />, label: t("tool.atom"), key: "C/N/O…" },
    { id: "bond", icon: <Hexagon className="size-4" />, label: t("tool.bond"), key: "1–4" },
    { id: "charge", icon: <PlusCircle className="size-4" />, label: t("tool.charge"), key: "Q" },
    { id: "measure", icon: <Ruler className="size-4" />, label: t("tool.measure"), key: "M" },
    { id: "erase", icon: <Eraser className="size-4" />, label: t("tool.erase"), key: "E" },
  ];

  const bondOrders: { value: BondOrderT; label: string }[] = [
    { value: "single", label: "—" },
    { value: "double", label: "=" },
    { value: "triple", label: "≡" },
    { value: "aromatic", label: "⌬" },
  ];

  const selectedAtom = selection.atoms.length === 1 ? m.atoms[selection.atoms[0]!] : undefined;
  const measure = useMemo(() => {
    const a = selection.atoms;
    if (a.length === 2) return { label: t("measure.distance"), value: distance(m, a[0]!, a[1]!), unit: "Å" };
    if (a.length === 3) return { label: t("measure.angle"), value: angle(m, a[0]!, a[1]!, a[2]!), unit: "°" };
    if (a.length === 4) return { label: t("measure.dihedral"), value: dihedral(m, a[0]!, a[1]!, a[2]!, a[3]!), unit: "°" };
    return null;
  }, [selection.atoms, m, t]);

  const statusTone = status === "valid" ? "success" : status === "fixed" ? "accent" : status === "invalid" ? "danger" : "neutral";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-1 px-3 py-2" role="toolbar" aria-label={t("canvas.toolbar")}>
        <div className="flex items-center gap-0.5">
          {tools.map((item) => (
            <IconButton key={item.id} label={item.label} shortcut={item.key} active={tool === item.id} onClick={() => useEditor.getState().setTool(item.id)} data-testid={`tool-${item.id}`}>
              {item.icon}
            </IconButton>
          ))}
        </div>
        <div className="mx-1 h-6 w-px bg-line" />
        <div className="flex items-center gap-0.5" aria-label={t("canvas.elements")}>
          {QUICK_ELEMENTS.map((el) => (
            <Tooltip key={el} label={t(`elements:element.${el}`)} shortcut={Object.entries(ELEMENT_KEYS).find(([, v]) => v === el)?.[0].toUpperCase()}>
              <button
                aria-label={t(`elements:element.${el}`)}
                aria-pressed={tool === "atom" && element === el}
                onClick={() => useEditor.getState().setElement(el)}
                data-testid={`element-${el}`}
                className={cx(
                  "h-8 min-w-8 rounded px-1.5 font-mono text-sm font-semibold transition-colors duration-1",
                  tool === "atom" && element === el ? "bg-accent-soft hairline" : "hover:bg-surface-3",
                  elementInk(el),
                )}
              >
                {el}
              </button>
            </Tooltip>
          ))}
          <ElementPicker onPick={(el) => useEditor.getState().setElement(el)} />
        </div>
        <div className="mx-1 h-6 w-px bg-line" />
        <Segmented
          label={t("canvas.bondOrder")}
          value={bondOrder}
          onChange={(v) => useEditor.getState().setBondOrder(v)}
          options={bondOrders.map((b) => ({ value: b.value, label: <span className="font-mono text-sm">{b.label}</span>, title: t(`bond.${b.value}`) }))}
        />
        <div className="mx-1 h-6 w-px bg-line" />
        <div className="flex items-center gap-0.5">
          {RING_TEMPLATES.map((tpl) => (
            <IconButton
              key={tpl.key}
              label={t(`canvas.template.${tpl.key}`)}
              onClick={() => void insertTemplate(tpl.key)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(FRAGMENT_MIME, tpl.key);
                e.dataTransfer.effectAllowed = "copy";
              }}
              data-testid={`template-${tpl.key}`}
            >
              <RingIcon sides={tpl.sides} aromatic={tpl.aromatic} />
            </IconButton>
          ))}
        </div>
        <div className="ms-auto flex items-center gap-1">
          <IconButton label={t("action.undo")} shortcut="Ctrl Z" disabled={!canUndo} onClick={() => useEditor.getState().undo()}>
            <Undo2 className="size-4" />
          </IconButton>
          <IconButton label={t("action.redo")} shortcut="Ctrl Y" disabled={!canRedo} onClick={() => useEditor.getState().redo()}>
            <Redo2 className="size-4" />
          </IconButton>
          <IconButton label={t("canvas.cleanLayout")} onClick={() => void relayout()} disabled={m.atoms.length === 0}>
            <Wand2 className="size-4" />
          </IconButton>
          <IconButton label={t("canvas.addHydrogens")} shortcut="Shift H" onClick={() => void addHydrogens()} disabled={m.atoms.length === 0}>
            <span className="font-mono text-sm font-semibold">+H</span>
          </IconButton>
          <Button
            variant="primary"
            icon={<Sparkles className="size-4" />}
            onClick={() => setRepairOpen(true)}
            disabled={m.atoms.length === 0}
            data-testid="repair-button"
          >
            {t("canvas.repair")}
            <Kbd tone="inverse">⇧R</Kbd>
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Panes */}
        <div className="relative flex min-w-0 flex-1">
          {(layout === "split" || layout === "2d") && <Sketch2D className={cx("min-w-0 flex-1", layout === "split" && "border-e border-line")} />}
          {(layout === "split" || layout === "3d") && (
            <div className="relative min-w-0 flex-1">
              <Viewer3D
                className="size-full"
                molecule={m}
                formula={(quick?.formula?.value as string) ?? formulaOf(m, implicitH)}
                selectedAtoms={selection.atoms}
                errorAtoms={errorAtoms}
                warningAtoms={warningAtoms}
                style={renderStyle}
                onAtomClick={(i, e) => {
                  const editor = useEditor.getState();
                  if (editor.tool === "atom" || editor.tool === "bond") {
                    const from = editor.doc.molecule.atoms[i]!;
                    if (editor.tool === "atom" && from.el !== editor.element && !e.shiftKey) {
                      commit(t("history.changeElement"), updateAtom(editor.doc, i, { el: editor.element, hCount: null }), { atoms: [i], bonds: [] });
                    } else {
                      void import("@/lib/molecule").then(({ addBondedAtom }) => {
                        const doc2 = useEditor.getState().doc;
                        const r = addBondedAtom(doc2, i, editor.tool === "atom" ? editor.element : "C", editor.tool === "bond" ? editor.bondOrder : "single");
                        commit(t("history.addBond"), r.doc, { atoms: [i, r.index], bonds: [r.bond] }, true);
                      });
                    }
                  } else if (editor.tool === "erase") {
                    commit(t("history.deleteAtom"), removeAtoms(editor.doc, new Set([i])).doc, { atoms: [], bonds: [] });
                  } else {
                    const atoms = e.shiftKey || editor.tool === "measure" ? [...editor.selection.atoms.filter((x) => x !== i), i].slice(-4) : [i];
                    editor.setSelection({ atoms, bonds: [] });
                  }
                }}
              />
              <div className="absolute end-3 top-3 flex items-center gap-1 rounded bg-surface-1/90 p-1 shadow-1 hairline backdrop-blur">
                <Segmented
                  size="sm"
                  label={t("canvas.renderStyle")}
                  value={renderStyle}
                  onChange={setRenderStyle}
                  options={[
                    { value: "ball-and-stick", label: t("canvas.style.ballStick") },
                    { value: "sticks", label: t("canvas.style.sticks") },
                    { value: "spacefill", label: t("canvas.style.spacefill") },
                  ]}
                />
                <IconButton size="sm" label={t("canvas.fit")} shortcut="F" onClick={() => window.dispatchEvent(new Event("mf:fit3d"))}>
                  <Maximize className="size-3.5" />
                </IconButton>
              </div>
              {m.atoms.length === 0 && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center" data-testid="viewer-empty">
                  <div className="flex flex-col items-center gap-2 text-center">
                    <Box className="size-7 text-ink-3/60" strokeWidth={1.4} />
                    <p className="max-w-[220px] text-xs leading-5 text-ink-3">{t("canvas.viewerEmpty")}</p>
                  </div>
                </div>
              )}
              {relaxing && (
                <div className="absolute bottom-3 start-3">
                  <Badge tone="accent">
                    <Zap className="size-3" />
                    {t("canvas.relaxing")}
                  </Badge>
                </div>
              )}
            </div>
          )}
          <div className="absolute bottom-3 start-1/2 flex -translate-x-1/2 rounded bg-surface-1/95 p-1 shadow-2 hairline rtl:translate-x-1/2">
            <Segmented
              size="sm"
              label={t("canvas.layout")}
              value={layout}
              onChange={setLayout}
              options={[
                { value: "2d", label: <Square className="size-3.5" />, title: t("canvas.layout2d") },
                { value: "split", label: <Columns2 className="size-3.5" />, title: t("canvas.layoutSplit") },
                { value: "3d", label: <Box className="size-3.5" />, title: t("canvas.layout3d") },
              ]}
            />
          </div>
        </div>

        {/* Inspector */}
        <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-s border-line bg-surface-1" aria-label={t("inspector.title")}>
          <section className="border-b border-line p-4">
            <label htmlFor="molecule-name" className="text-2xs font-semibold uppercase tracking-wide text-ink-3">
              {t("inspector.name")}
            </label>
            <input
              id="molecule-name"
              className="mt-1 w-full rounded bg-transparent px-1 py-0.5 text-md font-semibold text-ink hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
              placeholder={t("inspector.untitled")}
              value={m.name}
              onChange={(e) => useEditor.getState().preview({ ...doc, molecule: { ...m, name: e.target.value } })}
              onBlur={(e) => useEditor.getState().rename(e.target.value)}
            />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <p className="text-2xs text-ink-3">{t("inspector.formula")}</p>
                <p className="text-sm text-ink" data-testid="formula"><Formula value={(quick?.formula?.value as string) ?? formulaOf(m, implicitH)} /></p>
              </div>
              <div>
                <p className="text-2xs text-ink-3">{t("inspector.mw")}</p>
                {quick?.molecularWeight ? (
                  <Quantity value={quick.molecularWeight.value} unit={quick.molecularWeight.unit} method={quick.molecularWeight.method} digits={3} />
                ) : (
                  <p className="text-sm text-ink-3">—</p>
                )}
              </div>
              <div>
                <p className="text-2xs text-ink-3">{t("inspector.atoms")}</p>
                <p className="font-mono text-sm text-ink">{m.atoms.length + implicitH.reduce((s, h) => s + (h ?? 0), 0)}</p>
              </div>
              <div>
                <p className="text-2xs text-ink-3">{t("inspector.bonds")}</p>
                <p className="font-mono text-sm text-ink">{m.bonds.length}</p>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <Button size="sm" variant="secondary" icon={<Save className="size-3.5" />} onClick={() => void saveToLibrary()} disabled={m.atoms.length === 0} data-testid="save-library">
                {t("inspector.save")}
              </Button>
              <Button size="sm" variant="secondary" icon={<FlaskConical className="size-3.5" />} onClick={() => useApp.getState().setView("simulate")} disabled={m.atoms.length === 0}>
                {t("inspector.simulate")}
              </Button>
            </div>
          </section>

          <section className="border-b border-line p-4" aria-live="polite">
            <div className="flex items-center justify-between">
              <h3 className="text-2xs font-semibold uppercase tracking-wide text-ink-3">{t("inspector.validation")}</h3>
              {latency !== null && <span className="font-mono text-2xs text-ink-3">{latency} ms</span>}
            </div>
            <div className="mt-2" data-testid="validation-status" data-status={status}>
              <Badge tone={statusTone}>{t(`validation.status.${status}`)}</Badge>
            </div>
            <ul className="mt-3 space-y-2">
              {issues.filter((i) => i.severity !== "info").slice(0, 12).map((issue, k) => (
                <li key={k} className="flex gap-2 text-xs leading-5">
                  <span className={cx("mt-1.5 size-1.5 shrink-0 rounded-full", issue.severity === "error" ? "bg-danger" : "bg-warning")} />
                  <span className="text-ink-2">{issueText(issue.code, issue.params, issue.message)}</span>
                </li>
              ))}
              {issues.filter((i) => i.severity === "info").map((issue, k) => (
                <li key={`i${k}`} className="flex gap-2 text-xs leading-5 text-ink-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" />
                  {issueText(issue.code, issue.params, issue.message)}
                </li>
              ))}
            </ul>
          </section>

          <section className="border-b border-line p-4">
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-ink-3">{t("inspector.selection")}</h3>
            {selectedAtom ? (
              <div className="mt-2 space-y-2 text-sm">
                <p className="text-ink">
                  <span className={cx("font-mono font-semibold", elementInk(selectedAtom.el))}>{selectedAtom.el}</span>
                  <span className="text-ink-3"> #{selectedAtom.i + 1} · {t(`elements:element.${selectedAtom.el}`)}</span>
                </p>
                <p className="text-xs text-ink-2">
                  {t("inspector.hybridization")}: <span className="font-mono">{hybridization[selectedAtom.i]?.toLowerCase() ?? "—"}</span> · {t("inspector.implicitH")}:{" "}
                  <span className="font-mono">{implicitH[selectedAtom.i] ?? 0}</span>
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-2">{t("inspector.charge")}</span>
                  {[-1, 0, 1].map((q) => (
                    <Button
                      key={q}
                      size="sm"
                      variant={selectedAtom.charge === q ? "primary" : "ghost"}
                      onClick={() => commit(t("history.setCharge"), updateAtom(doc, selectedAtom.i, { charge: q }), { atoms: [selectedAtom.i], bonds: [] })}
                    >
                      {q > 0 ? "+1" : q < 0 ? "−1" : "0"}
                    </Button>
                  ))}
                </div>
              </div>
            ) : measure ? (
              <div className="mt-2" data-testid="measurement">
                <p className="text-xs text-ink-3">{measure.label}</p>
                <Quantity value={measure.value} unit={measure.unit} digits={3} emphasis method={t("measure.method")} />
              </div>
            ) : (
              <p className="mt-2 text-xs leading-5 text-ink-3">{t("inspector.selectionHint")}</p>
            )}
          </section>

          <section className="space-y-3 p-4">
            <Switch id="live-physics" label={t("inspector.livePhysics")} checked={livePhysics} onChange={() => useValidation.getState().toggleLivePhysics()} />
            <Switch id="show-carbon" label={t("inspector.showCarbon")} checked={showCarbon} onChange={() => useValidation.getState().toggleShowCarbon()} />
          <Switch id="show-carbon-h" label={t("inspector.showCarbonH")} checked={!hideCarbonH} onChange={() => useValidation.getState().set({ hideCarbonH: !hideCarbonH })} />
            <Button size="sm" variant="ghost" icon={<Zap className="size-3.5" />} onClick={() => void relaxNow()} disabled={m.atoms.length < 2}>
              {t("inspector.relaxNow")}
            </Button>
          </section>
        </aside>
      </div>
      <RepairDialog open={repairOpen} onOpenChange={setRepairOpen} />
    </div>
  );
}
