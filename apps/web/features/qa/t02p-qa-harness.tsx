"use client";

import { useCallback, useState } from "react";

import { T02pProductPreview } from "../product-preview/t02p-product-preview";
import { AuthorProvider } from "../authors/author-context";
import { PublishingEntryProvider } from "../publishing/publishing-entry";
import { PublishingProvider } from "../publishing/publishing-provider";
import { CommentSection } from "../comments/comment-section";
import {
  qaCommentScenarioLabels,
  qaCommentScenarioNames,
} from "../comments/comment-scenarios";
import { useQaCommentStore } from "../comments/use-qa-comment-store";
import { homeScenarioNames } from "./home-scenario-contract";
import { loadCatalogDetailPresentation } from "../detail/load-catalog-detail";
import {
  QaNavigationSearchAction,
  QaProductUtilities,
  QaUtilitiesProvider,
} from "./inscription-filter-presentation";
import {
  defaultQaUserScenarioName,
  qaCurrentUser,
  qaUserScenarioLabels,
  qaUserScenarioNames,
} from "./user-scenarios";
import { qaSearchScenarioNames, qaSearchScenarios } from "./search-scenarios";

import { quickActionContentKey } from "../quick-actions/quick-action-types";
import type { ContentQuickActionEnvironment } from "../quick-actions/quick-action-types";
import type { HomeFeed } from "../home/home-feed";
import type { CatalogDetail } from "@moya/contracts";
import type {
  T02pDevelopmentCatalogScenario,
  T02pDevelopmentCatalogScenarios,
} from "../product-preview/catalog-scenarios";
import type { PresentationPlatform } from "../shell/device-platform";
import type {
  DevelopmentHomeScenarios,
  HomeScenarioName,
} from "./home-scenario-contract";
import type { QaSearchScenarioName } from "./search-scenarios";
import type { QaUserScenarioName } from "./user-scenarios";
import type { QaCommentScenarioName } from "../comments/comment-scenarios";

type PresentationPlatformMode = "auto" | PresentationPlatform;

const catalogScenarioOptions = [
  ["visual", "Visual"],
  ["small-populated", "Small populated"],
  ["empty", "Empty"],
  ["unavailable", "Unavailable"],
  ["unexpected-error", "Unexpected error"],
] as const satisfies readonly (readonly [
  T02pDevelopmentCatalogScenario,
  string,
])[];

const homeScenarioLabels = {
  "discover-empty": "Discover empty",
  "discover-visual": "Discover visual",
  "nearby-demo": "Nearby demo",
  "nearby-unavailable": "Nearby unavailable",
  "topic-long-blocks": "Topic long blocks",
  "topics-catalog-collection": "Topics catalog collection",
  "topics-editorial": "Topics editorial",
  "topics-empty": "Topics empty",
} as const satisfies Record<HomeScenarioName, string>;

const platformOptions = [
  ["auto", "Auto"],
  ["phone", "Phone"],
  ["tablet", "Tablet"],
  ["pc", "PC"],
] as const satisfies readonly (readonly [PresentationPlatformMode, string])[];

const searchScenarioLabels = {
  "search-default": "Search default",
  "search-open": "Search open",
  "search-typing": "Search typing",
  "search-empty": "Search empty",
} as const satisfies Record<QaSearchScenarioName, string>;

export interface T02pQaHarnessProps {
  readonly catalogScenarios: T02pDevelopmentCatalogScenarios;
  readonly homeScenarios: DevelopmentHomeScenarios;
  readonly initialCommentScenario?: QaCommentScenarioName;
  readonly initialHomeFeed?: HomeFeed;
  readonly initialHomeScenario?: HomeScenarioName;
  readonly initialPlatform: PresentationPlatform;
  readonly initialPlatformMode?: PresentationPlatformMode;
  readonly initialTopicId?: string | null;
  readonly detailRecords: readonly CatalogDetail[];
  readonly qaChrome?: "visible" | "hidden";
}

