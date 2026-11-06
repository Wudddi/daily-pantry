import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Daily Pantry · Personal health records",
  description: "Track inventory, weight trends and every training set so meal and training analysis use the same current records.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-CA">
      <body className="antialiased">{children}</body>
    </html>
  );
}
