import type { Metadata, Viewport } from "next";
import { NavProgress } from "@/components/nav-progress";
import { Toaster } from "@/components/toaster";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Jayngol TMS", template: "%s · Jayngol TMS" },
  description: "Jayngol Transport Services fleet management",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#1a150c" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <NavProgress />
        <Toaster />
        {children}
      </body>
    </html>
  );
}
