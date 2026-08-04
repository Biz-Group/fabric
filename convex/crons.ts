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

export default crons;
