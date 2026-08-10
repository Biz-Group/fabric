import { defineApp } from "convex/server";
import migrations from "@convex-dev/migrations/convex.config.js";
import { v } from "convex/values";

const app = defineApp({
  env: {
    AI_PROVIDER: v.optional(
      v.union(v.literal("openrouter"), v.literal("foundry")),
    ),
    OPENROUTER_API_KEY: v.optional(v.string()),
    FOUNDRY_ENDPOINT: v.optional(v.string()),
    FOUNDRY_API_KEY: v.optional(v.string()),
    FOUNDRY_SYNTHESIS_BACKEND: v.optional(
      v.union(v.literal("claude"), v.literal("gpt5mini")),
    ),
    FOUNDRY_CLAUDE_DEPLOYMENT: v.optional(v.string()),
    FOUNDRY_OPENAI_FALLBACK_DEPLOYMENT: v.optional(v.string()),
    FOUNDRY_SAFETY_DEPLOYMENT: v.optional(v.string()),
    // "true" (all tenants), "false"/unset (no tenants), or a comma-separated
    // Clerk organization allowlist for staged rollout on the shared prod
    // deployment. See lib/summaryV2Feature.ts.
    SUMMARY_V2: v.optional(v.string()),
    // Tags every AI usage ledger row with the deployment that produced it, so
    // the platform console can show prod and dev in one merged view.
    // Unset defaults to "dev" — deliberately the safe direction: an
    // unconfigured deployment is by definition not the one we set up, and
    // mislabelling prod as dev is instantly visible (prod totals read empty),
    // whereas mislabelling dev as prod silently corrupts prod's numbers.
    USAGE_DEPLOYMENT_LABEL: v.optional(
      v.union(v.literal("prod"), v.literal("dev")),
    ),
    // Where this deployment forwards its usage rows. Set on dev only — the sink
    // (prod) leaves both unset, which is how `forwardPendingUsage` knows it has
    // nothing to forward. Point it at the sink's
    // `https://<prod-deployment>.convex.site/ai-usage/ingest`.
    USAGE_SINK_URL: v.optional(v.string()),
    // Shared bearer secret for the ingest route. Must match on both sides.
    USAGE_SINK_SECRET: v.optional(v.string()),
  },
});
app.use(migrations);

export default app;
