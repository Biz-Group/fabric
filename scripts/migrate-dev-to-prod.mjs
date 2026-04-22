#!/usr/bin/env node
/**
 * One-shot Dev → Prod data migration for Fabric's Biz Group org.
 *
 * Usage:
 *   node scripts/migrate-dev-to-prod.mjs <PROD_BIZ_GROUP_ORG_ID>
 *   node scripts/migrate-dev-to-prod.mjs <PROD_BIZ_GROUP_ORG_ID> --skip-export
 *   node scripts/migrate-dev-to-prod.mjs <PROD_BIZ_GROUP_ORG_ID> --dry-run
 *
 * Arguments:
 *   <PROD_BIZ_GROUP_ORG_ID> — the Clerk org id for Biz Group in the NEW
 *     production Clerk instance. Required for every mode except --help.
 *
 * Env overrides:
 *   DEV_ORG_ID         — dev Biz Group org id (default: org_3Ca1s1y5S6JRO7LnpgqHvBHAtE5)
 *   DUMP_PATH          — path to dump JSON (default: ./dump.json)
 *
 * Flags:
 *   --skip-export      — skip the dev export step; use an existing DUMP_PATH file
 *   --dry-run          — export only; do not touch prod
 *   --skip-verify      — skip the post-import audit
 *
 * Prerequisites:
 *   - Dev Convex deployment linked (CONVEX_DEPLOYMENT in .env.local)
 *   - Prod Convex deployment deployed (`npx convex deploy` run once already)
 *   - Biz Group org created in prod Clerk and its org_... id known
 *
 * What gets copied:
 *   functions, departments, processes, conversations, processFlows.
 *
 * What does NOT get copied (and why):
 *   - users     — dev Clerk identities don't exist in prod; users auto-provision
 *                 on first sign-in via `users.store`.
 *   - memberships — same reason; auto-provisioned on first sign-in.
 *   - conversations.userId — nulled during import; backfill manually if needed.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONVEX_CLI = resolve(__dirname, "../node_modules/convex/bin/main.js");

const DEFAULT_DEV_ORG = "org_3Ca1s1y5S6JRO7LnpgqHvBHAtE5";

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node scripts/migrate-dev-to-prod.mjs <PROD_BIZ_GROUP_ORG_ID> [--skip-export] [--dry-run] [--skip-verify]",
    );
    process.exit(0);
  }
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const prodOrgId = positional[0];
  if (!prodOrgId) {
    console.error(
      "Error: PROD_BIZ_GROUP_ORG_ID is required as the first positional argument.",
    );
    console.error(
      "Usage: node scripts/migrate-dev-to-prod.mjs <PROD_BIZ_GROUP_ORG_ID>",
    );
    process.exit(1);
  }
  if (!prodOrgId.startsWith("org_")) {
    console.error(
      `Error: PROD_BIZ_GROUP_ORG_ID must start with "org_" — got "${prodOrgId}"`,
    );
    process.exit(1);
  }
  return {
    prodOrgId,
    devOrgId: process.env.DEV_ORG_ID ?? DEFAULT_DEV_ORG,
    dumpPath: resolve(process.env.DUMP_PATH ?? "./dump.json"),
    skipExport: flags.has("--skip-export"),
    dryRun: flags.has("--dry-run"),
    skipVerify: flags.has("--skip-verify"),
  };
}

/**
 * Runs the Convex CLI (optionally against the prod deployment) and returns
 * the parsed JSON return value. The CLI writes the return value to stdout
 * and everything else (status lines, warnings) to stderr.
 *
 * We invoke `node node_modules/convex/bin/main.js` directly rather than
 * `npx.cmd`, because Node 20+ on Windows refuses to spawn `.cmd` files
 * without a shell for security reasons (CVE-2024-27980), and using a shell
 * re-parses the JSON args and strips the quotes. Going straight through
 * Node keeps the JSON arg verbatim.
 */
