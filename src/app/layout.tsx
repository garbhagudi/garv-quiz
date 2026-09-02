import type { Metadata, Viewport } from "next";
import { Lexend, Nunito } from "next/font/google";
import "./globals.css";

const display = Lexend({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const body = Nunito({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Quiz Challenge - GarbhaGudi",
    template: "%s - GarbhaGudi Quiz",
  },
  description: "Live quiz for GARV 2026, GarbhaGudi.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // Tints the phone browser chrome to match the ground the page sits on. One
  // colour, because the page is light in both themes - see globals.css.
  themeColor: "#fff7f8",
  // Declares that the page handles dark mode itself. It does: by staying
  // light. This is what stops Samsung Internet and Chrome force-darkening it
  // with their own transformation - they use a page's dark styles when it says
  // it has them, and invent their own when it does not.
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
