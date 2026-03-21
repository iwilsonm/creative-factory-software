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
import type * as adgen2Images from "../adgen2Images.js";
import type * as apiCosts from "../apiCosts.js";
import type * as batchJobs from "../batchJobs.js";
import type * as brandDna from "../brandDna.js";
import type * as campaigns from "../campaigns.js";
import type * as chatThreads from "../chatThreads.js";
import type * as conductor from "../conductor.js";
import type * as correction_history from "../correction_history.js";
import type * as dashboard_todos from "../dashboard_todos.js";
import type * as fileStorage from "../fileStorage.js";
import type * as flexAds from "../flexAds.js";
import type * as foundationalDocs from "../foundationalDocs.js";
import type * as headlineHistory from "../headlineHistory.js";
import type * as inspirationImages from "../inspirationImages.js";
import type * as landingPageVersions from "../landingPageVersions.js";
import type * as landingPages from "../landingPages.js";
import type * as lpAgentConfig from "../lpAgentConfig.js";
import type * as lpHeadlineHistory from "../lpHeadlineHistory.js";
import type * as lpTemplates from "../lpTemplates.js";
import type * as metaPerformance from "../metaPerformance.js";
import type * as projects from "../projects.js";
import type * as quote_bank from "../quote_bank.js";
import type * as quote_mining_runs from "../quote_mining_runs.js";
import type * as sessions from "../sessions.js";
import type * as settings from "../settings.js";
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
  adgen2Images: typeof adgen2Images;
  apiCosts: typeof apiCosts;
  batchJobs: typeof batchJobs;
  brandDna: typeof brandDna;
  campaigns: typeof campaigns;
  chatThreads: typeof chatThreads;
  conductor: typeof conductor;
  correction_history: typeof correction_history;
  dashboard_todos: typeof dashboard_todos;
  fileStorage: typeof fileStorage;
  flexAds: typeof flexAds;
  foundationalDocs: typeof foundationalDocs;
  headlineHistory: typeof headlineHistory;
  inspirationImages: typeof inspirationImages;
  landingPageVersions: typeof landingPageVersions;
  landingPages: typeof landingPages;
  lpAgentConfig: typeof lpAgentConfig;
  lpHeadlineHistory: typeof lpHeadlineHistory;
  lpTemplates: typeof lpTemplates;
  metaPerformance: typeof metaPerformance;
  projects: typeof projects;
  quote_bank: typeof quote_bank;
  quote_mining_runs: typeof quote_mining_runs;
  sessions: typeof sessions;
  settings: typeof settings;
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
