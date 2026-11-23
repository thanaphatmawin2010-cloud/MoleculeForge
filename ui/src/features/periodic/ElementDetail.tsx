/** Element detail panel: every spec 6.2 field, unit-labelled, with status badges, shells and trends. */
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Segmented, cx } from "@/design-system/primitives";
import type { Element } from "@/ipc/api";
import { familyClass } from "@/lib/chemistry";
import { formatNumber } from "@/lib/i18n";
import { useApp } from "@/state/app";
import { convertEnergy, convertTemperature, type EnergyUnit, type HeatProperty, heatValue, type TemperatureUnit } from "./layout";

type Q = { value: number | null; unit: string; status: string; source?: string | null };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/70 py-1.5 last:border-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="text-end text-sm text-ink">{children}</dd>
    </div>
  );
}

function Value({ q, convert, unit, digits = 4 }: { q: Q; convert?: (v: number) => number; unit?: string; digits?: number }) {
  const { t, i18n } = useTranslation();
  if (q.value === null) return <Badge tone="neutral">{t("elementStatus.unknown")}</Badge>;
  const value = convert ? convert(q.value) : q.value;
  return (
    <span className="ltr-run inline-flex items-baseline gap-1.5">
      <span className="font-mono tabular">{formatNumber(value, i18n.language, digits)}</span>
      <span className="text-2xs text-ink-3">{unit ?? q.unit}</span>
      {q.status === "predicted" && <Badge tone="warning">{t("elementStatus.predicted")}</Badge>}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-5 py-4">
      <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

/** Electron configuration with superscript occupancies: [Ar] 3d⁶ 4s². */
function Configuration({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className={className}>—</span>;
  const parts = value.split(/(\d+[spdfg])(\d+)/g);
  const out: ReactNode[] = [];
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    if (/^\d+[spdfg]$/.test(part) && parts[k + 1] !== undefined && /^\d+$/.test(parts[k + 1]!)) {
      out.push(
        <span key={k}>
          {part}
          <sup className="text-[0.75em]">{parts[k + 1]}</sup>
        </span>,
      );
      k++;
    } else if (part) out.push(<span key={k}>{part}</span>);
  }
  return (
    <span className={cx("ltr-run", className)} aria-label={value}>
      {out}
    </span>
  );
}

function ShellDiagram({ shells, symbol }: { shells: number[]; symbol: string }) {
  const { t } = useTranslation();
  const size = 200;
  const c = size / 2;
  const step = (c - 16) / Math.max(shells.length, 1);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto size-48" role="img" aria-label={t("element.shellDiagram", { shells: shells.join(", ") })}>
      <circle cx={c} cy={c} r={12} className="fill-accent" />
      <text x={c} y={c} dy="0.35em" textAnchor="middle" fontSize={9} fontWeight={700} className="fill-accent-on">
        {symbol}
      </text>
      {shells.map((count, k) => {
        const r = 16 + step * (k + 0.8);
        return (
          <g key={k}>
            <circle cx={c} cy={c} r={r} fill="none" className="stroke-line-strong" strokeWidth={0.8} />
            {Array.from({ length: count }, (_v, e) => {
              const a = (2 * Math.PI * e) / count - Math.PI / 2;
              return <circle key={e} cx={c + r * Math.cos(a)} cy={c + r * Math.sin(a)} r={2.2} className="fill-ink" />;
            })}
          </g>
        );
      })}
    </svg>
  );
}

function Trend({ elements, current, prop, axis }: { elements: Element[]; current: Element; prop: HeatProperty; axis: "period" | "group" }) {
  const { t, i18n } = useTranslation();
  const series = elements
    .filter((el) => (axis === "period" ? el.period === current.period && !(el.Z >= 58 && el.Z <= 71) && !(el.Z >= 90 && el.Z <= 103) : el.group !== null && el.group === current.group))
    .map((el) => ({ el, v: heatValue(el, prop).value }))
    .filter((p): p is { el: Element; v: number } => p.v !== null);
  if (series.length < 2) return null;
  const w = 300;
  const h = 90;
  const vs = series.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const x = (i: number) => 18 + (i * (w - 36)) / (series.length - 1);
  const y = (v: number) => h - 18 - ((v - lo) / (hi - lo || 1)) * (h - 32);
  const path = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return (
    <figure>
      <figcaption className="mb-1 text-2xs text-ink-3">
        {t(axis === "period" ? "element.trendPeriod" : "element.trendGroup", { property: t(`periodic.prop.${prop}`), n: axis === "period" ? current.period : current.group })}
      </figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={t(`periodic.prop.${prop}`)}>
        <path d={path} fill="none" className="stroke-ink-3" strokeWidth={1.5} />
        {series.map((p, i) => (
          <g key={p.el.Z}>
            <circle cx={x(i)} cy={y(p.v)} r={p.el.Z === current.Z ? 4 : 2.4} className={p.el.Z === current.Z ? "fill-accent" : "fill-ink-2"} />
            <text x={x(i)} y={h - 4} textAnchor="middle" fontSize={8} className={cx("font-mono", p.el.Z === current.Z ? "fill-accent" : "fill-ink-3")}>
              {p.el.symbol}
            </text>
          </g>
        ))}
        <text x={2} y={10} fontSize={8} className="fill-ink-3 font-mono">{formatNumber(hi, i18n.language, 2)}</text>
      </svg>
    </figure>
  );
}

export function ElementDetail({
  element,
  onClose,
  tempUnit,
  energyUnit,
  onTempUnit,
  onEnergyUnit,
  trendProperty,
}: {
  element: Element | null;
  onClose: () => void;
  tempUnit: TemperatureUnit;
  energyUnit: EnergyUnit;
  onTempUnit: (u: TemperatureUnit) => void;
  onEnergyUnit: (u: EnergyUnit) => void;
  trendProperty: HeatProperty;
}) {
  const { t, i18n } = useTranslation();
  const elements = useApp((s) => s.elements);
  const [allIsotopes, setAllIsotopes] = useState(false);
  const isotopes = useMemo(() => {
    if (!element) return [];
    const natural = element.isotopes.filter((i) => (i.abundance.value ?? 0) > 0);
    const rest = element.isotopes.filter((i) => !((i.abundance.value ?? 0) > 0)).sort((a, b) => (b.halfLife.seconds ?? 0) - (a.halfLife.seconds ?? 0));
    return allIsotopes ? [...natural, ...rest] : [...natural, ...rest].slice(0, Math.max(natural.length, 6));
  }, [element, allIsotopes]);
  const tUnit = tempUnit === "K" ? "K" : tempUnit === "C" ? "°C" : "°F";
  const fmt = (v: number, d = 4) => formatNumber(v, i18n.language, d);

  return (
    <AnimatePresence>
      {element && (
        <motion.aside
          key="detail"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 36 }}
          className="flex w-[400px] shrink-0 flex-col border-s border-line bg-surface-1"
          aria-label={t("element.detail", { name: t(`elements:element.${element.symbol}`) })}
          data-testid="element-detail"
        >
          <header className="flex items-start gap-4 border-b border-line p-5">
            <div className={cx("grid size-20 shrink-0 place-items-center rounded-lg", familyClass(element.category).tile)}>
              <div className="text-center">
                <div className={cx("font-mono text-2xs", familyClass(element.category).ink)}>{element.Z}</div>
                <div className={cx("font-mono text-3xl font-semibold leading-none", familyClass(element.category).ink)}>{element.symbol}</div>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-semibold text-ink">{t(`elements:element.${element.symbol}`)}</h2>
              <p className="text-sm text-ink-2">{t(`elements:category.${element.category}`)}</p>
              <p className="mt-1 text-xs text-ink-3">
                {t("element.position", { period: element.period, group: element.group ?? "—", block: element.block })}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={t("action.close")}>
              <X className="size-4" />
            </Button>
          </header>
          <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
            <Section title={t("element.identity")}>
              <dl>
                <Row label={t("element.atomicMass")}>
                  {element.atomicMass.value !== null ? (
                    <span className="ltr-run inline-flex items-baseline gap-1.5">
                      <span className="font-mono">{element.atomicMass.isMassNumberOfLongestLived ? `[${element.atomicMass.value}]` : fmt(element.atomicMass.value, 6)}</span>
                      {element.atomicMass.uncertainty !== null && <span className="font-mono text-2xs text-ink-3">± {element.atomicMass.uncertainty}</span>}
                      <span className="text-2xs text-ink-3">u</span>
                    </span>
                  ) : (
                    "—"
                  )}
                </Row>
                {element.atomicMass.isMassNumberOfLongestLived && <p className="pb-1 text-2xs text-ink-3">{t("element.massNumberNote")}</p>}
                <Row label={t("element.configuration")}>
                  <Configuration value={element.electronConfiguration.nobleGasShorthand} className="font-mono text-xs" />
                </Row>
                <Row label={t("element.fullConfiguration")}>
                  <Configuration value={element.electronConfiguration.full} className="font-mono text-2xs" />
                </Row>
                <Row label={t("element.shells")}>
                  <span className="ltr-run font-mono text-xs">{element.shellElectrons.join(", ")}</span>
                </Row>
                <Row label={t("element.oxidationStates")}>
                  <span className="ltr-run font-mono text-xs">
                    {element.oxidationStates.common.length ? element.oxidationStates.common.map((o) => (o > 0 ? `+${o}` : `${o}`)).join(", ") : "—"}
                  </span>
                </Row>
              </dl>
              <ShellDiagram shells={element.shellElectrons} symbol={element.symbol} />
            </Section>

            <Section title={t("element.atomic")}>
              <div className="mb-2 flex justify-end">
                <Segmented size="sm" label={t("element.energyUnit")} value={energyUnit} onChange={onEnergyUnit} options={[{ value: "kJ/mol", label: "kJ/mol" }, { value: "eV", label: "eV" }]} />
              </div>
              <dl>
                <Row label={t("element.enPauling")}><Value q={element.electronegativityPauling} digits={2} /></Row>
                <Row label={t("element.enAllen")}><Value q={element.electronegativityAllen} digits={3} /></Row>
                <Row label={t("element.radiusCovalent")}><Value q={element.radiusCovalent.single} digits={1} /></Row>
                <Row label={t("element.radiusCovalentDouble")}><Value q={element.radiusCovalent.double} digits={1} /></Row>
                <Row label={t("element.radiusCovalentTriple")}><Value q={element.radiusCovalent.triple} digits={1} /></Row>
                <Row label={t("element.radiusVdw")}><Value q={element.radiusVanDerWaals} digits={1} /></Row>
                <Row label={t("element.radiusAtomic")}><Value q={element.radiusAtomic} digits={1} /></Row>
                <Row label={t("element.electronAffinity")}>
                  <Value q={element.electronAffinity} convert={(v) => convertEnergy(v, energyUnit)} unit={energyUnit} />
                </Row>
                <Row label={t("element.polarizability")}><Value q={element.dipolePolarizability} digits={3} /></Row>
              </dl>
              {element.ionizationEnergies.values.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-xs text-ink-3">{t("element.ionizationEnergies")}</p>
                  <ol className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                    {element.ionizationEnergies.values.slice(0, 8).map((v, k) => (
                      <li key={k} className="flex justify-between text-xs">
                        <span className="text-ink-3">{t("element.ionizationNth", { n: k + 1 })}</span>
                        <span className="font-mono text-ink">{fmt(convertEnergy(v, energyUnit), energyUnit === "eV" ? 3 : 1)}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="mt-1 text-end text-2xs text-ink-3">{energyUnit}</p>
                </div>
              )}
            </Section>

            <Section title={t("element.physical")}>
              <div className="mb-2 flex justify-end">
                <Segmented size="sm" label={t("element.temperatureUnit")} value={tempUnit} onChange={onTempUnit} options={[{ value: "K", label: "K" }, { value: "C", label: "°C" }, { value: "F", label: "°F" }]} />
              </div>
              <dl>
                <Row label={t("element.density")}><Value q={element.density} /></Row>
                <Row label={t("element.meltingPoint")}><Value q={element.meltingPointK} convert={(v) => convertTemperature(v, tempUnit)} unit={tUnit} digits={2} /></Row>
                <Row label={t("element.boilingPoint")}><Value q={element.boilingPointK} convert={(v) => convertTemperature(v, tempUnit)} unit={tUnit} digits={2} /></Row>
                <Row label={t("element.heatOfFusion")}><Value q={element.heatOfFusion} /></Row>
                <Row label={t("element.heatOfVaporization")}><Value q={element.heatOfVaporization} /></Row>
                <Row label={t("element.molarHeatCapacity")}><Value q={element.molarHeatCapacity} /></Row>
                <Row label={t("element.thermalConductivity")}><Value q={element.thermalConductivity} /></Row>
                <Row label={t("element.electricalType")}>
                  {element.electricalType.value ? t(`elements:electrical.${element.electricalType.value}`) : <Badge>{t("elementStatus.unknown")}</Badge>}
                </Row>
                <Row label={t("element.crystalStructure")}>
                  {element.crystalStructure.value ? t(`elements:crystal.${element.crystalStructure.value}`, { defaultValue: element.crystalStructure.value }) : <Badge>{t("elementStatus.unknown")}</Badge>}
                </Row>
              </dl>
              {Object.entries(element.notes).map(([key, note]) => (
                <p key={key} className="mt-2 text-2xs leading-4 text-ink-3">
                  * {t(`element.noteFor.${key}`, { defaultValue: key })}: {t(`elements:note.${element.symbol}.${key}`, { defaultValue: note })}
                </p>
              ))}
            </Section>

            <Section title={t("element.trends")}>
              <div className="space-y-4">
                <Trend elements={elements} current={element} prop={trendProperty} axis="period" />
                <Trend elements={elements} current={element} prop={trendProperty} axis="group" />
              </div>
            </Section>

            <Section title={t("element.history")}>
              <dl>
                <Row label={t("element.discoveredBy")}>
                  {element.discoveredBy.knownSinceAntiquity ? t("element.antiquity") : element.discoveredBy.value ?? "—"}
                </Row>
                <Row label={t("element.yearDiscovered")}>
                  {element.yearDiscovered.knownSinceAntiquity ? t("element.antiquity") : element.yearDiscovered.value ?? "—"}
                </Row>
              </dl>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {element.commonUses.map((use) => (
                  <Badge key={use} tone="neutral">{t(`elements:use.${use}`)}</Badge>
                ))}
              </div>
            </Section>

            <Section title={t("element.isotopes", { count: element.isotopes.length })}>
              <table className="w-full text-xs">
                <thead className="text-ink-3">
                  <tr>
                    <th className="py-1 text-start font-medium">A</th>
                    <th className="py-1 text-end font-medium">{t("element.isotopeMass")}</th>
                    <th className="py-1 text-end font-medium">{t("element.abundance")}</th>
                    <th className="py-1 text-end font-medium">{t("element.halfLife")}</th>
                    <th className="py-1 text-end font-medium">{t("element.decay")}</th>
                  </tr>
                </thead>
                <tbody>
                  {isotopes.map((iso) => (
                    <tr key={iso.massNumber} className="border-t border-line/70">
                      <td className="py-1 font-mono text-ink">{iso.massNumber}{element.symbol}</td>
                      <td className="py-1 text-end font-mono text-ink-2">{iso.mass.value !== null ? fmt(iso.mass.value, 5) : "—"}</td>
                      <td className="py-1 text-end font-mono text-ink-2">{iso.abundance.value ? `${fmt(iso.abundance.value * 100, 4)}%` : "—"}</td>
                      <td className="py-1 text-end font-mono text-ink-2">
                        {iso.halfLife.stable ? t("element.stable") : iso.halfLife.value !== null ? `${fmt(iso.halfLife.value, 3)} ${iso.halfLife.unit ?? ""}` : "—"}
                      </td>
                      <td className="py-1 text-end font-mono text-2xs text-ink-3">{iso.decayMode.map((d) => d.mode).join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {element.isotopes.length > isotopes.length && (
                <Button size="sm" variant="quiet" className="mt-2" onClick={() => setAllIsotopes(true)}>
                  {t("element.showAllIsotopes", { count: element.isotopes.length })}
                </Button>
              )}
            </Section>

            {element.ionicRadii.entries.length > 0 && (
              <Section title={t("element.ionicRadii")}>
                <table className="w-full text-xs">
                  <thead className="text-ink-3">
                    <tr>
                      <th className="py-1 text-start font-medium">{t("element.ionCharge")}</th>
                      <th className="py-1 text-start font-medium">CN</th>
                      <th className="py-1 text-end font-medium">{t("element.ionicRadius")}</th>
                      <th className="py-1 text-end font-medium">{t("element.crystalRadius")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {element.ionicRadii.entries.slice(0, 24).map((r, k) => (
                      <tr key={k} className="border-t border-line/70">
                        <td className="py-1 font-mono text-ink">{r.charge > 0 ? `+${r.charge}` : r.charge}{r.spin ? ` (${r.spin})` : ""}</td>
                        <td className="py-1 font-mono text-ink-2">{r.coordination}</td>
                        <td className="py-1 text-end font-mono text-ink-2">{r.ionicRadius ?? "—"} pm</td>
                        <td className="py-1 text-end font-mono text-ink-2">{r.crystalRadius ?? "—"} pm</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-2xs text-ink-3">{element.ionicRadii.source}</p>
              </Section>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
