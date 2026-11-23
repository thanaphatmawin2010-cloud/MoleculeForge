/** Molecule library (spec 7.6/7.7): periodic-table-style family grid, search, favourites, import/export. */
import { motion } from "framer-motion";
import { Download, FolderOpen, Heart, PackagePlus, PenLine, Search, Star, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Formula } from "@/design-system/formula";
import { Badge, Button, EmptyState, IconButton, Segmented, cx, inputClass } from "@/design-system/primitives";
import { api, type LibraryItem } from "@/ipc/api";
import type { Molecule, Wedge } from "@/ipc/schema";
import { FAMILY_CLASS, LIBRARY_FAMILY } from "@/lib/chemistry";
import { openTextFile, saveFile } from "@/lib/files";
import { formatNumber } from "@/lib/i18n";
import type { Vec2 } from "@/lib/molecule";
import { useApp } from "@/state/app";
import { openFromLibrary } from "../canvas/io";
import { MoleculeThumbnail } from "./MoleculeThumbnail";

interface Category {
  id: string;
  row: number;
  col: number;
  family: string;
  count: number;
}

function Card({ item, onChanged }: { item: LibraryItem; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const [preview, setPreview] = useState<{ molecule: Molecule; layout: Vec2[]; wedges: Wedge[] } | null>(null);
  useEffect(() => {
    let live = true;
    api.libraryLoad(item.id).then((entry) => {
      if (live && entry.layout2d) setPreview({ molecule: entry.molecule, layout: entry.layout2d.map(([x, y]) => [x, -y] as Vec2), wedges: entry.wedges });
    });
    return () => {
      live = false;
    };
  }, [item.id]);
  const mw = item.descriptors?.molecularWeight;
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="group flex flex-col rounded-lg bg-surface-1 shadow-1 hairline transition-shadow duration-2 hover:shadow-2"
      data-testid={`library-card-${item.id}`}
    >
      <button className="relative aspect-[4/3] w-full overflow-hidden rounded-t-lg bg-surface-2/50" onClick={() => void openFromLibrary(item.id, false)} aria-label={t("library.open", { name: item.name })}>
        {preview ? <MoleculeThumbnail molecule={preview.molecule} layout={preview.layout} wedges={preview.wedges} label={item.name} /> : <div className="skeleton absolute inset-3" />}
      </button>
      <div className="flex flex-1 flex-col gap-1 border-t border-line p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-ink">{item.name}</h3>
          <IconButton
            size="sm"
            label={item.favorite ? t("library.unfavorite") : t("library.favorite")}
            active={item.favorite}
            onClick={() => void api.libraryFavorite(item.id, !item.favorite).then(onChanged)}
          >
            <Star className={cx("size-3.5", item.favorite && "fill-current")} />
          </IconButton>
        </div>
        <p className="text-xs text-ink-2"><Formula value={item.formula} /></p>
        <div className="mt-auto flex items-center justify-between pt-2">
          <span className="text-2xs text-ink-3">
            {typeof mw === "number" ? `${formatNumber(mw, i18n.language, 2)} g/mol` : ""}
          </span>
          <div className="flex gap-0.5 opacity-80 group-hover:opacity-100">
            <IconButton size="sm" label={t("library.insertFragment")} onClick={() => void openFromLibrary(item.id, true)}>
              <PackagePlus className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label={t("library.edit")} onClick={() => void openFromLibrary(item.id, false)}>
              <PenLine className="size-3.5" />
            </IconButton>
            {item.source === "user" && (
              <IconButton
                size="sm"
                label={t("library.delete")}
                onClick={() => void api.libraryDelete(item.id).then(onChanged)}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </motion.article>
  );
}

export function LibraryView() {
  const { t } = useTranslation();
  const pushToast = useApp((s) => s.pushToast);
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | "prebuilt" | "user">("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    api.libraryCategories().then((r) => setCategories(r.categories));
  }, [version]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api.libraryList({ query, category, source, favoritesOnly, limit: 400 }).then((r) => {
        setItems(r.items);
        setTotal(r.total);
      });
    }, query ? 150 : 0);
    return () => window.clearTimeout(timer);
  }, [query, category, source, favoritesOnly, version]);

  const grid = useMemo(() => [...categories].sort((a, b) => a.row - b.row || a.col - b.col), [categories]);

  const importFile = async () => {
    const file = await openTextFile([{ name: "SDF / JSON", extensions: ["sdf", "json"] }]);
    if (!file) return;
    const format = file.name.toLowerCase().endsWith(".json") ? "json" : "sdf";
    try {
      const result = await api.libraryImport(format, file.text);
      pushToast({ tone: "success", title: t("library.imported", { count: result.imported }), body: result.duplicates.length ? t("library.importDuplicates", { count: result.duplicates.length }) : undefined });
      refresh();
    } catch (err) {
      pushToast({ tone: "danger", title: t("library.importFailed"), body: err instanceof Error ? err.message : String(err) });
    }
  };

  const exportAll = async (format: "sdf" | "json") => {
    const ids = items.map((i) => i.id);
    const result = await api.libraryExport(format, ids);
    if (await saveFile(`moleculeforge-library.${format}`, result.data, [{ name: format.toUpperCase(), extensions: [format] }])) {
      pushToast({ tone: "success", title: t("library.exported", { count: result.count }) });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[1400px] space-y-6 p-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("library.title")}</h1>
            <p className="mt-1 text-sm text-ink-3">{t("library.subtitle")}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" icon={<Upload className="size-4" />} onClick={() => void importFile()}>
              {t("library.import")}
            </Button>
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => void exportAll("sdf")}>
              {t("library.exportSdf")}
            </Button>
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => void exportAll("json")}>
              {t("library.exportJson")}
            </Button>
          </div>
        </header>

        <section aria-label={t("library.families")}>
          <div className="grid grid-cols-5 gap-2" role="grid">
            {grid.map((c) => {
              const fam = FAMILY_CLASS[LIBRARY_FAMILY[c.family] ?? "unknown"]!;
              const active = category === c.id;
              return (
                <motion.button
                  key={c.id}
                  role="gridcell"
                  aria-selected={active}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setCategory(active ? null : c.id)}
                  style={{ gridRow: c.row, gridColumn: c.col }}
                  data-testid={`family-${c.id}`}
                  className={cx(
                    "flex min-h-[84px] flex-col justify-between rounded-lg p-3 text-start transition-shadow duration-2",
                    fam.tile,
                    active ? "ring-2 ring-accent shadow-2" : "shadow-1 hover:shadow-2",
                  )}
                >
                  <span className={cx("font-mono text-2xs opacity-80", fam.ink)}>{String(c.row).padStart(1)}·{c.col}</span>
                  <span className={cx("text-sm font-semibold leading-tight", fam.ink)}>{t(`library.category.${c.id}`)}</span>
                  <span className={cx("font-mono text-xs", fam.ink)}>{t("library.count", { count: c.count })}</span>
                </motion.button>
              );
            })}
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
              <input
                className={cx(inputClass, "w-72 ps-8")}
                placeholder={t("library.search")}
                aria-label={t("library.search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="library-search"
              />
            </div>
            <Segmented
              label={t("library.source")}
              value={source}
              onChange={setSource}
              options={[
                { value: "all", label: t("library.sourceAll") },
                { value: "prebuilt", label: t("library.sourcePrebuilt") },
                { value: "user", label: t("library.sourceUser") },
              ]}
            />
            <Button variant={favoritesOnly ? "primary" : "ghost"} size="sm" icon={<Heart className="size-3.5" />} onClick={() => setFavoritesOnly((v) => !v)}>
              {t("library.favoritesOnly")}
            </Button>
            {category && (
              <Badge tone="accent" className="cursor-pointer" onClick={() => setCategory(null)}>
                {t(`library.category.${category}`)} ×
              </Badge>
            )}
            <span className="ms-auto text-xs text-ink-3">{t("library.results", { count: total })}</span>
          </div>
          {items.length === 0 ? (
            <div className="h-64">
              <EmptyState icon={<FolderOpen className="size-5" />} title={t("library.emptyTitle")} body={t("library.emptyBody")} />
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {items.map((item) => (
                <Card key={item.id} item={item} onChanged={refresh} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
