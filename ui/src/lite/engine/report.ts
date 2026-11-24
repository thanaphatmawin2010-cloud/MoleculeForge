/**
 * Repair reports as Markdown: a port of compute/mfcompute/chem/report.py's Markdown writer. (PDF
 * reports, which embed fonts and an RDKit drawing, are written by the desktop app.)
 */
import { ENGINE_UNAVAILABLE, RpcFailure } from "./errors";
import { LITE_VERSION } from "./properties";

const DEFAULTS: Record<string, string> = {
  title: "Repair report", molecule: "Molecule", formula: "Formula", status: "Status", generated: "Generated",
  finalEnergy: "Final energy", rmsd: "RMSD from input", duration: "Duration", fixes: "Connectivity fixes",
  noFixes: "No connectivity fixes were needed.", changesBonds: "Bond length changes", changesAngles: "Bond angle changes",
  changesDihedrals: "Dihedral changes", noChanges: "No changes above the reporting threshold.",
  shown: "Showing the {shown} largest of {total} changes.", addedAtoms: "Implicit hydrogens made explicit",
  removedAtoms: "Atoms removed by valence fixes", geometryCheck: "Geometry check", minContact: "Closest non-bonded contact",
  methods: "Methods", remainingIssues: "Remaining issues", none: "None", colAtoms: "Atoms", colBefore: "Before",
  colAfter: "After", colDelta: "Change", colMethod: "Method", colBondType: "Bond type", colCount: "Count", colMean: "Mean",
  colExpected: "Expected", colStatus: "Status", ok: "OK", check: "Check", footer: "Computed offline by MoleculeForge {version}.",
};
const STATUS_DEFAULTS: Record<string, string> = { repaired: "Repaired", "already-optimal": "Already optimal", failed: "Repair failed" };
const MAX_TABLE_ROWS = 200;
const MAX_LINES = 500;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown, limit = 400) => String(v ?? "").slice(0, limit);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fmt = (v: unknown, digits = 4) => (num(v) ? v.toFixed(digits) : "—");
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function atomsLabel(change: Obj): string {
  const elements = (change["elements"] as unknown[]) ?? [];
  const atoms = (change["atoms"] as unknown[]) ?? [];
  return atoms.map((a, i) => (Number.isInteger(a) ? `${text(elements[i], 3)}${(a as number) + 1}` : "")).filter(Boolean).join("–");
}

/** File-name stem: letters with their combining marks (Thai vowels) and digits; other runs -> "-". */
export function slug(name: string): string {
  const kept = [...name].map((ch) => (/[\p{L}\p{M}\p{N}]/u.test(ch) ? ch : "-")).join("");
  const s = kept.replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return s.slice(0, 60) || "molecule";
}

