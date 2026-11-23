import type { Config } from "tailwindcss";

const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;
const family = (name: string) => ({
  DEFAULT: `hsl(var(--fam-${name}) var(--tile-s) var(--tile-l))`,
  ink: `hsl(var(--fam-${name}) var(--tile-ink-s) var(--tile-ink-l))`,
});

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      bg: token("bg"),
      surface: { 1: token("surface-1"), 2: token("surface-2"), 3: token("surface-3") },
      line: { DEFAULT: token("line"), strong: token("line-strong") },
      ink: { DEFAULT: token("ink"), 2: token("ink-2"), 3: token("ink-3") },
      accent: { DEFAULT: token("accent"), soft: token("accent-soft"), on: token("on-accent") },
      focus: token("focus"),
      success: { DEFAULT: token("success"), soft: token("success-soft") },
      warning: { DEFAULT: token("warning"), soft: token("warning-soft") },
      danger: { DEFAULT: token("danger"), soft: token("danger-soft") },
      info: { DEFAULT: token("info"), soft: token("info-soft") },
      viewport: { DEFAULT: token("viewport-bg"), grid: token("viewport-grid") },
      el: {
        c: token("el-c"),
        o: token("el-o"),
        n: token("el-n"),
        s: token("el-s"),
        p: token("el-p"),
        hal: token("el-hal"),
        br: token("el-br"),
        i: token("el-i"),
        metal: token("el-metal"),
      },
      fam: {
        alkali: family("alkali"),
        alkaline: family("alkaline"),
        transition: family("transition"),
        post: family("post"),
        metalloid: family("metalloid"),
        nonmetal: family("nonmetal"),
        halogen: family("halogen"),
        noble: family("noble"),
        lanthanide: family("lanthanide"),
        actinide: family("actinide"),
        unknown: family("unknown"),
      },
    },
    fontFamily: {
      sans: "var(--font-sans)",
      mono: "var(--font-mono)",
    },
    fontSize: {
      "2xs": ["11px", { lineHeight: "14px", letterSpacing: "0.01em" }],
      xs: ["12px", { lineHeight: "16px" }],
      sm: ["13px", { lineHeight: "18px" }],
      base: ["14px", { lineHeight: "20px" }],
      md: ["16px", { lineHeight: "22px" }],
      lg: ["18px", { lineHeight: "24px", letterSpacing: "-0.005em" }],
      xl: ["22px", { lineHeight: "28px", letterSpacing: "-0.01em" }],
      "2xl": ["28px", { lineHeight: "34px", letterSpacing: "-0.015em" }],
      "3xl": ["36px", { lineHeight: "40px", letterSpacing: "-0.02em" }],
    },
    borderRadius: {
      none: "0",
      sm: "var(--radius-sm)",
      DEFAULT: "var(--radius)",
      lg: "var(--radius-lg)",
      xl: "var(--radius-xl)",
      full: "9999px",
    },
    boxShadow: {
      none: "none",
      1: "var(--shadow-1)",
      2: "var(--shadow-2)",
      3: "var(--shadow-3)",
    },
    transitionDuration: {
      DEFAULT: "var(--dur-2)",
      1: "var(--dur-1)",
      2: "var(--dur-2)",
      3: "var(--dur-3)",
      4: "var(--dur-4)",
    },
    transitionTimingFunction: {
      DEFAULT: "var(--ease-standard)",
      standard: "var(--ease-standard)",
      emphasized: "var(--ease-emphasized)",
    },
    extend: {
      keyframes: {
        "halo-pulse": {
          "0%, 100%": { opacity: "0.55", transform: "scale(1)" },
          "50%": { opacity: "0.95", transform: "scale(1.08)" },
        },
        shimmer: { "0%": { backgroundPosition: "-200% 0" }, "100%": { backgroundPosition: "200% 0" } },
      },
      animation: {
        "halo-pulse": "halo-pulse 1.6s var(--ease-standard) infinite",
        shimmer: "shimmer 1.8s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
