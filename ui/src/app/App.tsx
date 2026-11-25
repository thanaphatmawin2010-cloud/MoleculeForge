/** Application shell: navigation rail, header, views, assistant drawer, command palette, toasts. */
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { motion } from "framer-motion";
import { Bot, Command, FlaskConical, Grid3x3, Languages, Library, Moon, PenTool, Sun } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "@/design-system/overlays";
import { Badge, IconButton, Kbd, TooltipProvider, cx } from "@/design-system/primitives";
import { IS_LITE } from "@/lib/edition";
import { changeLanguage, LOCALES } from "@/lib/i18n";
import { useApp, type View } from "@/state/app";
import { useEditor } from "@/state/editor";
import { AssistantPanel } from "../features/assistant/AssistantPanel";
import { CanvasView } from "../features/canvas/CanvasView";
import { LibraryView } from "../features/library/LibraryView";
import { PeriodicTableView } from "../features/periodic/PeriodicTableView";
import { SimulateView } from "../features/simulate/SimulateView";
import { CommandPalette } from "./CommandPalette";
import { ErrorBoundary } from "./ErrorBoundary";
import { openMoleculeFile } from "../features/canvas/io";
import { AboutLite, TrialBanner } from "./LiteNotice";
import { Logo } from "./Logo";
import { Onboarding } from "./Onboarding";

const NAV: { id: View; icon: ReactNode; key: string }[] = [
  { id: "build", icon: <PenTool className="size-5" />, key: "1" },
  { id: "elements", icon: <Grid3x3 className="size-5" />, key: "2" },
  { id: "library", icon: <Library className="size-5" />, key: "3" },
  { id: "simulate", icon: <FlaskConical className="size-5" />, key: "4" },
];

function SidecarStatus() {
  const { t } = useTranslation();
  const sidecar = useApp((s) => s.sidecar);
  const error = useApp((s) => s.sidecarError);
  const progress = useApp((s) => s.engineProgress);
  const caps = useApp((s) => s.capabilities);
  const tone = sidecar === "ready" ? "success" : sidecar === "error" ? "danger" : "neutral";
  let label: string;
  if (sidecar === "ready") {
    label = IS_LITE
      ? t("status.liteReady")
      : caps
        ? t("status.ready", { device: caps.gpu.accelerated ? t("status.gpu") : t("status.cpu"), cores: caps.cpu.physicalCores ?? "?" })
        : t("status.starting");
  } else if (sidecar === "starting" && IS_LITE) {
    label = t("status.liteStarting", { percent: Math.round(progress ?? 0) });
  } else {
    label = t(`status.${sidecar}`);
  }
  return (
    <Badge tone={tone} data-testid="engine-status" title={sidecar === "error" && error ? error : label}>
      <span className={cx("size-1.5 rounded-full", sidecar === "ready" ? "bg-success" : sidecar === "error" ? "bg-danger" : "animate-pulse bg-ink-3")} />
      {/* Phones show the dot; the label stays for screen readers. */}
      <span className="max-md:sr-only">{label}</span>
    </Badge>
  );
}

