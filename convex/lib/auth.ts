import { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

export async function requireAuth(
  ctx: QueryCtx | MutationCtx | ActionCtx,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }
  return identity;
}
