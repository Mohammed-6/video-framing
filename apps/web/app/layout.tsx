import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipForge — long videos to viral-ready shorts",
  description: "Upload a long video, get captioned vertical clips for Shorts, Reels and TikTok.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
