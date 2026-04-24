"use client";

import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useState, useMemo } from "react";
import { toast } from "sonner";
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
import { InviteMemberDialog } from "@/components/admin/invite-member-dialog";
import { PendingInvitesList } from "@/components/admin/pending-invites-list";
import { MoreHorizontal, Search, UserPlus } from "lucide-react";

const ROLE_OPTIONS = ["admin", "contributor", "viewer"] as const;
type Role = (typeof ROLE_OPTIONS)[number];

const roleBadgeVariant: Record<Role, "default" | "secondary" | "outline"> = {
  admin: "default",
  contributor: "secondary",
  viewer: "outline",
};

function requiresConfirm(current: Role, next: Role): boolean {
  return next === "admin" || current === "admin";
}

function RoleSelect({
  membershipId,
  currentRole,
  isSelf,
  memberName,
}: {
  membershipId: Id<"memberships">;
  currentRole: Role;
  isSelf: boolean;
  memberName: string;
}) {
  const setMembershipRole = useMutation(api.users.setMembershipRole);
  const [pendingRole, setPendingRole] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);

  const applyChange = async (nextRole: Role) => {
    setBusy(true);
    try {
      await setMembershipRole({ membershipId, role: nextRole });
      toast.success(`Role updated to ${nextRole}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to change role.";
      toast.error(msg);
    } finally {
      setBusy(false);
      setPendingRole(null);
    }
  };

  const handleChange = async (value: Role) => {
    if (value === currentRole) return;
    if (requiresConfirm(currentRole, value)) {
      setPendingRole(value);
      return;
    }
    await applyChange(value);
  };

  if (isSelf) {
    return (
      <Badge variant={roleBadgeVariant[currentRole]} className="capitalize">
        {currentRole}
      </Badge>
    );
  }

  return (
    <>
      <Select
        value={currentRole}
        onValueChange={(val) => handleChange(val as Role)}
        disabled={busy}
      >
        <SelectTrigger size="sm" className="w-[130px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLE_OPTIONS.map((role) => (
            <SelectItem key={role} value={role} className="capitalize">
              {role}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ConfirmDialog
        open={pendingRole !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRole(null);
        }}
        title={
          pendingRole === "admin"
            ? `Promote ${memberName} to admin?`
            : `Change ${memberName}'s role to ${pendingRole}?`
        }
        description={
          pendingRole === "admin"
            ? "Admins can manage members, invitations, and conversations across the workspace."
            : "This member will lose admin privileges."
        }
        confirmLabel="Change role"
        destructive={currentRole === "admin" && pendingRole !== "admin"}
        onConfirm={async () => {
          if (pendingRole) await applyChange(pendingRole);
        }}
      />
    </>
  );
}

function RowActions({
  membershipId,
  memberName,
  isSelf,
}: {
  membershipId: Id<"memberships">;
  memberName: string;
  isSelf: boolean;
}) {
  const removeMember = useAction(api.users.removeMemberFromOrg);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRemove = async () => {
    try {
      await removeMember({ membershipId });
      toast.success(`Removed ${memberName} from the workspace.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to remove member.";
      toast.error(msg);
      throw err;
    }
  };

  if (isSelf) {
    return (
      <Button variant="ghost" size="icon-sm" disabled>
        <MoreHorizontal />
      </Button>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" />}
        >
          <MoreHorizontal />
          <span className="sr-only">Open actions</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirmOpen(true)}
          >
            Remove from workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Remove ${memberName}?`}
        description="They will immediately lose access to this workspace and will be removed from the Clerk organization. They can be re-invited later."
        confirmLabel="Remove member"
        destructive
        onConfirm={handleRemove}
      />
    </>
  );
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function AdminUsersPage() {
  const members = useQuery(api.users.listOrgMembers);
  const me = useQuery(api.users.getMe);
  const [search, setSearch] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitesRefreshKey, setInvitesRefreshKey] = useState(0);

  const filtered = useMemo(() => {
    if (!members) return [];
    if (!search.trim()) return members;
    const q = search.toLowerCase();
    return members.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        (m.jobTitle ?? "").toLowerCase().includes(q),
    );
  }, [members, search]);

  if (members === undefined) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Members</h2>
          <p className="text-sm text-muted-foreground">
            Manage members and roles for this organization.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus />
          Invite member
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name, email, job title..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Job Title</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Profile</TableHead>
              <TableHead>Joined Org</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-24 text-center text-muted-foreground"
                >
                  {search ? "No members match your search." : "No members yet."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((m) => {
                const role = m.role as Role;
                const isSelf = me?._id === m.userId;
                return (
                  <TableRow key={m.membershipId}>
                    <TableCell className="font-medium">
                      {m.name}
                      {isSelf && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          (you)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.email}
                    </TableCell>
                    <TableCell>
                      <RoleSelect
                        membershipId={m.membershipId}
                        currentRole={role}
                        isSelf={isSelf}
                        memberName={m.name}
                      />
                    </TableCell>
                    <TableCell>
                      {m.jobTitle ?? (
                        <span className="text-muted-foreground">--</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {m.platformRole === "superAdmin" ? (
                        <Badge variant="default">Super Admin</Badge>
                      ) : (
                        <span className="text-muted-foreground">--</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={m.profileComplete ? "secondary" : "outline"}
                      >
                        {m.profileComplete ? "Complete" : "Incomplete"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(m.createdAt)}
                    </TableCell>
                    <TableCell>
                      <RowActions
                        membershipId={m.membershipId}
                        memberName={m.name}
                        isSelf={isSelf}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        {filtered.length} of {members.length} members shown
      </p>

      <div className="space-y-3 pt-4">
        <div>
          <h3 className="text-sm font-semibold">Pending invitations</h3>
          <p className="text-xs text-muted-foreground">
            People who&apos;ve been invited but haven&apos;t joined yet.
          </p>
        </div>
        <PendingInvitesList refreshKey={invitesRefreshKey} />
      </div>

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={() => setInvitesRefreshKey((k) => k + 1)}
      />
    </div>
  );
}
