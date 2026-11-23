import * as Popover from "@radix-ui/react-popover";
import { Grid3x3 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/design-system/primitives";
import { useApp } from "@/state/app";
import { PeriodicGrid } from "./PeriodicGrid";

/** Compact periodic table popover for choosing any of the 118 elements while drawing. */
export function ElementPicker({ onPick }: { onPick: (symbol: string) => void }) {
  const { t } = useTranslation();
  const elements = useApp((s) => s.elements);
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton label={t("canvas.allElements")} data-testid="element-picker">
          <Grid3x3 className="size-4" />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={8} align="start" className="z-50 rounded-lg bg-surface-1 p-3 shadow-3 hairline">
          <p className="mb-2 text-xs font-medium text-ink-2">{t("canvas.pickElement")}</p>
          <PeriodicGrid
            compact
            elements={elements}
            onSelect={(el) => {
              onPick(el.symbol);
              setOpen(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
