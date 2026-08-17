"use client";

import { useParams, usePathname } from "next/navigation";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getTenantSubdomain } from "@/lib/subdomain";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizePathname(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] || "/";
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : "/";
}

function appendWorkspacePath(baseHref: string, path: string): string {
  const normalizedPath = ensureLeadingSlash(path);
  if (normalizePathname(normalizedPath) === "/") return baseHref || "/";
  return `${baseHref}${normalizedPath}`;
}

function matchesRoute(
  currentPathname: string,
  targetPathname: string,
  exact: boolean,
): boolean {
  const current = normalizePathname(currentPathname);
  const target = normalizePathname(targetPathname);

  if (exact || target === "/") return current === target;
  return current === target || current.startsWith(`${target}/`);
}

function subscribeToHostChanges(onStoreChange: () => void) {
  void onStoreChange;
  return () => {};
}

function getTenantSubdomainSnapshot(): boolean {
  return getTenantSubdomain(window.location.host, ROOT_DOMAIN) !== null;
}

function getServerTenantSubdomainSnapshot(): boolean {
  return false;
}

export function useWorkspaceRoutes() {
  const params = useParams<{ org?: string | string[] }>();
  const pathname = normalizePathname(usePathname() ?? "/");
  const org = firstParam(params.org);
  const orgPathPrefix = org ? `/${encodeURIComponent(org)}` : "";
  const hasTenantSubdomain = useSyncExternalStore(
    subscribeToHostChanges,
    getTenantSubdomainSnapshot,
    getServerTenantSubdomainSnapshot,
  );

  const isOrgPathname =
    orgPathPrefix !== "" && matchesRoute(pathname, orgPathPrefix, false);
  const hrefBase = !hasTenantSubdomain && isOrgPathname ? orgPathPrefix : "";

  const withWorkspacePath = useCallback(
    (path: string) => appendWorkspacePath(hrefBase, path),
    [hrefBase],
  );

  const isActivePath = useCallback(
    (path: string, options?: { exact?: boolean }) => {
      const exact = options?.exact ?? false;
      const targets = new Set<string>([
        normalizePathname(appendWorkspacePath(hrefBase, path)),
      ]);

      if (orgPathPrefix) {
        targets.add(normalizePathname(appendWorkspacePath(orgPathPrefix, path)));
      }

      return [...targets].some((target) => matchesRoute(pathname, target, exact));
    },
    [hrefBase, orgPathPrefix, pathname],
  );

  return useMemo(
    () => ({
      appHref: withWorkspacePath("/"),
      releaseNotesHref: withWorkspacePath("/release-notes"),
      adminHref: withWorkspacePath("/admin"),
      adminUsersHref: withWorkspacePath("/admin/users"),
      adminConversationsHref: withWorkspacePath("/admin/conversations"),
      adminAppearanceHref: withWorkspacePath("/admin/appearance"),
      isActivePath,
      isAdminPath: isActivePath("/admin"),
      withWorkspacePath,
    }),
    [isActivePath, withWorkspacePath],
  );
}
