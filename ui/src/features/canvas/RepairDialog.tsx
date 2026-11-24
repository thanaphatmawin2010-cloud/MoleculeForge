/** One-click repair: progress with live geometry streaming, then the detailed report (spec 7.4). */
import i18next from "i18next";
import * as Tabs from "@radix-ui/react-tabs";
import { CheckCircle2, CircleAlert, Download, FileText, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/design-system/overlays";
import { Badge, Button, cx, ProgressBar } from "@/design-system/primitives";
import { api } from "@/ipc/api";
import { RpcError } from "@/ipc/client";
import type { RepairReport } from "@/ipc/schema";
import { IS_LITE } from "@/lib/edition";
import { errorText } from "@/lib/errors";
import { base64ToBytes, saveFile } from "@/lib/files";
import { formatNumber } from "@/lib/i18n";
import { applyCorrected, withCoordinates } from "@/lib/molecule";
import { useApp } from "@/state/app";
import { useEditor } from "@/state/editor";
import { fixReasonText, fixText, issueText, validate } from "./actions";

type Phase = { kind: "running"; percent: number; stage: string } | { kind: "done"; report: RepairReport } | { kind: "error"; message: string };

export function RepairDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "running", percent: 0, stage: "detect" });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const start = useEditor.getState().doc;
    const job = new AbortController();
    controller.current = job;
    setPhase({ kind: "running", percent: 0, stage: "detect" });
    api
      .repairGeometry(start.molecule, {
        signal: job.signal,
        onProgress: (p) => {
          setPhase({ kind: "running", percent: p.percent, stage: p.stage });
          const frame = p.data?.frame;
          const current = useEditor.getState().doc;
          if (Array.isArray(frame) && frame.length === current.molecule.atoms.length) {
            useEditor.getState().preview(withCoordinates(current, frame as number[][]));
          }
        },
      })
      .then((report) => {
        useEditor.getState().preview(start);
        if (report.status === "repaired") {
          const map = report.atomMap ?? start.molecule.atoms.map((_a, i) => i);
          const next = applyCorrected(start, report.molecule, map);
          useEditor.getState().execute(t("history.repair"), next);
          // The repaired geometry is the report's result: live physics must not re-relax it.
          void validate({ atoms: [], bonds: [] }, false, { relax: false });
          window.dispatchEvent(new Event("mf:fit3d"));
        }
        setPhase({ kind: "done", report });
      })
      .catch((err: unknown) => {
        useEditor.getState().preview(start);
        if (err instanceof RpcError && err.cancelled) {
          onOpenChange(false);
          return;
        }
        setPhase({ kind: "error", message: errorText(err) });
      });
    return () => job.abort();
  }, [open, onOpenChange, t]);

  const exportReport = async (format: "markdown" | "pdf") => {
    if (phase.kind !== "done") return;
    try {
      const out = await api.reportExport(phase.report, format, i18n.language, reportStrings(phase.report));
      const bytes = out.encoding === "base64" ? base64ToBytes(out.data) : out.data;
      const ok = await saveFile(out.filename, bytes, [{ name: format === "pdf" ? "PDF" : "Markdown", extensions: [format === "pdf" ? "pdf" : "md"] }]);
      if (ok) useApp.getState().pushToast({ tone: "success", title: t("repair.exported", { name: out.filename }) });
    } catch (err) {
      useApp.getState().pushToast({ tone: "danger", title: t("repair.exportFailed"), body: errorText(err) });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) controller.current?.abort();
        onOpenChange(next);
      }}
      title={t("repair.title")}
      description={t("repair.subtitle")}
      width="lg"
      footer={
        phase.kind === "running" ? (
          <Button variant="secondary" onClick={() => controller.current?.abort()}>
            {t("action.cancel")}
          </Button>
        ) : (
          <>
            {phase.kind === "done" && phase.report.status !== "failed" && (
              <>
                <Button variant="ghost" icon={<FileText className="size-4" />} onClick={() => void exportReport("markdown")}>
                  {t("repair.exportMarkdown")}
                </Button>
                {/* PDF reports embed fonts and an RDKit drawing: written by the desktop app only. */}
                {!IS_LITE && (
                  <Button variant="ghost" icon={<Download className="size-4" />} onClick={() => void exportReport("pdf")}>
                    {t("repair.exportPdf")}
                  </Button>
                )}
              </>
            )}
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              {t("action.done")}
            </Button>
          </>
        )
      }
    >
      {phase.kind === "running" && (
        <div className="space-y-3 py-4" data-testid="repair-progress">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-ink">{t(`repair.stage.${phase.stage}`, { defaultValue: phase.stage })}</span>
            <span className="font-mono text-xs text-ink-3">{Math.round(phase.percent)}%</span>
          </div>
          <ProgressBar value={phase.percent} label={t("repair.title")} />
          <p className="text-xs text-ink-3">{t("repair.watch")}</p>
        </div>
      )}
      {phase.kind === "error" && <p className="py-4 text-sm text-danger">{phase.message}</p>}
      {phase.kind === "done" && <RepairReportView report={phase.report} />}
    </Dialog>
  );
}

