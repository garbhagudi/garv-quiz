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
        ink: "#241539",
        // The GARV crimson. `light` and `dark` only exist to give the page
        // background depth and to keep small text on it legible; `DEFAULT` is
        // the brand colour itself, taken from the GARV wordmark.
        //
        // `tint` is the pale pink that small print on the crimson ground is set
        // in — 4:1 against DEFAULT at the top of the page and 7.5:1 against
        // `dark` at the foot, which is where that print actually sits.
        brand: {
          DEFAULT: "#d90743",
          light: "#f01a54",
          deep: "#ad0535",
          dark: "#8b0429",
          tint: "#ffd9e2",
        },
        plum: { DEFAULT: "#4C2A6E", soft: "#6B4691", deep: "#3A2058" },
        apricot: { DEFAULT: "#F5A25D", deep: "#E08A3C" },
        coral: "#E2685B",
        moss: "#3F8F6F",
        cream: "#FFFBF6",
        petal: "#F2EBFA",
        muted: "#7A6790",
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
