"use client";

import { useCallback, useState } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export type ProcessPdfDownloadArgs = {
  processId: Id<"processes">;
  processName: string;
  functionName: string;
  departmentName: string;
  summary: string | null;
  contributorName: string | null;
  submittedByName: string | null;
  lastUpdatedAt: number | null;
  completedConversationCount: number;
};

function sanitizeFilename(name: string) {
  const base = name
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return base || "process";
}

/**
 * Generates a polished process report PDF on the client. The flow document is
 * fetched fresh at click time, and @react-pdf/renderer is dynamically imported
 * so it never ships in the main bundle.
 */
export function useProcessPdfDownload() {
  const convex = useConvex();
  const [isDownloading, setIsDownloading] = useState(false);

  const download = useCallback(
    async (args: ProcessPdfDownloadArgs) => {
      setIsDownloading(true);
      const toastId = toast.loading("Generating PDF…");
      try {
        const flow = await convex.query(api.processFlows.getProcessFlow, {
          processId: args.processId,
        });
        const { generateProcessPdfBlob } = await import(
          "./process-pdf-document"
        );
        const blob = await generateProcessPdfBlob({
          processName: args.processName,
          functionName: args.functionName,
          departmentName: args.departmentName,
          summary: args.summary,
          contributorName: args.contributorName,
          submittedByName: args.submittedByName,
          lastUpdatedAt: args.lastUpdatedAt,
          completedConversationCount: args.completedConversationCount,
          flow,
          generatedAt: Date.now(),
        });

        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${sanitizeFilename(args.processName)}-process-report.pdf`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);

        toast.success("PDF downloaded", { id: toastId });
        return true;
      } catch (error) {
        console.error("Failed to generate process PDF", error);
        toast.error("Could not generate the PDF. Please try again.", {
          id: toastId,
        });
        return false;
      } finally {
        setIsDownloading(false);
      }
    },
    [convex],
  );

  return { download, isDownloading };
}
