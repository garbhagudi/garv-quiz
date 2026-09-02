import type { Config } from "tailwindcss";

/**
 * The palette is carried over from the original quiz page so the rebuild still
 * looks like GarbhaGudi: deep plum ground, cream cards, apricot as the single
 * accent that marks "act here".
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Every value is a CSS variable set in src/app/globals.css, once for
        // light and once under prefers-color-scheme: dark. <alpha-value> keeps
        // the opacity modifiers (bg-petal/60, border-ink/10) working as before.
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        body: "rgb(var(--c-body) / <alpha-value>)",
        sub: "rgb(var(--c-sub) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",
        // The GARV crimson. `light`, `dark` and `tint` are the crimson band on
        // the home page and its small print, which stays crimson in both
        // themes, so they are the one set of colours left as plain hex.
        brand: {
          DEFAULT: "rgb(var(--c-brand) / <alpha-value>)",
          deep: "rgb(var(--c-brand-deep) / <alpha-value>)",
          light: "#f01a54",
          dark: "#8b0429",
          tint: "#ffd9e2",
        },
        // `plum` is the ink of headings; `fill` is the ground under white button
        // text. One colour in light, two in dark - see globals.css.
        plum: {
          DEFAULT: "rgb(var(--c-plum) / <alpha-value>)",
          soft: "rgb(var(--c-plum-soft) / <alpha-value>)",
          deep: "rgb(var(--c-plum-deep) / <alpha-value>)",
          fill: "rgb(var(--c-plum-fill) / <alpha-value>)",
          "fill-deep": "rgb(var(--c-plum-fill-deep) / <alpha-value>)",
        },
        apricot: { DEFAULT: "rgb(var(--c-apricot) / <alpha-value>)", deep: "rgb(var(--c-apricot-deep) / <alpha-value>)" },
        coral: "rgb(var(--c-coral) / <alpha-value>)",
        moss: { DEFAULT: "rgb(var(--c-moss) / <alpha-value>)", fill: "rgb(var(--c-moss-fill) / <alpha-value>)" },
        cream: "rgb(var(--c-cream) / <alpha-value>)",
        petal: "rgb(var(--c-petal) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        ground: "rgb(var(--c-ground) / <alpha-value>)",
        desk: "rgb(var(--c-desk) / <alpha-value>)",
        prize: { from: "rgb(var(--c-prize-from) / <alpha-value>)", to: "rgb(var(--c-prize-to) / <alpha-value>)", ink: "rgb(var(--c-prize-ink) / <alpha-value>)" },
        scrim: "rgb(var(--c-scrim) / <alpha-value>)",
      },
      fontFamily: {
        display: ["var(--font-display)", "Lexend", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "Nunito", "system-ui", "sans-serif"],
      },
      borderRadius: { xl2: "1.25rem", xl3: "1.6rem" },
      spacing: { "4.5": "1.125rem", "5.5": "1.375rem" },
      boxShadow: {
        card: "0 10px 30px -12px rgba(36,21,57,.28)",
        lift: "0 18px 45px -20px rgba(36,21,57,.45)",
        bar: "0 8px 24px -14px rgba(36,21,57,.55)",
      },
      keyframes: {
        pulseDot: {
          "0%,100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.28)" },
        },
        rise: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        pulseDot: "pulseDot 1.4s ease-in-out infinite",
        rise: "rise .28s cubic-bezier(.2,.7,.3,1) both",
      },
    },
  },
  plugins: [],
};

export default config;
