"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  href,
  tone = "default",
}: {
  label: string;
  value: string | number | null | undefined;
  hint?: string;
  icon?: LucideIcon;
  href?: string;
  tone?: "default" | "destructive";
}) {
  const body = (
    <Card
      className={cn(
        "h-full transition-all",
        href && "cursor-pointer hover:ring-2 hover:ring-ring/30",
      )}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardDescription>{label}</CardDescription>
          {Icon && (
            <Icon
              className={cn(
                "size-4",
                tone === "destructive"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            />
          )}
        </div>
        <CardTitle
          className={cn(
            "text-2xl font-semibold tabular-nums",
            tone === "destructive" && "text-destructive",
          )}
        >
          {value === undefined ? (
            <span className="inline-block h-6 w-12 animate-pulse rounded bg-muted" />
          ) : value === null ? (
            "—"
          ) : (
            value
          )}
        </CardTitle>
      </CardHeader>
      {hint && (
        <CardContent>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      )}
    </Card>
  );

  if (href) {
    return (
      <Link href={href} className="block h-full">
        {body}
      </Link>
    );
  }
  return body;
}
