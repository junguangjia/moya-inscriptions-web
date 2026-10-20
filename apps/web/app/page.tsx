import {
  CatalogSearch,
  CatalogSearchNavigationAction,
  CatalogSearchProvider,
} from "../features/search/catalog-search";
import { parseHomeFeed } from "../features/home/home-feed";
import { resolveCommunityCommentSurface } from "../features/product-application/community-comment-surface";
import { ProductAccessWatcher } from "../features/product-access/product-access-actions";
import { ProductAccessNotice } from "../features/product-access/product-access-notice";
import { loadProductionProductStates } from "../features/product-application/load-production-product-states";
import { ProductApplication } from "../features/product-application/product-application";
import { readFormalRequestContext } from "./formal-request-context";
import { readVisitorAccess } from "./product-access";
import { wideScreenBrowseOnlyHint } from "./wide-screen-browse-only";
import { ProductAnalytics } from "../features/analytics/product-analytics";

export default async function FormalPage({
  searchParams,
}: {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  // Decided before anything is loaded: a visitor without access receives the
  // notice alone, never product data hidden behind it.
  const access = await readVisitorAccess();
  if (access.state !== "granted")
    return <ProductAccessNotice access={access} />;
  const [{ initialPlatform }, states] = await Promise.all([
    readFormalRequestContext(),
    loadProductionProductStates(access.token),
  ]);
  const query = (await searchParams) ?? {};
  const initialHomeFeed = parseHomeFeed(query.feed);
  const initialTopicId =
    typeof query.topic === "string" && query.topic.length <= 160
      ? query.topic
      : null;
  const browseOnly = wideScreenBrowseOnlyHint(access);

  return (
    <CatalogSearchProvider>
      {access.closedBeta && <ProductAccessWatcher expected="granted" />}
      <ProductApplication
        {...(resolveCommunityCommentSurface() !== null
          ? {
              liveNotifications: true,
              articleAuthoring: true,
              ...(browseOnly === undefined
                ? {}
                : { wideScreenBrowseOnly: browseOnly }),
            }
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
        productUtility={
          <>
            <CatalogSearch />
            <ProductAnalytics
              enabled={
                process.env.NODE_ENV === "production" &&
                process.env.NEXT_PUBLIC_MOYA_ANALYTICS_ENABLED === "true"
              }
            />
          </>
        }
        states={states}
      />
    </CatalogSearchProvider>
  );
}
