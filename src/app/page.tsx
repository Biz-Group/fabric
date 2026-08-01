import type { Metadata } from "next";
import { Instrument_Sans, Newsreader } from "next/font/google";

import { MarketingLandingPage } from "@/features/marketing/marketing-landing-page";

const instrumentSans = Instrument_Sans({
  variable: "--font-marketing-sans",
  subsets: ["latin"],
  display: "swap",
});

const newsreader = Newsreader({
  variable: "--font-marketing-serif",
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://bizfabric.ai"),
  title: "Fabric — See how your business really works",
  description:
    "Fabric turns the conversations behind your operations into living process knowledge, clear maps, and evidence-backed opportunities to improve.",
  alternates: {
    canonical: "https://bizfabric.ai",
  },
  openGraph: {
    type: "website",
    url: "https://bizfabric.ai",
    siteName: "Fabric",
    title: "Fabric — See how your business really works",
    description:
      "Turn the way work really happens into a living map of your business.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Fabric — See how your business really works",
    description:
      "Turn the way work really happens into a living map of your business.",
  },
};

export default function Home() {
  return (
    <div className={`${instrumentSans.variable} ${newsreader.variable}`}>
      <MarketingLandingPage />
    </div>
  );
}
