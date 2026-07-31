"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  Loader2,
  Mic,
  PlayCircle,
  Upload,
  User,
  UserCheck,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { FocusedConversationPlayback } from "@/features/conversations/conversation-log";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const COMPACT_QUERY_LIMIT = 100;
const INITIAL_VISIBLE_COUNT = 8;

type CompactConversationRows = FunctionReturnType<
  typeof api.conversations.listCompactByProcess
>;
type CompactConversation = CompactConversationRows[number];
type ConversationStatus = CompactConversation["status"];
type ConversationInputMode = CompactConversation["inputMode"];
type StatusFilter = "all" | ConversationStatus;
type TypeFilter = "all" | ConversationInputMode;
type SortOrder = "newest" | "oldest";

type ProcessConversationListProps = {
  processId: Id<"processes">;
  canLabelSpeakers: boolean;
  labelingJumpKey?: number;
};

const STATUS_META: Record<
  ConversationStatus,
  { label: string; className: string; icon: LucideIcon }
> = {
  done: {
    label: "Completed",
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200",
    icon: CheckCircle2,
  },
  processing: {
    label: "In progress",
    className:
      "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200",
    icon: Loader2,
  },
  needs_speaker_labels: {
    label: "Needs labels",
    className:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
    icon: Mic,
  },
  failed: {
    label: "Failed",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    icon: AlertCircle,
  },
};

const TYPE_META: Record<
  ConversationInputMode,
  { label: string; icon: LucideIcon }
> = {
  agent: { label: "AI Interview", icon: Bot },
  voiceRecord: { label: "Voice Recording", icon: Mic },
  audioUpload: { label: "Audio Upload", icon: Upload },
};

const STATUS_FILTER_ITEMS: Record<StatusFilter, string> = {
  all: "All conversations",
  done: "Completed",
  processing: "In progress",
  needs_speaker_labels: "Needs labels",
  failed: "Failed",
};

const TYPE_FILTER_ITEMS: Record<TypeFilter, string> = {
  all: "All types",
  agent: "AI Interview",
  voiceRecord: "Voice Recording",
  audioUpload: "Audio Upload",
};

const SORT_ORDER_ITEMS: Record<SortOrder, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
};

function formatDateTime(epochMs: number) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochMs));
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return "--:--";
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function conversationTitleFromParts(
  inputMode: ConversationInputMode,
  contributorName: string,
) {
  return `${TYPE_META[inputMode].label} with ${contributorName}`;
}

/**
 * Prefers the one-line title from post-call analysis (ElevenLabs'
 * `call_summary_title` for interviews, our own model's for uploaded audio) so a
 * row says what was discussed. Rows still processing — or from a provider that
 * returned no title — fall back to the input mode + contributor phrasing.
 */
function conversationTitle(conversation: CompactConversation) {
  return (
    conversation.title?.trim() ||
    conversationTitleFromParts(
      conversation.inputMode,
      conversation.contributorName,
    )
  );
}