export function App() {
  const { t, i18n } = useTranslation();
  const view = useApp((s) => s.view);
  const theme = useApp((s) => s.theme);
  const setView = useApp((s) => s.setView);
  const docName = useEditor((s) => s.doc.molecule.name);
  const dirty = useEditor((s) => s.dirty);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useApp.getState().setPaletteOpen(true);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        useApp.getState().toggleAssistant();
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openMoleculeFile();
      } else if (mod && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        setView(NAV[Number(e.key) - 1]!.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  return (
    <TooltipProvider>
      {/* Desktop: a navigation rail on the left. Phones: a tab bar along the bottom. */}
      <div className="flex h-full max-md:flex-col">
        <nav
          className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-e border-line bg-surface-1 py-3 max-md:order-last max-md:h-[calc(3.5rem+env(safe-area-inset-bottom))] max-md:w-full max-md:flex-row max-md:items-stretch max-md:gap-0 max-md:border-e-0 max-md:border-t max-md:px-1 max-md:py-0 max-md:pb-[env(safe-area-inset-bottom)]"
          aria-label={t("nav.label")}
        >
          <div className="mb-3 max-md:hidden">
            <Logo className="size-9" />
          </div>
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
              data-testid={`nav-${item.id}`}
              className={cx(
                "group relative flex w-14 flex-col items-center gap-1 rounded-lg py-2 text-2xs font-medium transition-colors duration-1 max-md:w-auto max-md:flex-1 max-md:justify-center max-md:rounded-none max-md:py-1",
                view === item.id ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-surface-3 hover:text-ink",
              )}
              title={`${t(`nav.${item.id}`)} (Ctrl+${item.key})`}
            >
              {view === item.id && (
                <motion.span
                  layoutId="nav-indicator"
                  className="absolute inset-y-2 start-0 w-0.5 rounded-full bg-accent max-md:inset-x-4 max-md:inset-y-auto max-md:top-0 max-md:h-0.5 max-md:w-auto"
                />
              )}
              {item.icon}
              <span>{t(`nav.${item.id}`)}</span>
            </button>
          ))}
          <div className="mt-auto flex flex-col items-center gap-1 max-md:mt-0 max-md:flex-1 max-md:justify-center">
            <IconButton label={t("nav.assistant")} shortcut="Ctrl J" tooltipSide="right" onClick={() => useApp.getState().toggleAssistant()} data-testid="nav-assistant">
              <Bot className="size-5" />
            </IconButton>
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface-1 px-4 max-md:h-[calc(3rem+env(safe-area-inset-top))] max-md:gap-2 max-md:px-3 max-md:pt-[env(safe-area-inset-top)]">
            <h1 className="min-w-0 truncate text-sm font-semibold text-ink">
              <span className="max-md:hidden">{t("app.name")}</span>
              <span className="ms-2 font-normal text-ink-3 max-md:ms-0 max-md:font-semibold max-md:text-ink">
                {t(`nav.${view}`)}
                {view === "build" && <span className="max-md:font-normal max-md:text-ink-3">{` · ${docName || t("inspector.untitled")}${dirty ? " •" : ""}`}</span>}
              </span>
            </h1>
            <div className="ms-auto flex items-center gap-2">
              <SidecarStatus />
              <button
                onClick={() => useApp.getState().setPaletteOpen(true)}
                className="flex h-8 items-center gap-2 rounded bg-surface-2 px-2.5 text-xs text-ink-3 hover:text-ink hairline max-md:hidden"
                data-testid="open-palette"
              >
                <Command className="size-3.5" />
                {t("palette.trigger")}
                <Kbd>Ctrl K</Kbd>
              </button>
              <Dropdown.Root>
                <Dropdown.Trigger asChild>
                  <IconButton label={t("settings.language")} data-testid="language-menu">
                    <Languages className="size-4" />
                  </IconButton>
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content align="end" sideOffset={6} className="z-50 min-w-40 rounded bg-surface-1 p-1 shadow-3 hairline">
                    {LOCALES.map((loc) => (
                      <Dropdown.Item
                        key={loc.code}
                        onSelect={() => void changeLanguage(loc.code)}
                        className={cx("cursor-pointer rounded-sm px-3 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-3", i18n.language === loc.code ? "font-semibold text-accent" : "text-ink")}
                        data-testid={`language-${loc.code}`}
                      >
                        {loc.label}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
              <AboutLite />
              <IconButton label={theme === "dark" ? t("settings.light") : t("settings.dark")} onClick={() => useApp.getState().setTheme(theme === "dark" ? "light" : "dark")} data-testid="theme-toggle">
                {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </IconButton>
            </div>
          </header>
          <TrialBanner />
          <main className="min-h-0 flex-1">
            {/* Enter-only transition: an exit animation with mode="wait" can stall when the view
                changes again mid-exit (e.g. opening a molecule from the library), leaving no view. */}
            <motion.div
              key={view}
              className="h-full"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
            >
              <ErrorBoundary key={view} area={view}>
                {view === "build" && <CanvasView />}
                {view === "elements" && <PeriodicTableView />}
                {view === "library" && <LibraryView />}
                {view === "simulate" && <SimulateView />}
              </ErrorBoundary>
            </motion.div>
          </main>
        </div>
        <AssistantPanel />
      </div>
      <CommandPalette />
      <Onboarding />
      <Toaster />
    </TooltipProvider>
  );
}
