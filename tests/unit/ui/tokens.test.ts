import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** WCAG 2.1 contrast of the design tokens, computed from tokens.css itself. */
const css = readFileSync(resolve(__dirname, "../../../ui/src/design-system/tokens.css"), "utf8");

function block(selector: RegExp): Record<string, [number, number, number]> {
  const start = css.search(selector);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const out: Record<string, [number, number, number]> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)) out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}

function luminance([h, s, l]: [number, number, number]): number {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(8) + 0.0722 * f(4);
}

const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe.each([
  ["light", block(/:root\s*\{/)],
  ["dark", block(/\[data-theme="dark"\]/)],
])("%s theme tokens", (_name, t) => {
  it("defines every core token", () => {
    for (const key of ["bg", "surface-1", "ink", "ink-2", "ink-3", "accent", "success", "warning", "danger", "info"]) expect(t[key]).toBeDefined();
  });

  it("meets WCAG AA for body text and secondary text", () => {
    expect(contrast(t.ink!, t.bg!)).toBeGreaterThanOrEqual(7);
    expect(contrast(t["ink-2"]!, t["surface-1"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["ink-3"]!, t.bg!)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps status colours readable on surfaces", () => {
    for (const key of ["accent", "danger", "success", "info"]) expect(contrast(t[key]!, t["surface-1"]!)).toBeGreaterThanOrEqual(3);
  });
});
