import type { Metadata, Viewport } from "next";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import "./globals.css";

export const metadata: Metadata = {
  title: "JDSmartLearn",
  description: "Upload a lesson. Get a summary and practice questions back.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "JDSmartLearn", statusBarStyle: "default" },
};

/** 360px phones first - no user-scalable lock, students need to zoom text. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
