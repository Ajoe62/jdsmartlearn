import type { Metadata, Viewport } from "next";
import { Outfit } from "next/font/google";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import "./globals.css";

/**
 * The display face: headings, the wordmark and numerals. Geometric, low stroke
 * contrast, circular bowls - the closest widely available match to the ilumo
 * wordmark.
 *
 * next/font SELF-HOSTS this into /_next/static/media at build time, which the
 * service worker already cache-firsts. So it costs one request on a student's
 * first visit and nothing after, and no request ever leaves for a third party.
 * Body copy deliberately stays on the system stack - see globals.css.
 */
const display = Outfit({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  // No `weight`: Outfit is variable, so this ships one file declared
  // `font-weight: 100 900` rather than a static instance per weight.
  //
  // Measured cost to a student on first load: 32 KB. next/font splits the face
  // by unicode-range, and only the basic-latin file is preloaded - the latin-ext
  // file is never fetched for English content. It also generates an "Outfit
  // Fallback" from local Arial with ascent/descent overrides, so the swap costs
  // no layout shift. None of this counts against the 30 KB student JS budget.
});

export const metadata: Metadata = {
  title: {
    default: "JDSmartLearn — an Ilumotech product",
    template: "%s · JDSmartLearn",
  },
  description: "Upload a lesson. Get a summary and practice questions back.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "JDSmartLearn", statusBarStyle: "default" },
};

/** 360px phones first - no user-scalable lock, students need to zoom text. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#3852D6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={display.variable}>
      <body className="min-h-dvh">
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
