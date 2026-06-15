import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { ThemeProvider } from "next-themes";
import ServiceWorkerRegister from "./ServiceWorkerRegister";
import "./globals.css";

const defaultUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(defaultUrl),
  title: "LeylineSync",
  description: "Your phone, your controller — couch-play Magic.",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  // Lets iOS Safari run the home-screen install fullscreen (no URL bar).
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "LeylineSync",
  },
};

export const viewport: Viewport = {
  themeColor: "#0F1117",
  // Draw under the notch / home indicator so `svh` + safe-area insets can use
  // the full screen once browser chrome is hidden.
  viewportFit: "cover",
};

const geistSans = Geist({
  variable: "--font-geist-sans",
  display: "swap",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.className} antialiased`} suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ServiceWorkerRegister />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
