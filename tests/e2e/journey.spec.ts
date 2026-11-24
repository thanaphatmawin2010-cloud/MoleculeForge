import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/** §9.4: build water from blank → validate → repair → simulate → read the dashboard → save to the
 * library → switch language → ask the assistant to explain the result and confirm it used tools. */

async function start(page: Page, theme: "light" | "dark" = "light", locale: "en" | "th" = "en"): Promise<void> {
  await page.addInitScript(([t, l]) => {
    try {
      localStorage.setItem("moleculeforge.onboarding", "done");
      localStorage.setItem("moleculeforge.locale", l);
      localStorage.setItem("moleculeforge.theme", t);
    } catch {
      /* storage unavailable: defaults apply */
    }
  }, [theme, locale] as const);
  await page.goto("");
  await expect(page.getByTestId("engine-status")).toHaveClass(/success/, { timeout: 120_000 });
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

test("the full journey", async ({ page }) => {
  await start(page);

  // Build water from a blank canvas; every bond is validated live.
  await drawWater(page);
  await expect(page.getByText("Bond connected correctly.").first()).toBeVisible();
  await expect(page.getByTestId("formula")).toHaveText("H2O");

  // One-click repair produces a report.
  await page.getByTestId("repair-button").click();
  const report = page.getByTestId("repair-report");
  await expect(report).toBeVisible({ timeout: 180_000 });
  await expect(report).toHaveAttribute("data-status", /repaired|already-optimal/);
  await page.getByRole("button", { name: "Done" }).click();

  // Simulate and read the dashboard.
  await page.keyboard.press("Control+4");
  await page.getByRole("radio", { name: "Fast" }).click();
  await page.getByRole("button", { name: "Run" }).click();
  const mw = page.getByTestId("prop-molecularWeight");
  await expect(mw).toContainText("18.015", { timeout: 300_000 });
  await expect(mw).toContainText("g/mol");
  await expect(page.getByTestId("prop-dipoleMoment")).toContainText("D");

  // Save to the library.
  await page.keyboard.press("Control+1");
  await page.getByRole("button", { name: "Save to library" }).click();
  await expect(page.getByText(/Saved to the library|Already in the library/).first()).toBeVisible();

  // Switch language at runtime.
  await page.getByTestId("language-menu").click();
  await page.getByTestId("language-th").click();
  await expect(page.getByText("ข้อมูลโมเลกุล").or(page.getByText("ชื่อ")).first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "th");

  // Ask the local assistant; it must call the real tools.
  await page.keyboard.press("Control+j");
  const input = page.getByTestId("assistant-input");
  await input.fill("Explain the computed dipole moment and molecular weight of this molecule.");
  await input.press("Enter");
  const answer = page.getByTestId("assistant-answer").last();
  await expect(answer).toHaveAttribute("data-confidence", /high|medium|low/, { timeout: 30 * 60_000 });
  const toolCalls = page.getByTestId("assistant-tool-call");
  await expect(toolCalls.first()).toBeVisible();
  const names = await toolCalls.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-tool")));
  expect(names.every((n) => ["sanitize", "validateBonds", "repairGeometry", "descriptors", "simulate", "dock", "getElement", "lookupMolecule"].includes(n ?? ""))).toBe(true);
});

test("a ring template dragged onto the sketch is inserted where it is dropped", async ({ page }) => {
  await start(page);
  const sketch = page.getByTestId("sketch-2d");
  await page.getByTestId("template-benzene").dragTo(sketch, { targetPosition: { x: 180, y: 140 } });
  await expect(page.getByTestId("formula")).toHaveText("C6H6");
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("formula")).not.toHaveText("C6H6");
});

test("periodic table: all elements, search, detail with units, heat map and trends", async ({ page }) => {
  await start(page);
  await page.keyboard.press("Control+2");
  await expect(page.locator('[data-testid^="element-tile-"]')).toHaveCount(118);
  // Search by name dims every other element.
  await page.getByTestId("periodic-search").fill("iron");
  await expect(page.getByTestId("element-tile-Fe")).not.toHaveClass(/opacity-25/);
  await expect(page.getByTestId("element-tile-Cu")).toHaveClass(/opacity-25/);
  await page.getByTestId("periodic-search").fill("");
  // Detail panel: name, unit-labelled values, configuration, isotopes and trends.
  await page.getByTestId("element-tile-Fe").click();
  const detail = page.getByTestId("element-detail");
  await expect(detail.getByRole("heading", { name: "Iron" })).toBeVisible();
  await expect(detail).toContainText("55.845");
  await expect(detail).toContainText("Electron configuration");
  await expect(detail).toContainText(/Isotopes \(\d+\)/);
  await expect(detail).toContainText("Trends");
  await expect(detail).toContainText("across period 4");
  // Heat map by property colours every tile with data.
  await page.getByRole("radio", { name: "Property" }).click();
  await expect(page.getByTestId("heat-property")).toBeVisible();
  const styled = await page.locator('[data-testid^="element-tile-"]').evaluateAll((tiles) => tiles.filter((t) => (t as HTMLElement).style.backgroundColor !== "").length);
  expect(styled).toBeGreaterThan(80);
});

for (const [theme, locale] of [["light", "en"], ["dark", "en"], ["light", "th"]] as const) {
  test(`every main view passes an accessibility scan (${theme}, ${locale})`, async ({ page }) => {
    await start(page, theme, locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
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
    // Overlays: element detail, command palette, assistant.
    await page.keyboard.press("Control+2");
    await page.getByTestId("element-tile-Fe").click();
    await page.waitForTimeout(800);
    await scan("element detail");
    await page.keyboard.press("Control+1");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(600);
    await scan("command palette");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+j");
    // Scan once the panel has finished sliding in (mid-animation opacity would distort contrast).
    await expect(page.getByTestId("assistant-panel")).toHaveCSS("opacity", "1");
    await page.waitForTimeout(300);
    await scan("assistant");
  });
}
