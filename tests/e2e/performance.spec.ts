import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

/**
 * §10 performance, measured in the real UI against the real compute sidecar. The measured values
 * are written to test-results/performance.json; the assertions are floors that also hold with
 * software rendering on a CPU-only machine (GPU numbers depend on the user's hardware).
 */

const results: Record<string, unknown> = {};
const RESULTS = join("test-results", "performance.json");

// Merged into the file after every test: Playwright starts a new worker after a failure, and the
// measurements of earlier tests must survive that. (Playwright empties test-results/ per run.)
test.afterEach(() => {
  mkdirSync("test-results", { recursive: true });
  const previous = existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(RESULTS, JSON.stringify({ ...previous, ...results }, null, 2) + "\n");
});

async function start(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("moleculeforge.onboarding", "done");
      localStorage.setItem("moleculeforge.locale", "en");
      localStorage.setItem("moleculeforge.theme", "light");
    } catch {
      /* storage unavailable: defaults apply */
    }
  });
  await page.goto("");
  await expect(page.getByTestId("engine-status")).toHaveClass(/success/, { timeout: 120_000 });
}

/** A box of water molecules as PDB text (O–H 0.9572 Å, H–O–H 104.52°, 3.1 Å grid). */
function waterBox(count: number): string {
  const lines: string[] = [];
  const side = Math.ceil(Math.cbrt(count));
  const angle = (104.52 * Math.PI) / 180;
  const fmt = (v: number) => v.toFixed(3).padStart(8);
  let serial = 0;
  const conect: string[] = [];
  for (let n = 0; n < count; n++) {
    const [x, y, z] = [(n % side) * 3.1, (Math.floor(n / side) % side) * 3.1, Math.floor(n / side / side) * 3.1];
    const atoms: [string, string, number, number, number][] = [
      [" O  ", "O", x, y, z],
      [" H1 ", "H", x + 0.9572, y, z],
      [" H2 ", "H", x + 0.9572 * Math.cos(angle), y + 0.9572 * Math.sin(angle), z],
    ];
    const first = serial + 1;
    for (const [name, el, ax, ay, az] of atoms) {
      serial += 1;
      lines.push(`HETATM${String(serial).padStart(5)} ${name} HOH A${String(n + 1).padStart(4)}    ${fmt(ax)}${fmt(ay)}${fmt(az)}  1.00  0.00          ${el.padStart(2)}`);
    }
    conect.push(`CONECT${String(first).padStart(5)}${String(first + 1).padStart(5)}${String(first + 2).padStart(5)}`);
  }
  return [...lines, ...conect, "END", ""].join("\n");
}

/** Median and worst frame intervals (ms) of requestAnimationFrame over `run`. */
async function frameTimes(page: Page, run: () => Promise<void>): Promise<{ median: number; p95: number; max: number; frames: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { mfFrames: number[]; mfFramesOn: boolean };
    w.mfFrames = [];
    w.mfFramesOn = true;
    let last = performance.now();
    const tick = (t: number) => {
      w.mfFrames.push(t - last);
      last = t;
      if (w.mfFramesOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await run();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { mfFrames: number[]; mfFramesOn: boolean };
    w.mfFramesOn = false;
    return w.mfFrames.slice(2);
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0, frames: frames.length };
}

/** Open a water box, then measure frame times while orbiting the 3D view for four seconds. */
async function orbit(page: Page, waters: number): Promise<number> {
  await start(page);
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+o");
  await (await chooser).setFiles({ name: `water-${waters}.pdb`, mimeType: "chemical/x-pdb", buffer: Buffer.from(waterBox(waters)) });
  await expect(page.getByTestId("formula")).toHaveText(`H${waters * 2}O${waters}`, { timeout: 300_000 });
  await page.waitForTimeout(3000);
  const viewer = page.getByTestId("viewer-3d");
  const box = (await viewer.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const timing = await frameTimes(page, async () => {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    const end = Date.now() + 4000;
    for (let i = 0; Date.now() < end; i++) {
      await page.mouse.move(centre.x + 120 * Math.cos(i / 12), centre.y + 70 * Math.sin(i / 12));
      await page.waitForTimeout(8);
    }
    await page.mouse.up();
  });
  results[`orbit${waters * 3}Atoms`] = { atoms: waters * 3, medianFrameMs: timing.median, fps: 1000 / timing.median, p95FrameMs: timing.p95, frames: timing.frames };
  return 1000 / timing.median;
}

// Floors for software rendering on a CPU-only machine; the §10 target (~60 fps at ~5,000 atoms)
// needs a GPU, and the measured values are reported in BUILD_LOG.md.
test("3D view frame rate while orbiting 501 atoms", async ({ page }) => {
  expect(await orbit(page, 167)).toBeGreaterThan(10);
});

test("3D view frame rate while orbiting 5,001 atoms", async ({ page }) => {
  expect(await orbit(page, 1667)).toBeGreaterThan(2);
});

test("drawing a 50-atom chain never blocks the UI", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const w = window as unknown as { mfLong: number[] };
    w.mfLong = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.mfLong.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
  });
  const sketch = page.getByTestId("sketch-2d");
  const box = (await sketch.boundingBox())!;
  const centreOf = async (index: number) => {
    const atom = page.getByTestId(`atom-2d-${index}`);
    await expect(atom).toBeAttached();
    const b = (await atom.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  // Zoom the sketch out so a 50-atom zigzag fits beside the 3D view.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 200);
  await page.waitForTimeout(300);
  await page.keyboard.press("c");
  const started = Date.now();
  await page.mouse.click(box.x + 50, box.y + 60);
  // Grow a zigzag chain row by row, always dragging from the atom just added.
  let direction = 1;
  for (let k = 1; k < 50; k++) {
    const from = await centreOf(k - 1);
    let to = { x: from.x + direction * 30, y: from.y + (k % 2 === 0 ? -16 : 16) };
    if (to.x > box.x + box.width - 40 || to.x < box.x + 40) {
      direction = -direction;
      to = { x: from.x, y: from.y + 34 };
    }
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 3 });
    await page.mouse.up();
    await expect(page.getByTestId(`atom-2d-${k}`)).toBeAttached();
  }
  await expect(page.getByTestId("formula")).toHaveText("C50H102", { timeout: 120_000 });
  const elapsed = Date.now() - started;
  const long = await page.evaluate(() => (window as unknown as { mfLong: number[] }).mfLong);
  results.build50Atoms = { edits: 49, totalMs: elapsed, longTasks: long.length, longestTaskMs: Math.max(0, ...long) };
  expect(Math.max(0, ...long)).toBeLessThan(500);
});

test("the UI keeps rendering while a simulation runs", async ({ page }) => {
  await start(page);
  await page.getByTestId("template-benzene").click();
  await expect(page.getByTestId("formula")).toHaveText("C6H6");
  await page.keyboard.press("Control+4");
  await page.getByRole("radio", { name: "Standard" }).click();
  await page.getByRole("button", { name: "Run" }).click();
  const busy = await frameTimes(page, async () => {
    await page.waitForTimeout(5000);
  });
  results.framesDuringSimulation = { medianFrameMs: busy.median, worstFrameMs: busy.max, frames: busy.frames };
  await expect(page.getByTestId("prop-molecularWeight")).toContainText("78.11", { timeout: 600_000 });
  expect(busy.max).toBeLessThan(250);
});
