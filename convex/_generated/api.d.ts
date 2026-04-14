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
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as orgIntegrity from "../orgIntegrity.js";
import type * as postCall from "../postCall.js";
import type * as processFlows from "../processFlows.js";
import type * as processes from "../processes.js";
import type * as seed from "../seed.js";
import type * as summaries from "../summaries.js";
import type * as summariesHelpers from "../summariesHelpers.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  cleanup: typeof cleanup;
  conversations: typeof conversations;
  departments: typeof departments;
  functions: typeof functions;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  orgIntegrity: typeof orgIntegrity;
  postCall: typeof postCall;
  processFlows: typeof processFlows;
  processes: typeof processes;
  seed: typeof seed;
  summaries: typeof summaries;
  summariesHelpers: typeof summariesHelpers;
  users: typeof users;
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

export declare const components: {};