export function toMarkdown(report: Obj, strings: Obj = {}): string {
  const L = { ...DEFAULTS };
  for (const [k, v] of Object.entries(strings)) if (k in DEFAULTS && typeof v === "string" && v.trim()) L[k] = v.slice(0, 400);
  const lines = (key: string): string[] => {
    const v = strings[key];
    return Array.isArray(v) ? v.slice(0, MAX_LINES).filter((x): x is string => typeof x === "string").map((x) => text(x)) : [];
  };
  const molecule = obj(report["molecule"]);
  const name = text(molecule["name"] || "", 120) || "molecule";
  const formula = text(molecule["formula"] || "", 120);
  const status = text(report["status"] || "repaired", 40);
  const statusText = typeof strings["statusText"] === "string" && strings["statusText"] ? text(strings["statusText"]) : STATUS_DEFAULTS[status] ?? status;
  const reason = text(report["reason"] || "");
  const residual = obj(report["residualEnergy"]);
  const energy = num(residual["value"]) ? `${fmt(residual["value"], 6)} ${text(residual["unit"], 20)} (${text(residual["method"], 120)})` : "—";
  const rmsdObj = obj(report["rmsd"]);
  const rmsd = num(rmsdObj["value"]) ? `${fmt(rmsdObj["value"], 4)} Å` : "—";
  const duration = num(report["durationMs"]) ? `${Math.trunc(report["durationMs"] as number)} ms` : "—";
  const fixLines = lines("fixLines").length ? lines("fixLines") : ((report["fixesApplied"] as Obj[]) ?? []).slice(0, MAX_LINES).map((f) => text(obj(obj(f)["fix"])["description"]));
  const issueLines = lines("issueLines").length
    ? lines("issueLines")
    : ((report["finalIssues"] as Obj[]) ?? []).slice(0, MAX_LINES).filter((i) => ["error", "warning"].includes(String(obj(i)["severity"]))).map((i) => text(obj(i)["message"]));
  const stageNames = obj(strings["stageNames"]);
  const stage = (s: string) => text(stageNames[s] ?? s, 80);
  const changes = obj(report["changes"]);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const generated = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const out = [`# ${L["title"]}: ${md(name)}`, "", "| | |", "|---|---|"];
  for (const [key, value] of [["molecule", name], ["formula", formula || "—"], ["status", statusText], ["finalEnergy", energy], ["rmsd", rmsd], ["duration", duration], ["generated", generated]] as const) {
    out.push(`| ${md(L[key]!)} | ${md(value)} |`);
  }
  if (reason) out.push("", `> ${md(reason)}`);
  out.push("", `## ${L["fixes"]}`, "");
  out.push(...(fixLines.length ? fixLines.map((l) => `- ${md(l)}`) : [L["noFixes"]!]));
  for (const [kind, label] of [["bonds", "changesBonds"], ["angles", "changesAngles"], ["dihedrals", "changesDihedrals"]] as const) {
    const items = ((changes[kind] as Obj[]) ?? []).filter((c) => c && typeof c === "object");
    const totalRaw = changes[`${kind}Total`];
    const total = Number.isInteger(totalRaw) ? (totalRaw as number) : items.length;
    const shown = items.slice(0, MAX_TABLE_ROWS);
    out.push("", `## ${L[label]} (${total})`, "");
    if (!shown.length) {
      out.push(L["noChanges"]!);
      continue;
    }
    if (total > shown.length) out.push(L["shown"]!.replace("{shown}", String(shown.length)).replace("{total}", String(total)), "");
    out.push(`| ${L["colAtoms"]} | ${L["colBefore"]} | ${L["colAfter"]} | ${L["colDelta"]} | ${L["colMethod"]} |`, "|---|---:|---:|---:|---|");
    for (const c of shown) {
      const unit = text(c["unit"], 3);
      const digits = unit === "Å" ? 4 : 2;
      const delta = c["delta"];
      const sign = num(delta) && delta > 0 ? "+" : "";
      const sep = unit === "°" ? "" : " ";
      const row = [atomsLabel(c), `${fmt(c["old"], digits)}${sep}${unit}`, `${fmt(c["new"], digits)}${sep}${unit}`, `${sign}${fmt(delta, digits)}${sep}${unit}`, text(c["rule"], 60)];
      out.push(`| ${row.map(md).join(" | ")} |`);
    }
  }
  const added = ((changes["addedAtoms"] as Obj[]) ?? []).filter((a) => Number.isInteger(obj(a)["atom"])).map((a) => `${text(a["element"], 3)}${(a["atom"] as number) + 1}`);
  const removed = ((changes["removedAtoms"] as Obj[]) ?? []).filter((a) => Number.isInteger(obj(a)["atom"])).map((a) => String((a["atom"] as number) + 1));
  if (added.length) out.push("", `## ${L["addedAtoms"]}`, "", added.join(", "));
  if (removed.length) out.push("", `## ${L["removedAtoms"]}`, "", removed.join(", "));
  const check = obj(report["geometryCheck"]);
  const rows: string[][] = [];
  for (const r of ((check["bondTable"] as Obj[]) ?? []).slice(0, MAX_TABLE_ROWS)) {
    const ref = obj(r["reference"]);
    rows.push([text(r["type"], 60), String(r["count"] ?? ""), `${fmt(r["mean"], 4)} Å`, `${fmt(ref["low"], 2)}–${fmt(ref["high"], 2)} Å`, r["withinTenPercent"] ? L["ok"]! : L["check"]!]);
  }
  for (const r of ((check["angleTable"] as Obj[]) ?? []).slice(0, MAX_TABLE_ROWS)) {
    rows.push([`∠ ${text(r["class"], 40)}`, String(r["count"] ?? ""), `${fmt(r["mean"], 2)}°`, num(r["ideal"]) ? `${fmt(r["ideal"], 2)}°` : "—", r["withinTenPercent"] ? L["ok"]! : L["check"]!]);
  }
  const contact = obj(check["minNonBondedDistance"]);
  const pair = Array.isArray(contact["atoms"]) ? (contact["atoms"] as number[]) : null;
  const contactText = num(contact["value"]) ? `${fmt(contact["value"], 3)} Å${pair && pair.length === 2 ? ` (${pair[0]! + 1}–${pair[1]! + 1})` : ""}` : null;
  if (rows.length || contactText) {
    out.push("", `## ${L["geometryCheck"]}`, "");
    if (rows.length) {
      out.push(`| ${L["colBondType"]} | ${L["colCount"]} | ${L["colMean"]} | ${L["colExpected"]} | ${L["colStatus"]} |`, "|---|---:|---:|---:|---|");
      for (const row of rows) out.push(`| ${row.map(md).join(" | ")} |`);
    }
    if (contactText) out.push("", `${L["minContact"]}: ${contactText}`);
  }
  const methods = ((report["methods"] as Obj[]) ?? []).filter((m) => m && typeof m === "object").slice(0, 50);
  if (methods.length) {
    out.push("", `## ${L["methods"]}`, "");
    methods.forEach((m, i) => {
      const details = text(m["details"]);
      out.push(`${i + 1}. **${md(stage(text(m["stage"], 40)))}** — ${md(text(m["method"]))}${details ? ` (${md(details)})` : ""}`);
    });
  }
  out.push("", `## ${L["remainingIssues"]}`, "");
  out.push(...(issueLines.length ? issueLines.map((l) => `- ${md(l)}`) : [L["none"]!]));
  out.push("", "---", "", L["footer"]!.replace("{version}", LITE_VERSION), "");
  return out.join("\n");
}

export function exportReport(report: Obj, format: string, locale = "en", strings: Obj = {}) {
  if (format !== "markdown") {
    throw new RpcFailure(ENGINE_UNAVAILABLE, "PDF reports are written by the MoleculeForge desktop app; export Markdown here", { code: "DESKTOP_ONLY", format });
  }
  const stem = `repair-report-${slug(text(obj(report["molecule"])["name"]) || "molecule")}`;
  return { format: "markdown", data: toMarkdown(report, strings), encoding: "utf-8", filename: `${stem}.md`, locale };
}
