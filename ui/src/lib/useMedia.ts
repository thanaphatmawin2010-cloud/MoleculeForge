/** Media queries as React state. Layout that CSS alone can express uses Tailwind's `max-md:` instead. */
import { useSyncExternalStore } from "react";

/** Phones (and narrow windows): below Tailwind's `md` breakpoint. */
export const PHONE_QUERY = "(max-width: 767px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

export const useIsPhone = (): boolean => useMediaQuery(PHONE_QUERY);
