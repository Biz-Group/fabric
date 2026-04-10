import { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";

// Role hierarchy: admin > contributor > viewer
const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 0,
  contributor: 1,
  admin: 2,
};

type Role = "admin" | "contributor" | "viewer";

/**
 * Require authentication only. Returns the identity.
 * Used by read-only queries that all roles can access.
 */
export async function requireAuth(
  ctx: QueryCtx | MutationCtx | ActionCtx,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }
  return identity;
}

/** Resolve the effective role for a user document. Treats undefined as "viewer". */
export function effectiveRole(user: Doc<"users">): Role {
  return user.role ?? "viewer";
}

/**
 * Require that the caller has at least the given minimum role.
 * Returns the user document on success.
 */
export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  minimumRole: Role,
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

  const role = effectiveRole(user);
  if (ROLE_HIERARCHY[role] < ROLE_HIERARCHY[minimumRole]) {
    throw new Error("Insufficient permissions");
  }

  return user;
}

/** Require at least "contributor" role. Returns user doc. */
export async function requireContributor(ctx: QueryCtx | MutationCtx) {
  return requireRole(ctx, "contributor");
}

/** Require "admin" role. Returns user doc. */
export async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  return requireRole(ctx, "admin");
}

/**
 * For actions that lack ctx.db — check role from a pre-fetched user doc.
 * Throws if the user doesn't meet the minimum role.
 */
export function checkRoleFromUser(
  user: { role?: string } | null,
  minimumRole: Role,
): void {
  if (!user) throw new Error("User record not found");
  const role = (user.role ?? "viewer") as Role;
  if (ROLE_HIERARCHY[role] < ROLE_HIERARCHY[minimumRole]) {
    throw new Error("Insufficient permissions");
  }
}
