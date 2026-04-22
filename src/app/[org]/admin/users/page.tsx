"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useState, useMemo } from "react";
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
import { Search } from "lucide-react";

const ROLE_OPTIONS = ["admin", "contributor", "viewer"] as const;
type Role = (typeof ROLE_OPTIONS)[number];

const roleBadgeVariant: Record<Role, "default" | "secondary" | "outline"> = {
  admin: "default",
  contributor: "secondary",
  viewer: "outline",
};

function RoleSelect({
  membershipId,
  currentRole,
  isSelf,
}: {
  membershipId: Id<"memberships">;
  currentRole: Role;
  isSelf: boolean;
}) {
  const setMembershipRole = useMutation(api.users.setMembershipRole);

  const handleChange = async (value: Role) => {
    if (value === currentRole) return;
    await setMembershipRole({ membershipId, role: value });
  };

  if (isSelf) {
    return (
      <Badge variant={roleBadgeVariant[currentRole]} className="capitalize">
        {currentRole}
      </Badge>
    );
  }

  return (
    <Select value={currentRole} onValueChange={(val) => handleChange(val as Role)}>
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
      <div>
        <h2 className="text-lg font-semibold">Members</h2>
        <p className="text-sm text-muted-foreground">
          Manage members and roles for this organization.
        </p>
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
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
    </div>
  );
}
