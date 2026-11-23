/** Comprehensive periodic table (spec 7.5): category or heat-map colouring, search, detail panel, trends. */
import * as Select from "@radix-ui/react-select";
import { ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Segmented, cx, inputClass } from "@/design-system/primitives";
import type { Element } from "@/ipc/api";
import { formatNumber } from "@/lib/i18n";
import { FAMILY_CLASS } from "@/lib/chemistry";
import { useApp } from "@/state/app";
import { ElementDetail } from "./ElementDetail";
import { HEAT_PROPERTIES, type HeatProperty, heatValue, type EnergyUnit, type TemperatureUnit } from "./layout";
import { PeriodicGrid } from "./PeriodicGrid";

const LOG_SCALE: Set<HeatProperty> = new Set(["density", "thermalConductivity", "dipolePolarizability"]);

export function PeriodicTableView() {
  const { t, i18n } = useTranslation();
  const elements = useApp((s) => s.elements);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"category" | "heat">("category");
  const [prop, setProp] = useState<HeatProperty>("electronegativityPauling");
  const [selected, setSelected] = useState<Element | null>(null);
  const [tempUnit, setTempUnit] = useState<TemperatureUnit>("K");
  const [energyUnit, setEnergyUnit] = useState<EnergyUnit>("kJ/mol");

  const highlight = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      elements
        .filter(
          (el) =>
            el.symbol.toLowerCase() === q ||
            String(el.Z) === q ||
            el.nameEn.toLowerCase().includes(q) ||
            t(`elements:element.${el.symbol}`).toLowerCase().includes(q),
        )
        .map((el) => el.Z),
    );
  }, [query, elements, t]);

  const heat = useMemo(() => {
    if (mode !== "heat") return null;
    const values = elements.map((el) => heatValue(el, prop).value).filter((v): v is number => v !== null);
    return { prop, min: Math.min(...values), max: Math.max(...values), log: LOG_SCALE.has(prop) };
  }, [mode, prop, elements]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && highlight && highlight.size > 0) {
      const first = elements.find((el) => highlight.has(el.Z));
      if (first) setSelected(first);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("periodic.title")}</h1>
            <p className="mt-1 text-sm text-ink-3">{t("periodic.subtitle", { count: elements.length })}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
              <input
                className={cx(inputClass, "w-56 ps-8")}
                placeholder={t("periodic.search")}
                aria-label={t("periodic.search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
                data-testid="periodic-search"
              />
            </div>
            <Segmented
              label={t("periodic.colourBy")}
              value={mode}
              onChange={setMode}
              options={[
                { value: "category", label: t("periodic.byCategory") },
                { value: "heat", label: t("periodic.byProperty") },
              ]}
            />
            {mode === "heat" && (
              <Select.Root value={prop} onValueChange={(v) => setProp(v as HeatProperty)}>
                <Select.Trigger className="inline-flex h-9 items-center gap-2 rounded bg-surface-1 px-3 text-sm text-ink hairline" aria-label={t("periodic.property")} data-testid="heat-property">
                  <Select.Value />
                  <ChevronDown className="size-4 text-ink-3" />
                </Select.Trigger>
                <Select.Portal>
                  <Select.Content position="popper" sideOffset={4} className="z-50 rounded bg-surface-1 p-1 shadow-3 hairline">
                    <Select.Viewport>
                      {HEAT_PROPERTIES.map((p) => (
                        <Select.Item key={p} value={p} className="cursor-pointer rounded-sm px-3 py-1.5 text-sm text-ink outline-none data-[highlighted]:bg-surface-3">
                          <Select.ItemText>{t(`periodic.prop.${p}`)}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Viewport>
                  </Select.Content>
                </Select.Portal>
              </Select.Root>
            )}
          </div>
        </header>

        <div className="min-h-[520px] flex-1">
          <PeriodicGrid elements={elements} selected={selected?.Z ?? null} highlight={highlight} heat={heat} onSelect={setSelected} />
        </div>

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-label={t("periodic.legend")}>
          {mode === "category" ? (
            Object.keys(FAMILY_CLASS)
              .filter((k) => k !== "unknown")
              .map((key) => (
                <span key={key} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                  <span className={cx("size-3 rounded-sm", FAMILY_CLASS[key]!.tile, "hairline")} />
                  {t(`elements:category.${key}`)}
                </span>
              ))
          ) : (
            heat && (
              <div className="flex items-center gap-3 text-xs text-ink-2">
                <span>{t(`periodic.prop.${prop}`)}</span>
                <span className="font-mono">{formatNumber(heat.min, i18n.language, 2)}</span>
                <span
                  className="h-2.5 w-48 rounded-full"
                  style={{ background: "linear-gradient(90deg, color-mix(in oklab, hsl(var(--accent)) 8%, hsl(var(--surface-2))), hsl(var(--accent)))" }}
                />
                <span className="font-mono">{formatNumber(heat.max, i18n.language, 2)}</span>
                <span className="text-ink-3">{heatValue(elements[0]!, prop).unit}{heat.log ? ` · ${t("periodic.logScale")}` : ""}</span>
                <span className="inline-flex items-center gap-1 text-ink-3">
                  <span className="size-3 rounded-sm bg-surface-2 bg-[repeating-linear-gradient(135deg,transparent_0_4px,hsl(var(--line))_4px_5px)] hairline" />
                  {t("periodic.noData")}
                </span>
              </div>
            )
          )}
        </footer>
      </div>
      <ElementDetail
        element={selected}
        onClose={() => setSelected(null)}
        tempUnit={tempUnit}
        energyUnit={energyUnit}
        onTempUnit={setTempUnit}
        onEnergyUnit={setEnergyUnit}
        trendProperty={mode === "heat" ? prop : "electronegativityPauling"}
      />
    </div>
  );
}
