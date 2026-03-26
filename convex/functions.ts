import { query } from "./_generated/server";
import { requireAuth } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx);
    return await ctx.db
      .query("functions")
      .order("asc")
      .collect();
  },
});
