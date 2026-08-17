"use client";

import Link from "next/link";
import { useOrganization } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import {
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Menu,
  Megaphone,
  PanelLeft,
  PanelLeftClose,
  Search,
  Settings,
  Workflow,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserMenu } from "@/features/shell/user-menu";
import { useWorkspaceRoutes } from "@/features/shell/use-workspace-routes";
import {
  getWorkspaceInitials,
  WorkspaceBrandLockup,
  type WorkspaceBrandOrganization,
} from "@/features/shell/workspace-brand-lockup";
import { cn } from "@/lib/utils";

type ProcessAppShellProps = {
  children: ReactNode;
  onSearch: () => void;
};

type WorkspaceAppShellProps = {
  children: ReactNode;
  mainClassName?: string;
  onSearch?: () => void;
  title?: string;
  navSections?: WorkspaceNavSection[];
};

const SIDEBAR_COLLAPSED_KEY = "fabric:sidebar-collapsed";
const SIDEBAR_COLLAPSED_EVENT = "fabric:sidebar-collapsed-change";

export type WorkspaceNavItem = {
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  visible?: boolean;
};

export type WorkspaceNavSection = {
  label?: string;
  items: WorkspaceNavItem[];
  visible?: boolean;
};

function getSidebarCollapsedSnapshot(): boolean {
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
}

function getServerSidebarCollapsedSnapshot(): boolean {
  return false;
}

function subscribeToSidebarCollapsed(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(SIDEBAR_COLLAPSED_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(SIDEBAR_COLLAPSED_EVENT, onStoreChange);
  };
}

function SearchTrigger({
  onSearch,
  compact = false,
}: {
  onSearch: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSearch}
      className={cn(
        "group flex min-w-0 items-center rounded-lg border border-border bg-background text-left text-sm text-muted-foreground shadow-xs transition-colors hover:border-org-accent-border hover:bg-org-accent-subtle hover:text-foreground focus-visible:border-org-accent-ring focus-visible:ring-3 focus-visible:ring-org-accent-ring/35",
        compact ? "size-9 justify-center" : "h-9 w-full max-w-xl gap-2 px-3",
      )}
      aria-label="Search functions, departments, or processes"
    >
      <Search className="size-4 shrink-0" />
      {!compact && (
        <>
          <span className="min-w-0 flex-1 truncate">
            Search functions, departments, or processes...
          </span>
          <span
            className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:flex"
            aria-hidden="true"
          >
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans">
              Ctrl
            </kbd>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans">
              K
            </kbd>
          </span>
        </>
      )}
    </button>
  );
}

function WorkspaceCard({
  orgName,
  collapsed = false,
}: {
  orgName: string;
  collapsed?: boolean;
}) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              className="mx-auto flex size-9 items-center justify-center rounded-md bg-org-accent-subtle text-xs font-semibold text-org-accent"
              aria-label={`${orgName} workspace`}
            />
          }
        >
          {getWorkspaceInitials(orgName)}
        </TooltipTrigger>
        <TooltipContent side="right">{orgName}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="rounded-lg border border-sidebar-border bg-background/80 p-3 shadow-xs">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-sidebar-foreground">
          {orgName}
        </p>
        <p className="text-xs text-sidebar-foreground/60">Workspace</p>
      </div>
    </div>
  );
}

