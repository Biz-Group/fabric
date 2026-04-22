import { v } from "convex/values";
import {
  action,
  ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireSuperAdmin } from "./lib/orgAuth";

// ---------------------------------------------------------------------------
// Platform-role management (super-admin layer)
//
// Fabric runs a two-layer auth model:
//   1. Platform role  — users.platformRole = "superAdmin" (orthogonal, not
//      scoped to any org). Grants: create/delete orgs, fan-out action,
//      cross-org dashboards. Does NOT by itself grant tenant data access.
//   2. Org role       — memberships.role   = admin | contributor | viewer.
//      Scoped to one org. Governs all tenant data access.
//
// Super-admins gain access to client orgs via Model A: a fan-out action makes
// them real Clerk members of every org and writes matching Fabric memberships
// rows. No per-request bypass anywhere in the auth path.
// ---------------------------------------------------------------------------

/** Parse the Clerk user id out of `https://<issuer>|user_xxx`. */
function clerkUserIdFromTokenIdentifier(tokenIdentifier: string): string {
  const idx = tokenIdentifier.lastIndexOf("|");
  if (idx === -1) {
    throw new Error(`Unexpected tokenIdentifier format: ${tokenIdentifier}`);
  }
  return tokenIdentifier.substring(idx + 1);
}

// --- Bootstrap -------------------------------------------------------------

/**
 * One-shot bootstrap for the first platform super-admin when a user row
 * already exists in Convex. Run via CLI:
 *   npx convex run platform:bootstrapSuperAdmin '{"email":"saish.gaonkar@bizgroup.ae"}'
 *
 * Sets users.platformRole to "superAdmin" for the matching email. Does NOT
 * touch Clerk or memberships — if the user already has admin memberships
 * everywhere they need them, that's sufficient. Otherwise, run
 * `fanOutSuperAdminMemberships` for each additional org they should access.
 *
 * Use `seedAndBootstrapSuperAdmin` instead when the Convex `users` row
 * doesn't exist yet (e.g. fresh prod deployment where nobody has signed in).
 */
export const bootstrapSuperAdmin = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (!user) throw new Error(`No user found with email: ${args.email}`);

    if (user.platformRole === "superAdmin") {
      return {
        userId: user._id,
        email: args.email,
        alreadySuperAdmin: true,
      };
    }

    await ctx.db.patch(user._id, { platformRole: "superAdmin" });
    return {
      userId: user._id,
      email: args.email,
      alreadySuperAdmin: false,
    };
  },
});

/**
 * Full super-admin bootstrap that works even when the Convex `users` row
 * doesn't exist yet. Intended for bringing up a brand-new Fabric deployment:
 * no one has signed in, so `users.store` hasn't run yet, so the usual
 * bootstrapSuperAdmin fails with "No user found".
 *
 * This action:
 *   1. Calls the Clerk Admin API to look up the user by email
 *   2. Constructs the canonical `tokenIdentifier` that `users.store` would
 *      eventually write (`<CLERK_JWT_ISSUER_DOMAIN>|<clerk_user_id>`)
 *   3. Upserts the users row with that tokenIdentifier + platformRole
 *
 * When the user later signs into the app for the first time, `users.store`
 * finds this pre-seeded row via `by_tokenIdentifier` and reuses it (instead
 * of creating a second row).
 *
 * Requires:
 *   - CLERK_SECRET_KEY set on the Convex deployment
 *   - CLERK_JWT_ISSUER_DOMAIN set on the Convex deployment
 *   - The user has already been invited to and accepted the Clerk org
 *     (otherwise Clerk returns an empty list)
 *
 * Run with:
 *   npx convex run --prod platform:seedAndBootstrapSuperAdmin '{"email":"saish.gaonkar@bizgroup.ae"}'
 */
