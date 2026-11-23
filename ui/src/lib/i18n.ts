/**
 * Internationalisation: i18next + ICU MessageFormat (plurals, select/gender, number formatting,
 * word order). All user-facing strings live in src/locales/<lng>/*.json.
 */
import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import enCommon from "@/locales/en/common.json";
import enElements from "@/locales/en/elements.json";
import enIssues from "@/locales/en/issues.json";
import thCommon from "@/locales/th/common.json";
import thElements from "@/locales/th/elements.json";
import thIssues from "@/locales/th/issues.json";
import { readPreference, writePreference } from "./preferences";

export const LOCALES = [
  { code: "en", label: "English", dir: "ltr" },
  { code: "th", label: "ไทย", dir: "ltr" },
] as const;
export type LocaleCode = (typeof LOCALES)[number]["code"];

const RTL = new Set(["ar", "he", "fa", "ur"]);

export const resources = {
  en: { common: enCommon, elements: enElements, issues: enIssues },
  th: { common: thCommon, elements: thElements, issues: thIssues },
} as const;

function initialLanguage(): LocaleCode {
  const saved = readPreference("locale");
  if (saved && saved in resources) return saved as LocaleCode;
  const nav = typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : "en";
  return nav in resources ? (nav as LocaleCode) : "en";
}

export function applyDirection(lng: string): void {
  const dir = RTL.has(lng.slice(0, 2)) ? "rtl" : "ltr";
  document.documentElement.lang = lng;
  document.documentElement.dir = dir;
}

export async function initI18n(): Promise<typeof i18next> {
  const lng = initialLanguage();
  await i18next
    .use(ICU)
    .use(initReactI18next)
    .init({
      resources,
      lng,
      fallbackLng: "en",
      ns: ["common", "elements", "issues"],
      defaultNS: "common",
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  applyDirection(lng);
  return i18next;
}

export async function changeLanguage(lng: LocaleCode): Promise<void> {
  writePreference("locale", lng);
  await i18next.changeLanguage(lng);
  applyDirection(lng);
}

/**
 * Locale-aware number formatting. ``fixed`` keeps trailing zeros so columns of measurements
 * line up (1.390 Å next to 1.351 Å); otherwise insignificant zeros are dropped.
 */
export function formatNumber(value: number, lng: string, maximumFractionDigits = 4, fixed = false): string {
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e7)) {
    return new Intl.NumberFormat(lng, { notation: "scientific", maximumFractionDigits: 3 }).format(value);
  }
  return new Intl.NumberFormat(lng, { maximumFractionDigits, minimumFractionDigits: fixed ? maximumFractionDigits : 0 }).format(value);
}
