import {
  CatalogSearch,
  CatalogSearchNavigationAction,
  CatalogSearchProvider,
} from "../features/search/catalog-search";
import { parseHomeFeed } from "../features/home/home-feed";
import { resolveCommunityCommentSurface } from "../features/product-application/community-comment-surface";
import { loadProductionProductStates } from "../features/product-application/load-production-product-states";
import { ProductApplication } from "../features/product-application/product-application";
import { readFormalRequestContext } from "./formal-request-context";

export default async function FormalPage({
  searchParams,
}: {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const [{ initialPlatform }, states] = await Promise.all([
    readFormalRequestContext(),
    loadProductionProductStates(),
  ]);
  const query = (await searchParams) ?? {};
  const initialHomeFeed = parseHomeFeed(query.feed);
  const initialTopicId =
    typeof query.topic === "string" && query.topic.length <= 160
      ? query.topic
      : null;

  return (
    <CatalogSearchProvider>
      <ProductApplication
        {...(process.env.NODE_ENV === "development"
          ? { liveNotifications: true }
          : {})}
        authorCommunity={resolveCommunityCommentSurface() !== null}
        comments={resolveCommunityCommentSurface()}
        {...(process.env.NODE_ENV === "development" &&
        process.env.NEXT_PUBLIC_MOYA_DISCUSSION_PREVIEW === "true"
          ? { developmentDiscussion: true }
          : {})}
        initialHomeFeed={initialHomeFeed}
        initialPlatform={initialPlatform}
        initialTopicId={initialTopicId}
        navigationAction={<CatalogSearchNavigationAction />}
        productUtility={<CatalogSearch />}
        states={states}
      />
    </CatalogSearchProvider>
  );
}
