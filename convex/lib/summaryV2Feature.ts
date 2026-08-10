import { env } from "../_generated/server";

/**
 * Summary V2 rollout switch.
 *
 * `SUMMARY_V2` accepts three forms:
 *   - unset, empty, or `false` — off for every tenant. This is the rollback
 *     position: reads fall back to the stored deterministic Markdown and no
 *     structured artifact is deleted.
 *   - `true` — on for every tenant on this deployment.
 *   - a comma-separated list of Clerk organization IDs — on for exactly those
 *     tenants, off for every other tenant on the same deployment.
 *
 * The list form exists because production is one Convex deployment shared by
 * every tenant. A boolean cannot express "internal tenant first, then selected
 * external tenants", which is the sequence the rollout requires; without it,
 * the only way to try V2 on one tenant is to enable it for all of them.
 *
 * Unknown or malformed entries simply never match an org, so a typo fails
 * closed to the legacy path rather than enabling a tenant by accident.
 */
export type SummaryV2Rollout =
  | { mode: "off" }
  | { mode: "all" }
  | { mode: "allowlist"; orgIds: ReadonlySet<string> };

export function parseSummaryV2Rollout(
  raw: string | undefined,
): SummaryV2Rollout {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === "false") return { mode: "off" };
  if (value.toLowerCase() === "true") return { mode: "all" };
  const orgIds = new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  // An allowlist that parsed to nothing is indistinguishable from off, and
  // treating it as off keeps every downstream check on the safe path.
  return orgIds.size === 0 ? { mode: "off" } : { mode: "allowlist", orgIds };
}

export function summaryV2Rollout(): SummaryV2Rollout {
  return parseSummaryV2Rollout(env.SUMMARY_V2);
}

export function isSummaryV2EnabledForOrg(clerkOrgId: string): boolean {
  const rollout = summaryV2Rollout();
  if (rollout.mode === "off") return false;
  if (rollout.mode === "all") return true;
  return rollout.orgIds.has(clerkOrgId);
}

/**
 * True when at least one tenant has V2 enabled. Only for deployment-wide
 * decisions that genuinely have no organization in hand; anything touching a
 * tenant's data must use `isSummaryV2EnabledForOrg`.
 */
export function isSummaryV2EnabledAnywhere(): boolean {
  return summaryV2Rollout().mode !== "off";
}

/**
 * Read half of the rollback switch. Disabling `SUMMARY_V2` for a tenant must
 * return every overview surface — UI, clipboard, and PDF — to the
 * deterministic legacy Markdown projection while every structured artifact
 * stays in the database, so reads hide `summaryV2` instead of deleting it.
 */
export function readableSummaryV2<T>(
  clerkOrgId: string,
  artifact: T | undefined,
): T | undefined {
  return isSummaryV2EnabledForOrg(clerkOrgId) ? artifact : undefined;
}

/**
 * Same gate for the list projections, which read `summaryV2` off the document
 * to derive lightweight state and coverage metadata. The row carries its own
 * `clerkOrgId`, so a caller cannot accidentally gate one tenant's row on
 * another tenant's rollout state.
 */
export function withSummaryV2ReadGate<
  T extends { clerkOrgId: string; summaryV2?: unknown },
>(row: T): T {
  if (isSummaryV2EnabledForOrg(row.clerkOrgId)) return row;
  const withoutArtifact = { ...row };
  delete withoutArtifact.summaryV2;
  return withoutArtifact;
}
