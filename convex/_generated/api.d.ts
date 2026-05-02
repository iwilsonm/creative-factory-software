/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adCreatives from "../adCreatives.js";
import type * as adSets from "../adSets.js";
import type * as ad_deployments from "../ad_deployments.js";
import type * as analyticsSavedViews from "../analyticsSavedViews.js";
import type * as apiCosts from "../apiCosts.js";
import type * as batchJobs from "../batchJobs.js";
import type * as campaigns from "../campaigns.js";
import type * as conductor from "../conductor.js";
import type * as correction_history from "../correction_history.js";
import type * as dashboard_todos from "../dashboard_todos.js";
import type * as entityNotes from "../entityNotes.js";
import type * as fileStorage from "../fileStorage.js";
import type * as flexAds from "../flexAds.js";
import type * as foundationalDocs from "../foundationalDocs.js";
import type * as headlineHistory from "../headlineHistory.js";
import type * as inspirationImages from "../inspirationImages.js";
import type * as migrations from "../migrations.js";
import type * as observationResults from "../observationResults.js";
import type * as observationSnapshots from "../observationSnapshots.js";
import type * as projects from "../projects.js";
import type * as sessions from "../sessions.js";
import type * as settings from "../settings.js";
import type * as staging from "../staging.js";
import type * as system from "../system.js";
import type * as tagAssignments from "../tagAssignments.js";
import type * as tags from "../tags.js";
import type * as templateImages from "../templateImages.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  adCreatives: typeof adCreatives;
  adSets: typeof adSets;
  ad_deployments: typeof ad_deployments;
  analyticsSavedViews: typeof analyticsSavedViews;
  apiCosts: typeof apiCosts;
  batchJobs: typeof batchJobs;
  campaigns: typeof campaigns;
  conductor: typeof conductor;
  correction_history: typeof correction_history;
  dashboard_todos: typeof dashboard_todos;
  entityNotes: typeof entityNotes;
  fileStorage: typeof fileStorage;
  flexAds: typeof flexAds;
  foundationalDocs: typeof foundationalDocs;
  headlineHistory: typeof headlineHistory;
  inspirationImages: typeof inspirationImages;
  migrations: typeof migrations;
  observationResults: typeof observationResults;
  observationSnapshots: typeof observationSnapshots;
  projects: typeof projects;
  sessions: typeof sessions;
  settings: typeof settings;
  staging: typeof staging;
  system: typeof system;
  tagAssignments: typeof tagAssignments;
  tags: typeof tags;
  templateImages: typeof templateImages;
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
