import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests run the real UI against the real compute sidecar through the dev bridge
 * (loopback WebSocket with a per-run token). The installed desktop app is exercised separately by
 * scripts/launch_check.py (cold start and the offline socket check over the whole process tree).
 */
// The config is evaluated by the runner and again by every worker: the runner's token and data
// directory reach the workers through the environment so the browser and the bridge agree.
const token = process.env.MF_E2E_TOKEN ?? `e2e-${Date.now().toString(36)}`;
// The browser preinstalled in the development container; CI sets PW_CHROMIUM="" to use Playwright's own.
const chromium = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";
const dataDir = process.env.MF_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "moleculeforge-e2e-"));
process.env.MF_E2E_TOKEN = token;
process.env.MF_E2E_DATA_DIR = dataDir;

export default defineConfig({
  testDir: "../tests/e2e",
  timeout: 40 * 60 * 1000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:5173/?bridgePort=8766&bridgeToken=${token}`,
    viewport: { width: 1440, height: 900 },
    trace: "off",
    launchOptions: chromium ? { executablePath: chromium } : {},
  },
  webServer: [
    {
      command: "node scripts/dev-bridge.mjs --port 8766",
      url: "http://127.0.0.1:8766/health",
      env: { BRIDGE_TOKEN: token, MF_DATA_DIR: dataDir },
      timeout: 120_000,
      reuseExistingServer: false,
    },
    { command: "pnpm dev", url: "http://127.0.0.1:5173", timeout: 120_000, reuseExistingServer: true },
  ],
});
