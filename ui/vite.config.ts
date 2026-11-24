import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The page CSP. Desktop builds allow only the Tauri IPC origin; the loopback WebSocket used by the
 * dev/e2e bridge is added solely in development or when VITE_ENABLE_BRIDGE=1 (test builds), so
 * packaged builds can open no socket at all from the web view. MoleculeForge Lite (web trial and
 * Android) talks to nothing but its own origin: its engine is WebAssembly in a Web Worker, so it
 * needs 'wasm-unsafe-eval' (WebAssembly compilation only; JavaScript eval stays blocked).
 */
function contentSecurityPolicy(edition: "desktop" | "lite", bridge: boolean): Plugin {
  const connect = edition === "lite" ? "'self'" : bridge ? "'self' ipc: http://ipc.localhost ws://127.0.0.1:*" : "'self' ipc: http://ipc.localhost";
  const script = edition === "lite" ? "'self' 'wasm-unsafe-eval'" : "'self'";
  return {
    name: "moleculeforge-csp",
    transformIndexHtml: (html) => html.replace("%MF_CONNECT_SRC%", connect).replace("%MF_SCRIPT_SRC%", script),
  };
}

/** Data files the Lite engine fetches from its own origin: the element data and the prebuilt
 * library. Served in development, emitted into the build. (OpenChemLib's force-field tables are
 * emitted by Vite itself: the library references them relative to its own module.) */
const LITE_FILES: Record<string, string> = {
  "data/elements.json": here("../data/elements.json"),
  "data/molecules/library.json": here("../data/molecules/library.json"),
};

function liteAssets(): Plugin {
  return {
    name: "moleculeforge-lite-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/^\/+/, "");
        const file = LITE_FILES[path];
        if (!file) return next();
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(LITE_FILES)) this.emitFile({ type: "asset", fileName, source: readFileSync(source) });
    },
    transformIndexHtml: (html) => html.replace("<title>MoleculeForge</title>", "<title>MoleculeForge Lite</title>"),
  };
}

// The UI is always served from the bundle: no CDN, no remote assets (spec P3/X3).
export default defineConfig(({ mode, command }) => {
  const lite = mode === "lite";
  return {
    // Lite is served from a sub-path (GitHub Pages) or the Android asset loader: relative URLs.
    base: lite && command === "build" ? "./" : "/",
    plugins: [
      react(),
      contentSecurityPolicy(lite ? "lite" : "desktop", !lite && (mode !== "production" || process.env.VITE_ENABLE_BRIDGE === "1")),
      ...(lite ? [liteAssets()] : []),
    ],
    resolve: {
      alias: [
        // Desktop builds (and unit tests) get a stub, so the WebAssembly engine never enters them.
        ...(lite ? [] : [{ find: /^@\/lite\/transport$/, replacement: here("./src/lite/transport.desktop.ts") }]),
        { find: "@", replacement: here("./src") },
      ],
    },
    clearScreen: false,
    server: { host: "127.0.0.1", port: lite ? 5174 : 5173, strictPort: true },
    worker: { format: "es" },
    build: {
      target: "es2022",
      outDir: lite ? "dist-lite" : "dist",
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks: {
            three: ["three"],
            react: ["react", "react-dom"],
            i18n: ["i18next", "react-i18next", "i18next-icu", "intl-messageformat"],
          },
        },
      },
    },
    test: {
      // Test files live in ../tests/unit/ui (repository layout); resolve their bare imports from here.
      alias: { zod: here("./node_modules/zod") },
      // Transform (rather than externalise) the ICU stack so Node's CommonJS interop matches the app bundle.
      server: { deps: { inline: ["i18next-icu", "intl-messageformat"] } },
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.test.{ts,tsx}", "../tests/unit/ui/**/*.test.{ts,tsx}", "../tests/unit/lite/**/*.test.ts"],
      css: false,
    },
  };
}) as never;
