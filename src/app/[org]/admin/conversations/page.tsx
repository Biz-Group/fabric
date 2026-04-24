"use client";

import { useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import {
  useAction,
  useConvex,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { toast } from "sonner";
import {
  Bot,
  Download,
  Mic,
  MoreHorizontal,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

type ConversationRow = FunctionReturnType<
  typeof api.conversations.listAllForOrg
>["page"][number];
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ConversationTranscriptDialog } from "@/components/admin/conversation-transcript-dialog";
import {
  buildConversationsCsv,
  downloadCsv,
} from "@/components/admin/conversations-export";

type Status = "processing" | "done" | "failed";
type StatusFilter = "all" | Status;

const PAGE_SIZE = 50;

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function StatusBadge({ status }: { status: Status }) {
  if (status === "done") return <Badge variant="secondary">Done</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="outline">Processing</Badge>;
}

function getConversationTypeLabel(inputMode: ConversationRow["inputMode"]) {
  return inputMode === "voiceRecord" ? "Voice Recording" : "AI Interview";
}

function ConversationTypeBadge({
  inputMode,
}: {
  inputMode: ConversationRow["inputMode"];
}) {
  const isVoiceRecording = inputMode === "voiceRecord";
  const Icon = isVoiceRecording ? Mic : Bot;

  return (
    <Badge
      variant={isVoiceRecording ? "outline" : "secondary"}
      className="gap-1.5"
    >
      <Icon />
      {getConversationTypeLabel(inputMode)}
    </Badge>
  );
}

export default function AdminConversationsPage() {
  const searchParams = useSearchParams();
  const initialStatus = useMemo<StatusFilter>(() => {
    const fromUrl = searchParams.get("status");
    if (fromUrl === "done" || fromUrl === "processing" || fromUrl === "failed") {
      return fromUrl;
    }
    return "all";
  }, [searchParams]);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus);
  const [search, setSearch] = useState("");
  const [viewingId, setViewingId] = useState<Id<"conversations"> | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<Id<"conversations"> | null>(null);
  const [retryingId, setRetryingId] = useState<Id<"conversations"> | null>(null);
  const [exporting, setExporting] = useState(false);

  const me = useQuery(api.users.getMyMembership);

  const queryArgs = useMemo(
    () =>
      statusFilter === "all"
        ? {}
        : { status: statusFilter as Status },
    [statusFilter],
  );

  const { results, status, loadMore } = usePaginatedQuery(
    api.conversations.listAllForOrg,
    queryArgs,
    { initialNumItems: PAGE_SIZE },
  );

  const convex = useConvex();
  const deleteConversation = useMutation(api.conversations.deleteForAdmin);
  const retryConversation = useAction(api.conversations.retryFetch);

  const filtered = useMemo(() => {
    if (!search.trim()) return results;
    const q = search.toLowerCase();
    return results.filter(
      (r) =>
        r.contributorName.toLowerCase().includes(q) ||
        (r.processName ?? "").toLowerCase().includes(q) ||
        (r.summary ?? "").toLowerCase().includes(q) ||
        getConversationTypeLabel(r.inputMode).toLowerCase().includes(q),
    );
  }, [results, search]);

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteConversation({ conversationId: pendingDelete });
      toast.success("Conversation deleted.");
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to delete conversation.";
      toast.error(msg);
      throw err;
    }
  };

  const handleRetry = async (id: Id<"conversations">) => {
    setRetryingId(id);
    try {
      const result = await retryConversation({ conversationId: id });
      if (result.status === "done") toast.success("Retry succeeded.");
      else if (result.status === "failed") toast.error("Retry failed again.");
      else toast.info(`Retry queued (status: ${result.status}).`);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to retry conversation.";
      toast.error(msg);
    } finally {
      setRetryingId(null);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const rows: ConversationRow[] = [];
      let cursor: string | null = null;
      for (;;) {
        const result: FunctionReturnType<
          typeof api.conversations.listAllForOrg
        > = await convex.query(api.conversations.listAllForOrg, {
          ...queryArgs,
          paginationOpts: { numItems: 500, cursor },
        });
        rows.push(...result.page);
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
      const csv = buildConversationsCsv(rows);
      const slug = me?.orgSlug || "workspace";
      const date = new Date().toISOString().slice(0, 10);
      downloadCsv(`conversations-${slug}-${date}.csv`, csv);
      toast.success(`Exported ${rows.length} conversations.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed.";
      toast.error(msg);
    } finally {
      setExporting(false);
    }
  };

  const isLoading = status === "LoadingFirstPage";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Conversations</h2>
          <p className="text-sm text-muted-foreground">
            Review and manage every voice conversation captured in this
            workspace.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleExport}
          disabled={exporting || results.length === 0}
        >
          <Download />
          {exporting ? "Exporting..." : "Export CSV"}
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search contributor, type, process, or summary..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(val) => setStatusFilter(val as StatusFilter)}
        >
          <SelectTrigger size="sm" className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Contributor</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Process</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="h-24 text-center text-muted-foreground"
                  >
                    {search
                      ? "No conversations match your search."
                      : "No conversations yet."}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((r) => (
                  <TableRow key={r._id}>
                    <TableCell className="text-muted-foreground">
                      {formatDate(r._creationTime)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {r.contributorName}
                    </TableCell>
                    <TableCell>
                      <ConversationTypeBadge inputMode={r.inputMode} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{r.processName ?? "—"}</span>
                        {r.functionName && r.departmentName && (
                          <span className="text-xs text-muted-foreground">
                            {r.functionName} · {r.departmentName}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDuration(r.durationSeconds)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-sm" />}
                        >
                          <MoreHorizontal />
                          <span className="sr-only">Open actions</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setViewingId(r._id)}>
                            View transcript
                          </DropdownMenuItem>
                          {r.status === "failed" && (
                            <DropdownMenuItem
                              onClick={() => handleRetry(r._id)}
                              disabled={retryingId === r._id}
                            >
                              <RotateCcw />
                              {retryingId === r._id
                                ? "Retrying..."
                                : "Retry fetch"}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setPendingDelete(r._id)}
                          >
                            <Trash2 />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {filtered.length} shown
          {search && ` (filtered from ${results.length} loaded)`}
        </p>
        {status === "CanLoadMore" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadMore(PAGE_SIZE)}
          >
            Load more
          </Button>
        )}
        {status === "LoadingMore" && (
          <p className="text-xs text-muted-foreground">Loading more...</p>
        )}
      </div>

      <ConversationTranscriptDialog
        conversationId={viewingId}
        open={viewingId !== null}
        onOpenChange={(open) => {
          if (!open) setViewingId(null);
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this conversation?"
        description="The transcript, summary, and audio metadata will be permanently removed. The parent process summary will be regenerated. This action cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}
