"use client";

import { Check, Monitor, MoonStar, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/features/theming/theme-provider";
import type { ThemePreference } from "@/features/theming/theme-config";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    value: "light",
    label: "Light",
    description: "Bright and crisp",
    icon: Sun,
  },
  {
    value: "dark",
    label: "Dark",
    description: "Calm and low-glare",
    icon: MoonStar,
  },
  {
    value: "system",
    label: "System",
    description: "Match this device",
    icon: Monitor,
  },
];

export function ThemeToggle({ className }: { className?: string }) {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const ActiveIcon =
    preference === "system"
      ? Monitor
      : resolvedTheme === "dark"
        ? MoonStar
        : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("size-8 text-muted-foreground", className)}
            aria-label={`Appearance: ${preference}`}
          />
        }
      >
        <ActiveIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56 p-1.5">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pb-1 pt-1.5">
            Appearance
          </DropdownMenuLabel>
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = preference === option.value;
            return (
              <DropdownMenuItem
                key={option.value}
                onClick={() => setPreference(option.value)}
                className="min-h-11 gap-3 px-2.5 py-2"
                aria-current={selected ? "true" : undefined}
              >
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/55 text-muted-foreground",
                    selected &&
                      "border-org-accent-border bg-org-accent-subtle text-org-accent",
                  )}
                >
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                {selected ? (
                  <Check className="size-3.5 shrink-0 text-org-accent" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
