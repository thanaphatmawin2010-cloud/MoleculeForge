/**
 * Which build is running. The desktop app (Tauri shell + Python compute sidecar) and MoleculeForge
 * Lite (the web trial and the Android app: the same screens over a WebAssembly engine in a Web
 * Worker, ui/src/lite) share every view; Lite explains what only the desktop engines can do.
 *
 * Both values are fixed at build time (`vite build --mode lite`), so desktop builds carry no Lite
 * code paths and vice versa.
 */
export const IS_LITE: boolean = import.meta.env.VITE_EDITION === "lite";

/** Where the trial points people for the full app; empty hides the link. Set by the Pages and
 * Android builds to the repository's latest release. */
export const DOWNLOAD_URL: string = typeof import.meta.env.VITE_DOWNLOAD_URL === "string" ? import.meta.env.VITE_DOWNLOAD_URL : "";

/** What only the desktop app can do, with the engine that does it there. */
export const DESKTOP_FEATURES = ["md", "dock", "quantum", "assistant", "pdf", "formats"] as const;
export type DesktopFeature = (typeof DESKTOP_FEATURES)[number];