/** Every label in the exported report, already in the reader's language (locale files stay the single source). */
function reportStrings(report: RepairReport): Record<string, string | string[] | Record<string, string>> {
  const labels = (i18next.getResourceBundle(i18next.resolvedLanguage ?? "en", "common") as { report?: Record<string, string> }).report ?? {};
  return {
    ...labels,
    statusText: i18next.t(`repair.status.${report.status}`),
    fixLines: report.fixesApplied.map((f) => `${fixText(f)} — ${fixReasonText(f)}`),
    issueLines: (report.finalIssues ?? []).filter((i) => i.severity !== "info").map((i) => issueText(i.code, i.params, i.message)),
    stageNames: Object.fromEntries((report.methods ?? []).map((m) => [m.stage, i18next.t(`repair.stage.${m.stage}`, { defaultValue: m.stage })])),
  };
}

export function RepairReportView({ report }: { report: RepairReport }) {
  const { t, i18n } = useTranslation();
  const fmt = (v: number, d = 3) => formatNumber(v, i18n.language, d, true);
  const changes = report.changes;
  const statusTone = report.status === "failed" ? "danger" : report.status === "already-optimal" ? "info" : "success";
  return (
    <div className="space-y-5" data-testid="repair-report" data-status={report.status}>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={statusTone}>
          {report.status === "failed" ? <CircleAlert className="size-3" /> : report.status === "already-optimal" ? <CheckCircle2 className="size-3" /> : <Sparkles className="size-3" />}
          {t(`repair.status.${report.status}`)}
        </Badge>
        {report.residualEnergy && report.residualEnergy.value !== null && (
          <span className="text-xs text-ink-2">
            {t("repair.residual")}: <span className="font-mono">{fmt(report.residualEnergy.value, 6)}</span> {report.residualEnergy.unit}
            <span className="text-ink-3"> · {report.residualEnergy.method}</span>
          </span>
        )}
        {report.rmsd?.value != null && (
          <span className="text-xs text-ink-2">
            RMSD <span className="font-mono">{fmt(report.rmsd.value, 3)}</span> Å
          </span>
        )}
      </div>
      {report.status === "failed" && <p className="text-sm text-danger">{report.reason}</p>}
      {report.fixesApplied.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{t("repair.fixes")}</h3>
          <ul className="space-y-1.5">
            {report.fixesApplied.map((fix, i) => (
              <li key={i} className="flex gap-2 text-sm text-ink-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                <span>
                  {fixText(fix)} <span className="text-ink-3">— {fixReasonText(fix)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {changes && report.status !== "failed" && (
        <Tabs.Root defaultValue="bonds">
          <Tabs.List className="mb-3 flex gap-1 border-b border-line" aria-label={t("repair.changes")}>
            {(["bonds", "angles", "dihedrals", "check", "methods"] as const).map((tab) => (
              <Tabs.Trigger
                key={tab}
                value={tab}
                className="-mb-px border-b-2 border-transparent px-3 py-2 text-xs font-medium text-ink-3 hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink"
              >
                {t(`repair.tab.${tab}`)}
                {tab === "bonds" && ` (${changes.bondsTotal})`}
                {tab === "angles" && ` (${changes.anglesTotal})`}
                {tab === "dihedrals" && ` (${changes.dihedralsTotal})`}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {(["bonds", "angles", "dihedrals"] as const).map((kind) => (
            <Tabs.Content key={kind} value={kind}>
              {changes[kind].length === 0 ? (
                <p className="py-3 text-sm text-ink-3">{t("repair.noChanges")}</p>
              ) : (
                <div className="max-h-72 overflow-auto rounded hairline">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-surface-2 text-ink-3">
                      <tr>
                        <th className="px-3 py-2 text-start font-medium">{t("repair.col.atoms")}</th>
                        <th className="px-3 py-2 text-end font-medium">{t("repair.col.before")}</th>
                        <th className="px-3 py-2 text-end font-medium">{t("repair.col.after")}</th>
                        <th className="px-3 py-2 text-end font-medium">Δ</th>
                        <th className="px-3 py-2 text-start font-medium">{t("repair.col.method")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes[kind].slice(0, 300).map((c, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="px-3 py-1.5 font-mono text-ink">{c.elements.map((el, k) => `${el}${c.atoms[k]! + 1}`).join("–")}</td>
                          <td className="px-3 py-1.5 text-end font-mono text-ink-2">{fmt(c.old)} {c.unit}</td>
                          <td className="px-3 py-1.5 text-end font-mono text-ink">{fmt(c.new)} {c.unit}</td>
                          <td className={cx("px-3 py-1.5 text-end font-mono", c.delta > 0 ? "text-info" : "text-accent")}>
                            {c.delta > 0 ? "+" : ""}
                            {fmt(c.delta)}
                          </td>
                          <td className="px-3 py-1.5 text-ink-3">{c.rule}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Tabs.Content>
          ))}
          <Tabs.Content value="check">
            {report.geometryCheck && (
              <div className="space-y-4">
                <table className="w-full text-xs">
                  <thead className="text-ink-3">
                    <tr>
                      <th className="py-1.5 text-start font-medium">{t("repair.col.bondType")}</th>
                      <th className="py-1.5 text-end font-medium">n</th>
                      <th className="py-1.5 text-end font-medium">{t("repair.col.mean")}</th>
                      <th className="py-1.5 text-end font-medium">{t("repair.col.expected")}</th>
                      <th className="py-1.5 text-end font-medium">{t("repair.col.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.geometryCheck.bondTable.map((row) => (
                      <tr key={row.type} className="border-t border-line">
                        <td className="py-1.5 font-mono text-ink">{row.type}</td>
                        <td className="py-1.5 text-end text-ink-2">{row.count}</td>
                        <td className="py-1.5 text-end font-mono text-ink">{fmt(row.mean)} Å</td>
                        <td className="py-1.5 text-end font-mono text-ink-3">
                          {fmt(row.reference.low, 2)}–{fmt(row.reference.high, 2)} Å
                        </td>
                        <td className="py-1.5 text-end">
                          <Badge tone={row.withinTenPercent ? "success" : "warning"}>{row.withinTenPercent ? t("repair.ok") : t("repair.check")}</Badge>
                        </td>
                      </tr>
                    ))}
                    {report.geometryCheck.angleTable.map((row) => (
                      <tr key={row.class} className="border-t border-line">
                        <td className="py-1.5 font-mono text-ink">∠ {row.class}</td>
                        <td className="py-1.5 text-end text-ink-2">{row.count}</td>
                        <td className="py-1.5 text-end font-mono text-ink">{fmt(row.mean, 2)}°</td>
                        <td className="py-1.5 text-end font-mono text-ink-3">{row.ideal !== null ? `${fmt(row.ideal, 2)}°` : "—"}</td>
                        <td className="py-1.5 text-end">
                          <Badge tone={row.withinTenPercent ? "success" : "warning"}>{row.withinTenPercent ? t("repair.ok") : t("repair.check")}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.geometryCheck.minNonBondedDistance.value !== null && (
                  <p className="text-xs text-ink-2">
                    {t("repair.minContact")}: <span className="font-mono">{fmt(report.geometryCheck.minNonBondedDistance.value)} Å</span>
                  </p>
                )}
              </div>
            )}
          </Tabs.Content>
          <Tabs.Content value="methods">
            <ol className="space-y-2">
              {report.methods?.map((m, i) => (
                <li key={i} className="text-xs">
                  <span className="font-semibold text-ink">{t(`repair.stage.${m.stage}`, { defaultValue: m.stage })}</span>
                  <span className="text-ink-2"> — {m.method}</span>
                  {m.details && <span className="text-ink-3"> ({m.details})</span>}
                </li>
              ))}
            </ol>
          </Tabs.Content>
        </Tabs.Root>
      )}
    </div>
  );
}
