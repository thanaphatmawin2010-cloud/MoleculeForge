/**
 * Validation reason codes with English explanations: a port of compute/mfcompute/chem/issues.py.
 * The UI localises the codes itself, so codes and parameter names must match the desktop engine.
 */
import type { Issue } from "@/ipc/schema";

export const CODES: Record<string, [Issue["severity"], string]> = {
  VALID: ["info", "Bond connected correctly."],
  UNKNOWN_ELEMENT: ["error", "'{element}' is not an element symbol."],
  SELF_BOND: ["error", "Atom {atom} is bonded to itself."],
  DUPLICATE_BOND: ["error", "Atoms {a} and {b} are bonded twice."],
  ISOTOPE_UNKNOWN: ["error", "Mass number {isotope} is not a known isotope of {element}."],
  VALENCE_EXCEEDED: ["error", "{element} atom {atom} has {valence} bonds; at most {allowed} are allowed with charge {charge}."],
  AROMATIC_INVALID: ["error", "The ring containing atoms {atomList} cannot be aromatic as drawn (no valid Kekulé structure)."],
  UNDERSATURATED: ["error", "{element} atom {atom} has an unpaired electron (radical); hydrogen count is too low."],
  RADICAL: ["warning", "{element} atom {atom} carries {radicals} unpaired electron(s)."],
  HYPERVALENT: ["info", "{element} atom {atom} uses an expanded valence ({valence}); this is allowed for period-3+ elements."],
  CHARGE_UNUSUAL: ["warning", "{element} atom {atom} has an unusual formal charge of {charge}."],
  FRAGMENTS: ["info", "The structure has {count} disconnected fragments."],
  ATOMS_OVERLAP: ["error", "Atoms {a} and {b} occupy the same position ({distance} Å apart)."],
  CLASH: ["error", "Non-bonded atoms {a} and {b} are only {distance} Å apart (minimum {limit} Å)."],
  BOND_TOO_LONG: ["warning", "Bond {a}–{b} is {length} Å; expected about {expected} Å."],
  BOND_TOO_SHORT: ["warning", "Bond {a}–{b} is {length} Å; expected about {expected} Å."],
  EMPTY: ["info", "The canvas is empty."],
};

export const FIX_DESCRIPTIONS: Record<string, string> = {
  removeBond: "Removed bond {a}–{b}.",
  removeAtom: "Removed hydrogen atom {atom} to free a valence.",
  setBondOrder: "Changed bond {a}–{b} from {from} to {to}.",
  setCharge: "Set formal charge of {element} atom {atom} to {charge:+d}.",
  setHCount: "Set hydrogen count of {element} atom {atom} to {hCount}.",
  kekulize: "Assigned a valid Kekulé structure to atoms {atoms}.",
  clearIsotope: "Cleared invalid isotope on atom {atom}.",
  moveAtom: "Moved atom {atom} to a bond length of {length} Å.",
};

const DISPLAY_INDEX_KEYS = new Set(["atom", "a", "b"]);

export type Params = Record<string, unknown>;

/** Atom numbers shown to people are 1-based, matching the editor labels. */
export function displayParams(params: Params): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(params)) out[k] = DISPLAY_INDEX_KEYS.has(k) && Number.isInteger(v) ? (v as number) + 1 : v;
  return out;
}

/** Parameters the desktop engine holds as Python floats (printed as "1.0", never "1"). */
const FLOAT_KEYS = new Set(["distance", "length", "expected", "limit"]);

/** Python str() of a value: floats keep a decimal point, None/True/False as Python prints them. */
export function pyStr(value: unknown, key = ""): string {
  if (typeof value === "number") return FLOAT_KEYS.has(key) && Number.isInteger(value) ? `${value}.0` : String(value);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** str.format with named fields and the one spec the templates use ({charge:+d}). */
export function format(template: string, params: Params): string {
  let failed = false;
  const text = template.replace(/\{(\w+)(?::([^}]*))?\}/g, (_, key: string, spec?: string) => {
    if (!(key in params)) {
      failed = true;
      return "";
    }
    const value = params[key];
    if (spec === "+d") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        failed = true;
        return "";
      }
      return value >= 0 ? `+${value}` : String(value);
    }
    return pyStr(value, key);
  });
  return failed ? template : text;
}

export function makeIssue(code: string, options: { atoms?: number[]; bonds?: number[] } = {}, params: Params = {}): Issue {
  const [severity, template] = CODES[code]!;
  const shown = displayParams(params);
  return { code, severity, message: format(template, shown), atoms: options.atoms ?? [], bonds: options.bonds ?? [], params: shown };
}

export function describeFix(op: string, params: Params): string {
  const template = FIX_DESCRIPTIONS[op] ?? op;
  return format(template, displayParams(params));
}
