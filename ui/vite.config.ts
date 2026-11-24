import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The page CSP allows only the Tauri IPC origin. The loopback WebSocket used by the dev/e2e
 * bridge is added solely in development or when VITE_ENABLE_BRIDGE=1 (test builds), so packaged
 * builds can open no socket at all from the web view.
 */
function contentSecurityPolicy(bridge: boolean): Plugin {
  return {
    name: "moleculeforge-csp",
    transformIndexHtml: (html) =>
      html.replace("%MF_CONNECT_SRC%", bridge ? "'self' ipc: http://ipc.localhost ws://127.0.0.1:*" : "'self' ipc: http://ipc.localhost"),
  };
}

// The UI is always served from the bundle: no CDN, no remote assets (spec P3/X3).
export default defineConfig(({ mode }) => ({
  plugins: [react(), contentSecurityPolicy(mode !== "production" || process.env.VITE_ENABLE_BRIDGE === "1")],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    target: "es2022",
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
    alias: { zod: fileURLToPath(new URL("./node_modules/zod", import.meta.url)) },
    // Transform (rather than externalise) the ICU stack so Node's CommonJS interop matches the app bundle.
    server: { deps: { inline: ["i18next-icu", "intl-messageformat"] } },
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "../tests/unit/ui/**/*.test.{ts,tsx}", "../tests/unit/lite/**/*.test.ts"],
    css: false,
  },
}) as never);
