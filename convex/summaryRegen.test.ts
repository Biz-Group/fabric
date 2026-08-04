/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ORG = "org_summary_regen";

/**
 * The coalescing gate exists because concurrent conversation completions each
 * used to schedule their own regeneration, and two runs racing on "the latest
 * conversation" could drop a transcript or integrate one twice. The property
 * these tests pin down: concurrent requests collapse onto one run, and none of
 * them is ever lost.
 */
async function seedProcess(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const functionId = await ctx.db.insert("functions", {
      name: "Operations",
      sortOrder: 0,
      clerkOrgId: ORG,
    });
    const departmentId = await ctx.db.insert("departments", {
      functionId,
      name: "Payroll",
      sortOrder: 0,
      clerkOrgId: ORG,
    });
    return await ctx.db.insert("processes", {
      departmentId,
      name: "Monthly close",
      sortOrder: 0,
      clerkOrgId: ORG,
    });
  });
}

function readGate(
  t: ReturnType<typeof convexTest>,
  processId: Id<"processes">,
) {
  return t.run(async (ctx) => {
    const process = await ctx.db.get(processId);
    return {
      scheduledAt: process?.summaryRegenScheduledAt,
      requestedAgain: process?.summaryRegenRequestedAgain,
    };
  });
}

describe("process summary regen coalescing", () => {
  test("the first request starts a run", async () => {
    const t = convexTest(schema, modules);
    const processId = await seedProcess(t);

    const result = await t.mutation(
      internal.postCall.requestProcessSummaryRegen,
      { processId, clerkOrgId: ORG },
    );

    expect(result).toEqual({ scheduled: true });
    const gate = await readGate(t, processId);
    expect(gate.scheduledAt).toEqual(expect.any(Number));
    expect(gate.requestedAgain).toBe(false);
  });

  test("requests arriving mid-run coalesce instead of starting more runs", async () => {
    const t = convexTest(schema, modules);
    const processId = await seedProcess(t);

    const first = await t.mutation(
      internal.postCall.requestProcessSummaryRegen,
      { processId, clerkOrgId: ORG },
    );
    const second = await t.mutation(
      internal.postCall.requestProcessSummaryRegen,
      { processId, clerkOrgId: ORG },
    );
    const third = await t.mutation(
      internal.postCall.requestProcessSummaryRegen,
      { processId, clerkOrgId: ORG },
    );

    expect(first.scheduled).toBe(true);
    expect(second.scheduled).toBe(false);
    expect(third.scheduled).toBe(false);
    // Three conversations landing at once cost one run plus one trailing pass,
    // not three full pipelines.
    expect((await readGate(t, processId)).requestedAgain).toBe(true);
  });

  test("finishing a run with queued work schedules exactly one more pass", async () => {
    const t = convexTest(schema, modules);
    const processId = await seedProcess(t);

    await t.mutation(internal.postCall.requestProcessSummaryRegen, {
      processId,
      clerkOrgId: ORG,
    });
    await t.mutation(internal.postCall.requestProcessSummaryRegen, {
      processId,
      clerkOrgId: ORG,
    });

    await t.mutation(internal.postCall.finishProcessSummaryRegen, {
      processId,
      clerkOrgId: ORG,
    });

    const gate = await readGate(t, processId);
    // Gate still held by the trailing pass, and the queue is drained — so the
    // work is not lost and cannot fan out into a second trailing pass.
    expect(gate.scheduledAt).toEqual(expect.any(Number));
    expect(gate.requestedAgain).toBe(false);
  });

  test("finishing a quiet run releases the gate", async () => {
    const t = convexTest(schema, modules);
    const processId = await seedProcess(t);

    await t.mutation(internal.postCall.requestProcessSummaryRegen, {
      processId,
      clerkOrgId: ORG,
    });
    await t.mutation(internal.postCall.finishProcessSummaryRegen, {
      processId,
      clerkOrgId: ORG,
    });

    expect(await readGate(t, processId)).toEqual({
      scheduledAt: undefined,
      requestedAgain: undefined,
    });
  });

  test("a wedged run does not block regeneration forever", async () => {
    const t = convexTest(schema, modules);
    const processId = await seedProcess(t);

    await t.mutation(internal.postCall.requestProcessSummaryRegen, {
      processId,
      clerkOrgId: ORG,
    });
    // Simulate a run that died without releasing the gate — no heartbeat for
    // well past the staleness window.
    await t.run(async (ctx) => {
      await ctx.db.patch(processId, {
        summaryRegenScheduledAt: Date.now() - 10 * 60 * 1000,
      });
    });

    const result = await t.mutation(
      internal.postCall.requestProcessSummaryRegen,
      { processId, clerkOrgId: ORG },
    );

    expect(result).toEqual({ scheduled: true });
  });

  test("the heartbeat keeps a long backfill from looking wedged", async () => {
    const t = convexTest(schema, modules);
    const processId = await seedProcess(t);

    await t.mutation(internal.postCall.requestProcessSummaryRegen, {
      processId,
      clerkOrgId: ORG,
    });
    const stale = Date.now() - 10 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.patch(processId, { summaryRegenScheduledAt: stale });
    });

    await t.mutation(internal.postCall.touchProcessSummaryRegen, {
      processId,
      clerkOrgId: ORG,
    });

    const gate = await readGate(t, processId);
    expect(gate.scheduledAt).toBeGreaterThan(stale);
    // And with the heartbeat fresh again, a new request coalesces rather than
    // starting a competing pipeline.
    const result = await t.mutation(
      internal.postCall.requestProcessSummaryRegen,
      { processId, clerkOrgId: ORG },
    );
    expect(result.scheduled).toBe(false);
  });

  test("the gate is per process", async () => {
    const t = convexTest(schema, modules);
    const first = await seedProcess(t);
    const second = await seedProcess(t);

    const a = await t.mutation(internal.postCall.requestProcessSummaryRegen, {
      processId: first,
      clerkOrgId: ORG,
    });
    const b = await t.mutation(internal.postCall.requestProcessSummaryRegen, {
      processId: second,
      clerkOrgId: ORG,
    });

    expect(a.scheduled).toBe(true);
    expect(b.scheduled).toBe(true);
  });

  test("another org cannot drive a process's regeneration", async () => {
    const t = convexTest(schema, modules);
    const processId = await seedProcess(t);

    await expect(
      t.mutation(internal.postCall.requestProcessSummaryRegen, {
        processId,
        clerkOrgId: "org_someone_else",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
