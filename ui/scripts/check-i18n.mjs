#!/usr/bin/env node
/**
 * i18n coverage gate (run in CI and by `pnpm i18n:check`). Fails when:
 *  1. a locale is missing a key that English has, or has an extra one;
 *  2. a message is not valid ICU MessageFormat, or its placeholders differ from English;
 *  3. a key used in the UI source does not exist;
 *  4. a value family produced by the data or the compute sidecar has no translation
 *     (element names, categories, crystal structures, uses, notes, issue codes, fixes,
 *     library categories, pKa groups, property names, job stages, heat-map properties);
 *  5. an issue/fix template uses a placeholder the sidecar does not send;
 *  6. JSX contains hard-coded user-facing English text.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";

const ui = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(ui, "..");
const LOCALES = ["en", "th"];
const NAMESPACES = ["common", "elements", "issues"];
const errors = [];
const fail = (msg) => errors.push(msg);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

function argNames(message, where) {
  const names = new Set();
  const walk = (nodes) => {
    for (const n of nodes) {
      if ([TYPE.argument, TYPE.number, TYPE.date, TYPE.time].includes(n.type)) names.add(n.value);
      if (n.type === TYPE.select || n.type === TYPE.plural) {
        names.add(n.value);
        for (const opt of Object.values(n.options)) walk(opt.value);
      }
      if (n.type === TYPE.tag) walk(n.children);
    }
  };
  try {
    walk(parse(message, { requiresOtherClause: true }));
  } catch (err) {
    fail(`${where}: invalid ICU message (${err.message}): ${message}`);
  }
  return names;
}

// ---- 1 + 2: locale parity and ICU validity ---------------------------------------------
const catalog = {};
for (const lng of LOCALES) {
  catalog[lng] = {};
  for (const ns of NAMESPACES) catalog[lng][ns] = flatten(readJson(join(ui, "src/locales", lng, `${ns}.json`)));
}
let total = 0;
for (const ns of NAMESPACES) {
  const en = catalog.en[ns];
  total += Object.keys(en).length;
  for (const lng of LOCALES.filter((l) => l !== "en")) {
    const other = catalog[lng][ns];
    for (const key of Object.keys(en)) {
      if (!(key in other)) {
        fail(`${lng}/${ns}: missing key ${key}`);
        continue;
      }
      if (!other[key].trim()) fail(`${lng}/${ns}: empty translation for ${key}`);
      const a = [...argNames(en[key], `en/${ns}:${key}`)].sort().join(",");
      const b = [...argNames(other[key], `${lng}/${ns}:${key}`)].sort().join(",");
      if (a !== b) fail(`${lng}/${ns}:${key}: placeholders {${b}} differ from English {${a}}`);
    }
    for (const key of Object.keys(other)) if (!(key in en)) fail(`${lng}/${ns}: extra key ${key} (not in English)`);
  }
}
const has = (ns, key) => key in catalog.en[ns];
const requireKey = (ns, key, why) => {
  if (!has(ns, key)) fail(`missing ${ns}:${key} (${why})`);
};

// ---- 3: keys used in the source ----------------------------------------------------------
function walkFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, exts, out);
    else if (exts.some((e) => name.endsWith(e)) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}
const sources = walkFiles(join(ui, "src"), [".ts", ".tsx"]).filter((p) => !p.includes(`${join("src", "locales")}`));
const splitKey = (raw) => {
  const m = raw.match(/^(\w+):(.*)$/);
  return m && NAMESPACES.includes(m[1]) ? [m[1], m[2]] : ["common", raw];
};
const topLevel = new Set(Object.keys(catalog.en.common).map((k) => k.split(".")[0]));
let used = 0;
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ui, file);
  // t("key"), i18next.t("key") and keys chosen by a ternary inside t( … )
  for (const m of text.matchAll(/\bt\(\s*(["'])([^"'`$]+)\1/g)) {
    const [ns, key] = splitKey(m[2]);
    used++;
    if (!has(ns, key)) fail(`${rel}: unknown i18n key ${ns}:${key}`);
  }
  // Keys stored in constants (e.g. suggestion lists), skipping RPC method names in src/ipc and in
  // MoleculeForge Lite's in-browser engine (src/lite), which answers the same methods.
  if (!rel.includes(join("src", "ipc")) && !rel.includes(join("src", "lite"))) {
    for (const m of text.matchAll(/["']((?:elements:|issues:)?[a-z]+(?:\.[A-Za-z0-9-]+)+)["']/g)) {
      const [ns, key] = splitKey(m[1]);
      const head = key.split(".")[0];
      if (ns === "common" && !topLevel.has(head)) continue;
      if (/\.(json|tsx?|css|svg|png|woff2?|sdf|mol|pdb|xyz)$/.test(key)) continue;
      if (!has(ns, key)) fail(`${rel}: string "${m[1]}" looks like an i18n key but does not exist`);
    }
  }
}

// ---- 4 + 5: value families produced by data and by the sidecar --------------------------
const elements = readJson(join(repo, "data/elements.json")).elements;
for (const el of elements) {
  requireKey("elements", `element.${el.symbol}`, "element name");
  requireKey("elements", `category.${el.category}`, `category of ${el.symbol}`);
  if (el.crystalStructure?.value) requireKey("elements", `crystal.${el.crystalStructure.value}`, `crystal of ${el.symbol}`);
  if (el.electricalType?.value) requireKey("elements", `electrical.${el.electricalType.value}`, `electrical type of ${el.symbol}`);
  for (const use of el.commonUses ?? []) requireKey("elements", `use.${use}`, `use of ${el.symbol}`);
  for (const key of Object.keys(el.notes ?? {})) {
    requireKey("elements", `note.${el.symbol}.${key}`, `note on ${el.symbol}`);
    requireKey("common", `element.noteFor.${key}`, `note label for ${key}`);
  }
}

const py = (p) => readFileSync(join(repo, "compute/mfcompute", p), "utf8");
const issuesPy = py("chem/issues.py");
const block = (src, name) => src.slice(src.indexOf(`${name}:`), src.indexOf("\n}\n", src.indexOf(`${name}:`)));
const placeholders = (template) => new Set([...template.matchAll(/\{(\w+)(?::[^}]*)?\}/g)].map((m) => m[1]));
for (const m of block(issuesPy, "CODES").matchAll(/"([A-Z_]+)": \("(?:info|warning|error)", "((?:[^"\\]|\\.)*)"\)/g)) {
  const key = `code.${m[1]}`;
  requireKey("issues", key, "validation reason code");
  if (has("issues", key)) {
    const sent = placeholders(m[2]);
    for (const name of argNames(catalog.en.issues[key], key)) if (!sent.has(name)) fail(`issues:${key} uses {${name}} which the sidecar never sends`);
  }
}
const validatePy = py("chem/validate.py");
for (const m of block(issuesPy, "FIX_DESCRIPTIONS").matchAll(/"(\w+)": "((?:[^"\\]|\\.)*)"/g)) {
  const key = `fix.${m[1]}`;
  requireKey("issues", key, "repair operation");
  if (has("issues", key)) {
    const sent = placeholders(m[2]);
    for (const name of argNames(catalog.en.issues[key], key)) if (!sent.has(name)) fail(`issues:${key} uses {${name}} which the sidecar never sends`);
  }
}
if (!validatePy.includes('"params": display_params(describe)')) fail("chem/validate.py no longer sends display params with fixes");

// Report labels are sent raw to the sidecar (chem/report.py substitutes {version}, {shown}, {total}).
const reportKeys = [...block(py("chem/report.py"), "DEFAULTS").matchAll(/^\s+"(\w+)": "/gm)].map((m) => m[1]);
for (const k of reportKeys) requireKey("common", `report.${k}`, "report label in chem/report.py");
for (const key of Object.keys(catalog.en.common).filter((k) => k.startsWith("report."))) {
  if (!reportKeys.includes(key.slice("report.".length))) fail(`common:${key} is not a label in chem/report.py DEFAULTS`);
  for (const lng of LOCALES) {
    const extra = [...argNames(catalog[lng].common[key], key)].filter((n) => !["version", "shown", "total"].includes(n));
    if (extra.length || /\{\s*\w+\s*,/.test(catalog[lng].common[key])) fail(`${lng}/common:${key}: report labels may only use {version}, {shown}, {total}`);
  }
}
for (const m of py("data/categorize.py").matchAll(/Category\("([a-z-]+)"/g)) requireKey("common", `library.category.${m[1]}`, "library category");
const pka = py("chem/pka.py");
for (const m of block(pka, "GROUP_IDS").matchAll(/: "(\w+)",/g)) requireKey("common", `pka.${m[1]}`, "pKa group");
for (const kind of ["acid", "base"]) requireKey("common", `pka.kind.${kind}`, "pKa kind");

const stagesIn = (files) => {
  const out = new Set();
  for (const f of files) {
    const src = py(f);
    for (const m of src.matchAll(/ctx\.progress\([^,]+,\s*"([a-z0-9-]+)"/g)) out.add(m[1]);
    for (const m of src.matchAll(/stage="([a-z0-9-]+)"/g)) out.add(m[1]);
    for (const m of src.matchAll(/"stage": "([a-z0-9-]+)"/g)) out.add(m[1]);
  }
  return out;
};
const simFiles = readdirSync(join(repo, "compute/mfcompute/sim")).filter((f) => f.endsWith(".py")).map((f) => `sim/${f}`);
for (const s of stagesIn([...simFiles, "chem/geometry.py", "handlers.py"])) requireKey("common", `simulate.stage.${s}`, "job progress stage");
for (const s of stagesIn(["chem/geometry.py"])) requireKey("common", `repair.stage.${s}`, "repair stage");
for (const s of stagesIn(["ai/assistant.py"])) requireKey("common", `assistant.stage.${s}`, "assistant stage");

const simulateView = readFileSync(join(ui, "src/features/simulate/SimulateView.tsx"), "utf8");
const groups = simulateView.slice(simulateView.indexOf("const GROUPS"), simulateView.indexOf("];", simulateView.indexOf("const GROUPS")));
for (const m of groups.matchAll(/id: "(\w+)"/g)) requireKey("common", `results.group.${m[1]}`, "result group");
for (const m of groups.matchAll(/keys: \[([^\]]*)\]/g)) for (const k of m[1].matchAll(/"(\w+)"/g)) requireKey("common", `prop.${k[1]}`, "property name");
const layout = readFileSync(join(ui, "src/features/periodic/layout.ts"), "utf8");
const heat = layout.slice(layout.indexOf("HEAT_PROPERTIES"), layout.indexOf("];", layout.indexOf("HEAT_PROPERTIES")));
for (const m of heat.matchAll(/"(\w+)"/g)) requireKey("common", `periodic.prop.${m[1]}`, "heat-map property");

// ---- 6: hard-coded JSX text ----------------------------------------------------------------
const ALLOWED_TEXT = new Set(["K", "°C", "°F", "Å", "kJ/mol", "eV", "kcal/mol", "MoleculeForge", "SMILES", "pKa", "logP"]);
for (const file of sources.filter((p) => p.endsWith(".tsx"))) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/>\s*([A-Za-z][A-Za-z ,.'!?:-]{2,})\s*</g)) {
    const s = m[1].trim();
    if (ALLOWED_TEXT.has(s) || !/[a-z]{2}/.test(s) || /^(Ctrl|Shift|Alt)( [A-Z0-9]+)+$/.test(s)) continue;
    fail(`${relative(ui, file)}: hard-coded text "${s}" (move it to the locale files)`);
  }
}

if (errors.length) {
  console.error(`i18n check failed with ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`i18n OK: ${total} keys × ${LOCALES.length} locales, ${used} static usages, all value families covered.`);
