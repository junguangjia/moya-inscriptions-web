import { loadHomeCatalogState } from "../../features/home/load-home-catalog";

import type { CatalogSummary } from "@moya/contracts";
import type { HomeFeedState } from "../../features/home/home-feed";
import type { HomeCatalogSource } from "../../features/home/load-home-catalog";
import type { Topic } from "../../features/topics/topic";

export type DiscoverSource = () => Promise<HomeFeedState<CatalogSummary>>;
export type TopicsSource = () => Promise<HomeFeedState<Topic>>;

export const loadDiscoverFeed = async (
  source?: HomeCatalogSource,
): Promise<HomeFeedState<CatalogSummary>> => {
  const state = await loadHomeCatalogState(
    { page: "1", pageSize: "24" },
    source,
  );
  if (state.state === "populated") {
    return { items: state.page.items, state: "populated" };
  }
  if (state.state === "empty") return { state: "empty" };
  return state;
};

export const unavailableTopicsSource: TopicsSource = async () => ({
  state: "unavailable",
});
