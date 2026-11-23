import { useTranslation } from "react-i18next";
import { formatNumber } from "@/lib/i18n";
import { Tooltip, cx } from "./primitives";

/** A computed value with its unit and method (spec P4: every number carries method + unit). */
export function Quantity({
  value,
  unit,
  method,
  uncertainty,
  digits = 4,
  className,
  emphasis,
}: {
  value: unknown;
  unit: string;
  method?: string;
  uncertainty?: number | null;
  digits?: number;
  className?: string;
  emphasis?: boolean;
}) {
  const { i18n, t } = useTranslation();
  let text: string;
  if (typeof value === "number") text = formatNumber(value, i18n.language, digits);
  else if (typeof value === "boolean") text = value ? t("value.yes") : t("value.no");
  else if (value === null || value === undefined) text = t("value.notAvailable");
  else text = String(value);
  const body = (
    <span className={cx("ltr-run inline-flex items-baseline gap-1 tabular", className)}>
      <span className={cx("font-mono", emphasis ? "text-lg font-medium text-ink" : "text-sm text-ink")}>{text}</span>
      {uncertainty != null && typeof value === "number" && (
        <span className="font-mono text-2xs text-ink-3">± {formatNumber(uncertainty, i18n.language, 2)}</span>
      )}
      {unit && <span className="text-2xs text-ink-3">{unit}</span>}
    </span>
  );
  if (!method) return body;
  return (
    <Tooltip label={<span className="max-w-xs">{t("value.method", { method })}</span>}>
      <span tabIndex={0} className="cursor-help rounded-sm">
        {body}
      </span>
    </Tooltip>
  );
}
