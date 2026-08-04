import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Reaps flow generations whose heartbeat has gone stale. The staged pipeline
// hands off between scheduled actions, so an action killed between writing a
// batch and scheduling the next one leaves pending work with nothing to pick it
// up — invisible to any try/catch. Runs every 5 minutes against a 10-minute
// staleness window, so a wedged generation resolves within ~15 minutes rather
// than sitting in "generating" forever.
crons.interval(
  "reap stuck process flow generations",
  { minutes: 5 },
  internal.processFlows.reapStuckFlowGenerations,
  {},
);

// Ships dev-deployment AI usage rows to the prod sink so the platform console
// can show one merged view. A no-op on the sink itself (USAGE_SINK_URL unset).
// Deliberately not inline with the AI call: a cross-deployment request on the
// pipeline's critical path is what the reliability plan exists to prevent.
crons.interval(
  "forward AI usage to the sink deployment",
  { minutes: 5 },
  internal.aiUsage.forwardPendingUsage,
  {},
);

// Folds yesterday's ledger into rollups so the console reads O(1) for history
// instead of scanning. Runs at 00:30 UTC — after the day closes, with enough
// margin that a straggling forward from dev still lands in the right day.
crons.daily(
  "fold yesterday's AI usage into rollups",
  { hourUTC: 0, minuteUTC: 30 },
  internal.aiUsage.foldUsageDay,
  {},
);

// Trims raw ledger rows past the retention window. Skips any day that has not
// been rolled up, so a stalled fold shows up as a growing table rather than
// permanent data loss.
crons.daily(
  "prune AI usage rows past retention",
  { hourUTC: 3, minuteUTC: 0 },
  internal.aiUsage.pruneOldUsageEvents,
  {},
);

export default crons;
