/**
 * MoleculeForge primitives. Every visual value resolves to a design token (tailwind.config.ts).
 */
import * as RadixScroll from "@radix-ui/react-scroll-area";
import * as RadixSwitch from "@radix-ui/react-switch";
import * as RadixToggleGroup from "@radix-ui/react-toggle-group";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { Loader2 } from "lucide-react";
import { type ButtonHTMLAttributes, forwardRef, type HTMLAttributes, type ReactNode } from "react";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/* ---------------------------------------------------------------- Button */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet";
type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-on shadow-1 hover:brightness-[1.06] active:brightness-95 disabled:opacity-50",
  secondary:
    "bg-surface-1 text-ink hairline hover:bg-surface-3 active:bg-surface-2 disabled:opacity-50",
  ghost: "text-ink-2 hover:text-ink hover:bg-surface-3 active:bg-surface-2 disabled:opacity-40",
  quiet: "text-ink-2 hover:text-ink disabled:opacity-40",
  danger: "bg-danger text-surface-1 hover:brightness-110 disabled:opacity-50",
};
const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-sm",
  md: "h-9 px-3.5 text-sm gap-2 rounded",
  lg: "h-11 px-5 text-md gap-2.5 rounded",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(
        "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,filter,box-shadow,color] duration-1",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/* ---------------------------------------------------------------- Tooltip */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tooltip({ label, shortcut, children, side = "top" }: { label: ReactNode; shortcut?: string; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 flex items-center gap-2 rounded-sm bg-ink px-2 py-1 text-xs text-bg shadow-2 data-[state=delayed-open]:animate-in"
        >
          {label}
          {shortcut && <Kbd tone="inverse">{shortcut}</Kbd>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

/* ---------------------------------------------------------------- IconButton */

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: "sm" | "md" | "lg";
  tooltipSide?: "top" | "right" | "bottom" | "left";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, active, size = "md", className, children, tooltipSide, ...rest },
  ref,
) {
  const dims = size === "sm" ? "size-7" : size === "lg" ? "size-11" : "size-9";
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        aria-label={label}
        aria-pressed={active}
        className={cx(
          "inline-flex items-center justify-center rounded transition-colors duration-1",
          dims,
          active ? "bg-accent-soft text-accent hairline" : "text-ink-2 hover:bg-surface-3 hover:text-ink",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});

/* ---------------------------------------------------------------- Surfaces */

export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rounded-lg bg-surface-1 hairline shadow-1", className)} {...rest} />;
}

export function PanelHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- Badge / Kbd */

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink-2",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

export function Badge({ tone = "neutral", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cx("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-2xs font-medium", TONE[tone], className)}
      {...rest}
    />
  );
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Shortcut labels are written "Ctrl K" in the source; macOS shows the Command glyph instead. */
export function shortcutLabel(text: string): string {
  return IS_MAC ? text.replace(/\bCtrl\b ?/g, "⌘").replace(/\bAlt\b ?/g, "⌥") : text;
}

export function Kbd({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "inverse" }) {
  return (
    <kbd
      className={cx(
        "ltr-run inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-mono text-2xs",
        tone === "inverse" ? "bg-bg/15 text-bg" : "bg-surface-2 text-ink-2 hairline",
      )}
    >
      {typeof children === "string" ? shortcutLabel(children) : children}
    </kbd>
  );
}

/* ---------------------------------------------------------------- Segmented */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <RadixToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={label}
      className="inline-flex rounded bg-surface-2 p-0.5 hairline"
    >
      {options.map((opt) => (
        <RadixToggleGroup.Item
          key={opt.value}
          value={opt.value}
          title={opt.title}
          aria-label={opt.title}
          className={cx(
            "rounded-sm font-medium text-ink-2 transition-colors duration-1 hover:text-ink data-[state=on]:bg-surface-1 data-[state=on]:text-ink data-[state=on]:shadow-1",
            size === "sm" ? "h-6 px-2 text-2xs" : "h-7 px-3 text-xs",
          )}
        >
          {opt.label}
        </RadixToggleGroup.Item>
      ))}
    </RadixToggleGroup.Root>
  );
}

/* ---------------------------------------------------------------- Switch */

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm text-ink-2">
        {label}
      </label>
      <RadixSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="relative h-5 w-9 rounded-full bg-surface-3 hairline transition-colors data-[state=checked]:bg-accent"
      >
        <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-surface-1 shadow-1 transition-transform duration-2 data-[state=checked]:translate-x-[18px] rtl:data-[state=checked]:-translate-x-[18px]" />
      </RadixSwitch.Root>
    </div>
  );
}

/* ---------------------------------------------------------------- Progress */

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className="h-full rounded-full bg-accent transition-[width] duration-3" style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ---------------------------------------------------------------- Scroll */

export function ScrollArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <RadixScroll.Root className={cx("overflow-hidden", className)}>
      <RadixScroll.Viewport className="size-full">{children}</RadixScroll.Viewport>
      <RadixScroll.Scrollbar orientation="vertical" className="flex w-2 touch-none select-none p-0.5">
        <RadixScroll.Thumb className="relative flex-1 rounded-full bg-line-strong" />
      </RadixScroll.Scrollbar>
    </RadixScroll.Root>
  );
}

/* ---------------------------------------------------------------- Empty state */

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-surface-2 text-ink-3 hairline">{icon}</div>
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        {body && <p className="mt-1 max-w-sm text-xs leading-5 text-ink-3">{body}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------------------------------------------------------------- Field */

export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-2xs text-ink-3">{hint}</p>}
    </div>
  );
}

export const inputClass =
  "h-9 w-full rounded bg-surface-1 px-3 text-sm text-ink hairline placeholder:text-ink-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus";
