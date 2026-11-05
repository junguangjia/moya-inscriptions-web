import type { CatalogSummary, TimelineEntry } from "@moya/contracts";
import type { Topic } from "../topics/topic";

export const homeFeeds = [
  "discover",
  "timeline",
  "inscriptions",
  "calligraphy",
] as const;

export type HomeFeed = (typeof homeFeeds)[number];

export type HomeFeedState<T> =
  | { readonly state: "loading" }
  | { readonly state: "populated"; readonly items: readonly T[] }
  | { readonly state: "empty" }
  | { readonly state: "unavailable" }
  | { readonly state: "unexpected-error" };

export interface HomeSurfaceData {
  readonly discover: HomeFeedState<CatalogSummary>;
  readonly timeline: HomeFeedState<TimelineEntry>;
  readonly topics: HomeFeedState<Topic>;
}

export const parseHomeFeed = (value: unknown): HomeFeed => {
  // Links shared before the timeline replaced 附近 open the timeline.
  if (value === "nearby") return "timeline";
  return homeFeeds.includes(value as HomeFeed)
    ? (value as HomeFeed)
    : "discover";
};
