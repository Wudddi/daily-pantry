import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "每日库存 · 我的健康记录",
  description: "记录食物库存、体重趋势和每一组训练，让饮食与训练分析读取同一份最新记录。",
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
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
