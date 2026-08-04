"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Toaster } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-screen";

// Middleware guarantees authentication for every route on this host; this
// layout enforces *authorization*: only platform super-admins may see the
// console. Every Convex function behind it re-checks server-side, so this
// gate is UX, not security.
export default function TenantsConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isLoaded, isSignedIn } = useUser();
  const me = useQuery(api.users.getMe);
  const storeUser = useMutation(api.users.store);

  // Ensure the Convex user row exists for a staff member whose first visit
  // is the console itself (requireSuperAdmin needs the row).
  useEffect(() => {
    if (isLoaded && isSignedIn) void storeUser();
  }, [isLoaded, isSignedIn, storeUser]);

  if (!isLoaded || me === undefined) {
    return <LoadingScreen message="Loading tenant console..." />;
  }

  if (!isSignedIn) {
    return (
      <LoadingScreen message="Redirecting to sign in..." showSpinner={false} />
    );
  }

  if (!me || me.platformRole !== "superAdmin") {
    return <AccessBlocker />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <ConsoleHeader email={me.email} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {children}
      </main>
      <Toaster richColors closeButton position="bottom-right" />
    </div>
  );
}

function ConsoleHeader({ email }: { email: string }) {
  const pathname = usePathname();
  // The browser path has no /tenants-console prefix (middleware rewrite), but
  // normalize defensively in case this renders from the internal path.
  const path = pathname?.replace(/^\/tenants-console/, "") || "/";
  const { signOut } = useClerk();

  const navItems = [
    { href: "/", label: "Tenants", active: path === "/" || path.startsWith("/new") },
    { href: "/usage", label: "Usage", active: path.startsWith("/usage") },
    { href: "/team", label: "Platform team", active: path.startsWith("/team") },
  ];

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-8">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold">Fabric</span>
            <span className="text-sm text-muted-foreground">
              Tenant console
            </span>
          </div>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={
                  item.active
                    ? "rounded-md bg-muted px-3 py-1.5 text-sm font-medium"
                    : "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                }
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{email}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => signOut({ redirectUrl: "/sign-in" })}
          >
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}

function AccessBlocker() {
  const { signOut } = useClerk();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xl font-semibold">Platform access required</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        The tenant console is available to Fabric platform super-admins only.
        If you believe you should have access, ask an existing super-admin to
        promote your account.
      </p>
      <button
        type="button"
        onClick={() => signOut({ redirectUrl: "/sign-in" })}
        className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        Sign out
      </button>
    </div>
  );
}
