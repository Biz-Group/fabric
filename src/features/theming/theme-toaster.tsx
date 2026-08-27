"use client";

import { Toaster } from "sonner";
import { useTheme } from "@/features/theming/theme-provider";

export function ThemeToaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Toaster
      theme={resolvedTheme}
      richColors
      closeButton
      position="bottom-right"
    />
  );
}