function LoadingRows() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="rounded-lg border bg-background p-3">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="size-8 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ConversationRow({
  conversation,
  selected,
  onSelect,
}: {
  conversation: CompactConversation;
  selected: boolean;
  onSelect: () => void;
}) {
  const type = TYPE_META[conversation.inputMode];
  const status = STATUS_META[conversation.status];
  const TypeIcon = type.icon;
  const StatusIcon = status.icon;
  const title = conversationTitle(conversation);
  const needsLabels = conversation.status === "needs_speaker_labels";
  const failed = conversation.status === "failed";

  return (
    <div
      className={cn(
        "group flex min-h-24 items-stretch rounded-lg border bg-background transition-colors",
        selected && "border-org-accent-border bg-org-accent-selected ring-1 ring-org-accent-border",
        needsLabels && !selected && "border-amber-200 bg-amber-50/50 dark:border-amber-500/30 dark:bg-amber-500/10",
        failed && !selected && "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex shrink-0 items-start p-3 pr-0">
        {/* Carries the input mode, so the three capture types are told apart at
            the start of the row rather than by a second trailing icon. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                className={cn(
                  "size-11 rounded-xl bg-background text-foreground shadow-none",
                  selected && "border-org-accent-border text-org-accent",
                )}
                aria-label={
                  conversation.hasAudio
                    ? `${type.label} — open audio for ${title}`
                    : `${type.label} — open details for ${title}`
                }
                onClick={onSelect}
              >
                <TypeIcon className="size-5" aria-hidden="true" />
              </Button>
            }
          />
          <TooltipContent>{type.label}</TooltipContent>
        </Tooltip>
      </div>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start p-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-org-accent-ring/35"
        aria-expanded={selected}
        aria-current={selected ? "true" : undefined}
        aria-label={`${selected ? "Selected conversation" : "Open conversation"}: ${title}`}
        onClick={onSelect}
      >
        <span className="min-w-0 flex-1 space-y-2">
          <span className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <span className="min-w-0 max-w-full truncate text-sm font-medium text-foreground">
              {title}
            </span>
            <Badge variant="outline" className={cn("gap-1.5", status.className)}>
              <StatusIcon
                className={cn(
                  "size-3",
                  conversation.status === "processing" && "animate-spin",
                )}
                aria-hidden="true"
              />
              {status.label}
            </Badge>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {/* The title now describes the conversation rather than naming the
                contributor, so the byline moves here. */}
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <User className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{conversation.contributorName}</span>
            </span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Clock className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{formatDateTime(conversation._creationTime)}</span>
            </span>
            <span className="tabular-nums" title={conversation.durationSeconds === null ? "Duration unavailable" : undefined}>
              {formatDuration(conversation.durationSeconds)}
            </span>
            {/* Set only when an admin recorded on the contributor's behalf. The
                byline above names the contributor, so without this the entry
                reads as their own submission. */}
            {conversation.submittedByName && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <UserCheck className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  Submitted by {conversation.submittedByName}
                </span>
              </span>
            )}
          </span>
        </span>
      </button>
    </div>
  );
}

function ConversationPlaybackPanel({
  processId,
  conversationId,
  canLabelSpeakers,
  hasConversations,
}: {
  processId: Id<"processes">;
  conversationId: Id<"conversations"> | null;
  canLabelSpeakers: boolean;
  hasConversations: boolean;
}) {
  const conversations = useQuery(
    api.conversations.listByProcess,
    conversationId ? { processId } : "skip",
  );
  const conversation = conversations?.find((row) => row._id === conversationId);

  if (!conversationId) {
    return (
      <section className="flex h-full min-h-72 flex-col bg-background">
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <EmptyState
            icon={hasConversations ? PlayCircle : Mic}
            title={hasConversations ? "Select a conversation" : "No conversations yet"}
            description={
              hasConversations
                ? "Playback and transcript review will appear in this panel."
                : "Capture a conversation to start building the process history."
            }
            className="w-full border-0 bg-transparent"
          />
        </div>
      </section>
    );
  }

  if (conversations === undefined) {
    return (
      <section className="flex h-full min-h-72 flex-col bg-background">
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </section>
    );
  }

  if (!conversation) {
    return (
      <section className="flex h-full min-h-72 flex-col bg-background">
        <div className="p-4 text-sm text-muted-foreground">
          Conversation details are no longer available.
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-72 overflow-hidden bg-background">
      <FocusedConversationPlayback
        conversation={conversation}
        canLabelSpeakers={canLabelSpeakers}
      />
    </section>
  );
}

export function ProcessConversationsTab({
  processId,
  canLabelSpeakers,
  labelingJumpKey = 0,
}: ProcessConversationListProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [viewAll, setViewAll] = useState(false);
  const [selectedConversationId, setSelectedConversationId] =
    useState<Id<"conversations"> | null>(null);
  const handledLabelingJumpKey = useRef(0);
  const conversations = useQuery(api.conversations.listCompactByProcess, {
    processId,
    limit: COMPACT_QUERY_LIMIT,
  });

  /* eslint-disable react-hooks/set-state-in-effect -- this responds to an explicit header jump command. */
  useEffect(() => {
    if (
      !labelingJumpKey ||
      handledLabelingJumpKey.current === labelingJumpKey
    ) {
      return;
    }

    setStatusFilter("needs_speaker_labels");
    setTypeFilter("all");
    setViewAll(true);

    if (conversations === undefined) return;

    const firstConversationNeedingLabels = conversations.find(
      (conversation) => conversation.status === "needs_speaker_labels",
    );
    if (firstConversationNeedingLabels) {
      setSelectedConversationId(firstConversationNeedingLabels._id);
    }
    handledLabelingJumpKey.current = labelingJumpKey;
  }, [conversations, labelingJumpKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const filteredConversations = useMemo(() => {
    const rows = conversations ?? [];
    const next = rows.filter((conversation) => {
      const statusMatches =
        statusFilter === "all" || conversation.status === statusFilter;
      const typeMatches =
        typeFilter === "all" || conversation.inputMode === typeFilter;
      return statusMatches && typeMatches;
    });

    return [...next].sort((first, second) =>
      sortOrder === "newest"
        ? second._creationTime - first._creationTime
        : first._creationTime - second._creationTime,
    );
  }, [conversations, sortOrder, statusFilter, typeFilter]);

  const visibleConversations = viewAll
    ? filteredConversations
    : filteredConversations.slice(0, INITIAL_VISIBLE_COUNT);
  const hasMoreConversations =
    filteredConversations.length > visibleConversations.length;
  const hasFilters = statusFilter !== "all" || typeFilter !== "all";
  const activeConversationId =
    visibleConversations.find(
      (conversation) => conversation._id === selectedConversationId,
    )?._id ??
    visibleConversations[0]?._id ??
    null;

  return (
    <TooltipProvider>
      <div className="grid min-h-full min-w-0 gap-0 md:h-full md:min-h-0 md:grid-cols-2">
        <section className="min-w-0 p-4 md:min-h-0 md:overflow-y-auto md:p-6">
          <div className="space-y-4">
            <div className="grid w-full min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]">
              <Select
                value={statusFilter}
                items={STATUS_FILTER_ITEMS}
                onValueChange={(value) => setStatusFilter(value as StatusFilter)}
              >
                <SelectTrigger size="sm" className="w-full" aria-label="Status filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All conversations</SelectItem>
                  <SelectItem value="done">Completed</SelectItem>
                  <SelectItem value="processing">In progress</SelectItem>
                  <SelectItem value="needs_speaker_labels">Needs labels</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={typeFilter}
                items={TYPE_FILTER_ITEMS}
                onValueChange={(value) => setTypeFilter(value as TypeFilter)}
              >
                <SelectTrigger size="sm" className="w-full" aria-label="Type filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="agent">AI Interview</SelectItem>
                  <SelectItem value="voiceRecord">Voice Recording</SelectItem>
                  <SelectItem value="audioUpload">Audio Upload</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={sortOrder}
                items={SORT_ORDER_ITEMS}
                onValueChange={(value) => setSortOrder(value as SortOrder)}
              >
                <SelectTrigger size="sm" className="w-full" aria-label="Sort conversations">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="oldest">Oldest first</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {conversations === undefined ? (
              <LoadingRows />
            ) : conversations.length === 0 ? (
              <EmptyState
                icon={Mic}
                title="No conversations yet"
                description="Record a conversation to start building the process history."
                className="min-h-72"
              />
            ) : filteredConversations.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No matching conversations"
                description={hasFilters ? "Clear a filter to see more conversations." : undefined}
                className="min-h-72"
              />
            ) : (
              <div className="space-y-3">
                {visibleConversations.map((conversation) => (
                  <ConversationRow
                    key={conversation._id}
                    conversation={conversation}
                    selected={activeConversationId === conversation._id}
                    onSelect={() => setSelectedConversationId(conversation._id)}
                  />
                ))}

                {filteredConversations.length > INITIAL_VISIBLE_COUNT && (
                  <div className="flex justify-center pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => setViewAll((current) => !current)}
                    >
                      {viewAll ? (
                        <ChevronUp className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                      {viewAll
                        ? "Show fewer"
                        : `View all conversations (${filteredConversations.length})`}
                    </Button>
                  </div>
                )}

                {hasMoreConversations && (
                  <p className="text-center text-xs text-muted-foreground">
                    Showing {visibleConversations.length} of {filteredConversations.length}
                  </p>
                )}
              </div>
            )}
          </div>
        </section>

        <aside className="min-w-0 border-t p-4 md:min-h-0 md:overflow-hidden md:border-l md:border-t-0 md:p-6">
          <ConversationPlaybackPanel
            processId={processId}
            conversationId={activeConversationId}
            canLabelSpeakers={canLabelSpeakers}
            hasConversations={(conversations?.length ?? 0) > 0}
          />
        </aside>
      </div>
    </TooltipProvider>
  );
}
