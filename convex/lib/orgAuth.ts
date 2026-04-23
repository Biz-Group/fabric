import { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

// Per-org role hierarchy: admin > contributor > viewer.
export type Role = "admin" | "contributor" | "viewer";
const RANK: Record<Role, number> = { viewer: 0, contributor: 1, admin: 2 };

type IdentityWithOrgClaims = {
  orgId?: string;
  orgSlug?: string;
  o?: {
    id?: string;
    slg?: string;
  };
};

/**
 * Identity-only gate for user-scoped operations that must work even when
 * there's no active Clerk org — profile onboarding, the apex landing page, etc.
 * For tenant data access, use `requireOrgMember` or a role variant instead.
 */
export async function requireAuth(
  ctx: QueryCtx | MutationCtx | ActionCtx,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity;
}

/** Clerk's Convex token can expose org claims either as top-level custom
 * claims (`orgId`, `orgSlug`) or in the compact built-in `o` object
 * (`o.id`, `o.slg`). Support both so auth keeps working across template
 * variations and SDK changes. */
export function getActiveOrgClaims(identity: unknown): {
  orgId: string | null;
  orgSlug: string | null;
} {
  const claims = identity as IdentityWithOrgClaims;
  const orgId = claims.orgId ?? claims.o?.id ?? null;
  const orgSlug = claims.orgSlug ?? claims.o?.slg ?? null;
  return { orgId, orgSlug };
}

export type OrgContext = {
  tokenIdentifier: string;
  orgId: string;
  orgSlug: string;
  userId: Id<"users">;
  role: Role;
  email?: string;
  name?: string;
};

/**
 * Resolves identity + Fabric membership for the caller's active Clerk org.
 * Throws if not authenticated, no active org, user record missing, or no
 * membership row for that org. No platformRole bypass — super-admins access
 * client orgs via auto-provisioned memberships (Model A).
 */
export async function requireOrgMember(
  ctx: QueryCtx | MutationCtx,
): Promise<OrgContext> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const { orgId, orgSlug } = getActiveOrgClaims(identity);
  if (!orgId) throw new Error("No active organization");

  const user = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
  if (!user) throw new Error("User record not found");

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier).eq("clerkOrgId", orgId),
    )
    .unique();
  if (!membership) throw new Error("Not a member of this organization");

  return {
    tokenIdentifier: identity.tokenIdentifier,
    orgId,
    orgSlug: orgSlug ?? "",
    userId: user._id,
    role: membership.role,
    email: identity.email ?? undefined,
    name: identity.name ?? undefined,
  };
}

export async function requireOrgRole(
  ctx: QueryCtx | MutationCtx,
  minimum: Role,
): Promise<OrgContext> {
  const org = await requireOrgMember(ctx);
  if (RANK[org.role] < RANK[minimum]) {
    throw new Error("Insufficient permissions");
  }
  return org;
}

export const requireOrgContributor = (ctx: QueryCtx | MutationCtx) =>
  requireOrgRole(ctx, "contributor");

export const requireOrgAdmin = (ctx: QueryCtx | MutationCtx) =>
  requireOrgRole(ctx, "admin");

/**
 * Throws "Not found" (not "Forbidden") when a document belongs to a different
 * org — avoids leaking existence across tenants.
 */
export function assertOrgOwns<T extends { clerkOrgId?: string }>(
  caller: { orgId: string },
  doc: T | null,
): asserts doc is T {
  if (!doc || doc.clerkOrgId !== caller.orgId) throw new Error("Not found");
}

/**
 * Action-safe: actions have no ctx.db. Public action entrypoints use this to
 * establish org context from the JWT, then pass `orgId` explicitly to every
 * internal query/mutation they invoke (internals do not re-read ctx.auth).
 */
export async function resolveOrgForAction(
  ctx: ActionCtx,
): Promise<{ orgId: string; tokenIdentifier: string }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const { orgId } = getActiveOrgClaims(identity);
  if (!orgId) throw new Error("No active organization");
  return { orgId, tokenIdentifier: identity.tokenIdentifier };
}

// ---- Platform-scope helpers ------------------------------------------------

/**
 * Platform-level auth. Grants: create/delete orgs, fan-out action,
 * cross-org dashboards. Does NOT by itself grant access to any tenant's
 * data — for that, the super-admin must have (or auto-acquire) a membership
 * row via the fan-out flow.
 *
 * Intentionally does NOT require an active Clerk org — platform tools at the
 * apex domain must work even when no org is selected.
 */
export async function requireSuperAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const user = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
  if (!user) throw new Error("User record not found");
  if (user.platformRole !== "superAdmin") {
    throw new Error("Platform super-admin required");
  }
  return user;
}

/** Action-safe variant. */
export async function requireSuperAdminForAction(
  ctx: ActionCtx,
): Promise<{ tokenIdentifier: string }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  // Actions can't read ctx.db directly — the caller should invoke an internal
  // query that uses requireSuperAdmin if it needs the full user doc.
  return { tokenIdentifier: identity.tokenIdentifier };
}
