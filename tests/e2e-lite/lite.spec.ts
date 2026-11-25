import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * MoleculeForge Lite (web trial / Android): the same journey as the desktop app on the in-browser
 * engine, the desktop-only features explained instead of failing, and nothing fetched from any
 * origin but the app's own.
 */

async function start(page: Page, locale: "en" | "th" = "en", theme: "light" | "dark" = "light"): Promise<string[]> {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("http://127.0.0.1:") && !url.startsWith("data:") && !url.startsWith("blob:")) foreign.push(url);
  });
  await page.addInitScript(([l, t]) => {
    try {
      localStorage.setItem("moleculeforge.onboarding", "done");
      localStorage.setItem("moleculeforge.locale", l);
      localStorage.setItem("moleculeforge.theme", t);
    } catch {
      /* storage unavailable: defaults apply */
    }
  }, [locale, theme] as const);
  await page.goto("");
  await expect(page.getByTestId("engine-status")).toHaveClass(/success/, { timeout: 120_000 });
  return foreign;
}

async function drawWater(page: Page): Promise<void> {
  const canvas = page.getByTestId("sketch-2d");
  const box = (await canvas.boundingBox())!;
  const o = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.45 };
  await page.keyboard.press("o");
  await page.mouse.click(o.x, o.y);
  await page.keyboard.press("h");
  for (const [dx, dy] of [[70, 0], [-45, 55]] as const) {
    await page.mouse.move(o.x, o.y);
    await page.mouse.down();
    await page.mouse.move(o.x + dx / 2, o.y + dy / 2, { steps: 4 });
    await page.mouse.move(o.x + dx, o.y + dy, { steps: 4 });
    await page.mouse.up();
  }
}

test("the trial journey runs on the in-browser engine", async ({ page }) => {
  const foreign = await start(page);
  await expect(page.getByTestId("engine-status")).toHaveText(/runs on this device/);
  await expect(page.getByTestId("trial-banner")).toBeVisible();

  // Build water; every bond is validated live by the WebAssembly engine.
  await drawWater(page);
  await expect(page.getByText("Bond connected correctly.").first()).toBeVisible();
  await expect(page.getByTestId("formula")).toHaveText("H2O");

  // One-click repair produces a report (Markdown export only).
  await page.getByTestId("repair-button").click();
  const report = page.getByTestId("repair-report");
  await expect(report).toBeVisible({ timeout: 120_000 });
  await expect(report).toHaveAttribute("data-status", /repaired|already-optimal/);
  await expect(page.getByRole("button", { name: "Export PDF" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export Markdown" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // Properties: descriptors, MMFF94 geometry and shape; quantum levels point to the desktop app.
  await page.keyboard.press("Control+4");
  await expect(page.getByTestId("desktop-only-quantum")).toBeVisible();
  await page.getByRole("button", { name: "Run" }).click();
  const mw = page.getByTestId("prop-molecularWeight");
  await expect(mw).toContainText("18.015", { timeout: 120_000 });
  await expect(page.getByTestId("prop-sasa")).toContainText("Å²");
  await expect(page.getByTestId("simulation-warnings")).toContainText("MoleculeForge Lite");

  // Molecular dynamics and docking are explained, with no Run button.
  await page.getByRole("radio", { name: "Dynamics" }).click();
  await expect(page.getByTestId("desktop-only-md")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run" })).toHaveCount(0);
  await page.getByRole("radio", { name: "Dock" }).click();
  await expect(page.getByTestId("desktop-only-dock")).toBeVisible();

  // Minimise with MMFF94 in the browser; xtb is listed but disabled.
  await page.getByRole("radio", { name: "Minimise" }).click();
  await expect(page.locator('option[value="GFN2-xTB"]')).toBeDisabled();
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByText("OpenChemLib · MMFF94").first()).toBeVisible({ timeout: 120_000 });

  // Save to the library (IndexedDB) and find it again after a reload.
  await page.keyboard.press("Control+1");
  await page.getByRole("button", { name: "Save to library" }).click();
  await expect(page.getByText(/Saved to the library|Already in the library/).first()).toBeVisible();

  // The assistant explains where it lives.
  await page.keyboard.press("Control+j");
  await expect(page.getByTestId("desktop-only-assistant")).toBeVisible();
  await expect(page.getByTestId("assistant-input")).toHaveCount(0);

  // Switch language at runtime.
  await page.getByTestId("language-menu").click();
  await page.getByTestId("language-th").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  await expect(page.getByTestId("engine-status")).toHaveText(/ทำงานบนอุปกรณ์นี้/);

  expect(foreign).toEqual([]);
});

test("library: 187 prebuilt molecules, sorting, and a saved molecule survives a reload", async ({ page }) => {
  await start(page);
  await page.keyboard.press("Control+3");
  await expect(page.getByText("187 results")).toBeVisible();
  const first = page.locator('[data-testid^="library-card-"]').first();
  await page.getByTestId("library-sort").click();
  await page.getByRole("option", { name: "Molecular weight" }).click();
  await expect(first).toContainText("Hydrogen");

  // Open a SMILES file (a molecule that is not prebuilt), save it, reload: it is still in "Mine".
  await page.keyboard.press("Control+1");
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+o");
  await (await chooser).setFiles({ name: "neopentyl-alcohol.smi", mimeType: "text/plain", buffer: Buffer.from("CC(C)(C)CO neopentyl alcohol\n") });
  await expect(page.getByTestId("formula")).toHaveText("C5H12O");
  await page.getByRole("button", { name: "Save to library" }).click();
  await expect(page.getByText("Saved to the library").first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("engine-status")).toHaveClass(/success/, { timeout: 120_000 });
  await page.keyboard.press("Control+3");
  await page.getByRole("radio", { name: "Mine" }).click();
  await expect(page.locator('[data-testid^="library-card-"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="library-card-"]').first()).toContainText("neopentyl alcohol");
});

test("installable, and works offline after the first visit", async ({ page, context }) => {
  await start(page);
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
    return (await fetch(link.href)).json() as Promise<{ display: string; icons: { purpose?: string }[] }>;
  });
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((icon) => icon.purpose ?? "any")).toContain("maskable");

  // The service worker caches the whole app; then the page reloads with the network off.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const cached = () => page.evaluate(async () => {
    const keys = await caches.keys();
    return keys.length ? (await (await caches.open(keys[0]!)).keys()).length : 0;
  });
  await expect.poll(cached, { timeout: 120_000 }).toBeGreaterThan(30);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("engine-status")).toHaveClass(/success/, { timeout: 120_000 });
  expect(await page.evaluate(() => fetch("data/not-cached.json").then(() => "network", () => "offline"))).toBe("offline");
  await page.getByTestId("template-benzene").click();
  await expect(page.getByTestId("formula")).toHaveText("C6H6");
  await page.keyboard.press("Control+4");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByTestId("prop-molecularWeight")).toContainText("78.11", { timeout: 120_000 });
  await context.setOffline(false);
});