export const seedAndBootstrapSuperAdmin = internalAction({
  args: { email: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    clerkUserId: string;
    tokenIdentifier: string;
    userId: Id<"users">;
    action: "patched-existing" | "inserted-new";
  }> => {
    const clerkSecret = process.env.CLERK_SECRET_KEY;
    const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
    if (!clerkSecret) {
      throw new Error("CLERK_SECRET_KEY is not set in Convex env");
    }
    if (!issuerDomain) {
      throw new Error("CLERK_JWT_ISSUER_DOMAIN is not set in Convex env");
    }

    const url = new URL("https://api.clerk.com/v1/users");
    url.searchParams.append("email_address", args.email);
    url.searchParams.set("limit", "1");

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${clerkSecret}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Clerk API ${resp.status}: ${body}`);
    }
    const users = (await resp.json()) as Array<{
      id: string;
      first_name?: string | null;
      last_name?: string | null;
      email_addresses?: Array<{ email_address: string }>;
    }>;
    if (!Array.isArray(users) || users.length === 0) {
      throw new Error(
        `No Clerk user found with email ${args.email}. Invite the user to the Clerk org first, and make sure they have accepted.`,
      );
    }

    const clerkUser = users[0];
    const tokenIdentifier = `${issuerDomain}|${clerkUser.id}`;
    const firstName = clerkUser.first_name ?? "";
    const lastName = clerkUser.last_name ?? "";
    const displayName = `${firstName} ${lastName}`.trim() || clerkUser.id;

    const { userId, action } = await ctx.runMutation(
      internal.platform.upsertAndSeedSuperAdminInternal,
      {
        email: args.email,
        tokenIdentifier,
        name: displayName,
      },
    );

    return {
      clerkUserId: clerkUser.id,
      tokenIdentifier,
      userId,
      action,
    };
  },
});

/**
 * Internal helper for `seedAndBootstrapSuperAdmin`. Upserts a user row and
 * stamps `platformRole: "superAdmin"`. Prefers lookup by tokenIdentifier,
 * falls back to email (handles the case where `users.store` already ran
 * but somehow produced a row without a matching tokenIdentifier).
 */
export const upsertAndSeedSuperAdminInternal = internalMutation({
  args: {
    email: v.string(),
    tokenIdentifier: v.string(),
    name: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    userId: Id<"users">;
    action: "patched-existing" | "inserted-new";
  }> => {
    let user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier),
      )
      .unique();
    if (!user) {
      user = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", args.email))
        .unique();
    }

    if (user) {
      await ctx.db.patch(user._id, {
        tokenIdentifier: args.tokenIdentifier,
        platformRole: "superAdmin",
      });
      return { userId: user._id, action: "patched-existing" };
    }

    const userId = await ctx.db.insert("users", {
      tokenIdentifier: args.tokenIdentifier,
      email: args.email,
      name: args.name,
      profileComplete: false,
      platformRole: "superAdmin",
    });
    return { userId, action: "inserted-new" };
  },
});

// --- Read surface ----------------------------------------------------------

/** Super-admin-only. List every platform super-admin. */
export const listSuperAdmins = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    return await ctx.db
      .query("users")
      .withIndex("by_platformRole", (q) => q.eq("platformRole", "superAdmin"))
      .collect();
  },
});

/** Internal: list super-admins for the fan-out action. */
export const getSuperAdminsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_platformRole", (q) => q.eq("platformRole", "superAdmin"))
      .collect();
    return users.map((u) => ({
      userId: u._id,
      tokenIdentifier: u.tokenIdentifier,
      email: u.email,
      name: u.name,
    }));
  },
});

/** Internal: super-admin gate for the fan-out action. Returns caller user. */
export const requireSuperAdminInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await requireSuperAdmin(ctx);
    return { userId: user._id, tokenIdentifier: user.tokenIdentifier };
  },
});

// --- Promote / demote ------------------------------------------------------

/**
 * Super-admin-only. Promote or demote another user's platform role.
 *
 * Safety: prevents the caller from demoting themselves to protect against
 * locking the platform out of super-admin access (symmetric to the
 * "can't demote the last admin" guard on org roles).
 *
 * Note: this mutation only toggles the flag. When promoting, the newly-minted
 * super-admin must still be added as a Clerk member of any org they need
 * access to — run `fanOutSuperAdminMemberships` for each such org.
 */
export const setPlatformRole = mutation({
  args: {
    targetUserId: v.id("users"),
    platformRole: v.union(v.literal("superAdmin"), v.null()),
  },
  handler: async (ctx, args) => {
    const caller = await requireSuperAdmin(ctx);

    const target = await ctx.db.get(args.targetUserId);
    if (!target) throw new Error("Target user not found");

    // Prevent self-demotion
    if (
      caller._id === args.targetUserId &&
      args.platformRole === null &&
      caller.platformRole === "superAdmin"
    ) {
      throw new Error("Cannot demote yourself from super-admin");
    }

    if (args.platformRole === null) {
      await ctx.db.patch(args.targetUserId, { platformRole: undefined });
    } else {
      await ctx.db.patch(args.targetUserId, { platformRole: args.platformRole });
    }
  },
});

// --- Fan-out ---------------------------------------------------------------

/** Internal: idempotent membership insert, used by the fan-out action. */
export const insertSuperAdminMembershipInternal = internalMutation({
  args: {
    tokenIdentifier: v.string(),
    userId: v.id("users"),
    clerkOrgId: v.string(),
    invitedBy: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
        q
          .eq("tokenIdentifier", args.tokenIdentifier)
          .eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();
    if (existing) {
      // Upgrade to admin if existing membership has a lower role.
      if (existing.role !== "admin") {
        await ctx.db.patch(existing._id, { role: "admin" });
      }
      return { inserted: false, upgraded: existing.role !== "admin" };
    }
    await ctx.db.insert("memberships", {
      tokenIdentifier: args.tokenIdentifier,
      userId: args.userId,
      clerkOrgId: args.clerkOrgId,
      role: "admin",
      invitedBy: args.invitedBy,
      createdAt: Date.now(),
    });
    return { inserted: true, upgraded: false };
  },
});

type FanOutResult = {
  clerkOrgId: string;
  superAdminsProcessed: number;
  membershipsInserted: number;
  membershipsUpgraded: number;
  clerkApiErrors: Array<{ userId: Id<"users">; email: string; message: string }>;
};

/**
 * Shared fan-out implementation — synchronizes every platform super-admin
 * into the given Clerk org as `org:admin` and ensures a matching Fabric
 * memberships row. Used by both the UI-facing action (auth-gated) and the
 * CLI-friendly internal action.
 */
async function fanOutImpl(
  ctx: ActionCtx,
  clerkOrgId: string,
  invitedBy: Id<"users"> | undefined,
): Promise<FanOutResult> {
  const clerkSecret = process.env.CLERK_SECRET_KEY;
  if (!clerkSecret) {
    throw new Error("CLERK_SECRET_KEY is not set in Convex env");
  }

  const superAdmins: Array<{
    userId: Id<"users">;
    tokenIdentifier: string;
    email: string;
    name: string;
  }> = await ctx.runQuery(internal.platform.getSuperAdminsInternal, {});

  const result: FanOutResult = {
    clerkOrgId,
    superAdminsProcessed: 0,
    membershipsInserted: 0,
    membershipsUpgraded: 0,
    clerkApiErrors: [],
  };

  for (const sa of superAdmins) {
    result.superAdminsProcessed++;
    const clerkUserId = clerkUserIdFromTokenIdentifier(sa.tokenIdentifier);

    // Step 1: add the user to the Clerk org as org:admin.
    // Idempotency: if the user is already a member, Clerk returns a 400 with
    // code `already_a_member_in_organization` — we treat that as success so
    // the fan-out can be re-run safely.
    const resp = await fetch(
      `https://api.clerk.com/v1/organizations/${clerkOrgId}/memberships`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clerkSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: clerkUserId,
          role: "org:admin",
        }),
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      let alreadyMember = false;
      try {
        const parsed = JSON.parse(body) as {
          errors?: Array<{ code?: string }>;
        };
        alreadyMember =
          parsed.errors?.some(
            (e) => e.code === "already_a_member_in_organization",
          ) ?? false;
      } catch {
        // Non-JSON body — fall through to error handling.
      }
      if (!alreadyMember) {
        result.clerkApiErrors.push({
          userId: sa.userId,
          email: sa.email,
          message: `Clerk API ${resp.status}: ${body}`,
        });
        // Don't write Fabric membership if Clerk side failed — keeps the two
        // systems consistent. The caller can retry once the error is fixed.
        continue;
      }
    }

    // Step 2: idempotently insert/upgrade the Fabric membership row.
    const mr: { inserted: boolean; upgraded: boolean } = await ctx.runMutation(
      internal.platform.insertSuperAdminMembershipInternal,
      {
        tokenIdentifier: sa.tokenIdentifier,
        userId: sa.userId,
        clerkOrgId,
        invitedBy,
      },
    );
    if (mr.inserted) result.membershipsInserted++;
    if (mr.upgraded) result.membershipsUpgraded++;
  }

  return result;
}

/**
 * UI-facing action. Super-admin-gated via JWT. Call from authenticated
 * client code once an in-app org-creation flow exists.
 */
export const fanOutSuperAdminMemberships = action({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<FanOutResult> => {
    const caller: { userId: Id<"users">; tokenIdentifier: string } =
      await ctx.runQuery(internal.platform.requireSuperAdminInternal, {});
    return fanOutImpl(ctx, args.clerkOrgId, caller.userId);
  },
});

/**
 * CLI-friendly variant. Use when invoking from `npx convex run`, where no
 * JWT identity is attached. Deployment-key auth is the gate here.
 *
 *   npx convex run platform:fanOutSuperAdminMembershipsInternal '{"clerkOrgId":"org_xxxxx"}'
 */
export const fanOutSuperAdminMembershipsInternal = internalAction({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<FanOutResult> => {
    return fanOutImpl(ctx, args.clerkOrgId, undefined);
  },
});
