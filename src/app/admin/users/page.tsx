"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Doc, Id } from "../../../../convex/_generated/dataModel";
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
  userId,
  currentRole,
  isSelf,
}: {
  userId: Id<"users">;
  currentRole: Role;
  isSelf: boolean;
}) {
  const setUserRole = useMutation(api.users.setUserRole);

  const handleChange = async (value: Role) => {
    if (value === currentRole) return;
    await setUserRole({ targetUserId: userId, role: value });
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
  const users = useQuery(api.users.listAllUsers);
  const me = useQuery(api.users.getMe);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!users) return [];
    if (!search.trim()) return users;
    const q = search.toLowerCase();
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.department ?? "").toLowerCase().includes(q) ||
        (u.function ?? "").toLowerCase().includes(q),
    );
  }, [users, search]);

  if (users === undefined) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Users</h2>
        <p className="text-sm text-muted-foreground">
          Manage user accounts and roles across your organization.
        </p>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name, email, department..."
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
              <TableHead>Department</TableHead>
              <TableHead>Function</TableHead>
              <TableHead>Profile</TableHead>
              <TableHead>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  {search ? "No users match your search." : "No users yet."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((user) => {
                const role = (user.role ?? "viewer") as Role;
                const isSelf = me?._id === user._id;
                return (
                  <TableRow key={user._id}>
                    <TableCell className="font-medium">
                      {user.name}
                      {isSelf && (
                        <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{user.email}</TableCell>
                    <TableCell>
                      <RoleSelect userId={user._id} currentRole={role} isSelf={isSelf} />
                    </TableCell>
                    <TableCell>{user.department ?? <span className="text-muted-foreground">--</span>}</TableCell>
                    <TableCell>{user.function ?? <span className="text-muted-foreground">--</span>}</TableCell>
                    <TableCell>
                      <Badge variant={user.profileComplete ? "secondary" : "outline"}>
                        {user.profileComplete ? "Complete" : "Incomplete"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(user._creationTime)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        {filtered.length} of {users.length} users shown
      </p>
    </div>
  );
}
