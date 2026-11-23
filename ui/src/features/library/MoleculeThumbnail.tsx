import { memo } from "react";
import type { Molecule, Wedge } from "@/ipc/schema";
import { elementInk } from "@/lib/chemistry";
import { bondSegments, bounds, chargeLabel, labelled, wedgeShape } from "@/lib/depict";
import type { Vec2 } from "@/lib/molecule";

/**
 * Static 2D depiction drawn like a textbook skeletal formula: hydrogens are folded into their
 * heteroatom's label (OH, NH₂, written on the side away from the bonds) and hidden on carbon.
 */
export const MoleculeThumbnail = memo(function MoleculeThumbnail({
  molecule,
  layout,
  label,
  wedges = [],
}: {
  molecule: Molecule;
  layout: Vec2[];
  label: string;
  /** Skeletal stereo wedges (bond indices of ``molecule``). */
  wedges?: Wedge[];
}) {
  const heavy = molecule.atoms.some((a) => a.el !== "H");
  const hiddenH = new Array<number>(molecule.atoms.length).fill(0);
  const keep = molecule.atoms.map((a, i) => {
    if (a.el !== "H" || !heavy) return true;
    const nbrs = molecule.bonds.filter((b) => b.a === i || b.b === i);
    if (nbrs.length !== 1) return true;
    const other = nbrs[0]!.a === i ? nbrs[0]!.b : nbrs[0]!.a;
    if (molecule.atoms[other]?.el === "H") return true;
    hiddenH[other] = (hiddenH[other] ?? 0) + 1;
    return false;
  });
  const index: number[] = [];
  let k = 0;
  keep.forEach((flag, i) => (index[i] = flag ? k++ : -1));
  const kept = molecule.atoms.map((a, i) => ({ a, i })).filter(({ i }) => keep[i]);
  const atoms = kept.map(({ a }) => ({ ...a, i: index[a.i]! }));
  const hCounts = kept.map(({ i }) => hiddenH[i] ?? 0);
  const bondIds: number[] = [];
  const bonds = molecule.bonds.flatMap((b, i) => (keep[b.a] && keep[b.b] ? (bondIds.push(i), [{ ...b, a: index[b.a]!, b: index[b.b]! }]) : []));
  const wedgeByBond = new Map(wedges.map((w) => [w.bond, w]));
  const pts = layout.filter((_p, i) => keep[i]);
  const m: Molecule = { ...molecule, atoms, bonds };
  const b = bounds(pts);
  const pad = 0.95;
  // A minimum frame keeps small molecules (water, glycine) at the same drawing scale as larger ones.
  const w = Math.max(b.maxX - b.minX, 4.2) + pad * 2;
  const h = Math.max(b.maxY - b.minY, 3.1) + pad * 2;
  const x0 = (b.minX + b.maxX) / 2 - w / 2;
  const y0 = (b.minY + b.maxY) / 2 - h / 2;
  const segs = bondSegments(m, pts, false);
  return (
    <svg viewBox={`${x0} ${y0} ${w} ${h}`} className="absolute inset-0 size-full p-3" role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
      {segs.map((s, i) => {
        const stereo = wedgeByBond.get(bondIds[s.bond]!);
        const narrow = stereo ? layout[stereo.from] : undefined;
        if (stereo && narrow && molecule.bonds[stereo.bond]?.order === "single") {
          const shape = wedgeShape(s, narrow, stereo.kind, 0.15);
          return shape.points ? (
            <polygon key={i} points={shape.points} className="fill-ink" />
          ) : (
            <g key={i} className="stroke-ink">
              {shape.rungs!.map(([x1, y1, x2, y2], k) => (
                <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={0.05} strokeLinecap="round" />
              ))}
            </g>
          );
        }
        return <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className="stroke-ink" strokeWidth={0.08} strokeLinecap="round" strokeDasharray={s.dashed ? "0.14 0.1" : undefined} />;
      })}
      {atoms.map((a, i) => {
        const p = pts[i];
        if (!p || !(labelled(m, i, false) || (a.el === "C" && hCounts[i]! > 0 && bonds.every((bd) => bd.a !== i && bd.b !== i)))) return null;
        const nH = hCounts[i]!;
        // Bonds pointing right → write the hydrogens on the left ("HO–"), as in print.
        const nbrX = bonds.filter((bd) => bd.a === i || bd.b === i).map((bd) => pts[bd.a === i ? bd.b : bd.a]![0] - p[0]);
        const left = nH > 0 && nbrX.length > 0 && nbrX.reduce((s, x) => s + x, 0) / nbrX.length > 0.2;
        const hWidth = nH > 0 ? (nH > 1 ? 0.62 : 0.4) : 0;
        return (
          <g key={i}>
            <rect x={p[0] - 0.32 - (left ? hWidth : 0)} y={p[1] - 0.34} width={0.64 + hWidth} height={0.68} rx={0.3} className="fill-surface-2" />
            <text x={p[0]} y={p[1]} dy="0.34em" textAnchor="middle" fontSize={0.55} fontWeight={600} className={elementInk(a.el)}>
              {a.el}
            </text>
            {nH > 0 && (
              <text x={left ? p[0] - 0.26 : p[0] + 0.26} y={p[1]} dy="0.34em" textAnchor={left ? "end" : "start"} fontSize={0.55} fontWeight={600} className={elementInk(a.el)}>
                H{nH > 1 && <tspan fontSize={0.36} dy="0.14">{nH}</tspan>}
              </text>
            )}
            {a.charge !== 0 && (
              <text x={p[0] + 0.36 + (left ? 0 : hWidth)} y={p[1] - 0.24} fontSize={0.34} className="fill-ink">
                {chargeLabel(a.charge)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
});
