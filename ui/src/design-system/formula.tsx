/** Chemical formula with subscript counts and a superscript net charge (e.g. H₂O, SO₄²⁻). */
import { Fragment } from "react";
import { cx } from "./primitives";

export function Formula({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className={className}>—</span>;
  const charge = value.match(/([+-])(\d*)$/);
  const body = charge ? value.slice(0, charge.index) : value;
  const parts = body.match(/\d+|[^\d]+/g) ?? [];
  return (
    <span className={cx("whitespace-nowrap", className)} aria-label={value}>
      {parts.map((part, i) =>
        /^\d+$/.test(part) ? (
          <sub key={i} className="relative -bottom-[0.1em] text-[0.72em] leading-none">
            {part}
          </sub>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
      {charge && (
        <sup className="text-[0.72em] leading-none">
          {charge[2] && charge[2] !== "1" ? charge[2] : ""}
          {charge[1] === "-" ? "−" : "+"}
        </sup>
      )}
    </span>
  );
}
