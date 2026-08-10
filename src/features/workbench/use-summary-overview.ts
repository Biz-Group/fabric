"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

export type HierarchySummaryEntity =
  | { kind: "department"; departmentId: Id<"departments"> }
  | { kind: "function"; functionId: Id<"functions"> };

export type SummaryOverviewEntity =
  | { kind: "process"; processId: Id<"processes"> }
  | HierarchySummaryEntity;

/**
 * Reads one overview. Deliberately read-only.
 *
 * Viewing an overview used to start a refresh for any stale or not-yet-migrated
 * entity, which meant a few seconds of test audio could spend tokens at every
 * level of the hierarchy without anyone asking for it. Generation is now a
 * human action: a stale overview keeps showing its last good content and offers
 * Rebuild to contributors and admins.
 */
export function useSummaryOverview(entity: SummaryOverviewEntity | null) {
  return useQuery(api.summaries.getOverview, entity ? { entity } : "skip");
}
