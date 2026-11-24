import AxeBuilder from "@axe-core/playwright";
import { expect, type CDPSession, type Page, test } from "@playwright/test";

/**
 * MoleculeForge Lite on a phone (Pixel 7 emulation, the Android app's WebView renders the same
 * build): touch drawing, pinch zoom, the inspector sheet, and every view fitting the screen.
 */

type Point = [number, number];

async function start(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("moleculeforge.onboarding", "done");
      localStorage.setItem("moleculeforge.locale", "en");
    } catch {
      /* storage unavailable: defaults apply */
    }
  });
  await page.goto("");
  await expect(page.getByTestId("engine-status")).toHaveClass(/success/, { timeout: 120_000 });
}

/** Real touch input (Chrome turns it into pointer events with pointerType "touch"). */
function touchscreen(cdp: CDPSession) {
  const send = (type: "touchStart" | "touchMove" | "touchEnd", points: Point[]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  return {
    tap: async (p: Point) => {
      await send("touchStart", [p]);
      await send("touchEnd", []);
    },
    drag: async (from: Point, to: Point, steps = 8) => {
      await send("touchStart", [from]);
      for (let i = 1; i <= steps; i++) await send("touchMove", [[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]]);
      await send("touchEnd", []);
    },
    pinch: async (center: Point, fromGap: number, toGap: number, steps = 6) => {
      const at = (gap: number): Point[] => [[center[0] - gap / 2, center[1]], [center[0] + gap / 2, center[1]]];
      await send("touchStart", at(fromGap));
      for (let i = 1; i <= steps; i++) await send("touchMove", at(fromGap + ((toGap - fromGap) * i) / steps));
      await send("touchEnd", []);
    },
  };
}

const pageWidth = (page: Page) => page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth] as const);

test("touch drawing, pinch zoom and the inspector sheet", async ({ page, context }) => {
  await start(page);
  const touch = touchscreen(await context.newCDPSession(page));
  const [width, scrollWidth] = await pageWidth(page);
  expect(scrollWidth).toBe(width);

  // Draw water: tap O, tap the canvas, tap H, drag out from the oxygen twice.
  const box = (await page.getByTestId("sketch-2d").boundingBox())!;
  const o: Point = [box.x + box.width * 0.45, box.y + box.height * 0.45];
  await page.getByTestId("element-O").tap();
  await touch.tap(o);
  await page.getByTestId("element-H").tap();
  await touch.drag(o, [o[0] + 70, o[1]]);
  await touch.drag(o, [o[0] - 45, o[1] + 55]);
  await expect(page.getByTestId("phone-formula")).toHaveText("H2O");
  await expect(page.getByText("Bond connected correctly.").first()).toBeVisible();

  // Two fingers zoom the sketch; nothing is added or removed.
  await touch.pinch([box.x + box.width / 2, box.y + box.height / 2], 220, 120);
  await touch.pinch([box.x + box.width / 2, box.y + box.height / 2], 120, 260);
  await expect(page.getByTestId("phone-formula")).toHaveText("H2O");
  await page.waitForTimeout(500);
  await expect(page.getByTestId("phone-formula")).toHaveText("H2O");

  // The inspector opens as a bottom sheet and closes again.
  const inspector = page.getByTestId("inspector");
  await expect(inspector).toBeHidden();
  await page.getByTestId("inspector-toggle").tap();
  await expect(inspector).toBeVisible();
  await expect(inspector.getByTestId("formula")).toHaveText("H2O");
  await expect(inspector).toContainText("18.015");
  await page.getByTestId("inspector-close").tap();
  await expect(inspector).toBeHidden();

  // 2D and 3D are one pane at a time.
  await expect(page.getByRole("radio", { name: "Split view" })).toHaveCount(0);
});

test("every view fits the screen and properties run", async ({ page }) => {
  await start(page);
  await page.getByTestId("template-benzene").tap();
  await expect(page.getByTestId("phone-formula")).toHaveText("C6H6");
  for (const view of ["elements", "library", "simulate", "build"] as const) {
    await page.getByTestId(`nav-${view}`).tap();
    await page.waitForTimeout(600);
    const [width, scrollWidth] = await pageWidth(page);
    expect([view, scrollWidth]).toEqual([view, width]);
  }
  await page.getByTestId("nav-simulate").tap();
  await page.getByRole("button", { name: "Run" }).tap();
  await expect(page.getByTestId("prop-molecularWeight")).toContainText("78.11", { timeout: 120_000 });
  // The element detail and the assistant take the whole screen and close.
  await page.getByTestId("nav-elements").tap();
  await page.getByTestId("element-tile-Fe").tap();
  await expect(page.getByTestId("element-detail")).toBeInViewport();
  await page.getByTestId("element-detail").getByRole("button", { name: "Close" }).tap();
  await page.getByTestId("nav-assistant").tap();
  await expect(page.getByTestId("desktop-only-assistant")).toBeVisible();
});

test("phone views pass an accessibility scan", async ({ page }) => {
  await start(page);
  for (const view of ["build", "elements", "library", "simulate"] as const) {
    await page.getByTestId(`nav-${view}`).tap();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${view}: ${v.id} (${v.nodes.length})`)).toEqual([]);
  }
});
