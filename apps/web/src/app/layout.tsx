import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Green Valley Developers — Voice AI Sales Console",
  description: "AI voice sales agent console for Green Valley Residency leads.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-stone-50 text-stone-900">{children}</body>
    </html>
  );
}
