/** Simulation engine dashboard (spec 7.8): run real local computations and read every property. */
import * as Tabs from "@radix-ui/react-tabs";
import { Activity, Atom, Cpu, Download, FlaskConical, Gauge, Play, Square, Thermometer, Waves } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Formula } from "@/design-system/formula";
import { Badge, Button, EmptyState, Field, Panel, PanelHeader, ProgressBar, Segmented, Switch, cx, inputClass } from "@/design-system/primitives";
import { Quantity } from "@/design-system/quantity";
import { api, type LibraryItem } from "@/ipc/api";
import { RpcError } from "@/ipc/client";
import type { Molecule, PropertyValue, SimulationResult } from "@/ipc/schema";
import { saveFile } from "@/lib/files";
import { withCoordinates, formulaOf } from "@/lib/molecule";
import { useApp } from "@/state/app";
import { useEditor } from "@/state/editor";
import { Viewer3D } from "../canvas/Viewer3D";
import { IrSpectrum, LineChart, OrbitalLevels } from "./charts";

type Job = "properties" | "minimize" | "md" | "dock";

const GROUPS: { id: string; icon: ReactNode; keys: string[] }[] = [
  { id: "identity", icon: <Atom className="size-4" />, keys: ["formula", "molecularWeight", "exactMass", "atomCount", "heavyAtomCount", "netCharge", "stereocenters", "rotationalSymmetryNumber"] },
  { id: "energetics", icon: <Gauge className="size-4" />, keys: ["potentialEnergy", "totalEnergy", "dftEnergy", "heatOfFormation", "heatOfFormationKcal", "ionizationPotential"] },
  { id: "electronic", icon: <Activity className="size-4" />, keys: ["homo", "lumo", "homoLumoGap", "dipoleMoment", "dipoleMomentPm7", "polarizability"] },
  { id: "shape", icon: <Square className="size-4" />, keys: ["sasa", "polarSasa", "molecularVolume", "radiusOfGyration", "rotationalConstants", "principalMoments"] },
  { id: "druglike", icon: <FlaskConical className="size-4" />, keys: ["logP", "tpsa", "hBondDonors", "hBondAcceptors", "rotatableBonds", "molarRefractivity", "ringCount", "aromaticRingCount", "fractionCsp3", "qed"] },
  { id: "thermo", icon: <Thermometer className="size-4" />, keys: ["zeroPointEnergy", "enthalpyCorrection", "entropy", "entropyQuasiRRHO", "heatCapacityCp", "gibbsCorrection", "enthalpy", "gibbsFreeEnergy", "imaginaryFrequencyCount"] },
];

function PropertyCard({ name, pv }: { name: string; pv: PropertyValue }) {
  const { t } = useTranslation();
  const value = pv.value;
  let body: ReactNode;
  if (name === "formula" && typeof value === "string") {
    body = <Formula value={value} className="text-lg font-medium text-ink" />;
  } else if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    body = (
      <span className="font-mono text-sm text-ink">
        {(value as number[]).map((v) => v.toFixed(3)).join(" · ")} <span className="text-2xs text-ink-3">{pv.unit}</span>
      </span>
    );
  } else {
    body = <Quantity value={value} unit={pv.unit} method={pv.method} uncertainty={pv.uncertainty ?? null} emphasis />;
  }
  return (
    <div className="rounded bg-surface-2/60 p-3 hairline" data-testid={`prop-${name}`}>
      <p className="text-2xs text-ink-3">{t(`prop.${name}`, { defaultValue: name })}</p>
      <div className="mt-1">{body}</div>
      <p className="mt-1 line-clamp-2 text-2xs leading-4 text-ink-3">{pv.method}</p>
    </div>
  );
}

