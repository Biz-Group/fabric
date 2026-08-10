/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as aiUsage from "../aiUsage.js";
import type * as cleanup from "../cleanup.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as departments from "../departments.js";
import type * as descriptionSafety from "../descriptionSafety.js";
import type * as functions from "../functions.js";
import type * as hierarchy from "../hierarchy.js";
import type * as hierarchySummaryV2 from "../hierarchySummaryV2.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as lib_aiPricing from "../lib/aiPricing.js";
import type * as lib_aiProvider from "../lib/aiProvider.js";
import type * as lib_aiUsageMeter from "../lib/aiUsageMeter.js";
import type * as lib_aiUsageRollup from "../lib/aiUsageRollup.js";
import type * as lib_clerkApi from "../lib/clerkApi.js";
import type * as lib_contributorAttribution from "../lib/contributorAttribution.js";
import type * as lib_conversationAnalysis from "../lib/conversationAnalysis.js";
import type * as lib_conversationEvidenceV2 from "../lib/conversationEvidenceV2.js";
import type * as lib_conversationPipelines from "../lib/conversationPipelines.js";
import type * as lib_conversationTitle from "../lib/conversationTitle.js";
import type * as lib_elevenLabsCharging from "../lib/elevenLabsCharging.js";
import type * as lib_flowQuality from "../lib/flowQuality.js";
import type * as lib_flowStages from "../lib/flowStages.js";
import type * as lib_hierarchyOverviewV2 from "../lib/hierarchyOverviewV2.js";
import type * as lib_orgAuth from "../lib/orgAuth.js";
import type * as lib_processOverviewV2 from "../lib/processOverviewV2.js";
import type * as lib_slugs from "../lib/slugs.js";
import type * as lib_summaryEvaluation from "../lib/summaryEvaluation.js";
import type * as lib_summaryV2Feature from "../lib/summaryV2Feature.js";
import type * as lib_transcriptHash from "../lib/transcriptHash.js";
import type * as migrations from "../migrations.js";
import type * as orgIntegrity from "../orgIntegrity.js";
import type * as orgThemes from "../orgThemes.js";
import type * as platform from "../platform.js";
import type * as postCall from "../postCall.js";
import type * as processFlows from "../processFlows.js";
import type * as processSummaryV2 from "../processSummaryV2.js";
import type * as processes from "../processes.js";
import type * as readModelHelpers from "../readModelHelpers.js";
import type * as seed from "../seed.js";
import type * as summaries from "../summaries.js";
import type * as summariesHelpers from "../summariesHelpers.js";
import type * as summaryEvidence from "../summaryEvidence.js";
import type * as summaryOps from "../summaryOps.js";
import type * as summaryV2 from "../summaryV2.js";
import type * as tenants from "../tenants.js";
import type * as testFixtures_summaryV2 from "../testFixtures/summaryV2.js";
import type * as themeColors from "../themeColors.js";
import type * as users from "../users.js";
import type * as voiceRecordings from "../voiceRecordings.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  aiUsage: typeof aiUsage;
  cleanup: typeof cleanup;
  conversations: typeof conversations;
  crons: typeof crons;
  departments: typeof departments;
  descriptionSafety: typeof descriptionSafety;
  functions: typeof functions;
  hierarchy: typeof hierarchy;
  hierarchySummaryV2: typeof hierarchySummaryV2;
  http: typeof http;
  invitations: typeof invitations;
  "lib/aiPricing": typeof lib_aiPricing;
  "lib/aiProvider": typeof lib_aiProvider;
  "lib/aiUsageMeter": typeof lib_aiUsageMeter;
  "lib/aiUsageRollup": typeof lib_aiUsageRollup;
  "lib/clerkApi": typeof lib_clerkApi;
  "lib/contributorAttribution": typeof lib_contributorAttribution;
  "lib/conversationAnalysis": typeof lib_conversationAnalysis;
  "lib/conversationEvidenceV2": typeof lib_conversationEvidenceV2;
  "lib/conversationPipelines": typeof lib_conversationPipelines;
  "lib/conversationTitle": typeof lib_conversationTitle;
  "lib/elevenLabsCharging": typeof lib_elevenLabsCharging;
  "lib/flowQuality": typeof lib_flowQuality;
  "lib/flowStages": typeof lib_flowStages;
  "lib/hierarchyOverviewV2": typeof lib_hierarchyOverviewV2;
  "lib/orgAuth": typeof lib_orgAuth;
  "lib/processOverviewV2": typeof lib_processOverviewV2;
  "lib/slugs": typeof lib_slugs;
  "lib/summaryEvaluation": typeof lib_summaryEvaluation;
  "lib/summaryV2Feature": typeof lib_summaryV2Feature;
  "lib/transcriptHash": typeof lib_transcriptHash;
  migrations: typeof migrations;
  orgIntegrity: typeof orgIntegrity;
  orgThemes: typeof orgThemes;
  platform: typeof platform;
  postCall: typeof postCall;
  processFlows: typeof processFlows;
  processSummaryV2: typeof processSummaryV2;
  processes: typeof processes;
  readModelHelpers: typeof readModelHelpers;
  seed: typeof seed;
  summaries: typeof summaries;
  summariesHelpers: typeof summariesHelpers;
  summaryEvidence: typeof summaryEvidence;
  summaryOps: typeof summaryOps;
  summaryV2: typeof summaryV2;
  tenants: typeof tenants;
  "testFixtures/summaryV2": typeof testFixtures_summaryV2;
  themeColors: typeof themeColors;
  users: typeof users;
  voiceRecordings: typeof voiceRecordings;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
};
