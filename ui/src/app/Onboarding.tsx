/** First-run coach marks: build water in three steps (spec 7.1: first molecule within ~60 s). */
import { AnimatePresence, motion } from "framer-motion";
import { Droplets } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/design-system/primitives";
import { useApp } from "@/state/app";
import { useEditor } from "@/state/editor";

export function Onboarding() {
  const { t } = useTranslation();
  const done = useApp((s) => s.onboardingDone);
  const view = useApp((s) => s.view);
  const sidecar = useApp((s) => s.sidecar);
  const molecule = useEditor((s) => s.doc.molecule);
  const [dismissed, setDismissed] = useState(false);

  const step = useMemo(() => {
    const hasO = molecule.atoms.some((a) => a.el === "O");
    const hCount = molecule.bonds.filter((b) => {
      const pair = [molecule.atoms[b.a]?.el, molecule.atoms[b.b]?.el].sort().join("");
      return pair === "HO";
    }).length;
    if (!hasO) return 0;
    if (hCount < 2) return 1;
    return 2;
  }, [molecule]);

  useEffect(() => {
    if (step === 2 && !done) {
      const timer = window.setTimeout(() => useApp.getState().completeOnboarding(), 6000);
      return () => window.clearTimeout(timer);
    }
  }, [step, done]);

  const visible = !done && !dismissed && view === "build" && sidecar === "ready";
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          className="fixed bottom-6 start-[92px] z-30 w-[340px] rounded-xl bg-surface-1 p-4 shadow-3 hairline"
          role="dialog"
          aria-label={t("onboarding.title")}
          data-testid="onboarding"
        >
          <div className="flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-full bg-info-soft text-info">
              <Droplets className="size-4" />
            </div>
            <p className="text-sm font-semibold text-ink">{t("onboarding.title")}</p>
          </div>
          <ol className="mt-3 space-y-2">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex gap-2.5 text-xs leading-5">
                <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-2xs font-semibold ${i < step ? "bg-success text-surface-1" : i === step ? "bg-accent text-accent-on" : "bg-surface-3 text-ink-3"}`}>
                  {i < step ? "✓" : i + 1}
                </span>
                <span className={i === step ? "text-ink" : "text-ink-3"}>{t(`onboarding.step${i + 1}`)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => {
              setDismissed(true);
              useApp.getState().completeOnboarding();
            }}>
              {step === 2 ? t("onboarding.finish") : t("onboarding.skip")}
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
