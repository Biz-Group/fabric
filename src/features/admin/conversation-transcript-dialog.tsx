"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

type TranscriptMessage = {
  role: string;
  content: string;
  speakerName?: string;
};

function transcriptSpeakerName(
  msg: TranscriptMessage,
  contributorName: string,
): string {
  return msg.speakerName ?? (msg.role === "user" ? contributorName : "Agent");
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ConversationTranscriptDialog({
  conversationId,
  open,
  onOpenChange,
}: {
  conversationId: Id<"conversations"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const conversation = useQuery(
    api.conversations.getForAdmin,
    conversationId ? { conversationId } : "skip",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {conversation?.contributorName ?? "Conversation"}
          </DialogTitle>
          <DialogDescription>
            {conversation
              ? [
                  formatDateTime(conversation._creationTime),
                  formatDuration(conversation.durationSeconds),
                  // Only present when an admin filed this for someone else; the
                  // dialog is titled with the contributor's name, so an admin
                  // auditing the record needs to see who actually submitted it.
                  conversation.submittedByName
                    ? `Submitted by ${conversation.submittedByName}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Loading..."}
          </DialogDescription>
        </DialogHeader>

        {conversation === undefined && (
          <div className="flex h-40 items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        )}

        {conversation && (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            <div className="flex items-center gap-2">
              <StatusBadge status={conversation.status} />
            </div>

            {conversation.summary && (
              <section className="space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Summary
                </h4>
                <p className="text-sm whitespace-pre-wrap">
                  {conversation.summary}
                </p>
              </section>
            )}

            {conversation.transcript && conversation.transcript.length > 0 ? (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Transcript
                </h4>
                <div className="space-y-2 rounded-md border p-3">
                  {conversation.transcript.map((msg, i) => (
                    <div
                      key={i}
                      className={
                        msg.role === "user"
                          ? "text-sm"
                          : "text-sm text-muted-foreground"
                      }
                    >
                      <span className="mr-1.5 text-xs font-medium uppercase">
                        {transcriptSpeakerName(
                          msg as TranscriptMessage,
                          conversation.contributorName,
                        )}
                      </span>
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">
                No transcript available.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({
  status,
}: {
  status: "processing" | "needs_speaker_labels" | "done" | "failed";
}) {
  if (status === "done") return <Badge variant="secondary">Done</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "needs_speaker_labels") {
    return <Badge variant="outline">Needs Speaker Labels</Badge>;
  }
  return <Badge variant="outline">Processing</Badge>;
}