function WorkspaceNav({
  sections,
  onNavigate,
  collapsed = false,
}: {
  sections: WorkspaceNavSection[];
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const visibleSections = sections
    .filter((section) => section.visible !== false)
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.visible !== false),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {visibleSections.map((section, sectionIndex) => (
        <div
          key={section.label ?? sectionIndex}
          className={cn("flex flex-col gap-1", sectionIndex > 0 && "pt-3")}
        >
          {section.label && !collapsed && (
            <p className="px-2.5 pb-1 text-[11px] font-medium uppercase text-sidebar-foreground/48">
              {section.label}
            </p>
          )}
          {section.label && collapsed && sectionIndex > 0 && (
            <div className="mx-auto my-1 h-px w-6 bg-sidebar-border" />
          )}
          {section.items.map((item) => {
            const Icon = item.icon;
            const className = cn(
              "flex items-center rounded-lg border border-transparent text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/40",
              collapsed ? "size-9 justify-center" : "h-9 gap-2 px-2.5",
              item.active
                ? "border-org-accent-border bg-org-accent-selected text-org-accent-selected-foreground"
                : "text-sidebar-foreground/72 hover:bg-org-accent-subtle hover:text-sidebar-accent-foreground",
            );

            if (collapsed) {
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger
                    render={
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        className={className}
                        aria-current={item.active ? "page" : undefined}
                        aria-label={item.label}
                      />
                    }
                  >
                    <Icon className="size-4 shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={className}
                aria-current={item.active ? "page" : undefined}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function DesktopSidebar({
  navSections,
  orgName,
  organization,
  collapsed,
  onToggleCollapse,
}: {
  navSections: WorkspaceNavSection[];
  orgName: string;
  organization: WorkspaceBrandOrganization | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <aside
      className={cn(
        "hidden shrink-0 border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out md:flex md:flex-col",
        collapsed ? "w-[68px]" : "w-[252px]",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <div
          className={cn(
            "flex items-center gap-2",
            collapsed ? "justify-center" : "justify-between",
          )}
        >
          {!collapsed && (
            <WorkspaceBrandLockup
              organization={organization}
              fabricClassName="text-xl"
              className="min-w-0 gap-2 px-1"
              logoContainerClassName="px-0"
            />
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={onToggleCollapse}
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  aria-expanded={!collapsed}
                />
              }
            >
              {collapsed ? (
                <PanelLeft className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </TooltipTrigger>
            <TooltipContent side="right">
              {collapsed ? "Expand sidebar" : "Collapse sidebar"}
            </TooltipContent>
          </Tooltip>
        </div>
        <WorkspaceCard orgName={orgName} collapsed={collapsed} />
        <WorkspaceNav sections={navSections} collapsed={collapsed} />
      </div>
    </aside>
  );
}

function MobileNavSheet({
  navSections,
  orgName,
  organization,
  open,
  onOpenChange,
}: {
  navSections: WorkspaceNavSection[];
  orgName: string;
  organization: WorkspaceBrandOrganization | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[19rem] gap-0 p-0">
        <SheetHeader className="border-b p-4 pr-12">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Primary workspace navigation
          </SheetDescription>
          <WorkspaceBrandLockup
            organization={organization}
            fabricClassName="text-xl"
          />
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <WorkspaceCard orgName={orgName} />
          <WorkspaceNav
            sections={navSections}
            onNavigate={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TopBar({
  onSearch,
  onOpenNav,
  title,
}: {
  onSearch?: () => void;
  onOpenNav: () => void;
  title?: string;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 md:h-16 md:px-5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={onOpenNav}
              aria-label="Open navigation"
            />
          }
        >
          <Menu className="size-4" />
        </TooltipTrigger>
        <TooltipContent>Open navigation</TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1">
        {onSearch ? (
          <SearchTrigger onSearch={onSearch} />
        ) : (
          <h1 className="truncate text-sm font-medium text-foreground">
            {title}
          </h1>
        )}
      </div>
      <UserMenu compact />
    </header>
  );
}

export function WorkspaceAppShell({
  children,
  mainClassName,
  onSearch,
  title,
  navSections = [],
}: WorkspaceAppShellProps) {
  const { organization } = useOrganization();
  const membership = useQuery(api.users.getMyMembership);
  const routes = useWorkspaceRoutes();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const sidebarCollapsed = useSyncExternalStore(
    subscribeToSidebarCollapsed,
    getSidebarCollapsedSnapshot,
    getServerSidebarCollapsedSnapshot,
  );
  const orgName = organization?.name ?? "Workspace";
  const canAccessAdmin = membership?.role === "admin";

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
    window.dispatchEvent(new Event(SIDEBAR_COLLAPSED_EVENT));
  };

  const workspaceNavSections: WorkspaceNavSection[] = [
    {
      items: [
        {
          href: routes.appHref,
          icon: Workflow,
          label: "Processes",
          active: routes.isActivePath("/", { exact: true }),
        },
        {
          href: routes.releaseNotesHref,
          icon: Megaphone,
          label: "Release notes",
          active: routes.isActivePath("/release-notes"),
        },
        {
          href: routes.adminHref,
          icon: Settings,
          label: "Admin",
          active: routes.isAdminPath,
          visible: canAccessAdmin,
        },
      ],
    },
    ...navSections,
  ];

  return (
    <div className="flex h-full min-h-0 bg-background">
      <DesktopSidebar
        navSections={workspaceNavSections}
        orgName={orgName}
        organization={organization ?? null}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
      />
      <MobileNavSheet
        navSections={workspaceNavSections}
        orgName={orgName}
        organization={organization ?? null}
        open={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          onSearch={onSearch}
          onOpenNav={() => setMobileNavOpen(true)}
          title={title}
        />
        <main
          className={cn(
            "flex min-h-0 min-w-0 flex-1 overflow-hidden",
            mainClassName,
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

export function ProcessAppShell({
  children,
  onSearch,
}: ProcessAppShellProps) {
  return <WorkspaceAppShell onSearch={onSearch}>{children}</WorkspaceAppShell>;
}
