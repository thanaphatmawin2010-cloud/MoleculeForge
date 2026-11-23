import "@/design-system/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "@/ipc/api";
import { rpc } from "@/ipc/client";
import { initI18n } from "@/lib/i18n";
import { useApp } from "@/state/app";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";

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
    await rpc().waitUntilReady(api.ping);
    const [caps, elements] = await Promise.all([api.capabilities(), api.elementsAll()]);
    useApp.getState().setCapabilities(caps);
    useApp.getState().setElements(elements.elements);
    useApp.getState().setSidecar("ready");
  } catch (err) {
    useApp.getState().setSidecar("error", err instanceof Error ? err.message : String(err));
  }
}

bootstrap().catch((error: unknown) => window.mfShowFatal?.(error));
