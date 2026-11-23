/**
 * Interactive 2D structure editor (SVG). Shares the molecule graph with the 3D viewer; edits
 * are committed through ./actions so they are undoable and validated.
 */
import { motion } from "framer-motion";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "@/design-system/primitives";
import { elementInk } from "@/lib/chemistry";
import { bondSegments, bounds, chargeLabel, labelled, wedgeShape } from "@/lib/depict";
import {
  addAtom,
  addBond,
  addBondedAtom,
  bondIndex,
  BOND_2D,
  type Doc,
  moveLayout,
  NEXT_ORDER,
  removeAtoms,
  removeBonds,
  setBondOrder,
  updateAtom,
  type Vec2,
} from "@/lib/molecule";
import { useEditor } from "@/state/editor";
import { issueAtoms, issueBonds, useValidation } from "@/state/validation";
import { commit } from "./actions";

interface View {
  cx: number;
  cy: number;
  scale: number;
}

type Drag =
  | { kind: "pan"; startX: number; startY: number; view: View }
  | { kind: "bond"; from: number; to: Vec2 }
  | { kind: "move"; origin: Vec2; last: Vec2; atoms: Set<number>; start: Doc }
  | { kind: "marquee"; origin: Vec2; to: Vec2 };

const HIT_ATOM = 0.42;
const HIT_BOND = 0.26;

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function Sketch2D({ className }: { className?: string }) {
  const { t } = useTranslation();
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const element = useEditor((s) => s.element);
  const bondOrder = useEditor((s) => s.bondOrder);
  const issues = useValidation((s) => s.issues);
  const implicitH = useValidation((s) => s.implicitH);
  const showCarbon = useValidation((s) => s.showCarbon);
  const hideCarbonH = useValidation((s) => s.hideCarbonH);
  const wedgeList = useValidation((s) => s.wedges);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 600, h: 500 });
  const [view, setView] = useState<View>({ cx: 0, cy: 0, scale: 46 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ atom?: number; bond?: number }>({});
  const fittedFor = useRef<string | null>(null);

  const m = doc.molecule;
  // Hydrogens on carbon hidden for a skeletal drawing, indexed by their carbon.
  const { hidden, hiddenOf } = useMemo(() => {
    const hiddenSet = new Set<number>();
    const byAnchor = new Map<number, number[]>();
    if (hideCarbonH) {
      const degree = new Array<number>(m.atoms.length).fill(0);
      for (const b of m.bonds) {
        degree[b.a]!++;
        degree[b.b]!++;
      }
      for (const b of m.bonds) {
        for (const [h, c] of [[b.a, b.b], [b.b, b.a]] as const) {
          if (m.atoms[h]?.el === "H" && degree[h] === 1 && m.atoms[c]?.el === "C" && m.atoms[h]?.isotope === null) {
            hiddenSet.add(h);
            byAnchor.set(c, [...(byAnchor.get(c) ?? []), h]);
          }
        }
      }
    }
    return { hidden: hiddenSet, hiddenOf: byAnchor };
  }, [m, hideCarbonH]);
  const withHidden = useCallback((ids: number[]) => [...new Set([...ids, ...ids.flatMap((i) => hiddenOf.get(i) ?? [])])], [hiddenOf]);
  const errAtoms = useMemo(() => issueAtoms(issues, "error"), [issues]);
  const warnAtoms = useMemo(() => issueAtoms(issues, "warning"), [issues]);
  const errBonds = useMemo(() => issueBonds(issues, "error"), [issues]);
  const selAtoms = useMemo(() => new Set(selection.atoms), [selection.atoms]);
  const selBonds = useMemo(() => new Set(selection.bonds), [selection.bonds]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (doc.layout.length === 0) {
      setView({ cx: 0, cy: 0, scale: 46 });
      return;
    }
    const b = bounds(doc.layout);
    const w = Math.max(b.maxX - b.minX, 4);
    const h = Math.max(b.maxY - b.minY, 3);
    const scale = Math.min(70, Math.max(10, Math.min(size.w / (w + 3), size.h / (h + 3))));
    setView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale });
  }, [doc.layout, size.w, size.h]);

  // Fit only when a different molecule is loaded. A new, empty document is remembered too, so
  // drawing into it never re-centres the view under the user's cursor.
  useEffect(() => {
    if (fittedFor.current === m.id) return;
    fittedFor.current = m.id;
    if (doc.layout.length > 0) fit();
  }, [m.id, doc.layout.length, fit]);

  useEffect(() => {
    const handler = () => fit();
    window.addEventListener("mf:fit2d", handler);
    return () => window.removeEventListener("mf:fit2d", handler);
  }, [fit]);

  const toWorld = useCallback(
    (clientX: number, clientY: number): Vec2 => {
      const rect = svgRef.current!.getBoundingClientRect();
      return [(clientX - rect.left - size.w / 2) / view.scale + view.cx, (clientY - rect.top - size.h / 2) / view.scale + view.cy];
    },
    [size, view],
  );

  const hitAtom = useCallback(
    (p: Vec2, exclude?: number): number | undefined => {
      let best: number | undefined;
      let bestD = HIT_ATOM;
      doc.layout.forEach((q, i) => {
        if (i === exclude || hidden.has(i)) return;
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    },
    [doc.layout, hidden],
  );

  const hitBond = useCallback(
    (p: Vec2): number | undefined => {
      let best: number | undefined;
      let bestD = HIT_BOND;
      m.bonds.forEach((b, i) => {
        const a = doc.layout[b.a];
        const c = doc.layout[b.b];
        if (!a || !c || hidden.has(b.a) || hidden.has(b.b)) return;
        const d = distToSegment(p, a, c);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    },
    [doc.layout, m.bonds, hidden],
  );

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = toWorld(e.clientX, e.clientY);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, view });
      return;
    }
    const atom = hitAtom(p);
    const bond = atom === undefined ? hitBond(p) : undefined;
    const editor = useEditor.getState();
    if (tool === "select") {
      if (atom !== undefined) {
        const already = selAtoms.has(atom);
        const picked = e.shiftKey ? (already ? selection.atoms.filter((i) => i !== atom && !(hiddenOf.get(atom) ?? []).includes(i)) : [...selection.atoms, atom]) : already ? selection.atoms : [atom];
        const atoms = withHidden(picked);
        editor.setSelection({ atoms, bonds: e.shiftKey ? selection.bonds : [] });
        setDrag({ kind: "move", origin: p, last: p, atoms: new Set(atoms), start: doc });
      } else if (bond !== undefined) {
        editor.setSelection({ atoms: e.shiftKey ? selection.atoms : [], bonds: e.shiftKey ? [...selection.bonds, bond] : [bond] });
      } else {
        if (!e.shiftKey) editor.setSelection({ atoms: [], bonds: [] });
        setDrag({ kind: "marquee", origin: p, to: p });
      }
      return;
    }
    if (tool === "measure") {
      if (atom !== undefined) {
        const atoms = selection.atoms.includes(atom) ? selection.atoms.filter((i) => i !== atom) : [...selection.atoms, atom].slice(-4);
        editor.setSelection({ atoms, bonds: [] });
      }
      return;
    }
    if (tool === "erase") {
      if (atom !== undefined) {
        const { doc: next } = removeAtoms(doc, new Set(withHidden([atom])));
        commit(t("history.deleteAtom"), next, { atoms: [], bonds: [] });
      } else if (bond !== undefined) {
        commit(t("history.deleteBond"), removeBonds(doc, new Set([bond])), { atoms: [], bonds: [] });
      }
      return;
    }
    if (tool === "charge") {
      if (atom !== undefined) {
        const delta = e.shiftKey ? -1 : 1;
        const charge = Math.max(-4, Math.min(4, m.atoms[atom]!.charge + delta));
        commit(t("history.setCharge"), updateAtom(doc, atom, { charge }), { atoms: [atom], bonds: [] });
      }
      return;
    }
    // atom / bond tools
    if (atom !== undefined) {
      setDrag({ kind: "bond", from: atom, to: p });
      return;
    }
    if (bond !== undefined) {
      const current = m.bonds[bond]!;
      const order = tool === "bond" && current.order !== bondOrder ? bondOrder : NEXT_ORDER[current.order];
      commit(t("history.bondOrder"), setBondOrder(doc, bond, order).doc, { atoms: [current.a, current.b], bonds: [bond] }, true);
      return;
    }
    if (tool === "atom" || tool === "bond") {
      const { doc: next, index } = addAtom(doc, tool === "atom" ? element : "C", p);
      commit(t("history.addAtom"), next, { atoms: [index], bonds: [] });
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    if (!drag) {
      const atom = hitAtom(p);
      setHover(atom !== undefined ? { atom } : { bond: hitBond(p) });
      return;
    }
    if (drag.kind === "pan") {
      setView({
        ...drag.view,
        cx: drag.view.cx - (e.clientX - drag.startX) / drag.view.scale,
        cy: drag.view.cy - (e.clientY - drag.startY) / drag.view.scale,
      });
    } else if (drag.kind === "bond") {
      setDrag({ ...drag, to: p });
    } else if (drag.kind === "move") {
      const delta: Vec2 = [p[0] - drag.last[0], p[1] - drag.last[1]];
      useEditor.getState().preview(moveLayout(useEditor.getState().doc, drag.atoms, delta));
      setDrag({ ...drag, last: p });
    } else if (drag.kind === "marquee") {
      setDrag({ ...drag, to: p });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    svgRef.current?.releasePointerCapture(e.pointerId);
    const current = drag;
    setDrag(null);
    if (!current) return;
    const p = toWorld(e.clientX, e.clientY);
    if (current.kind === "bond") {
      const from = current.from;
      const moved = Math.hypot(p[0] - doc.layout[from]![0], p[1] - doc.layout[from]![1]) > HIT_ATOM;
      const order = tool === "bond" ? bondOrder : "single";
      const newElement = tool === "atom" ? element : "C";
      if (!moved) {
        // Click on an atom: change its element (atom tool) or grow a bonded atom.
        const atom = m.atoms[from]!;
        if (tool === "atom" && atom.el !== element) {
          commit(t("history.changeElement"), updateAtom(doc, from, { el: element, hCount: null }), { atoms: [from], bonds: [] });
        } else {
          const r = addBondedAtom(doc, from, newElement, order);
          commit(t("history.addBond"), r.doc, { atoms: [from, r.index], bonds: [r.bond] }, true);
        }
        return;
      }
      const target = hitAtom(p, from);
      if (target !== undefined) {
        const existing = bondIndex(m, from, target);
        const r = addBond(doc, from, target, order);
        commit(existing >= 0 ? t("history.bondOrder") : t("history.addBond"), r.doc, { atoms: [from, target], bonds: [r.bond] }, true);
      } else {
        const dx = p[0] - doc.layout[from]![0];
        const dy = p[1] - doc.layout[from]![1];
        const len = Math.hypot(dx, dy) || 1;
        const at: Vec2 = [doc.layout[from]![0] + (dx / len) * BOND_2D, doc.layout[from]![1] + (dy / len) * BOND_2D];
        const r = addBondedAtom(doc, from, newElement, order, at);
        commit(t("history.addBond"), r.doc, { atoms: [from, r.index], bonds: [r.bond] }, true);
      }
    } else if (current.kind === "move") {
      const moved = Math.hypot(current.last[0] - current.origin[0], current.last[1] - current.origin[1]) > 0.01;
      if (moved) {
        const after = useEditor.getState().doc;
        useEditor.getState().preview(current.start);
        useEditor.getState().execute(t("history.moveAtoms"), after);
      }
    } else if (current.kind === "marquee") {
      const [x1, y1] = current.origin;
      const [x2, y2] = current.to;
      const inside = (q: Vec2) => q[0] >= Math.min(x1, x2) && q[0] <= Math.max(x1, x2) && q[1] >= Math.min(y1, y2) && q[1] <= Math.max(y1, y2);
      const atoms = withHidden(doc.layout.map((q, i) => (!hidden.has(i) && inside(q) ? i : -1)).filter((i) => i >= 0));
      const bonds = m.bonds.map((b, i) => (atoms.includes(b.a) && atoms.includes(b.b) ? i : -1)).filter((i) => i >= 0);
      if (atoms.length) useEditor.getState().setSelection({ atoms: e.shiftKey ? [...new Set([...selection.atoms, ...atoms])] : atoms, bonds });
    }
  };

  const onWheel = (e: WheelEvent<SVGSVGElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const scale = Math.max(8, Math.min(160, view.scale * factor));
    const k = view.scale / scale;
    setView({ scale, cx: p[0] - (p[0] - view.cx) * k, cy: p[1] - (p[1] - view.cy) * k });
  };

  const segments = useMemo(() => {
    if (hidden.size === 0) return bondSegments(m, doc.layout, showCarbon);
    // Depict the molecule without the hidden hydrogens (so CH3 ends and double bonds are drawn as in print).
    const keep = m.atoms.map((_a, i) => !hidden.has(i));
    const index: number[] = [];
    let k = 0;
    keep.forEach((flag, i) => (index[i] = flag ? k++ : -1));
    const bondIds: number[] = [];
    const bonds = m.bonds.flatMap((b, i) => (keep[b.a] && keep[b.b] ? (bondIds.push(i), [{ ...b, a: index[b.a]!, b: index[b.b]! }]) : []));
    const atoms = m.atoms.filter((_a, i) => keep[i]).map((a) => ({ ...a, i: index[a.i]! }));
    const layout = doc.layout.filter((_p, i) => keep[i]);
    return bondSegments({ ...m, atoms, bonds }, layout, showCarbon).map((sg) => ({ ...sg, bond: bondIds[sg.bond]! }));
  }, [m, doc.layout, showCarbon, hidden]);
  const wedgeByBond = useMemo(() => new Map(wedgeList.map((w) => [w.bond, w])), [wedgeList]);
  const viewBox = `${view.cx - size.w / 2 / view.scale} ${view.cy - size.h / 2 / view.scale} ${size.w / view.scale} ${size.h / view.scale}`;
  const cursor = drag?.kind === "pan" ? "grabbing" : tool === "select" ? (hover.atom !== undefined ? "move" : "default") : tool === "erase" ? "not-allowed" : "crosshair";

  return (
    <div className={cx("relative overflow-hidden bg-surface-1 grain", className)}>
      <svg
        ref={svgRef}
        role="application"
        aria-label={t("canvas.sketchLabel")}
        className="size-full touch-none select-none"
        style={{ cursor }}
        viewBox={viewBox}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover({})}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        data-testid="sketch-2d"
      >
        <g>
          {segments.map((s, i) => {
            const selected = selBonds.has(s.bond);
            const bad = errBonds.has(s.bond);
            return (
              <g key={`seg-${i}`}>
                {(selected || bad || hover.bond === s.bond) && (
                  <line
                    x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                    className={bad ? "stroke-danger/40" : selected ? "stroke-accent/35" : "stroke-ink/10"}
                    strokeWidth={0.26}
                    strokeLinecap="round"
                  />
                )}
                {(() => {
                  const stereo = wedgeByBond.get(s.bond);
                  const narrow = stereo ? doc.layout[stereo.from] : undefined;
                  if (stereo && narrow && m.bonds[s.bond]?.order === "single") {
                    const shape = wedgeShape(s, narrow, stereo.kind);
                    return shape.points ? (
                      <polygon points={shape.points} className={bad ? "fill-danger" : "fill-ink"} data-testid={`wedge-${s.bond}`} />
                    ) : (
                      <g className={bad ? "stroke-danger" : "stroke-ink"} data-testid={`hash-${s.bond}`}>
                        {shape.rungs!.map(([x1, y1, x2, y2], k) => (
                          <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={0.04} strokeLinecap="round" />
                        ))}
                      </g>
                    );
                  }
                  return (
                    <line
                      x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                      className={bad ? "stroke-danger" : "stroke-ink"}
                      strokeWidth={0.065}
                      strokeLinecap="round"
                      strokeDasharray={s.dashed ? "0.14 0.1" : undefined}
                    />
                  );
                })()}
              </g>
            );
          })}
        </g>
        <g>
          {m.atoms.map((atom, i) => {
            const p = doc.layout[i];
            if (!p || hidden.has(i)) return null;
            const ownHidden = hiddenOf.get(i)?.length ?? 0;
            const visibleDegree = m.bonds.filter((b) => (b.a === i || b.b === i) && !hidden.has(b.a) && !hidden.has(b.b)).length;
            const show = labelled(m, i, showCarbon) || (ownHidden > 0 && visibleDegree === 0);
            const h = (implicitH[i] ?? 0) + (visibleDegree === 0 ? ownHidden : 0);
            const err = errAtoms.has(i);
            const warn = warnAtoms.has(i);
            const selected = selAtoms.has(i);
            const measureIndex = tool === "measure" ? selection.atoms.indexOf(i) : -1;
            return (
              <motion.g
                key={`atom-${i}-${atom.el}`}
                initial={{ scale: 0.3, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 520, damping: 22 }}
                style={{ originX: `${p[0]}px`, originY: `${p[1]}px` }}
                data-testid={`atom-2d-${i}`}
                data-element={atom.el}
              >
                {(err || warn) && (
                  <circle cx={p[0]} cy={p[1]} r={0.46} className={cx(err ? "fill-danger/20 stroke-danger" : "fill-warning/15 stroke-warning", "animate-halo-pulse")} strokeWidth={0.04} style={{ transformOrigin: `${p[0]}px ${p[1]}px` }} />
                )}
                {(selected || hover.atom === i) && (
                  <circle cx={p[0]} cy={p[1]} r={0.36} className={selected ? "fill-accent/25 stroke-accent" : "fill-ink/5"} strokeWidth={0.03} />
                )}
                {show ? (
                  <>
                    <circle cx={p[0]} cy={p[1]} r={0.27} className="fill-surface-1" />
                    <text x={p[0]} y={p[1]} dy="0.34em" textAnchor="middle" fontSize={0.5} fontWeight={600} className={elementInk(atom.el)}>
                      {atom.isotope ? <tspan fontSize={0.3} dy="-0.45em">{atom.isotope}</tspan> : null}
                      <tspan dy={atom.isotope ? "0.45em" : undefined}>{atom.el}</tspan>
                      {h > 0 && (atom.el !== "C" || visibleDegree === 0) ? (
                        <>
                          <tspan>H</tspan>
                          {h > 1 && <tspan fontSize={0.32} dy="0.18em">{h}</tspan>}
                        </>
                      ) : null}
                    </text>
                    {atom.charge !== 0 && (
                      <text x={p[0] + 0.36} y={p[1] - 0.22} fontSize={0.3} fontWeight={600} className="fill-ink">
                        {chargeLabel(atom.charge)}
                      </text>
                    )}
                  </>
                ) : (
                  <circle cx={p[0]} cy={p[1]} r={selected || hover.atom === i ? 0.07 : 0.0} className="fill-ink" />
                )}
                {measureIndex >= 0 && (
                  <text x={p[0] - 0.34} y={p[1] - 0.34} fontSize={0.24} fontWeight={700} className="fill-accent">
                    {measureIndex + 1}
                  </text>
                )}
              </motion.g>
            );
          })}
        </g>
        {drag?.kind === "bond" && doc.layout[drag.from] && (
          <line
            x1={doc.layout[drag.from]![0]} y1={doc.layout[drag.from]![1]} x2={drag.to[0]} y2={drag.to[1]}
            className="stroke-accent" strokeWidth={0.06} strokeDasharray="0.12 0.08" strokeLinecap="round"
          />
        )}
        {drag?.kind === "marquee" && (
          <rect
            x={Math.min(drag.origin[0], drag.to[0])} y={Math.min(drag.origin[1], drag.to[1])}
            width={Math.abs(drag.to[0] - drag.origin[0])} height={Math.abs(drag.to[1] - drag.origin[1])}
            className="fill-accent/10 stroke-accent" strokeWidth={0.03} strokeDasharray="0.1 0.06"
          />
        )}
      </svg>
      {m.atoms.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="max-w-xs text-center">
            <p className="text-sm font-semibold text-ink">{t("canvas.emptyTitle")}</p>
            <p className="mt-1 text-xs leading-5 text-ink-3">{t("canvas.emptyBody")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
