"use client";

import { useCallback, useRef } from "react";
import { useOptionalAuthors } from "../authors/author-context";
import { useAuthReturn } from "../auth/auth-return";

import { CatalogBrowseScreen } from "../home/catalog-screen";
import { AllCalligraphyFeed } from "../calligraphy/calligraphy-category-screen";
import { HomeScreen } from "../home/home-screen";
import {
  DiscussionPreviewProvider,
  useDiscussionPreview,
} from "../discussion-preview/preview-context";
import {
  DiscussionPreviewDetail,
  previewFeed,
} from "../discussion-preview/discussion-preview";
import { DiscussionScreen } from "../home/discussion-screen";
import { EditorialDetail } from "../editorial-content/editorial-detail";
import { ThreadDetail } from "../threads/thread-detail";
import { isThreadId } from "../threads/use-threads";
import {
  isArticleId,
  isCollectionId,
} from "../editorial-content/use-editorial-content";
import { loadCatalogDetailPresentation } from "../detail/load-catalog-detail";
import { PreviewCatalogDetailOverlay } from "./preview-catalog-detail-overlay";
import { ProductShell, useProductShell } from "../product-shell/product-shell";
import { findTopic } from "../topics/topic";
import { ContentQuickActionsProvider } from "../quick-actions/content-quick-actions";
import type { ContentQuickActionEnvironment } from "../quick-actions/quick-action-types";

import { TopicDetail } from "../topics/topic-detail";

import type { T02pDevelopmentCatalogDestinationStates } from "./catalog-scenarios";
import type { CatalogDetailPresentationLoader } from "../detail/load-catalog-detail";
import type { ArticleId, DiscussionTarget } from "@moya/contracts";
import type {
  ProductShellEditorOverlayControls,
  ProductShellProfileOverlayRenderProps,
} from "../product-shell/product-shell";
import type { ProductEditorTarget } from "../product-shell/product-history";
import type { CatalogDetailPresentation } from "../detail/catalog-detail-presentation";
import type { ReactNode, RefObject } from "react";
import type { HomeCatalogState } from "../home/catalog-state";
import type { HomeFeed, HomeSurfaceData } from "../home/home-feed";
import type { PresentationPlatform } from "../shell/device-platform";

const PreviewBrowse = ({ state }: { readonly state: HomeCatalogState }) => {
  const { feedLayout, openCatalog } = useProductShell();
  return (
    <div data-product-panel="inscriptions">
      <CatalogBrowseScreen
        feedLayout={feedLayout}
        kind="inscription"
        onOpenCatalog={(item, opener) => openCatalog(item.id, opener)}
        state={state}
      />
    </div>
  );
};

export interface T02pProductPreviewProps {
  readonly detailScopeKey?: string;
  readonly developmentDiscussion?: boolean;
  readonly headerStart?: ReactNode;
  readonly headerEnd?: ReactNode;
  readonly renderProfileOverlay?: (
    properties: ProductShellProfileOverlayRenderProps,
  ) => ReactNode;
  readonly articleEditorEnabled?: boolean;
  readonly renderEditorOverlay?: (
    target: ProductEditorTarget,
    controls: ProductShellEditorOverlayControls,
  ) => ReactNode;
  readonly workDetailLoader?: CatalogDetailPresentationLoader;
  readonly renderDiscussion?: (target: DiscussionTarget) => ReactNode;
  readonly renderDetailActions?: (
    detail: CatalogDetailPresentation,
    refresh: () => void,
  ) => ReactNode;
  readonly renderDiscover?: (active: boolean) => ReactNode;
  readonly renderInscriptions?: (active: boolean) => ReactNode;
  readonly userPage?: ReactNode;
  readonly catalogDetailLoader?: CatalogDetailPresentationLoader;
  readonly developmentPlatformOverride?: PresentationPlatform | null;
  readonly initialPlatform: PresentationPlatform;
  readonly initialHomeFeed?: HomeFeed;
  readonly onHomeFeedChange?: (feed: HomeFeed) => void;
  readonly initialTopicId?: string | null;
  readonly productUtility?: ReactNode;
  readonly navigationAction?: ReactNode;
  readonly quickActions?: ContentQuickActionEnvironment;
  readonly renderCommentSection?: (catalogId: string) => ReactNode;
  readonly showDevelopmentPagerControls?: boolean;
  readonly states: T02pDevelopmentCatalogDestinationStates;
}

