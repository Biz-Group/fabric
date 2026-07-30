"use client";

import { useMemo, useState } from "react";
import { useOrganization } from "@clerk/nextjs";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import {
  Bot,
  Check,
  ChevronDown,
  Download,
  GitBranch,
  Loader2,
  Mic,
  MoreHorizontal,
  Pencil,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type ProcessWorkbench = NonNullable<
  FunctionReturnType<typeof api.processes.getWorkbench>
>;

type ProcessHeaderProps = {
  processName: string;
  functionName: string;
  departmentName: string;
  workbench: ProcessWorkbench | null | undefined;
  canEdit: boolean;
  functionHref: string;
  departmentHref: string;
  onSelectFunction: () => void;
  onSelectDepartment: () => void;
  onCopyLink: () => Promise<boolean>;
  onJumpToLabeling: () => void;
  onEditProcess: () => void;
  onMoveProcess: () => void;
  onDeleteProcess: () => void;
  onDownloadProcess: () => void;
  isDownloading: boolean;
  onStartInterview: () => void;
  onRecordVoice: () => void;
  onUploadAudio: () => void;
};

type CopyState = "idle" | "copying" | "copied" | "failed";

function formatRelativeTime(epochMs: number | null | undefined) {
  if (!epochMs) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatAbsoluteTime(epochMs: number | null | undefined) {
  if (!epochMs) return undefined;
  return new Date(epochMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateTimeAttribute(epochMs: number | null | undefined) {
  if (!epochMs) return undefined;
  return new Date(epochMs).toISOString();
}

function getInitials(name: string | null | undefined) {
  if (!name) return "--";
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "--";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function statusClassName(status: ProcessWorkbench["pendingWork"]["status"]) {
  if (status === "needs_labels") {
    return "border-amber-500 bg-amber-500 text-white hover:bg-amber-500/90";
  }
  if (status === "failed") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (status === "processing") {
    return "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200";
  }
  return "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200";
}

function ProcessStatusBadge({
  workbench,
  onJumpToLabeling,
}: {
  workbench: ProcessWorkbench | null | undefined;
  onJumpToLabeling: () => void;
}) {
  if (workbench === undefined) {
    return <Skeleton className="h-5 w-20 rounded-full" />;
  }

  if (workbench === null) {
    return (
      <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground">
        Unavailable
      </Badge>
    );
  }

  if (workbench.pendingWork.status === "current") {
    return null;
  }

  if (workbench.pendingWork.status === "needs_labels") {
    return (
      <Badge
        variant="outline"
        render={
          <button
            type="button"
            aria-label={`${workbench.pendingWork.label}, jump to labeling`}
          />
        }
          className={cn(
          "gap-1.5 focus-visible:ring-3 focus-visible:ring-org-accent-ring/35",
          statusClassName(workbench.pendingWork.status),
        )}
        onClick={onJumpToLabeling}
      >
        {workbench.pendingWork.label}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5", statusClassName(workbench.pendingWork.status))}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {workbench.pendingWork.label}
    </Badge>
  );
}

function ProcessMetadata({
  contributorName,
  submittedByName,
  contributorImageUrl,
  updatedAt,
  relativeUpdatedAt,
  absoluteUpdatedAt,
  dateTime,
}: {
  contributorName: string | null | undefined;
  submittedByName: string | null | undefined;
  contributorImageUrl: string | null | undefined;
  updatedAt: number | null | undefined;
  relativeUpdatedAt: string | null;
  absoluteUpdatedAt?: string;
  dateTime?: string;
}) {
  const displayName = contributorName ?? "No contributor yet";

  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {contributorImageUrl ? (
        // Clerk-hosted avatar served from an external CDN; next/image would
        // require host allowlisting for a 24px image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={contributorImageUrl}
          alt=""
          aria-hidden="true"
          className="size-6 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-org-accent-subtle text-[10px] font-semibold text-org-accent"
          aria-hidden="true"
        >
          {getInitials(contributorName)}
        </span>
      )}
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground/80">{displayName}</span>
        {/* Present only when someone filed this on the contributor's behalf.
            Without it the byline would read as the contributor's own submission. */}
        {submittedByName && (
          <span title={`Submitted by ${submittedByName}`}>
            {" "}
            (submitted by {submittedByName})
          </span>
        )}
        <span aria-hidden="true"> · </span>
        {updatedAt && dateTime ? (
          <time dateTime={dateTime} title={absoluteUpdatedAt}>
            Updated {relativeUpdatedAt ?? "just now"}
          </time>
        ) : (
          <span>Not updated</span>
        )}
      </span>
    </div>
  );
}

function CaptureSplitButton({
  disabled,
  onStartInterview,
  onRecordVoice,
  onUploadAudio,
}: {
  disabled: boolean;
  onStartInterview: () => void;
  onRecordVoice: () => void;
  onUploadAudio: () => void;
}) {
  return (
    <div className="inline-flex min-w-0 shrink-0 rounded-lg shadow-sm">
      <Button
        type="button"
        className="min-h-10 min-w-0 justify-start gap-2 rounded-r-none px-3 sm:w-auto"
        disabled={disabled}
        onClick={onStartInterview}
      >
        <Bot className="size-4" />
        <span className="truncate">Start AI interview</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              className="min-h-10 rounded-l-none border-l border-primary-foreground/20 px-2"
              disabled={disabled}
              aria-label="Choose capture method"
            />
          }
        >
          <ChevronDown className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent role="menu" align="end" className="w-48">
          <DropdownMenuItem onClick={onRecordVoice}>
            <Mic className="size-4" />
            Record voice
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onUploadAudio}>
            <Upload className="size-4" />
            Upload audio
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ProcessHeader({
  processName,
  functionName,
  departmentName,
  workbench,
  canEdit,
  functionHref,
  departmentHref,
  onSelectFunction,
  onSelectDepartment,
  onCopyLink,
  onJumpToLabeling,
  onEditProcess,
  onMoveProcess,
  onDeleteProcess,
  onDownloadProcess,
  isDownloading,
  onStartInterview,
  onRecordVoice,
  onUploadAudio,
}: ProcessHeaderProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const latestContributor = workbench?.latestContributor;

  // Resolve the contributor's uploaded Clerk avatar by matching their Clerk
  // user id against the active org's membership list. Members beyond the first
  // page (large orgs) simply fall back to initials.
  const { memberships } = useOrganization({
    memberships: { pageSize: 100, keepPreviousData: true },
  });
  const contributorImageUrl = useMemo(() => {
    const clerkUserId = latestContributor?.clerkUserId;
    if (!clerkUserId) return null;
    const match = memberships?.data?.find(
      (member) => member.publicUserData?.userId === clerkUserId,
    );
    return match?.publicUserData?.hasImage
      ? match.publicUserData.imageUrl
      : null;
  }, [latestContributor?.clerkUserId, memberships?.data]);
  const lastUpdated = formatRelativeTime(workbench?.lastUpdatedAt);
  const lastUpdatedTitle = formatAbsoluteTime(workbench?.lastUpdatedAt);
  const lastUpdatedDateTime = formatDateTimeAttribute(workbench?.lastUpdatedAt);
  const captureDisabled = workbench === null;
  const safeProcessName = processName || "process";

  const handleCopyLink = async () => {
    setCopyState("copying");
    const copied = await onCopyLink();
    setCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  };

  const copyLabel =
    copyState === "copying"
      ? "Copying"
      : copyState === "copied"
        ? "Copied"
        : copyState === "failed"
          ? "Copy failed"
          : "Share";

  return (
    <header className="shrink-0 border-b bg-background">
      <div className="space-y-4 px-4 py-4 md:px-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            <Breadcrumb>
              <BreadcrumbList className="text-xs">
                <BreadcrumbItem>
                  <BreadcrumbLink
                    href={functionHref}
                    title={functionName || "Function"}
                    className="block max-w-40 truncate rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-org-accent-ring/35"
                    onClick={(event) => {
                      event.preventDefault();
                      onSelectFunction();
                    }}
                  >
                    {functionName || "Function"}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink
                    href={departmentHref}
                    title={departmentName || "Department"}
                    className="block max-w-48 truncate rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-org-accent-ring/35"
                    onClick={(event) => {
                      event.preventDefault();
                      onSelectDepartment();
                    }}
                  >
                    {departmentName || "Department"}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem className="min-w-0">
                  <span
                    aria-current="page"
                    title={processName || "Process"}
                    className="block max-w-72 truncate text-xs text-foreground"
                  >
                    {processName || "Process"}
                  </span>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>

            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 max-w-full break-words text-2xl font-semibold tracking-normal md:text-3xl">
                {processName || "Untitled process"}
              </h1>
              <ProcessStatusBadge
                workbench={workbench}
                onJumpToLabeling={onJumpToLabeling}
              />
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ProcessMetadata
                contributorName={latestContributor?.name}
                submittedByName={latestContributor?.submittedByName}
                contributorImageUrl={contributorImageUrl}
                updatedAt={workbench?.lastUpdatedAt}
                relativeUpdatedAt={lastUpdated}
                absoluteUpdatedAt={lastUpdatedTitle}
                dateTime={lastUpdatedDateTime}
              />
              {workbench?.flow?.stale && (
                <Badge
                  variant="outline"
                  className="border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200"
                >
                  Flow stale
                </Badge>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-3 xl:flex-nowrap xl:justify-end">
            {canEdit && (
              <CaptureSplitButton
                disabled={captureDisabled}
                onStartInterview={onStartInterview}
                onRecordVoice={onRecordVoice}
                onUploadAudio={onUploadAudio}
              />
            )}
            <div
              className={cn(
                "flex shrink-0 items-center gap-1.5",
                canEdit && "border-l pl-3",
              )}
            >
              <Button
                type="button"
                variant="ghost"
                className="hidden min-h-10 justify-start gap-2 px-2.5 text-muted-foreground hover:text-foreground md:inline-flex"
                onClick={handleCopyLink}
                disabled={copyState === "copying"}
              >
                {copyState === "copying" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : copyState === "copied" ? (
                  <Check className="size-4" />
                ) : (
                  <Share2 className="size-4" />
                )}
                {copyLabel}
              </Button>
              <div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-lg"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`More actions for ${safeProcessName}`}
                      />
                    }
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent role="menu" align="end" className="w-48">
                    <DropdownMenuItem
                      className="md:hidden"
                      disabled={copyState === "copying"}
                      onClick={handleCopyLink}
                    >
                      {copyState === "copying" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : copyState === "copied" ? (
                        <Check className="size-4" />
                      ) : (
                        <Share2 className="size-4" />
                      )}
                      {copyLabel}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="md:hidden" />
                    <DropdownMenuItem
                      disabled={isDownloading}
                      onClick={onDownloadProcess}
                    >
                      {isDownloading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      {isDownloading ? "Preparing PDF…" : "Download PDF"}
                    </DropdownMenuItem>
                    {canEdit && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={onEditProcess}>
                          <Pencil className="size-4" />
                          Edit process
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onMoveProcess}>
                          <GitBranch className="size-4" />
                          Move process
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={onDeleteProcess}
                        >
                          <Trash2 className="size-4" />
                          Delete process
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
