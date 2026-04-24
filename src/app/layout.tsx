import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "@/components/convex-client-provider";
import "./globals.css";

const clerkTaskUrls = {
  "choose-organization": "/join-organization",
};

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fabric.",
  description: "Capture how your organization works through conversations",
  icons: {
    shortcut: "/favicon.ico",
    icon: [
      {
        url: "/fabric-icon-black.ico",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/fabric-icon.ico",
        media: "(prefers-color-scheme: dark)",
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} h-full antialiased`}
    >
      <body suppressHydrationWarning className="min-h-full flex flex-col">
        <ClerkProvider taskUrls={clerkTaskUrls}>
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
