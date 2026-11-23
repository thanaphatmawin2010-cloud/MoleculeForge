/** Contains a failing panel so the rest of the app keeps working (never a blank window). */
import { Component, type ErrorInfo, type ReactNode } from "react";
import i18next from "i18next";

interface Props {
  area: string;
  children: ReactNode;
  /** Rendered instead of the default panel, e.g. a compact message inside the 3D viewport. */
  fallback?: (error: Error, retry: () => void) => ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.area}]`, error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.retry);
    return (
      <div role="alert" className="grid h-full place-items-center p-8" data-testid={`error-${this.props.area}`}>
        <div className="max-w-md rounded-lg bg-surface-1 p-5 text-center shadow-2 hairline">
          <p className="text-sm font-semibold text-ink">{i18next.t("error.title")}</p>
          <p className="mt-2 break-words font-mono text-xs leading-5 text-ink-3">{error.message}</p>
          <button className="mt-4 rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-on" onClick={this.retry}>
            {i18next.t("error.retry")}
          </button>
        </div>
      </div>
    );
  }
}