function RuleCard({ title, pv }: { title: string; pv?: PropertyValue }) {
  const { t } = useTranslation();
  if (!pv || typeof pv.value !== "object" || pv.value === null) return null;
  const data = pv.value as { checks: Record<string, boolean>; passes: boolean; violations?: number };
  return (
    <div className="rounded bg-surface-2/60 p-3 hairline" data-testid={`rule-${title}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink">{t(`results.rule.${title}`)}</p>
        <Badge tone={data.passes ? "success" : "danger"}>{data.passes ? t("results.passes") : t("results.fails")}</Badge>
      </div>
      <ul className="mt-2 space-y-1">
        {Object.entries(data.checks).map(([check, ok]) => (
          <li key={check} className="flex items-center justify-between text-xs">
            <span className="font-mono text-ink-2">{check}</span>
            <span className={ok ? "text-success" : "text-danger"}>{ok ? "✓" : "✗"}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-2xs text-ink-3">{pv.method}</p>
    </div>
  );
}

export function SimulateView() {
  const { t } = useTranslation();
  const doc = useEditor((s) => s.doc);
  const capabilities = useApp((s) => s.capabilities);
  const pushToast = useApp((s) => s.pushToast);
  const [job, setJob] = useState<Job>("properties");
  const [level, setLevel] = useState<"fast" | "standard" | "thorough">("standard");
  const [withMd, setWithMd] = useState(false);
  const [method, setMethod] = useState("auto");
  const [temperature, setTemperature] = useState(300);
  const [steps, setSteps] = useState(10000);
  const [receptorId, setReceptorId] = useState<string>("");
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [running, setRunning] = useState<{ percent: number; stage: string; message: string } | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [preview, setPreview] = useState<Molecule | null>(null);
  const [mode, setMode] = useState<number | null>(null);

  useEffect(() => {
    api.libraryList({ limit: 400 }).then((r) => setLibrary(r.items));
  }, []);

  const molecule = doc.molecule;
  const shown = preview ?? result?.geometry ?? molecule;

  const run = async () => {
    if (molecule.atoms.length === 0) return;
    const ctl = new AbortController();
    setController(ctl);
    setRunning({ percent: 0, stage: "start", message: "" });
    setResult(null);
    setMode(null);
    let streamBase: Molecule | null = null;
    const onProgress = (p: { percent: number; stage: string; message: string; data?: Record<string, unknown> }) => {
      setRunning({ percent: p.percent, stage: p.stage, message: p.message });
      const frame = p.data?.frame;
      if (Array.isArray(frame)) {
        streamBase ??= molecule;
        if ((frame as unknown[]).length === streamBase.atoms.length) {
          setPreview(withCoordinates({ molecule: streamBase, layout: [] }, frame as number[][]).molecule);
        }
      }
    };
    try {
      let res: SimulationResult;
      if (job === "properties") res = await api.properties(molecule, level, withMd, { signal: ctl.signal, onProgress });
      else if (job === "minimize") res = await api.minimize(molecule, method, { signal: ctl.signal, onProgress });
      else if (job === "md") res = await api.md(molecule, { temperatureK: temperature, steps, reportEvery: Math.max(10, Math.round(steps / 200)) }, { signal: ctl.signal, onProgress });
      else {
        const receptor = await api.libraryLoad(receptorId);
        res = await api.dock(receptor.molecule, molecule, 8, { signal: ctl.signal, onProgress });
      }
      setResult(res);
    } catch (err) {
      if (!(err instanceof RpcError && err.cancelled)) {
        pushToast({ tone: "danger", title: t("simulate.failed"), body: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setPreview(null);
      setRunning(null);
      setController(null);
    }
  };

  const exportResult = async (format: "json" | "csv") => {
    if (!result) return;
    let data: string;
    if (format === "json") data = JSON.stringify(result, null, 2);
    else {
      const rows = [["property", "value", "unit", "method", "uncertainty"]];
      for (const [key, pv] of Object.entries(result.properties)) {
        rows.push([key, typeof pv.value === "object" ? JSON.stringify(pv.value) : String(pv.value), pv.unit, pv.method, pv.uncertainty != null ? String(pv.uncertainty) : ""]);
      }
      data = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    }
    const name = `${(molecule.name || "molecule").replace(/[^\p{L}\p{N}_-]+/gu, "_")}-${result.method.replace(/\W+/g, "-")}.${format}`;
    if (await saveFile(name, data, [{ name: format.toUpperCase(), extensions: [format] }])) pushToast({ tone: "success", title: t("simulate.exported", { name }) });
  };

  const vibration = useMemo(() => {
    const modes = result?.data?.normalModes as { displacements: number[][][] } | undefined;
    return mode !== null && modes ? modes.displacements[mode] ?? null : null;
  }, [mode, result]);

  if (molecule.atoms.length === 0) {
    return (
      <div className="h-full">
        <EmptyState icon={<FlaskConical className="size-5" />} title={t("simulate.emptyTitle")} body={t("simulate.emptyBody")} action={<Button variant="primary" onClick={() => useApp.getState().setView("build")}>{t("simulate.goBuild")}</Button>} />
      </div>
    );
  }

  const props = result?.properties ?? {};
  const freq = props.vibrationalFrequencies?.value as number[] | undefined;
  const ir = props.irIntensities?.value as number[] | undefined;
  const orbitals = (result?.data?.orbitalsDft ?? result?.data?.orbitals) as { energiesEv: number[]; occupations: number[]; method: string } | undefined;
  const md = (result?.data?.timeSeries ?? (result?.data?.md as { timeSeries?: unknown } | undefined)?.timeSeries) as
    | { timePs: number[]; temperature: number[]; potential: number[]; kinetic: number[] }
    | undefined;
  const modes = result?.data?.modes as { mode: number; affinity: number; rmsdLowerBound: number; rmsdUpperBound: number }[] | undefined;
  const charges = props.gasteigerCharges?.value as (number | null)[] | undefined;
  const xtbCharges = props.partialChargesXtb?.value as number[] | undefined;
  const dftCharges = props.partialChargesMulliken?.value as number[] | undefined;
  const pka = props.pKaEstimates?.value as { group: string; groupId?: string; kind: string; pKa: number; uncertainty?: number; atoms: number[] }[] | undefined;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[320px] shrink-0 flex-col gap-4 overflow-y-auto border-e border-line bg-surface-1 p-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t("simulate.title")}</h1>
          <p className="mt-0.5 text-xs text-ink-3">
            {molecule.name || t("inspector.untitled")} · <Formula value={molecule.formula || formulaOf(molecule)} />
          </p>
        </div>
        <Segmented
          label={t("simulate.job")}
          value={job}
          onChange={setJob}
          options={[
            { value: "properties", label: t("simulate.jobProperties") },
            { value: "minimize", label: t("simulate.jobMinimize") },
            { value: "md", label: t("simulate.jobMd") },
            { value: "dock", label: t("simulate.jobDock") },
          ]}
        />
        {job === "properties" && (
          <div className="space-y-3">
            <Field label={t("simulate.level")} htmlFor="level" hint={t(`simulate.levelHint.${level}`)}>
              <Segmented label={t("simulate.level")} value={level} onChange={setLevel} options={[
                { value: "fast", label: t("simulate.levelFast") },
                { value: "standard", label: t("simulate.levelStandard") },
                { value: "thorough", label: t("simulate.levelThorough") },
              ]} />
            </Field>
            <Switch id="with-md" label={t("simulate.includeMd")} checked={withMd} onChange={setWithMd} />
          </div>
        )}
        {job === "minimize" && (
          <Field label={t("simulate.method")} htmlFor="method">
            <select id="method" className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
              {["auto", "MMFF94", "MMFF94s", "UFF", "GFN-FF", "GFN2-xTB"].map((m) => (
                <option key={m} value={m}>{m === "auto" ? t("simulate.auto") : m}</option>
              ))}
            </select>
          </Field>
        )}
        {job === "md" && (
          <div className="space-y-3">
            <Field label={t("simulate.temperature")} htmlFor="md-t" hint="K">
              <input id="md-t" type="number" min={10} max={2000} className={inputClass} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} />
            </Field>
            <Field label={t("simulate.steps")} htmlFor="md-steps" hint={t("simulate.stepsHint", { ps: steps / 1000 })}>
              <input id="md-steps" type="number" min={1000} max={1000000} step={1000} className={inputClass} value={steps} onChange={(e) => setSteps(Number(e.target.value))} />
            </Field>
          </div>
        )}
        {job === "dock" && (
          <Field label={t("simulate.receptor")} htmlFor="receptor" hint={t("simulate.receptorHint")}>
            <select id="receptor" className={inputClass} value={receptorId} onChange={(e) => setReceptorId(e.target.value)}>
              <option value="">{t("simulate.chooseReceptor")}</option>
              {library.map((item) => (
                <option key={item.id} value={item.id}>{item.name} ({item.formula})</option>
              ))}
            </select>
          </Field>
        )}
        {running ? (
          <div className="space-y-2" data-testid="sim-progress">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-ink">{t(`simulate.stage.${running.stage}`, { defaultValue: running.stage })}</span>
              <span className="font-mono text-ink-3">{Math.round(running.percent)}%</span>
            </div>
            <ProgressBar value={running.percent} label={t("simulate.progress")} />
            <p className="truncate text-2xs text-ink-3">{running.message}</p>
            <Button variant="secondary" icon={<Square className="size-3.5" />} onClick={() => controller?.abort()} className="w-full">
              {t("action.cancel")}
            </Button>
          </div>
        ) : (
          <Button variant="primary" size="lg" icon={<Play className="size-4" />} onClick={() => void run()} disabled={job === "dock" && !receptorId} data-testid="run-simulation">
            {t("simulate.run")}
          </Button>
        )}
        <div className="mt-auto space-y-1 rounded bg-surface-2/70 p-3 text-2xs text-ink-3 hairline">
          <p className="flex items-center gap-1.5 font-medium text-ink-2"><Cpu className="size-3.5" />{t("simulate.hardware")}</p>
          <p>{capabilities ? t("simulate.cpu", { cores: capabilities.cpu.physicalCores ?? "?", threads: capabilities.selected.threads }) : "…"}</p>
          <p>{capabilities ? t("simulate.gpu", { platform: capabilities.selected.openmmPlatform ?? "CPU", llm: capabilities.selected.llmOffload.toUpperCase() }) : ""}</p>
          <p>{t("simulate.offline")}</p>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-4">
            {!result && !running && (
              <Panel className="p-8">
                <EmptyState icon={<Waves className="size-5" />} title={t("simulate.readyTitle")} body={t("simulate.readyBody")} />
              </Panel>
            )}
            {result && (
              <>
                <Panel>
                  <PanelHeader
                    title={t("simulate.resultTitle", { method: result.method })}
                    subtitle={`${result.engine}${result.forceField ? ` · ${result.forceField}` : ""}${result.hamiltonian ? ` · ${result.hamiltonian}` : ""} · ${(result.durationMs / 1000).toFixed(1)} s`}
                    actions={
                      <>
                        <Badge tone={result.converged ? "success" : "warning"}>{result.converged ? t("simulate.converged") : t("simulate.notConverged")}</Badge>
                        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void exportResult("csv")}>CSV</Button>
                        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void exportResult("json")}>JSON</Button>
                      </>
                    }
                  />
                  {result.warnings.length > 0 && (
                    <ul className="space-y-1 border-b border-line px-4 py-3">
                      {result.warnings.map((w, i) => (
                        <li key={i} className="text-xs text-warning">{w}</li>
                      ))}
                    </ul>
                  )}
                  <Tabs.Root defaultValue="overview" className="p-4">
                    <Tabs.List className="mb-4 flex flex-wrap gap-1" aria-label={t("results.sections")}>
                      {["overview", "spectra", "charges", "dynamics", "docking"].map((tab) => (
                        <Tabs.Trigger key={tab} value={tab} className="rounded px-3 py-1.5 text-xs font-medium text-ink-3 hover:bg-surface-3 data-[state=active]:bg-surface-3 data-[state=active]:text-ink">
                          {t(`results.tab.${tab}`)}
                        </Tabs.Trigger>
                      ))}
                    </Tabs.List>
                    <Tabs.Content value="overview" className="space-y-5">
                      {GROUPS.map((group) => {
                        const entries = group.keys.filter((k) => props[k]);
                        if (entries.length === 0) return null;
                        return (
                          <section key={group.id}>
                            <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{group.icon}{t(`results.group.${group.id}`)}</h3>
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
                              {entries.map((k) => <PropertyCard key={k} name={k} pv={props[k]!} />)}
                            </div>
                          </section>
                        );
                      })}
                      {(props.lipinski || props.veber) && (
                        <section>
                          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{t("results.group.rules")}</h3>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <RuleCard title="lipinski" pv={props.lipinski} />
                            <RuleCard title="veber" pv={props.veber} />
                          </div>
                        </section>
                      )}
                      {pka && pka.length > 0 && (
                        <section>
                          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{t("results.pka")}</h3>
                          <table className="w-full text-xs">
                            <tbody>
                              {pka.map((p, i) => (
                                <tr key={i} className="border-t border-line">
                                  <td className="py-1.5 text-ink">{p.groupId ? t(`pka.${p.groupId}`, { defaultValue: p.group }) : p.group}</td>
                                  <td className="py-1.5 text-ink-3">{t(`pka.kind.${p.kind}`)}</td>
                                  <td className="py-1.5 text-end font-mono text-ink">{p.pKa.toFixed(2)} ± {(p.uncertainty ?? 1.5).toFixed(1)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <p className="mt-1 text-2xs text-ink-3">{props.pKaEstimates?.method}</p>
                        </section>
                      )}
                      {Object.keys(props).filter((k) => k.startsWith("md.")).length > 0 && (
                        <section>
                          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{t("results.group.md")}</h3>
                          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
                            {Object.keys(props).filter((k) => k.startsWith("md.")).map((k) => <PropertyCard key={k} name={k.slice(3)} pv={props[k]!} />)}
                          </div>
                        </section>
                      )}
                      {job !== "properties" && (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
                          {Object.entries(props).filter(([k]) => !GROUPS.some((g) => g.keys.includes(k))).map(([k, pv]) => <PropertyCard key={k} name={k} pv={pv} />)}
                        </div>
                      )}
                    </Tabs.Content>
                    <Tabs.Content value="spectra" className="space-y-5">
                      {freq && ir ? (
                        <section>
                          <h3 className="mb-2 text-xs font-semibold text-ink">{t("results.irSpectrum")}</h3>
                          <IrSpectrum frequencies={freq} intensities={ir} selected={mode} onPick={setMode} />
                          <p className="mt-1 text-2xs text-ink-3">{props.vibrationalFrequencies?.method} · {t("results.broadening")}</p>
                          <div className="mt-3 max-h-56 overflow-auto rounded hairline">
                            <table className="w-full text-xs">
                              <thead className="sticky top-0 bg-surface-2 text-ink-3">
                                <tr>
                                  <th className="px-3 py-1.5 text-start font-medium">#</th>
                                  <th className="px-3 py-1.5 text-end font-medium">cm⁻¹</th>
                                  <th className="px-3 py-1.5 text-end font-medium">km/mol</th>
                                  <th className="px-3 py-1.5" />
                                </tr>
                              </thead>
                              <tbody>
                                {freq.map((f, i) => f > 10 && (
                                  <tr key={i} className={cx("border-t border-line", mode === i && "bg-accent-soft")}>
                                    <td className="px-3 py-1 font-mono text-ink-3">{i + 1}</td>
                                    <td className="px-3 py-1 text-end font-mono text-ink">{f.toFixed(1)}</td>
                                    <td className="px-3 py-1 text-end font-mono text-ink-2">{(ir[i] ?? 0).toFixed(2)}</td>
                                    <td className="px-3 py-1 text-end">
                                      <Button size="sm" variant={mode === i ? "primary" : "ghost"} onClick={() => setMode(mode === i ? null : i)}>
                                        {mode === i ? t("results.stop") : t("results.animate")}
                                      </Button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      ) : (
                        <p className="text-sm text-ink-3">{t("results.noSpectra")}</p>
                      )}
                      {orbitals && <OrbitalLevels energies={orbitals.energiesEv} occupations={orbitals.occupations} method={orbitals.method} />}
                    </Tabs.Content>
                    <Tabs.Content value="charges">
                      {charges ? (
                        <div className="max-h-[480px] overflow-auto rounded hairline">
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-surface-2 text-ink-3">
                              <tr>
                                <th className="px-3 py-1.5 text-start font-medium">{t("results.atom")}</th>
                                <th className="px-3 py-1.5 text-end font-medium">{t("results.chargeGasteiger")}</th>
                                {xtbCharges && <th className="px-3 py-1.5 text-end font-medium">{t("results.chargeXtb")}</th>}
                                {dftCharges && <th className="px-3 py-1.5 text-end font-medium">{t("results.chargeMulliken")}</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {result.geometry.atoms.map((a, i) => (
                                <tr key={i} className="border-t border-line">
                                  <td className="px-3 py-1 font-mono text-ink">{a.el}{i + 1}</td>
                                  <td className="px-3 py-1 text-end font-mono text-ink-2">{charges[i]?.toFixed(3) ?? "—"}</td>
                                  {xtbCharges && <td className="px-3 py-1 text-end font-mono text-ink-2">{xtbCharges[i]?.toFixed(3) ?? "—"}</td>}
                                  {dftCharges && <td className="px-3 py-1 text-end font-mono text-ink-2">{dftCharges[i]?.toFixed(3) ?? "—"}</td>}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-sm text-ink-3">{t("results.noCharges")}</p>
                      )}
                    </Tabs.Content>
                    <Tabs.Content value="dynamics">
                      {md ? (
                        <div className="space-y-4">
                          <LineChart xLabel={t("results.timePs")} yLabel="K" series={[{ name: "T", tone: "accent", points: md.timePs.map((x, i) => [x, md.temperature[i]!]) }]} />
                          <LineChart xLabel={t("results.timePs")} yLabel="kcal/mol" series={[
                            { name: "Epot", tone: "info", points: md.timePs.map((x, i) => [x, md.potential[i]!]) },
                            { name: "Ekin", tone: "success", points: md.timePs.map((x, i) => [x, md.kinetic[i]!]) },
                          ]} />
                        </div>
                      ) : (
                        <p className="text-sm text-ink-3">{t("results.noDynamics")}</p>
                      )}
                    </Tabs.Content>
                    <Tabs.Content value="docking">
                      {modes ? (
                        <table className="w-full text-xs">
                          <thead className="text-ink-3">
                            <tr>
                              <th className="py-1.5 text-start font-medium">{t("results.pose")}</th>
                              <th className="py-1.5 text-end font-medium">{t("results.affinity")}</th>
                              <th className="py-1.5 text-end font-medium">RMSD l.b.</th>
                              <th className="py-1.5 text-end font-medium">RMSD u.b.</th>
                            </tr>
                          </thead>
                          <tbody>
                            {modes.map((md2) => (
                              <tr key={md2.mode} className="border-t border-line">
                                <td className="py-1.5 font-mono text-ink">{md2.mode}</td>
                                <td className="py-1.5 text-end font-mono text-ink">{md2.affinity.toFixed(2)} kcal/mol</td>
                                <td className="py-1.5 text-end font-mono text-ink-2">{md2.rmsdLowerBound.toFixed(2)} Å</td>
                                <td className="py-1.5 text-end font-mono text-ink-2">{md2.rmsdUpperBound.toFixed(2)} Å</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className="text-sm text-ink-3">{t("results.noDocking")}</p>
                      )}
                    </Tabs.Content>
                  </Tabs.Root>
                </Panel>
              </>
            )}
          </div>
          <div className="space-y-4 xl:sticky xl:top-5 xl:self-start">
            <Panel className="overflow-hidden">
              <PanelHeader title={running ? t("simulate.live") : t("simulate.structure")} subtitle={mode !== null && freq ? t("results.animatingMode", { freq: freq[mode]?.toFixed(1) }) : undefined} />
              <Viewer3D className="h-[380px]" molecule={shown} vibration={vibration} testId="sim-viewer" fitKey={`${shown.id}:${shown.atoms.length}`} />
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
