import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Council",
  description:
    "A local, file-backed room for thinking with a council of AI perspectives.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