export const T02pProductPreview = ({
  catalogDetailLoader = loadCatalogDetailPresentation,
  detailScopeKey = "catalog",
  developmentDiscussion = false,
  headerStart,
  headerEnd,
  renderProfileOverlay,
  renderEditorOverlay,
  articleEditorEnabled = false,
  workDetailLoader,
  renderDiscussion,
  renderDetailActions,
  renderDiscover,
  renderInscriptions,
  userPage,
  developmentPlatformOverride = null,
  initialPlatform,
  initialHomeFeed = "discover",
  onHomeFeedChange,
  initialTopicId = null,
  productUtility,
  navigationAction,
  quickActions,
  renderCommentSection,
  showDevelopmentPagerControls = false,
  states,
}: T02pProductPreviewProps) => (
  <DiscussionPreviewProvider enabled={developmentDiscussion}>
    <div data-clean-product-preview="">
      <ProductShell
        discussion={
          <div data-product-panel="discussion">
            <ContentQuickActionsProvider environment={quickActions}>
              <DiscussionScreen
                data={states.home.topics}
                headerStart={headerStart}
                headerEnd={headerEnd}
                initialTopicId={initialTopicId}
              />
            </ContentQuickActionsProvider>
          </div>
        }
        user={
          userPage ?? (
            <section className="phase4-page">
              <h1>用户</h1>
              <p>登录后查看个人主页。</p>
            </section>
          )
        }
        developmentPlatformOverride={developmentPlatformOverride}
        home={
          <div data-product-panel="home">
            <ContentQuickActionsProvider environment={quickActions}>
              <HomeScreen
                data={states.home}
                initialFeed={initialHomeFeed}
                {...(onHomeFeedChange
                  ? { onFeedChange: onHomeFeedChange }
                  : {})}
                headerStart={headerStart}
                headerEnd={headerEnd}
                {...(renderDiscover ? { renderDiscover } : {})}
                renderInscriptions={
                  renderInscriptions ??
                  (() => <PreviewBrowse state={states.inscriptions} />)
                }
                calligraphy={<AllCalligraphyFeed data={states.calligraphy} />}
              />
            </ContentQuickActionsProvider>
          </div>
        }
        initialPlatform={initialPlatform}
        primaryUtility={productUtility}
        navigationAction={navigationAction}
        {...(renderProfileOverlay ? { renderProfileOverlay } : {})}
        articleEditorEnabled={articleEditorEnabled}
        {...(renderEditorOverlay ? { renderEditorOverlay } : {})}
        showDevelopmentPagerControls={showDevelopmentPagerControls}
        renderDetailOverlay={({
          backButtonRef,
          target,
          initialScrollTop,
          navigationRevision,
          onClose,
          onScrollTopChange,
        }) => (
          <PreviewCatalogDetailOverlay
            backButtonRef={backButtonRef}
            key={`${detailScopeKey}:${target.type}:${target.id}:${navigationRevision}`}
            catalogId={target.id}
            target={target}
            commentSection={
              renderDiscussion?.(target) ??
              (target.type === "catalog"
                ? renderCommentSection?.(target.id)
                : undefined)
            }
            {...(renderDetailActions
              ? { renderActions: renderDetailActions }
              : {})}
            initialScrollTop={initialScrollTop}
            loader={
              target.type === "work"
                ? (workDetailLoader ?? unavailableDetailLoader)
                : catalogDetailLoader
            }
            onClose={onClose}
            onScrollTopChange={onScrollTopChange}
          />
        )}
        renderTopicOverlay={({ backButtonRef, onClose, topicId }) => (
          <PreviewTopicOverlay
            backButtonRef={backButtonRef}
            onClose={onClose}
            topicId={topicId}
            topicsState={states.home.topics}
            {...(renderDiscussion ? { renderDiscussion } : {})}
          />
        )}
      />
    </div>
  </DiscussionPreviewProvider>
);

const PreviewTopicOverlay = ({
  backButtonRef,
  onClose,
  topicId,
  topicsState,
  renderDiscussion,
}: {
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly topicId: string;
  readonly topicsState: HomeSurfaceData["topics"];
  readonly renderDiscussion?: (target: DiscussionTarget) => ReactNode;
}) => {
  const { feedLayout, platform, recoverUnavailableAuthContent } =
    useProductShell();
  const author = useOptionalAuthors();
  const authReturn = useAuthReturn();
  const identityReady =
    author === null || (!author.checking && !author.sessionError);
  // A 404 read before identity confirmation is not reused by the confirmed
  // source. Re-key that reader once on confirmation, preserving public
  // snapshots until it has mounted. Ordinary/focus checks keep the reader.
  const wasAuthSource = useRef(authReturn?.isRestoring() ?? false);
  const confirmedReader = useRef<string | null>(null);
  if (
    wasAuthSource.current &&
    confirmedReader.current === null &&
    identityReady
  )
    confirmedReader.current = author?.viewer?.id ?? "guest";
  const readerKey = wasAuthSource.current
    ? `${topicId}:auth:${confirmedReader.current ?? "checking"}`
    : topicId;
  const recover = useCallback(() => {
    recoverUnavailableAuthContent();
  }, [recoverUnavailableAuthContent]);
  const preview = useDiscussionPreview();
  if (preview && previewFeed(topicId))
    return (
      <DiscussionPreviewDetail
        key={topicId}
        id={topicId}
        backButtonRef={backButtonRef}
        onClose={onClose}
      />
    );
  if (isThreadId(topicId) && author !== null)
    return (
      <ThreadDetail
        key={readerKey}
        id={topicId}
        backButtonRef={backButtonRef}
        onClose={onClose}
        {...(identityReady ? { onUnavailable: recover } : {})}
        {...(renderDiscussion
          ? {
              renderComments: (workId: string) =>
                renderDiscussion({ type: "work", id: workId }),
            }
          : {})}
      />
    );
  if (isArticleId(topicId) || isCollectionId(topicId))
    return (
      <EditorialDetail
        key={readerKey}
        id={topicId}
        backButtonRef={backButtonRef}
        onClose={onClose}
        {...(identityReady ? { onUnavailable: recover } : {})}
        {...(renderDiscussion
          ? {
              renderComments: (articleId: string) =>
                renderDiscussion({
                  type: "article",
                  id: articleId as ArticleId,
                }),
            }
          : {})}
      />
    );
  const topics = topicsState.state === "populated" ? topicsState.items : [];
  return (
    <TopicDetail
      backButtonRef={backButtonRef}
      feedLayout={feedLayout}
      onClose={onClose}
      platform={platform}
      topic={findTopic(topics, topicId)}
      {...(identityReady &&
      (topicsState.state === "populated" || topicsState.state === "empty")
        ? { onUnavailable: recover }
        : {})}
    />
  );
};

const unavailableDetailLoader: CatalogDetailPresentationLoader = async () => ({
  state: "not-found",
});
