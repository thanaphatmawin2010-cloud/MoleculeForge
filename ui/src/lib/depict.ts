/**
 * 2D depiction geometry (pure): bond segments with label clearance and multiple-bond offsets,
 * plus which atoms carry visible labels (skeletal-formula conventions).
 */
import type { Molecule } from "@/ipc/schema";
import type { Vec2 } from "./molecule";

export interface Segment {
  bond: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed: boolean;
}

export function labelled(m: Molecule, i: number, showCarbon: boolean): boolean {
  const atom = m.atoms[i]!;
  if (atom.el !== "C") return true;
  if (showCarbon) return true;
  const degree = m.bonds.filter((b) => b.a === i || b.b === i).length;
  return degree === 0 || atom.charge !== 0 || atom.isotope !== null;
}

/** Shorten a line end that touches a labelled atom so the bond does not overlap the text. */
function trim(p: Vec2, q: Vec2, labelP: boolean, labelQ: boolean, clearance: number): [Vec2, Vec2] {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const a: Vec2 = labelP ? [p[0] + ux * clearance, p[1] + uy * clearance] : p;
  const b: Vec2 = labelQ ? [q[0] - ux * clearance, q[1] - uy * clearance] : q;
  return [a, b];
}

/** Ring centre side for placing the inner line of double/aromatic bonds inside rings. */
function innerSide(m: Molecule, layout: Vec2[], bond: number): number {
  const b = m.bonds[bond]!;
  const pa = layout[b.a]!;
  const pb = layout[b.b]!;
  const nx = -(pb[1] - pa[1]);
  const ny = pb[0] - pa[0];
  let score = 0;
  for (const other of m.bonds) {
    if (other === b) continue;
    const shared = other.a === b.a || other.b === b.a || other.a === b.b || other.b === b.b;
    if (!shared) continue;
    const far = other.a === b.a || other.a === b.b ? other.b : other.a;
    const p = layout[far]!;
    score += Math.sign((p[0] - pa[0]) * nx + (p[1] - pa[1]) * ny);
  }
  return score >= 0 ? 1 : -1;
}

export function bondSegments(m: Molecule, layout: Vec2[], showCarbon: boolean, clearance = 0.32): Segment[] {
  const segs: Segment[] = [];
  const off = 0.16;
  m.bonds.forEach((bond, index) => {
    const p = layout[bond.a];
    const q = layout[bond.b];
    if (!p || !q) return;
    const [a, b] = trim(p, q, labelled(m, bond.a, showCarbon), labelled(m, bond.b, showCarbon), clearance);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * off;
    const ny = (dx / len) * off;
    const shrink = 0.14;
    const sx = (dx / len) * shrink;
    const sy = (dy / len) * shrink;
    if (bond.order === "single") {
      segs.push({ bond: index, x1: a[0], y1: a[1], x2: b[0], y2: b[1], dashed: false });
    } else if (bond.order === "triple") {
      segs.push({ bond: index, x1: a[0], y1: a[1], x2: b[0], y2: b[1], dashed: false });
      segs.push({ bond: index, x1: a[0] + nx, y1: a[1] + ny, x2: b[0] + nx, y2: b[1] + ny, dashed: false });
      segs.push({ bond: index, x1: a[0] - nx, y1: a[1] - ny, x2: b[0] - nx, y2: b[1] - ny, dashed: false });
    } else {
      const side = innerSide(m, layout, index);
      const terminal = [bond.a, bond.b].some((i) => m.bonds.filter((x) => x.a === i || x.b === i).length === 1);
      if (terminal && bond.order === "double") {
        segs.push({ bond: index, x1: a[0] + nx / 2, y1: a[1] + ny / 2, x2: b[0] + nx / 2, y2: b[1] + ny / 2, dashed: false });
        segs.push({ bond: index, x1: a[0] - nx / 2, y1: a[1] - ny / 2, x2: b[0] - nx / 2, y2: b[1] - ny / 2, dashed: false });
      } else {
        segs.push({ bond: index, x1: a[0], y1: a[1], x2: b[0], y2: b[1], dashed: false });
        segs.push({
          bond: index,
          x1: a[0] + nx * side + sx,
          y1: a[1] + ny * side + sy,
          x2: b[0] + nx * side - sx,
          y2: b[1] + ny * side - sy,
          dashed: bond.order === "aromatic",
        });
      }
    }
  });
  return segs;
}

export function bounds(layout: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (layout.length === 0) return { minX: -4, minY: -3, maxX: 4, maxY: 3 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of layout) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

export function chargeLabel(charge: number): string {
  if (charge === 0) return "";
  const mag = Math.abs(charge);
  return `${mag > 1 ? mag : ""}${charge > 0 ? "+" : "−"}`;
}

export interface WedgeShape {
  bond: number;
  kind: "wedge" | "hash";
  /** Filled triangle (wedge) as an SVG points string. */
  points?: string;
  /** Hash rungs (x1, y1, x2, y2), widening away from the stereocentre. */
  rungs?: [number, number, number, number][];
}

/**
 * Stereo bond drawn on a (label-trimmed) segment: the narrow end sits at the stereocentre
 * (the end nearest ``narrow``), widening to ``width`` on each side at the far end.
 */
export function wedgeShape(seg: Segment, narrow: Vec2, kind: "wedge" | "hash", width = 0.13): WedgeShape {
  let [ax, ay, bx, by] = [seg.x1, seg.y1, seg.x2, seg.y2];
  if (Math.hypot(bx - narrow[0], by - narrow[1]) < Math.hypot(ax - narrow[0], ay - narrow[1])) [ax, ay, bx, by] = [bx, by, ax, ay];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const nx = -(by - ay) / len;
  const ny = (bx - ax) / len;
  if (kind === "wedge") {
    return { bond: seg.bond, kind, points: `${ax},${ay} ${bx + nx * width},${by + ny * width} ${bx - nx * width},${by - ny * width}` };
  }
  const count = Math.max(4, Math.round(len / 0.17));
  const rungs: [number, number, number, number][] = [];
  for (let k = 1; k <= count; k++) {
    const t = k / count;
    const cx = ax + (bx - ax) * t;
    const cy = ay + (by - ay) * t;
    const h = Math.max(0.025, width * t);
    rungs.push([cx + nx * h, cy + ny * h, cx - nx * h, cy - ny * h]);
  }
  return { bond: seg.bond, kind, rungs };
}
