import "@/design-system/global.css";
import i18next from "i18next";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "@/ipc/api";
import { rpc } from "@/ipc/client";
import { IS_LITE } from "@/lib/edition";
import { initI18n } from "@/lib/i18n";
import { useApp } from "@/state/app";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";

/** Lite's engine announces "ready" once RDKit, OpenChemLib and the data have loaded in its worker
 * (several megabytes on a first visit), or "engine.failed" when this browser cannot run it. */
function waitForLiteEngine(): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = rpc().onNotification((method, params) => {
      if (method === "engine.loading") useApp.getState().setEngineProgress(Number(params.percent) || 0);
      if (method === "engine.failed") {
        off();
        reject(new Error(String(params.message ?? "The compute engine could not start in this browser.")));
      }
    });
    void rpc().ready.then(() => {
      off();
      useApp.getState().setEngineProgress(null);
      resolve();
    });
  });
}

async function bootstrap(): Promise<void> {
  document.documentElement.dataset.theme = useApp.getState().theme;
  await initI18n();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary area="app">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
  try {
    // The desktop shell reports an engine that stopped unexpectedly as a notification.
    rpc().onNotification((method, params) => {
      if (method === "sidecar.exit") useApp.getState().setSidecar("error", `Compute engine stopped (exit code ${String(params.code ?? "?")})`);
    });
    if (IS_LITE) await waitForLiteEngine();
    else await rpc().waitUntilReady(api.ping);
    const [caps, elements] = await Promise.all([api.capabilities(), api.elementsAll()]);
    useApp.getState().setCapabilities(caps);
    useApp.getState().setElements(elements.elements);
    useApp.getState().setSidecar("ready");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useApp.getState().setSidecar("error", message);
    if (IS_LITE) useApp.getState().pushToast({ tone: "danger", title: i18next.t("lite.failed"), body: message });
  }
}

bootstrap().catch((error: unknown) => window.mfShowFatal?.(error));
