"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { AlertTriangle, Mail, MessageSquare, Users } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { StatCard } from "@/components/admin/stat-card";
import { ConversationTranscriptDialog } from "@/components/admin/conversation-transcript-dialog";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function StatusDot({ status }: { status: "processing" | "done" | "failed" }) {
  const color =
    status === "done"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-destructive"
        : "bg-amber-500";
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${color}`}
      aria-label={status}
    />
  );
}

export default function AdminOverviewPage() {
  const [sinceSevenDays] = useState(() => Date.now() - SEVEN_DAYS_MS);
  const [sinceFourteenDays] = useState(
    () => Date.now() - 2 * SEVEN_DAYS_MS,
  );
  const [pendingInvitesCount, setPendingInvitesCount] = useState<
    number | undefined
  >(undefined);
  const [viewingId, setViewingId] = useState<Id<"conversations"> | null>(null);

  const members = useQuery(api.users.listOrgMembers);
  const weeklyConversations = useQuery(api.conversations.countForOrg, {
    since: sinceSevenDays,
  });
  const priorWeekConversations = useQuery(api.conversations.countForOrg, {
    since: sinceFourteenDays,
  });
  const failedConversations = useQuery(api.conversations.countForOrg, {
    status: "failed",
  });
  const recentConversations = useQuery(api.conversations.listAllForOrg, {
    paginationOpts: { numItems: 5, cursor: null },
  });

  const listInvites = useAction(api.invitations.list);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listInvites({});
        if (!cancelled) setPendingInvitesCount(rows.length);
      } catch {
        if (!cancelled) setPendingInvitesCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listInvites]);

  const memberSummary = useMemo(() => {
    if (!members) return undefined;
    const counts = { admin: 0, contributor: 0, viewer: 0 };
    for (const m of members) {
      counts[m.role as keyof typeof counts] += 1;
    }
    return counts;
  }, [members]);

  const weeklyDelta = useMemo(() => {
    if (weeklyConversations === undefined || priorWeekConversations === undefined)
      return null;
    const priorOnlyCount = priorWeekConversations - weeklyConversations;
    if (priorOnlyCount === 0 && weeklyConversations === 0) return null;
    if (priorOnlyCount === 0) return `+${weeklyConversations} vs prior week`;
    const delta = weeklyConversations - priorOnlyCount;
    const sign = delta > 0 ? "+" : "";
    return `${sign}${delta} vs prior week`;
  }, [weeklyConversations, priorWeekConversations]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Overview</h2>
        <p className="text-sm text-muted-foreground">
          A snapshot of activity and health in this workspace.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Members"
          value={members?.length}
          hint={
            memberSummary
              ? `${memberSummary.admin} admin · ${memberSummary.contributor} contributor · ${memberSummary.viewer} viewer`
              : undefined
          }
          icon={Users}
          href="/admin/users"
        />
        <StatCard
          label="Pending invites"
          value={pendingInvitesCount}
          hint={
            pendingInvitesCount === 0
              ? "No outstanding invites"
              : undefined
          }
          icon={Mail}
          href="/admin/users"
        />
        <StatCard
          label="Conversations this week"
          value={weeklyConversations}
          hint={weeklyDelta ?? undefined}
          icon={MessageSquare}
          href="/admin/conversations"
        />
        <StatCard
          label="Failed conversations"
          value={failedConversations}
          hint={
            failedConversations && failedConversations > 0
              ? "Needs attention"
              : "All healthy"
          }
          icon={AlertTriangle}
          href="/admin/conversations?status=failed"
          tone={
            failedConversations && failedConversations > 0
              ? "destructive"
              : "default"
          }
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Recent conversations</h3>
            <p className="text-xs text-muted-foreground">
              The last 5 captured across every process.
            </p>
          </div>
        </div>
        {recentConversations === undefined ? (
          <div className="flex h-20 items-center justify-center rounded-lg border text-sm text-muted-foreground">
            Loading...
          </div>
        ) : recentConversations.page.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No conversations yet.
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {recentConversations.page.map((r) => (
              <button
                type="button"
                key={r._id}
                onClick={() => setViewingId(r._id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
              >
                <StatusDot status={r.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">
                      {r.contributorName}
                    </span>
                    {r.processName && (
                      <span className="shrink truncate rounded-full border border-border px-2 py-0.5 text-xs">
                        {r.processName}
                      </span>
                    )}
                  </div>
                  {r.summary && (
                    <p className="truncate text-xs text-muted-foreground">
                      {r.summary}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelative(r._creationTime)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <ConversationTranscriptDialog
        conversationId={viewingId}
        open={viewingId !== null}
        onOpenChange={(open) => {
          if (!open) setViewingId(null);
        }}
      />
    </div>
  );
}
