/** Element presentation helpers (family colour tokens, 2D ink classes). */

export const FAMILY_CLASS: Record<string, { tile: string; ink: string; dot: string }> = {
  "alkali-metal": { tile: "bg-fam-alkali", ink: "text-fam-alkali-ink", dot: "bg-fam-alkali-ink" },
  "alkaline-earth-metal": { tile: "bg-fam-alkaline", ink: "text-fam-alkaline-ink", dot: "bg-fam-alkaline-ink" },
  "transition-metal": { tile: "bg-fam-transition", ink: "text-fam-transition-ink", dot: "bg-fam-transition-ink" },
  "post-transition-metal": { tile: "bg-fam-post", ink: "text-fam-post-ink", dot: "bg-fam-post-ink" },
  metalloid: { tile: "bg-fam-metalloid", ink: "text-fam-metalloid-ink", dot: "bg-fam-metalloid-ink" },
  nonmetal: { tile: "bg-fam-nonmetal", ink: "text-fam-nonmetal-ink", dot: "bg-fam-nonmetal-ink" },
  halogen: { tile: "bg-fam-halogen", ink: "text-fam-halogen-ink", dot: "bg-fam-halogen-ink" },
  "noble-gas": { tile: "bg-fam-noble", ink: "text-fam-noble-ink", dot: "bg-fam-noble-ink" },
  lanthanide: { tile: "bg-fam-lanthanide", ink: "text-fam-lanthanide-ink", dot: "bg-fam-lanthanide-ink" },
  actinide: { tile: "bg-fam-actinide", ink: "text-fam-actinide-ink", dot: "bg-fam-actinide-ink" },
  unknown: { tile: "bg-fam-unknown", ink: "text-fam-unknown-ink", dot: "bg-fam-unknown-ink" },
};

export const familyClass = (category: string) => FAMILY_CLASS[category] ?? FAMILY_CLASS.unknown!;

/** Molecule-library family → same colour language as the periodic table blocks. */
export const LIBRARY_FAMILY: Record<string, keyof typeof FAMILY_CLASS> = {
  "s-block": "alkaline-earth-metal",
  "p-block": "nonmetal",
  "d-block": "transition-metal",
  "f-block": "lanthanide",
};

const HALOGENS = new Set(["F", "Cl"]);
const METALS = new Set([
  "Li", "Be", "Na", "Mg", "Al", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Rb", "Sr", "Y",
  "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Cs", "Ba", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au",
  "Hg", "Tl", "Pb", "Bi", "U", "Th",
]);

/** Tailwind fill/text class for an element label in 2D drawings. */
export function elementInk(el: string): string {
  if (el === "O") return "fill-el-o text-el-o";
  if (el === "N") return "fill-el-n text-el-n";
  if (el === "S" || el === "Se") return "fill-el-s text-el-s";
  if (el === "P") return "fill-el-p text-el-p";
  if (HALOGENS.has(el)) return "fill-el-hal text-el-hal";
  if (el === "Br") return "fill-el-br text-el-br";
  if (el === "I") return "fill-el-i text-el-i";
  if (METALS.has(el)) return "fill-el-metal text-el-metal";
  return "fill-el-c text-el-c";
}

export const QUICK_ELEMENTS = ["C", "H", "N", "O", "S", "P", "F", "Cl", "Br", "I"] as const;

/** Keyboard shortcuts for element selection in the editor. */
export const ELEMENT_KEYS: Record<string, string> = {
  c: "C", h: "H", n: "N", o: "O", s: "S", p: "P", f: "F", l: "Cl", b: "Br", i: "I",
};

/** Jmol/CPK fallback colours when element data has not loaded yet. */
export const CPK_FALLBACK: Record<string, string> = {
  H: "#ffffff", C: "#909090", N: "#3050f8", O: "#ff0d0d", F: "#90e050", Cl: "#1ff01f", Br: "#a62929", I: "#940094",
  S: "#ffff30", P: "#ff8000", B: "#ffb5b5", Na: "#ab5cf2", K: "#8f40d4", Mg: "#8aff00", Ca: "#3dff00", Fe: "#e06633",
};