export const T02pQaHarness = ({
  catalogScenarios,
  detailRecords,
  homeScenarios,
  initialCommentScenario = "comment-default",
  initialHomeFeed,
  initialHomeScenario = "discover-visual",
  initialPlatform,
  initialPlatformMode = "auto",
  initialTopicId,
  qaChrome = "visible",
}: T02pQaHarnessProps) => {
  const [catalogScenario, setCatalogScenario] =
    useState<T02pDevelopmentCatalogScenario>("visual");
  const [commentScenario, setCommentScenario] = useState<QaCommentScenarioName>(
    initialCommentScenario,
  );
  const [homeScenario, setHomeScenario] =
    useState<HomeScenarioName>(initialHomeScenario);
  const [platformMode, setPlatformMode] =
    useState<PresentationPlatformMode>(initialPlatformMode);
  const [searchScenario, setSearchScenario] =
    useState<QaSearchScenarioName>("search-default");
  const [userScenario, setUserScenario] = useState<QaUserScenarioName>(
    defaultQaUserScenarioName,
  );
  const [likedIds, setLikedIds] = useState<readonly string[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<readonly string[]>([]);
  const quickActions: ContentQuickActionEnvironment = {
    likedIds,
    favoriteIds,
    onAction: (action, content) => {
      const id = quickActionContentKey(content);
      const toggle = (ids: readonly string[]) =>
        ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
      if (action === "like") setLikedIds(toggle);
      if (action === "favorite") setFavoriteIds(toggle);
    },
  };
  const commentStore = useQaCommentStore(commentScenario);
  const home = homeScenarios[homeScenario];
  const [activeHomeFeed, setActiveHomeFeed] = useState<HomeFeed>(
    initialHomeFeed ?? home.initialFeed,
  );
  const catalog = catalogScenarios[catalogScenario];
  const search = qaSearchScenarios[searchScenario];
  const visualCatalogItems = [
    ...(catalogScenarios.visual.inscriptions.state === "populated"
      ? catalogScenarios.visual.inscriptions.page.items
      : []),
    ...(catalogScenarios.visual.calligraphy.categories.all.state === "populated"
      ? catalogScenarios.visual.calligraphy.categories.all.page.items
      : []),
  ];
  const states = {
    calligraphy: catalog.calligraphy,
    home: home.data,
    inscriptions: catalog.inscriptions,
  };
  const loadQaDetail = useCallback(
    (catalogId: string, signal?: AbortSignal) =>
      loadCatalogDetailPresentation(
        catalogId,
        signal,
        async (requestedId, requestSignal) => {
          if (requestSignal?.aborted === true) {
            throw new DOMException("Aborted", "AbortError");
          }
          const detail = detailRecords.find(({ id }) => id === requestedId);
          return detail === undefined
            ? { state: "not-found" as const }
            : { detail, state: "success" as const };
        },
        "qa",
      ),
    [detailRecords],
  );

  return (
    // The real Discussion panels read community data through the author seam
    // and observe publishing; the seam renders its own feedback region, so it
    // wraps the harness root rather than sitting inside it.
    <AuthorProvider signInHref="/dev/community">
      <PublishingProvider>
        <PublishingEntryProvider>
          <main
            data-catalog-scenario={catalogScenario}
            data-comment-scenario={commentScenario}
            data-home-scenario={homeScenario}
            data-qa-chrome={qaChrome}
            data-search-scenario={searchScenario}
            data-t02p-qa-harness=""
          >
            {qaChrome === "visible" ? (
              <aside aria-label="T02P QA controls" data-qa-controls="">
                <h1>T02P QA Harness</h1>
                <label htmlFor="t02p-qa-platform">
                  QA presentation platform
                </label>
                <select
                  id="t02p-qa-platform"
                  data-qa-platform-selector=""
                  value={platformMode}
                  onChange={(event) => {
                    const next = platformOptions.find(
                      ([candidate]) => candidate === event.currentTarget.value,
                    )?.[0];
                    if (next !== undefined) setPlatformMode(next);
                  }}
                >
                  {platformOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>

                <label htmlFor="t02p-qa-search-scenario">
                  QA Search scenario
                </label>
                <select
                  id="t02p-qa-search-scenario"
                  data-qa-search-scenario-selector=""
                  value={searchScenario}
                  onChange={(event) => {
                    const next = qaSearchScenarioNames.find(
                      (candidate) => candidate === event.currentTarget.value,
                    );
                    if (next !== undefined) setSearchScenario(next);
                  }}
                >
                  {qaSearchScenarioNames.map((value) => (
                    <option key={value} value={value}>
                      {searchScenarioLabels[value]}
                    </option>
                  ))}
                </select>

                <label htmlFor="t02p-qa-home-scenario">QA Home scenario</label>
                <select
                  id="t02p-qa-home-scenario"
                  data-qa-home-scenario-selector=""
                  value={homeScenario}
                  onChange={(event) => {
                    const next = homeScenarioNames.find(
                      (candidate) => candidate === event.currentTarget.value,
                    );
                    if (next !== undefined) setHomeScenario(next);
                  }}
                >
                  {homeScenarioNames.map((value) => (
                    <option key={value} value={value}>
                      {homeScenarioLabels[value]}
                    </option>
                  ))}
                </select>

                <label htmlFor="t02p-qa-user-scenario">QA User scenario</label>
                <select
                  id="t02p-qa-user-scenario"
                  data-qa-user-scenario-selector=""
                  value={userScenario}
                  onChange={(event) => {
                    const next = qaUserScenarioNames.find(
                      (candidate) => candidate === event.currentTarget.value,
                    );
                    if (next !== undefined) setUserScenario(next);
                  }}
                >
                  {qaUserScenarioNames.map((value) => (
                    <option key={value} value={value}>
                      {qaUserScenarioLabels[value]}
                    </option>
                  ))}
                </select>

                <label htmlFor="t02p-qa-catalog-scenario">
                  QA Catalog scenario
                </label>
                <select
                  id="t02p-qa-catalog-scenario"
                  data-qa-catalog-scenario-selector=""
                  value={catalogScenario}
                  onChange={(event) => {
                    const next = catalogScenarioOptions.find(
                      ([candidate]) => candidate === event.currentTarget.value,
                    )?.[0];
                    if (next !== undefined) setCatalogScenario(next);
                  }}
                >
                  {catalogScenarioOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <label htmlFor="t02p-qa-comment-scenario">
                  QA Comment scenario
                </label>
                <select
                  id="t02p-qa-comment-scenario"
                  data-qa-comment-scenario-selector=""
                  value={commentScenario}
                  onChange={(event) => {
                    const next = qaCommentScenarioNames.find(
                      (candidate) => candidate === event.currentTarget.value,
                    );
                    if (next !== undefined) setCommentScenario(next);
                  }}
                >
                  {qaCommentScenarioNames.map((value) => (
                    <option key={value} value={value}>
                      {qaCommentScenarioLabels[value]}
                    </option>
                  ))}
                </select>
              </aside>
            ) : null}

            <QaUtilitiesProvider
              initialSearchOpen={search.initialOpen}
              resetKey={`${searchScenario}:${userScenario}`}
            >
              <T02pProductPreview
                quickActions={quickActions}
                catalogDetailLoader={loadQaDetail}
                key={homeScenario}
                developmentPlatformOverride={
                  platformMode === "auto" ? null : platformMode
                }
                initialHomeFeed={initialHomeFeed ?? home.initialFeed}
                onHomeFeedChange={setActiveHomeFeed}
                initialPlatform={initialPlatform}
                initialTopicId={initialTopicId ?? home.initialTopicId ?? null}
                liveThreads
                navigationAction={<QaNavigationSearchAction />}
                productUtility={
                  <QaProductUtilities
                    activeHomeFeed={activeHomeFeed}
                    catalogItems={visualCatalogItems}
                    initialKeyword={search.initialKeyword}
                    key={`${searchScenario}:${userScenario}`}
                    showEmptyState={search.showEmptyState}
                    showRecentSearches={search.showRecentSearches}
                    userScenarioName={userScenario}
                  />
                }
                renderCommentSection={(catalogId) => (
                  <CommentSection
                    catalogId={catalogId}
                    currentUser={qaCurrentUser}
                    items={commentStore.getItems(catalogId)}
                    key={`${commentScenario}:${catalogId}`}
                    onSendComment={(text) =>
                      commentStore.sendComment(catalogId, text, qaCurrentUser)
                    }
                    onSendReply={(target, text) =>
                      commentStore.sendReply(
                        catalogId,
                        target,
                        text,
                        qaCurrentUser,
                      )
                    }
                    onToggleLike={(commentId, replyId) =>
                      commentStore.toggleLike(catalogId, commentId, replyId)
                    }
                    scenario={commentScenario}
                  />
                )}
                showDevelopmentPagerControls={qaChrome !== "hidden"}
                states={states}
              />
            </QaUtilitiesProvider>
          </main>
        </PublishingEntryProvider>
      </PublishingProvider>
    </AuthorProvider>
  );
};
