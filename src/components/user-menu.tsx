"use client";

import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Settings } from "lucide-react";

export function UserMenu() {
  const user = useQuery(api.users.getMe);
  const role = user?.role ?? "viewer";

  return (
    <div className="flex items-center gap-2">
      {role === "admin" && (
        <Link
          href="/admin"
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Settings className="size-3.5" />
          <span className="hidden sm:inline">Admin</span>
        </Link>
      )}
      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">
        {role}
      </span>
      <UserButton />
    </div>
  );
}
