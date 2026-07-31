/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as cleanup from "../cleanup.js";
import type * as conversations from "../conversations.js";
import type * as departments from "../departments.js";
import type * as descriptionSafety from "../descriptionSafety.js";
import type * as functions from "../functions.js";
import type * as hierarchy from "../hierarchy.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as lib_aiProvider from "../lib/aiProvider.js";
import type * as lib_clerkApi from "../lib/clerkApi.js";
import type * as lib_contributorAttribution from "../lib/contributorAttribution.js";
import type * as lib_conversationTitle from "../lib/conversationTitle.js";
import type * as lib_orgAuth from "../lib/orgAuth.js";
import type * as lib_slugs from "../lib/slugs.js";
import type * as migrations from "../migrations.js";
import type * as orgIntegrity from "../orgIntegrity.js";
import type * as orgThemes from "../orgThemes.js";
import type * as platform from "../platform.js";
import type * as postCall from "../postCall.js";
import type * as processFlows from "../processFlows.js";
import type * as processes from "../processes.js";
import type * as readModelHelpers from "../readModelHelpers.js";
import type * as seed from "../seed.js";
import type * as summaries from "../summaries.js";
import type * as summariesHelpers from "../summariesHelpers.js";
import type * as tenants from "../tenants.js";
import type * as themeColors from "../themeColors.js";
import type * as users from "../users.js";
import type * as voiceRecordings from "../voiceRecordings.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  cleanup: typeof cleanup;
  conversations: typeof conversations;
  departments: typeof departments;
  descriptionSafety: typeof descriptionSafety;
  functions: typeof functions;
  hierarchy: typeof hierarchy;
  http: typeof http;
  invitations: typeof invitations;
  "lib/aiProvider": typeof lib_aiProvider;
  "lib/clerkApi": typeof lib_clerkApi;
  "lib/contributorAttribution": typeof lib_contributorAttribution;
  "lib/conversationTitle": typeof lib_conversationTitle;
  "lib/orgAuth": typeof lib_orgAuth;
  "lib/slugs": typeof lib_slugs;
  migrations: typeof migrations;
  orgIntegrity: typeof orgIntegrity;
  orgThemes: typeof orgThemes;
  platform: typeof platform;
  postCall: typeof postCall;
  processFlows: typeof processFlows;
  processes: typeof processes;
  readModelHelpers: typeof readModelHelpers;
  seed: typeof seed;
  summaries: typeof summaries;
  summariesHelpers: typeof summariesHelpers;
  tenants: typeof tenants;
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
