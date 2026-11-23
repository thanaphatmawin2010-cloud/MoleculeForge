/** Command palette (Ctrl+K): every major action reachable from the keyboard. */
import * as RadixDialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Formula } from "@/design-system/formula";
import { Kbd } from "@/design-system/primitives";
import { api, type LibraryItem } from "@/ipc/api";
import { changeLanguage, LOCALES } from "@/lib/i18n";
import { useApp } from "@/state/app";
import { useEditor } from "@/state/editor";
import { addHydrogens, exportMolecule, newDocument, openFromLibrary, openMoleculeFile, relayout, saveToLibrary } from "../features/canvas/io";

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  useEffect(() => {
    if (open) void api.libraryList({ limit: 400 }).then((r) => setLibrary(r.items)).catch(() => setLibrary([]));
  }, [open]);
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  const item = "flex cursor-pointer items-center justify-between rounded-sm px-3 py-2 text-sm text-ink data-[selected=true]:bg-surface-3";
  const group = "px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-3";
  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-ink/25" />
        <RadixDialog.Content className="fixed left-1/2 top-[14vh] z-50 w-[620px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-xl bg-surface-1 shadow-3 hairline" aria-describedby={undefined}>
          <RadixDialog.Title className="sr-only">{t("palette.title")}</RadixDialog.Title>
          <Command label={t("palette.title")} loop>
            <Command.Input placeholder={t("palette.placeholder")} className="h-12 w-full border-b border-line bg-transparent px-4 text-md text-ink placeholder:text-ink-3 focus:outline-none" data-testid="palette-input" />
            <Command.List className="max-h-[56vh] overflow-y-auto p-1">
              <Command.Empty className="px-4 py-6 text-center text-sm text-ink-3">{t("palette.empty")}</Command.Empty>
              <Command.Group heading={t("palette.file")} className={group}>
                <Command.Item className={item} onSelect={() => run(newDocument)}>{t("palette.new")}</Command.Item>
                <Command.Item className={item} onSelect={() => run(() => void openMoleculeFile())}>{t("palette.open")}<Kbd>Ctrl O</Kbd></Command.Item>
                <Command.Item className={item} onSelect={() => run(() => void saveToLibrary())}>{t("palette.save")}</Command.Item>
                {(["sdf", "mol", "smiles", "inchi", "xyz", "pdb"] as const).map((f) => (
                  <Command.Item key={f} className={item} value={`export ${f}`} onSelect={() => run(() => void exportMolecule(f))}>
                    {t("palette.export", { format: f.toUpperCase() })}
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading={t("palette.edit")} className={group}>
                <Command.Item className={item} onSelect={() => run(() => useEditor.getState().undo())}>{t("action.undo")}<Kbd>Ctrl Z</Kbd></Command.Item>
                <Command.Item className={item} onSelect={() => run(() => useEditor.getState().redo())}>{t("action.redo")}<Kbd>Ctrl Y</Kbd></Command.Item>
                <Command.Item className={item} onSelect={() => run(() => void relayout())}>{t("canvas.cleanLayout")}</Command.Item>
                <Command.Item className={item} onSelect={() => run(() => void addHydrogens())}>{t("canvas.addHydrogens")}<Kbd>⇧H</Kbd></Command.Item>
              </Command.Group>
              <Command.Group heading={t("palette.navigate")} className={group}>
                {(["build", "elements", "library", "simulate"] as const).map((v, i) => (
                  <Command.Item key={v} className={item} onSelect={() => run(() => useApp.getState().setView(v))}>
                    {t(`nav.${v}`)}
                    <Kbd>{`Ctrl ${i + 1}`}</Kbd>
                  </Command.Item>
                ))}
                <Command.Item className={item} onSelect={() => run(() => useApp.getState().toggleAssistant(true))}>{t("nav.assistant")}<Kbd>Ctrl J</Kbd></Command.Item>
              </Command.Group>
              <Command.Group heading={t("palette.preferences")} className={group}>
                <Command.Item className={item} onSelect={() => run(() => useApp.getState().setTheme(useApp.getState().theme === "dark" ? "light" : "dark"))}>{t("palette.toggleTheme")}</Command.Item>
                {LOCALES.map((loc) => (
                  <Command.Item key={loc.code} className={item} value={`language ${loc.label}`} onSelect={() => run(() => void changeLanguage(loc.code))}>
                    {t("palette.language", { language: loc.label })}
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading={t("palette.library")} className={group}>
                {library.map((m) => (
                  <Command.Item key={m.id} className={item} value={`${m.name} ${m.formula} ${m.smiles ?? ""}`} onSelect={() => run(() => void openFromLibrary(m.id, false))}>
                    <span>{m.name}</span>
                    <Formula value={m.formula} className="text-xs text-ink-3" />
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
