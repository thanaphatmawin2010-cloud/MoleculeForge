import * as RadixDialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type Toast, useApp } from "@/state/app";
import { cx } from "./primitives";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = "md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg" | "xl";
}) {
  const { t } = useTranslation();
  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-3xl", xl: "max-w-5xl" };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content asChild>
              <motion.div
                className={cx(
                  "fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-surface-1 shadow-3 hairline",
                  widths[width],
                )}
                initial={{ opacity: 0, scale: 0.97, y: "-48%", x: "-50%" }}
                animate={{ opacity: 1, scale: 1, y: "-50%", x: "-50%" }}
                exit={{ opacity: 0, scale: 0.98, y: "-49%", x: "-50%" }}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              >
                <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                  <div>
                    <RadixDialog.Title className="text-md font-semibold text-ink">{title}</RadixDialog.Title>
                    {description ? (
                      <RadixDialog.Description className="mt-1 text-xs text-ink-3">{description}</RadixDialog.Description>
                    ) : (
                      <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
                    )}
                  </div>
                  <RadixDialog.Close
                    className="grid size-8 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink"
                    aria-label={t("action.close")}
                  >
                    <X className="size-4" />
                  </RadixDialog.Close>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
                {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}

const TONE_ICON = {
  success: <CheckCircle2 className="size-4 text-success" aria-hidden />,
  info: <Info className="size-4 text-info" aria-hidden />,
  warning: <TriangleAlert className="size-4 text-warning" aria-hidden />,
  danger: <OctagonAlert className="size-4 text-danger" aria-hidden />,
};

function ToastCard({ toast }: { toast: Toast }) {
  const { t } = useTranslation();
  const dismiss = useApp((s) => s.dismissToast);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (expanded) return;
    const timer = window.setTimeout(() => dismiss(toast.id), toast.tone === "danger" ? 9000 : 5200);
    return () => window.clearTimeout(timer);
  }, [dismiss, expanded, toast.id, toast.tone]);
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 500, damping: 36 }}
      className="pointer-events-auto w-[360px] rounded-lg bg-surface-1 p-3 shadow-3 hairline"
      role={toast.tone === "danger" ? "alert" : "status"}
      data-testid={`toast-${toast.tone}`}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5">{TONE_ICON[toast.tone]}</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{toast.title}</p>
          {toast.body && <p className="mt-0.5 text-xs leading-5 text-ink-2">{toast.body}</p>}
          {expanded && toast.details && (
            <ul className="mt-2 space-y-1 border-t border-line pt-2">
              {toast.details.map((line, i) => (
                <li key={i} className="text-2xs leading-4 text-ink-2">
                  {line}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-3">
            {toast.details && toast.details.length > 0 && (
              <button className="text-2xs font-medium text-ink-2 hover:text-ink" onClick={() => setExpanded((v) => !v)}>
                {expanded ? t("action.hideDetails") : t("action.showDetails")}
              </button>
            )}
            {toast.action && (
              <button
                className="text-2xs font-semibold text-accent hover:underline"
                onClick={() => {
                  toast.action?.run();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        </div>
        <button aria-label={t("action.dismiss")} onClick={() => dismiss(toast.id)} className="text-ink-3 hover:text-ink">
          <X className="size-3.5" />
        </button>
      </div>
    </motion.li>
  );
}

export function Toaster() {
  const toasts = useApp((s) => s.toasts);
  return (
    <ol className="pointer-events-none fixed bottom-4 end-4 z-50 flex flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </AnimatePresence>
    </ol>
  );
}
