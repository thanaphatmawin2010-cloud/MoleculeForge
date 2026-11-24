import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests for MoleculeForge Lite (the web trial; the Android app wraps the same build).
 * They run the production build (`pnpm build:lite`) served under a sub-path, as GitHub Pages
 * serves it, so relative asset URLs, the Web Worker and the WebAssembly engine are all exercised.
 */
// The browser preinstalled in the development container; CI sets PW_CHROMIUM="" to use Playwright's own.
const chromium = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";
const port = Number(process.env.MF_LITE_PORT ?? 4175);

export default defineConfig({
  testDir: "../tests/e2e-lite",
  timeout: 10 * 60 * 1000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}/MoleculeForge/`,
    viewport: { width: 1440, height: 900 },
    trace: "off",
    launchOptions: chromium ? { executablePath: chromium } : {},
  },
  webServer: {
    command: `pnpm exec vite preview --mode lite --outDir dist-lite --base /MoleculeForge/ --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/MoleculeForge/`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
