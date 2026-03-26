"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id, Doc } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  AudioPlayerProvider,
  AudioPlayerButton,
  AudioPlayerProgress,
} from "@/components/ui/audio-player";
import {
  MessageSquare,
  Mic,
  ChevronRight,
  User,
  Loader2,
  AlertCircle,
} from "lucide-react";

// --- Helpers ---

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function getAudioUrl(elevenlabsConversationId: string): string {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
  const siteUrl = convexUrl.replace(".cloud", ".site");
  return `${siteUrl}/audio/${elevenlabsConversationId}`;
}

// --- Types ---

interface TranscriptMessage {
  role: string;
  content: string;
  time_in_call_secs: number;
}

// --- Conversation Entry ---

function ConversationEntry({
  conversation,
}: {
  conversation: Doc<"conversations">;
}) {
  const isProcessing = conversation.status === "processing";
  const isFailed = conversation.status === "failed";
  const audioUrl = getAudioUrl(conversation.elevenlabsConversationId);
  const transcript = conversation.transcript as
    | TranscriptMessage[]
    | undefined;

  return (
    <Card
      className={cn(
        isFailed && "border-destructive/30 opacity-60"
      )}
    >
      <CardContent className="space-y-3">
        {/* Header: contributor name + date + duration */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <User className="h-3.5 w-3.5 text-primary" />
            </div>
            <span className="text-sm font-medium">
              {conversation.contributorName}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span>{formatDate(conversation._creationTime)}</span>
            {conversation.durationSeconds != null && (
              <>
                <span>·</span>
                <span>{formatDuration(conversation.durationSeconds)}</span>
              </>
            )}
          </div>
        </div>

        {/* Status: processing */}
        {isProcessing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Processing conversation...
          </div>
        )}

        {/* Status: failed */}
        {isFailed && (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" />
            Processing failed
          </div>
        )}

        {/* AI-generated summary — collapsible, default collapsed */}
        {conversation.summary && (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[panel-open]:rotate-90" />
              Summary
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="mt-2 pl-[18px] text-sm leading-relaxed text-muted-foreground">
                {conversation.summary}
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Audio Player — play/pause + scrub bar + duration */}
        {conversation.status === "done" && (
          <div className="flex items-center gap-3">
            <AudioPlayerButton
              item={{
                id: conversation._id,
                src: audioUrl,
              }}
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
            />
            <AudioPlayerProgress className="flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {conversation.durationSeconds != null
                ? formatDuration(conversation.durationSeconds)
                : "--:--"}
            </span>
          </div>
        )}

        {/* Full transcript — collapsible, default collapsed */}
        {transcript && transcript.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[panel-open]:rotate-90" />
              Full Transcript
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 space-y-3 pl-[18px]">
                {transcript.map((msg, i) => (
                  <div key={i} className="text-sm leading-relaxed">
                    <span
                      className={cn(
                        "font-medium",
                        msg.role === "ai"
                          ? "text-primary"
                          : "text-foreground"
                      )}
                    >
                      {msg.role === "ai"
                        ? "Fabric"
                        : conversation.contributorName}
                    </span>
                    <span className="text-muted-foreground">
                      {" \u2014 "}
                      {msg.content}
                    </span>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

// --- Main Component ---

export function ConversationLog({
  processId,
}: {
  processId: Id<"processes">;
}) {
  const conversations = useQuery(api.conversations.listByProcess, {
    processId,
  });

  return (
    <div>
      <div className="flex items-center gap-2 pb-3">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Conversations</h3>
        {conversations && conversations.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {conversations.length}
          </span>
        )}
      </div>
      <Separator />

      {conversations === undefined ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : conversations.length === 0 ? (
        <Card className="mt-3">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <div className="rounded-xl bg-muted/60 p-3">
              <Mic className="h-6 w-6 text-muted-foreground/70" />
            </div>
            <p className="max-w-[260px] text-center text-sm text-muted-foreground">
              No conversations yet — be the first to record how this process
              works.
            </p>
          </CardContent>
        </Card>
      ) : (
        <AudioPlayerProvider>
          <div className="mt-3 space-y-3">
            {conversations.map((conv) => (
              <ConversationEntry key={conv._id} conversation={conv} />
            ))}
          </div>
        </AudioPlayerProvider>
      )}
    </div>
  );
}