test("About shows every bundled licence, RDKit's included", async ({ page }) => {
  await start(page);
  await page.getByTestId("about-lite").click();
  await expect(page.getByTestId("about-lite-dialog")).toBeVisible();
  await page.getByTestId("show-licences").click();
  const text = page.getByTestId("licences-text");
  await expect(text).toContainText("@rdkit/rdkit 2026.9.2 (BSD-3-Clause)");
  await expect(text).toContainText("Rational Discovery LLC");
  await expect(text).toContainText("openchemlib");
  await expect(text).toContainText("androidx.webkit:webkit");
});

test("periodic table: all 118 elements with details", async ({ page }) => {
  await start(page);
  await page.keyboard.press("Control+2");
  await expect(page.locator('[data-testid^="element-tile-"]')).toHaveCount(118);
  await page.getByTestId("element-tile-Fe").click();
  const detail = page.getByTestId("element-detail");
  await expect(detail.getByRole("heading", { name: "Iron" })).toBeVisible();
  await expect(detail).toContainText("55.845");
});

for (const [theme, locale] of [["light", "en"], ["dark", "th"]] as const) {
  test(`main views pass an accessibility scan (${theme}, ${locale})`, async ({ page }) => {
    await start(page, locale, theme);
    const scan = async (name: string) => {
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious.map((v) => `${name}: ${v.id} (${v.nodes.length})`)).toEqual([]);
    };
    for (const [shortcut, name] of [["Control+1", "build"], ["Control+2", "elements"], ["Control+3", "library"], ["Control+4", "simulate"]] as const) {
      await page.keyboard.press(shortcut);
      await page.waitForTimeout(800);
      await scan(name);
    }
    await page.keyboard.press("Control+j");
    await expect(page.getByTestId("assistant-panel")).toHaveCSS("opacity", "1");
    await page.waitForTimeout(300);
    await scan("assistant");
  });
}