function runConvex(functionName, args, { prod = false } = {}) {
  const cliArgs = [CONVEX_CLI, "run"];
  if (prod) cliArgs.push("--prod");
  cliArgs.push(functionName, JSON.stringify(args));

  const label = prod ? "[prod]" : "[dev]";
  console.log(`${label} Running ${functionName} ${JSON.stringify(args)}`);

  let stdout;
  try {
    stdout = execFileSync(process.execPath, cliArgs, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (err) {
    console.error(`\n${label} Convex call failed for ${functionName}.`);
    throw err;
  }

  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some functions return plain strings that JSON.parse still handles
    // (because the CLI wraps them in quotes). If it still fails, return raw.
    return trimmed;
  }
}

async function postDumpToStorage(uploadUrl, dumpJson) {
  console.log(`[prod] Uploading dump (${dumpJson.length.toLocaleString()} bytes) to storage...`);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: dumpJson,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Upload failed (HTTP ${response.status}): ${body.slice(0, 500)}`,
    );
  }
  const json = await response.json();
  if (!json.storageId) {
    throw new Error(`Upload response missing storageId: ${JSON.stringify(json)}`);
  }
  return json.storageId;
}

async function main() {
  const opts = parseArgs();
  console.log("Fabric Dev → Prod Migration");
  console.log(`  Source (dev)  org: ${opts.devOrgId}`);
  console.log(`  Target (prod) org: ${opts.prodOrgId}`);
  console.log(`  Dump path        : ${opts.dumpPath}`);
  console.log(`  Skip export      : ${opts.skipExport}`);
  console.log(`  Dry run          : ${opts.dryRun}`);
  console.log("");

  // ── Step 1: Export from dev ────────────────────────────────────────────
  let dumpJson;
  if (opts.skipExport) {
    console.log(`[local] Using existing dump at ${opts.dumpPath}`);
    dumpJson = readFileSync(opts.dumpPath, "utf-8");
  } else {
    const payload = runConvex("migrations:exportForOrg", {
      clerkOrgId: opts.devOrgId,
    });
    if (!payload || typeof payload !== "object") {
      throw new Error(`Unexpected export return value: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    console.log(
      `[dev] Exported: functions=${payload.functions.length}, departments=${payload.departments.length}, processes=${payload.processes.length}, conversations=${payload.conversations.length}, processFlows=${payload.processFlows.length}`,
    );
    dumpJson = JSON.stringify(payload);
    writeFileSync(opts.dumpPath, dumpJson, "utf-8");
    const size = statSync(opts.dumpPath).size;
    console.log(`[local] Wrote dump to ${opts.dumpPath} (${size.toLocaleString()} bytes)`);
  }

  if (opts.dryRun) {
    console.log("\n--dry-run set — stopping before touching prod.");
    process.exit(0);
  }

  // ── Step 2: Request upload URL from prod ───────────────────────────────
  const uploadUrl = runConvex(
    "migrations:prodImportGenerateUploadUrl",
    {},
    { prod: true },
  );
  if (typeof uploadUrl !== "string") {
    throw new Error(
      `prodImportGenerateUploadUrl returned non-string: ${JSON.stringify(uploadUrl).slice(0, 200)}`,
    );
  }

  // ── Step 3: POST dump to prod storage ──────────────────────────────────
  const storageId = await postDumpToStorage(uploadUrl, dumpJson);
  console.log(`[prod] Dump stored as ${storageId}`);

  // ── Step 4: Run import ─────────────────────────────────────────────────
  const importResult = runConvex(
    "migrations:prodImportFromStorage",
    {
      storageId,
      targetOrgId: opts.prodOrgId,
      expectedSourceOrgId: opts.devOrgId,
    },
    { prod: true },
  );
  console.log(`[prod] Import complete:`);
  console.log(JSON.stringify(importResult, null, 2));

  // ── Step 5: Verify ─────────────────────────────────────────────────────
  if (opts.skipVerify) {
    console.log("\n--skip-verify set — not running integrity audit.");
    return;
  }
  const audit = runConvex(
    "orgIntegrity:auditHierarchyIntegrity",
    { clerkOrgId: opts.prodOrgId },
    { prod: true },
  );
  console.log(`[prod] Integrity audit:`);
  console.log(JSON.stringify(audit, null, 2));
}

main().catch((err) => {
  console.error("\nMigration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
