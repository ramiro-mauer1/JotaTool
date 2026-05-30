import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "JotaTool — Batch Watermark Remover",
  description: "Herramienta interna premium para eliminar marcas de agua de lotes de imágenes con IA.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={GeistSans.className}>
      <body className="antialiased selection:bg-gold-500/30 selection:text-gold-200">
        {children}
      </body>
    </html>
  );
}
