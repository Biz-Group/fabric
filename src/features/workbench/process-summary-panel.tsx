"use client";

import { useState } from "react";
import { Check, Copy, FileText, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MarkdownSummary } from "@/features/workbench/markdown-summary";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copying" | "copied" | "failed";

type ProcessSummaryPanelProps = {
  summary: string | null | undefined;
  isLoading: boolean;
  canRefresh: boolean;
  isRefreshing: boolean;
  onRefresh: () => Promise<void> | void;
};

function LoadingSummaryPanel() {
  return (
    <section className="flex h-full min-h-72 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-2 pb-3">
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
      <div className="min-h-0 flex-1 space-y-3">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-4 h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
      </div>
    </section>
  );
}

function RebuildingText({ hasSummary }: { hasSummary: boolean }) {
  return (
    <div>
      <p className="text-sm font-medium">
        {hasSummary ? "Rebuilding summary" : "Building summary"}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        Each conversation is re-read before the summary is merged, so this can
        take a few minutes. You can leave this page.
      </p>
    </div>
  );
}

export function ProcessSummaryPanel({
  summary,
  isLoading,
  canRefresh,
  isRefreshing,
  onRefresh,
}: ProcessSummaryPanelProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const summaryText = summary?.trim() ?? "";
  const hasSummary = summaryText.length > 0;

  if (isLoading) return <LoadingSummaryPanel />;

  const copyLabel =
    copyState === "copying"
      ? "Copying"
      : copyState === "copied"
        ? "Copied"
        : copyState === "failed"
          ? "Copy failed"
          : "Copy Summary";

  const handleCopy = async () => {
    if (!summaryText) return;
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(summaryText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    } finally {
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  };

  return (
    <section className="flex h-full min-h-72 flex-col">
      {(hasSummary || canRefresh) && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pb-3">
          {hasSummary && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={copyState === "copying"}
                    onClick={handleCopy}
                    aria-label={copyLabel}
                  >
                    {copyState === "copied" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                }
              />
              <TooltipContent>{copyLabel}</TooltipContent>
            </Tooltip>
          )}
          {canRefresh && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={isRefreshing}
              onClick={onRefresh}
            >
              {isRefreshing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {isRefreshing ? "Rebuilding" : "Rebuild"}
            </Button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {hasSummary ? (
          <div className="min-h-full">
            {isRefreshing && (
              // Sticky rather than an overlay centred on the content: a long
              // summary put the middle of the scroll area well below the fold,
              // so the message only appeared if you scrolled to find it. This
              // stays at the top of the visible area however far down you are.
              <div className="bg-background/95 sticky top-0 z-10 mb-3 flex items-start gap-3 rounded-lg border px-4 py-3 backdrop-blur-sm">
                <Loader2 className="text-org-accent mt-0.5 size-4 shrink-0 animate-spin" />
                <RebuildingText hasSummary />
              </div>
            )}
            <div className={cn("pb-2", isRefreshing && "opacity-50")}>
              <MarkdownSummary content={summaryText} />
            </div>
          </div>
        ) : isRefreshing ? (
          // A first summary is generated the same way, so the panel must say
          // so rather than claim there is nothing here. Centred is right here:
          // there is no content to scroll past.
          <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 text-center">
            <Loader2 className="text-org-accent size-6 animate-spin" />
            <RebuildingText hasSummary={false} />
          </div>
        ) : (
          <EmptyState
            icon={FileText}
            title="No process summary yet"
            description="Complete a conversation to generate the rolling process summary."
            className="h-full min-h-64"
          />
        )}
      </div>
    </section>
  );
}
