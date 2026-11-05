import type { HomeFeed, HomeSurfaceData } from "../home/home-feed";

export const homeScenarioNames = [
  "discover-visual",
  "discover-empty",
  "timeline-demo",
  "timeline-unavailable",
  "topics-editorial",
  "topics-catalog-collection",
  "topics-empty",
  "topic-long-blocks",
] as const;

export type HomeScenarioName = (typeof homeScenarioNames)[number];

export interface DevelopmentHomeScenario {
  readonly data: HomeSurfaceData;
  readonly initialFeed: HomeFeed;
  readonly initialTopicId?: string;
}

export type DevelopmentHomeScenarios = Readonly<
  Record<HomeScenarioName, DevelopmentHomeScenario>
>;
