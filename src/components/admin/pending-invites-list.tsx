"use client";

import { useCallback, useEffect, useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type PendingInvite = {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: number;
  expiresAt: number | null;
};

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export type PendingInvitesHandle = {
  refresh: () => Promise<void>;
};

export function PendingInvitesList({
  refreshKey = 0,
}: {
  refreshKey?: number;
}) {
  const listInvites = useAction(api.invitations.list);
  const reInvite = useAction(api.invitations.invite);
  const revokeInvite = useAction(api.invitations.revoke);

  const [invites, setInvites] = useState<PendingInvite[] | undefined>(undefined);
  const [pendingRevoke, setPendingRevoke] = useState<PendingInvite | null>(
    null,
  );
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listInvites({});
      setInvites(rows);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to load invitations.";
      toast.error(msg);
      setInvites([]);
    }
  }, [listInvites]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const handleResend = async (invite: PendingInvite) => {
    setMutatingId(invite.id);
    try {
      // Clerk doesn't expose a first-class "resend" — revoke + re-invite is
      // the canonical path. Both calls re-verify admin on the server.
      await revokeInvite({ invitationId: invite.id });
      await reInvite({ email: invite.email });
      toast.success(`Re-sent invitation to ${invite.email}.`);
      await refresh();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to resend invitation.";
      toast.error(msg);
    } finally {
      setMutatingId(null);
    }
  };

  const handleRevoke = async () => {
    if (!pendingRevoke) return;
    setMutatingId(pendingRevoke.id);
    try {
      await revokeInvite({ invitationId: pendingRevoke.id });
      toast.success(`Revoked invitation for ${pendingRevoke.email}.`);
      await refresh();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to revoke invitation.";
      toast.error(msg);
      throw err;
    } finally {
      setMutatingId(null);
    }
  };

  if (invites === undefined) {
    return (
      <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
        Loading invitations...
      </div>
    );
  }

  if (invites.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No pending invitations.
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Invited</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.map((invite) => (
              <TableRow key={invite.id}>
                <TableCell className="font-medium">{invite.email}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(invite.createdAt)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {invite.expiresAt ? formatDate(invite.expiresAt) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={mutatingId === invite.id}
                      onClick={() => handleResend(invite)}
                    >
                      Resend
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={mutatingId === invite.id}
                      onClick={() => setPendingRevoke(invite)}
                    >
                      Revoke
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
        title={
          pendingRevoke
            ? `Revoke invitation for ${pendingRevoke.email}?`
            : "Revoke invitation?"
        }
        description="The invitation link will stop working. You can invite them again later."
        confirmLabel="Revoke"
        destructive
        onConfirm={handleRevoke}
      />
    </>
  );
}
