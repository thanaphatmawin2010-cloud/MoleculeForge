/**
 * Loaded as its own entry script before the app so that even a failure while the app's modules
 * load (a syntax or runtime error in a dependency) shows a readable message, never a blank window.
 */
declare global {
  interface Window {
    mfShowFatal?: (error: unknown) => void;
  }
}

/** Last-resort screen for failures before React is running (never leave the window blank). */
export function showFatal(error: unknown): void {
  const root = document.getElementById("root");
  if (!root || root.childElementCount > 0) return;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  panel.style.cssText = "max-width:560px;margin:15vh auto;padding:24px;font:14px/1.6 system-ui,sans-serif;color:#17181c";
  const title = document.createElement("strong");
  title.textContent = "MoleculeForge could not start";
  const detail = document.createElement("pre");
  detail.style.cssText = "white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;color:#555";
  detail.textContent = message;
  panel.append(title, detail);
  root.append(panel);
}
window.addEventListener("error", (event) => showFatal(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => showFatal(event.reason));
window.mfShowFatal = showFatal;
