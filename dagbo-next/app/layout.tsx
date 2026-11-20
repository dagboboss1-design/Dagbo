import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DAGBO SIGNAL — Signal Wey No Dey Lie",
  description: "A real-data trading intelligence workspace.",
  applicationName: "DAGBO SIGNAL",
  manifest: "/manifest.webmanifest",
};
export const viewport: Viewport = { themeColor: "#080808", width: "device-width", initialScale: 1 };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
