"use client";

import { LiveCommentSection } from "../comments/live-comment-section";
import { AuthorProvider, useAuthors } from "../authors/author-context";
import {
  AuthorProfileOverlay,
  AuthorProfilePage,
} from "../authors/author-profile";
import { DiscoveryFeed, FilteredInscriptions } from "../authors/discovery-feed";
import { DiscussionSection } from "../authors/discussion-section";
import { DetailActions, loadWorkDetail } from "../authors/work-detail";
import { LiveCatalogCards } from "../authors/live-catalog-cards";
import "../authors/author-styles.css";
import { T02pProductPreview } from "../product-preview/t02p-product-preview";
import { CreateWorkAction } from "../publishing/create-action";
import { PublishingEntryProvider } from "../publishing/publishing-entry";
import { PublishingProvider } from "../publishing/publishing-provider";
import { ArticleCreateEntry } from "../editorial-content/article-authoring/article-create-entry";
import { ArticleAvailability } from "../editorial-content/article-authoring/article-availability";
import { ArticleAuthoringHost } from "../editorial-content/article-authoring/article-host";
import { renderEditorOverlay } from "../publishing/ui/editor/editor-overlay";
import { EditorSessionProvider } from "../publishing/ui/editor/editor-session-provider";
import { NotificationProvider } from "../notifications/notification-context";
import { MessageTrigger } from "../authors/message-center";
import { DirectMessageEntryProvider } from "../messages";
import { useProductShell } from "../product-shell/product-shell";
import { CatalogSearchHeaderAction } from "../search/catalog-search";

import type { CommunityCommentSurface } from "./community-comment-surface";
import type { T02pProductPreviewProps } from "../product-preview/t02p-product-preview";

export interface ProductApplicationProps extends Pick<
  T02pProductPreviewProps,
  | "initialHomeFeed"
  | "initialPlatform"
  | "initialTopicId"
  | "developmentDiscussion"
  | "navigationAction"
  | "productUtility"
  | "states"
> {
  /**
   * The live comment section composed through the frozen seam (amendment
   * section 6); null keeps the accepted Detail without a comment section.
   */
  readonly comments: CommunityCommentSurface | null;
  /**
   * Formal Development composition; the clean Catalog preview keeps its data.
   * With comments, it replaces `navigationAction` with the publishing plus and
   * puts Search in the headers, so it must render inside
   * `CatalogSearchProvider`.
   */
  readonly authorCommunity?: boolean;
  /** Presentation input until the notification service is connected; never synthesized. */
  readonly messageUnreadCount?: number;
  readonly liveNotifications?: boolean;
  readonly articleAuthoring?: boolean;
}

/**
 * The accepted Product application — Home, Browse, Search, Detail and Viewer —
 * with Catalog comments over the real comment client. A Client Component so
 * the render-prop seam is created on the client, while the Server pages decide
 * with plain data whether comments are composed at all.
 */
export const ProductApplication = ({
  comments,
  authorCommunity = false,
  messageUnreadCount = 0,
  liveNotifications = false,
  articleAuthoring = false,
  ...preview
}: ProductApplicationProps) =>
  comments === null || !authorCommunity ? (
    <T02pProductPreview
      {...preview}
      {...(comments === null
        ? {}
        : {
            renderCommentSection: (catalogId: string) => (
              <LiveCommentSection
                catalogId={catalogId}
                key={catalogId}
                signInHref={comments.signInHref}
              />
            ),
          })}
    />
  ) : (
    <AuthorProvider signInHref={comments.signInHref}>
      <NotificationProvider enabled={liveNotifications}>
        <DirectMessageEntryProvider>
          <AuthorProduct
            preview={preview}
            unreadCount={messageUnreadCount}
            liveNotifications={liveNotifications}
            articleAuthoring={articleAuthoring}
          />
        </DirectMessageEntryProvider>
      </NotificationProvider>
    </AuthorProvider>
  );

const AuthorProduct = ({
  preview,
  unreadCount,
  liveNotifications,
  articleAuthoring,
}: {
  preview: Omit<
    ProductApplicationProps,
    | "comments"
    | "authorCommunity"
    | "messageUnreadCount"
    | "liveNotifications"
    | "articleAuthoring"
  >;
  unreadCount: number;
  liveNotifications: boolean;
  articleAuthoring: boolean;
}) => {
  const author = useAuthors();
  return (
    // Uploads and the editor session live above every page and overlay (U01).
    <ArticleAvailability enabled={articleAuthoring}>
      <PublishingProvider>
        <EditorSessionProvider>
          <LiveCatalogCards>
            {" "}
            <PublishingEntryProvider>
              <T02pProductPreview
                {...preview}
                detailScopeKey={author.viewer?.id ?? "guest"}
                // Publishing takes the one dock action; Search moves to the headers.
                navigationAction={
                  articleAuthoring ? (
                    <ArticleCreateEntry />
                  ) : (
                    <CreateWorkAction />
                  )
                }
                articleEditorEnabled={articleAuthoring}
                renderEditorOverlay={(target, controls) =>
                  target.type === "article-list" ||
                  target.type === "article-draft" ? (
                    articleAuthoring ? (
                      <ArticleAuthoringHost
                        target={target}
                        controls={controls}
                      />
                    ) : null
                  ) : (
                    renderEditorOverlay(target, controls)
                  )
                }
                renderProfileOverlay={(properties) => (
                  <AuthorProfileOverlay {...properties} />
                )}
                workDetailLoader={loadWorkDetail}
                renderDiscussion={(target) => (
                  <DiscussionSection
                    target={target}
                    key={`${target.type}:${target.id}`}
                  />
                )}
                renderDetailActions={(detail) => (
                  <DetailActions detail={detail} />
                )}
                renderDiscover={(active) => (
                  <DiscoveryFeed kind="all" active={active} />
                )}
                renderInscriptions={(active) => (
                  <FilteredInscriptions active={active} />
                )}
                userPage={<UserPage />}
                headerStart={<CatalogSearchHeaderAction />}
                headerEnd={
                  <MessageTrigger
                    liveNotifications={liveNotifications}
                    developmentPreview={preview.developmentDiscussion ?? false}
                    unreadCount={unreadCount}
                  />
                }
              />
            </PublishingEntryProvider>
          </LiveCatalogCards>
        </EditorSessionProvider>
      </PublishingProvider>
    </ArticleAvailability>
  );
};

const UserPage = () => {
  const shell = useProductShell();
  return (
    <AuthorProfilePage
      onBack={() => shell.navigatePrimary("home")}
      headerStart={<CatalogSearchHeaderAction />}
    />
  );
};
