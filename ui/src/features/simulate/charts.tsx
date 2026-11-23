/** Lightweight SVG charts tuned to the design tokens (no external charting runtime). */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "@/lib/i18n";

function ticks(min: number, max: number, count = 5): number[] {
  const span = max - min || 1;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const nice = [1, 2, 2.5, 5, 10].map((f) => f * step).find((s) => span / s <= count) ?? step * 10;
  const start = Math.ceil(min / nice) * nice;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += nice) out.push(Number(v.toPrecision(12)));
  return out;
}

export interface Series {
  name: string;
  points: [number, number][];
  tone: "accent" | "info" | "success" | "warning";
}

const STROKE = { accent: "stroke-accent", info: "stroke-info", success: "stroke-success", warning: "stroke-warning" };
const FILL = { accent: "fill-accent", info: "fill-info", success: "fill-success", warning: "fill-warning" };

export function LineChart({ series, xLabel, yLabel, height = 200, invertX = false }: { series: Series[]; xLabel: string; yLabel: string; height?: number; invertX?: boolean }) {
  const { i18n } = useTranslation();
  const w = 560;
  const h = height;
  const m = { l: 52, r: 12, t: 10, b: 34 };
  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const ymin = Math.min(...ys);
  const ymax = Math.max(...ys);
  const pad = (ymax - ymin || 1) * 0.08;
  const y0 = ymin - pad;
  const y1 = ymax + pad;
  const sx = (x: number) => {
    const t = (x - xmin) / (xmax - xmin || 1);
    return m.l + (invertX ? 1 - t : t) * (w - m.l - m.r);
  };
  const sy = (y: number) => h - m.b - ((y - y0) / (y1 - y0 || 1)) * (h - m.t - m.b);
  if (all.length === 0) return null;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`${yLabel} / ${xLabel}`}>
      {ticks(y0, y1).map((v) => (
        <g key={`y${v}`}>
          <line x1={m.l} x2={w - m.r} y1={sy(v)} y2={sy(v)} className="stroke-line" strokeWidth={1} />
          <text x={m.l - 6} y={sy(v)} dy="0.32em" textAnchor="end" fontSize={10} className="fill-ink-3 font-mono">
            {formatNumber(v, i18n.language, 2)}
          </text>
        </g>
      ))}
      {ticks(xmin, xmax).map((v) => (
        <text key={`x${v}`} x={sx(v)} y={h - m.b + 14} textAnchor="middle" fontSize={10} className="fill-ink-3 font-mono">
          {formatNumber(v, i18n.language, 1)}
        </text>
      ))}
      <text x={(m.l + w - m.r) / 2} y={h - 4} textAnchor="middle" fontSize={10} className="fill-ink-2">
        {xLabel}
      </text>
      <text x={12} y={(m.t + h - m.b) / 2} textAnchor="middle" fontSize={10} className="fill-ink-2" transform={`rotate(-90 12 ${(m.t + h - m.b) / 2})`}>
        {yLabel}
      </text>
      {series.map((s) => (
        <path
          key={s.name}
          d={s.points.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ")}
          fill="none"
          className={STROKE[s.tone]}
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

/** IR spectrum: Lorentzian-broadened absorption (HWHM 10 cm⁻¹) with stick lines, high wavenumber on the left. */
export function IrSpectrum({ frequencies, intensities, onPick, selected }: { frequencies: number[]; intensities: number[]; onPick?: (index: number) => void; selected?: number | null }) {
  const { t } = useTranslation();
  const data = useMemo(() => {
    const modes = frequencies.map((f, i) => ({ f, I: intensities[i] ?? 0, i })).filter((m) => m.f > 10);
    const gamma = 10;
    const pts: [number, number][] = [];
    for (let x = 400; x <= 4000; x += 4) {
      let y = 0;
      for (const mode of modes) y += (mode.I * gamma * gamma) / ((x - mode.f) ** 2 + gamma * gamma);
      pts.push([x, y]);
    }
    const max = Math.max(...pts.map((p) => p[1]), 1e-9);
    return { modes, pts: pts.map(([x, y]) => [x, (100 * y) / max] as [number, number]) };
  }, [frequencies, intensities]);
  const w = 560;
  const h = 210;
  const m = { l: 40, r: 12, t: 10, b: 34 };
  const sx = (x: number) => m.l + (1 - (x - 400) / 3600) * (w - m.l - m.r);
  const sy = (y: number) => h - m.b - (y / 105) * (h - m.t - m.b);
  const maxI = Math.max(...data.modes.map((md) => md.I), 1e-9);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={t("results.irSpectrum")} data-testid="ir-spectrum">
      {[0, 25, 50, 75, 100].map((v) => (
        <line key={v} x1={m.l} x2={w - m.r} y1={sy(v)} y2={sy(v)} className="stroke-line" />
      ))}
      {[4000, 3500, 3000, 2500, 2000, 1500, 1000, 500].map((v) => (
        <text key={v} x={sx(v)} y={h - m.b + 14} textAnchor="middle" fontSize={10} className="fill-ink-3 font-mono">
          {v}
        </text>
      ))}
      <text x={(m.l + w) / 2} y={h - 4} textAnchor="middle" fontSize={10} className="fill-ink-2">
        {t("results.wavenumber")}
      </text>
      {data.modes.map((mode) => (
        <line
          key={mode.i}
          x1={sx(mode.f)}
          x2={sx(mode.f)}
          y1={sy(0)}
          y2={sy((100 * mode.I) / maxI)}
          className={selected === mode.i ? "stroke-accent" : "stroke-ink-3"}
          strokeWidth={selected === mode.i ? 2.4 : 1}
          onClick={() => onPick?.(mode.i)}
          style={{ cursor: onPick ? "pointer" : undefined }}
        >
          <title>{`${mode.f.toFixed(1)} cm⁻¹ · ${mode.I.toFixed(2)} km/mol`}</title>
        </line>
      ))}
      <path d={data.pts.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ")} fill="none" className="stroke-accent" strokeWidth={1.6} />
    </svg>
  );
}

/** Frontier-orbital level diagram (occupied below, virtual above the gap). */
export function OrbitalLevels({ energies, occupations, method }: { energies: number[]; occupations: number[]; method: string }) {
  const { t, i18n } = useTranslation();
  const homoIndex = occupations.reduce((acc, occ, i) => (occ > 1e-3 ? i : acc), -1);
  const window = energies
    .map((e, i) => ({ e, i, occ: occupations[i] ?? 0 }))
    .filter((o) => o.i >= homoIndex - 4 && o.i <= homoIndex + 5);
  if (window.length === 0) return null;
  const lo = Math.min(...window.map((o) => o.e));
  const hi = Math.max(...window.map((o) => o.e));
  const h = 240;
  const sy = (e: number) => h - 16 - ((e - lo) / (hi - lo || 1)) * (h - 32);
  return (
    <figure>
      <svg viewBox={`0 0 280 ${h}`} className="w-full" role="img" aria-label={t("results.orbitals")} data-testid="orbital-levels">
        {window.map((o) => {
          const occupied = o.occ > 1e-3;
          const label = o.i === homoIndex ? "HOMO" : o.i === homoIndex + 1 ? "LUMO" : o.i < homoIndex ? `HOMO−${homoIndex - o.i}` : `LUMO+${o.i - homoIndex - 1}`;
          return (
            <g key={o.i}>
              <line x1={70} x2={150} y1={sy(o.e)} y2={sy(o.e)} className={occupied ? "stroke-accent" : "stroke-info"} strokeWidth={2} />
              {occupied && <text x={110} y={sy(o.e) - 3} textAnchor="middle" fontSize={9} className="fill-accent">↑↓</text>}
              <text x={160} y={sy(o.e)} dy="0.32em" fontSize={10} className="fill-ink-2 font-mono">
                {formatNumber(o.e, i18n.language, 2)} eV
              </text>
              <text x={62} y={sy(o.e)} dy="0.32em" textAnchor="end" fontSize={10} className={o.i === homoIndex || o.i === homoIndex + 1 ? "fill-ink font-semibold" : "fill-ink-3"}>
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="text-center text-2xs text-ink-3">{method}</figcaption>
    </figure>
  );
}

export const toneFill = FILL;
