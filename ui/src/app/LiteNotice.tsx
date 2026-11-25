/** MoleculeForge Lite: the trial banner and the notices that stand in for desktop-only features. */
import { Download, Info, Monitor, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/design-system/overlays";
import { Button, IconButton, cx } from "@/design-system/primitives";
import { DOWNLOAD_URL, IS_LITE, type DesktopFeature } from "@/lib/edition";
import { readPreference, writePreference } from "@/lib/preferences";

/** A link to the desktop download (the repository's latest release). Hidden when none is configured. */
export function DownloadLink({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { t } = useTranslation();
  if (!DOWNLOAD_URL) return null;
  return (
    <a
      href={DOWNLOAD_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm bg-accent font-medium text-accent-on shadow-1 hover:brightness-[1.06]",
        compact ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-xs",
        className,
      )}
      data-testid="download-desktop"
    >
      <Download className="size-3.5" aria-hidden />
      {t("lite.download")}
    </a>
  );
}

/** One line across the top of the trial: what it is and where the full app is. */
export function TrialBanner() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(() => readPreference("liteBanner") === "hidden");
  if (!IS_LITE || hidden) return null;
  return (
    <div role="note" className="flex items-center gap-3 border-b border-line bg-accent-soft/50 px-4 py-1.5 text-xs text-ink-2" data-testid="trial-banner">
      <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1 leading-5">
        <span className="font-semibold text-ink">{t("lite.banner.title")}</span>
        <span className="hidden sm:inline"> · {t("lite.banner.body")}</span>
      </p>
      <DownloadLink compact />
      <IconButton
        label={t("lite.banner.dismiss")}
        onClick={() => {
          writePreference("liteBanner", "hidden");
          setHidden(true);
        }}
        data-testid="trial-banner-dismiss"
      >
        <X className="size-4" />
      </IconButton>
    </div>
  );
}

/** Stands in for a feature that needs the desktop engines (OpenMM, Vina, xtb, PySCF, the local LLM). */
export function DesktopOnly({ feature, className }: { feature: DesktopFeature; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cx("rounded bg-info-soft/60 p-3 text-xs hairline", className)} data-testid={`desktop-only-${feature}`}>
      <p className="flex items-center gap-1.5 font-semibold text-ink">
        <Monitor className="size-3.5 shrink-0" aria-hidden />
        {t(`lite.feature.${feature}.title`)}
      </p>
      <p className="mt-1 leading-5 text-ink-2">{t(`lite.feature.${feature}.body`)}</p>
      <DownloadLink className="mt-2.5" compact />
    </div>
  );
}

/** About MoleculeForge Lite: what the trial is, and the licence of every component it ships. */
export function AboutLite() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [licences, setLicences] = useState<string | null>(null);
  const [showLicences, setShowLicences] = useState(false);
  useEffect(() => {
    if (!showLicences || licences !== null) return;
    fetch(new URL("licenses/THIRD_PARTY_LICENSES.txt", document.baseURI))
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then(setLicences)
      .catch(() => setLicences(t("lite.about.licencesMissing")));
  }, [showLicences, licences, t]);
  if (!IS_LITE) return null;
  return (
    <>
      <IconButton label={t("lite.about.title")} onClick={() => setOpen(true)} data-testid="about-lite">
        <Info className="size-4" />
      </IconButton>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("lite.about.title")}
        description={t("lite.banner.title")}
        footer={DOWNLOAD_URL ? <DownloadLink /> : undefined}
      >
        <div className="space-y-3 text-sm leading-6 text-ink-2" data-testid="about-lite-dialog">
          <p>{t("lite.about.body")}</p>
          <p>{t("lite.banner.body")}</p>
          <p className="text-xs text-ink-3">{t("lite.about.engines")}</p>
          {showLicences ? (
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-3 font-mono text-2xs leading-4 text-ink-2 hairline" data-testid="licences-text">
              {licences ?? "…"}
            </pre>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setShowLicences(true)} data-testid="show-licences">
              {t("lite.about.licences")}
            </Button>
          )}
        </div>
      </Dialog>
    </>
  );
}
