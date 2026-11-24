import { motion, type MotionStyle } from "framer-motion";
import { useTranslation } from "react-i18next";
import { cx } from "@/design-system/primitives";
import type { Element } from "@/ipc/api";
import { formatNumber } from "@/lib/i18n";
import { familyClass } from "@/lib/chemistry";
import { type HeatProperty, heatValue, position } from "./layout";

export interface GridProps {
  elements: Element[];
  compact?: boolean;
  selected?: number | null;
  highlight?: Set<number> | null;
  heat?: { prop: HeatProperty; min: number; max: number; log: boolean } | null;
  onSelect: (el: Element) => void;
}

function heatStyle(value: number | null, heat: NonNullable<GridProps["heat"]>): React.CSSProperties {
  if (value === null) return {};
  const lo = heat.log ? Math.log10(Math.max(heat.min, 1e-9)) : heat.min;
  const hi = heat.log ? Math.log10(Math.max(heat.max, 1e-9)) : heat.max;
  const v = heat.log ? Math.log10(Math.max(value, 1e-9)) : value;
  const t = hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5;
  const pct = Math.round(8 + t * 82);
  return { backgroundColor: `color-mix(in oklab, hsl(var(--accent)) ${pct}%, hsl(var(--surface-2)))`, color: t > 0.55 ? "hsl(var(--on-accent))" : undefined };
}

export function PeriodicGrid({ elements, compact = false, selected = null, highlight = null, heat = null, onSelect }: GridProps) {
  const { t, i18n } = useTranslation();
  return (
    <div
      // A set of toggle buttons laid out as the periodic table (no grid keyboard model, so no ARIA grid).
      role="group"
      // The periodic table's layout (group 1 on the left) is a scientific convention: never mirrored.
      dir="ltr"
      aria-label={t("periodic.gridLabel")}
      className={cx("grid gap-[3px]", compact ? "grid-cols-[repeat(18,minmax(0,28px))]" : "grid-cols-[repeat(18,minmax(0,1fr))]")}
      style={{ gridTemplateRows: compact ? "repeat(7, 28px) 8px repeat(2, 28px)" : "repeat(7, minmax(0,1fr)) 10px repeat(2, minmax(0,1fr))" }}
    >
      {elements.map((el) => {
        const { row, col } = position(el);
        const fam = familyClass(el.category);
        const dim = highlight && !highlight.has(el.Z);
        const heatData = heat ? heatValue(el, heat.prop) : null;
        const style: MotionStyle = { gridRow: row, gridColumn: col, ...(heat && heatData ? (heatStyle(heatData.value, heat) as MotionStyle) : {}) };
        return (
          <motion.button
            key={el.Z}
            aria-label={`${t(`elements:element.${el.symbol}`)}, ${t("periodic.atomicNumber")} ${el.Z}`}
            aria-pressed={selected === el.Z}
            onClick={() => onSelect(el)}
            whileHover={{ y: -1, scale: compact ? 1.08 : 1.04 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 600, damping: 30 }}
            style={style}
            data-testid={`element-tile-${el.symbol}`}
            className={cx(
              "relative flex flex-col overflow-hidden rounded-sm text-start outline-none ring-accent transition-opacity duration-2 focus-visible:ring-2",
              !heat && fam.tile,
              heat && heatData?.value === null && "bg-surface-2 bg-[repeating-linear-gradient(135deg,transparent_0_4px,hsl(var(--line))_4px_5px)]",
              selected === el.Z && "ring-2 ring-accent",
              dim && "opacity-25",
              compact ? "items-center justify-center" : "p-1.5",
            )}
          >
            {compact ? (
              <span className={cx("font-mono text-xs font-semibold", !heat && fam.ink)}>{el.symbol}</span>
            ) : (
              <>
                <span className={cx("font-mono text-2xs leading-none", !heat && fam.ink)}>{el.Z}</span>
                <span className={cx("mt-auto font-mono text-lg font-semibold leading-none", !heat && fam.ink)}>{el.symbol}</span>
                <span className={cx("mt-0.5 truncate text-[10px] leading-tight opacity-85", !heat && fam.ink)}>
                  {heat && heatData ? (heatData.value === null ? "—" : formatNumber(heatData.value, i18n.language, 2)) : t(`elements:element.${el.symbol}`)}
                </span>
              </>
            )}
          </motion.button>
        );
      })}
      {!compact && (
        <>
          <div style={{ gridRow: 6, gridColumn: 3 }} className="grid place-items-center rounded-sm text-2xs text-ink-3 hairline">57–71</div>
          <div style={{ gridRow: 7, gridColumn: 3 }} className="grid place-items-center rounded-sm text-2xs text-ink-3 hairline">89–103</div>
        </>
      )}
    </div>
  );
}
