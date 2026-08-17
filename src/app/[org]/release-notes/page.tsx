import type { Metadata } from "next";
import { Instrument_Sans, Newsreader } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReleaseNotes } from "@/features/release-notes/release-notes";
import { WorkspaceAppShell } from "@/features/shell/process-app-shell";

const releaseSans = Instrument_Sans({
  variable: "--font-release-sans",
  subsets: ["latin"],
  display: "swap",
});

const releaseSerif = Newsreader({
  variable: "--font-release-serif",
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Release notes | Fabric",
  description: "Monthly product updates from Fabric.",
};

export default function ReleaseNotesPage() {
  return (
    <TooltipProvider>
      <div
        className={`${releaseSans.variable} ${releaseSerif.variable} h-dvh`}
      >
        <WorkspaceAppShell
          title="Release notes"
          mainClassName="overflow-y-auto overscroll-y-contain"
        >
          <ReleaseNotes />
        </WorkspaceAppShell>
      </div>
    </TooltipProvider>
  );
}
