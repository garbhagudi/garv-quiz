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
  // Tints the phone browser chrome to match the ground the page sits on.
  themeColor: "#fff7f8",
  // This palette is light on purpose - blush ground, cream card, plum ink - and
  // has no dark counterpart. Without saying so, Chrome on Android, Samsung
  // Internet and others treat the silence as "no opinion" and darken the page
  // themselves, which turns the brand crimson and the join QR into something
  // else. Declared here, in the head, so it is known before any stylesheet
  // loads; repeated in globals.css so it holds for every element after.
  colorScheme: "light",
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
