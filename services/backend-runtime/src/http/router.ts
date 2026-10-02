import { handleNotificationRequest } from "../community/notification-handler.js";
import { handleArticleAuthoringRequest } from "../community/article-authoring-handler.js";
import { handleArticleDelegationHttpRequest } from "../community/article-delegation-handler.js";
import type { BackendApplicationOptions } from "../application.js";
import type { NotificationStreams } from "../community/notification-stream.js";
import type { NotificationService } from "@moya/api";
import type { RequestListener, ServerResponse } from "node:http";

import {
  handleCatalogDetail,
  handleCatalogList,
  handleCatalogSearch,
} from "../catalog/catalog-handler.js";
import {
  handleCreateComment,
  handleCreateReply,
  handleReadComments,
  handleReadReplies,
} from "../community/comment-handler.js";
import { handleCommunityAuth } from "../community/auth-handler.js";
import {
  handleCurrentUser,
  handleDevelopmentSignIn,
  handleDevelopmentSignOut,
} from "../community/community-handler.js";
import { handleAuthorRequest } from "../community/author-handler.js";
import { handleOperatorRequest } from "../community/operator-handler.js";
import { healthHandler } from "../health/health-handler.js";
import { sendJson } from "./json-response.js";
import { sendApiError } from "./api-error-response.js";
import { containRequest } from "./request-boundary.js";

// A rejected route handler fails only its own request (see containRequest).
const apiFailure = (response: ServerResponse): void =>
  sendApiError(response, "INTERNAL_ERROR", "Internal error");
const operatorFailure = (response: ServerResponse): void =>
  sendJson(response, 500, { error: { status: 500, code: "INTERNAL_ERROR" } });

import type {
  ArticleAuthoringService,
  CommunityContentOperatorPort,
  DiscussionPort,
  AuthorCommunityService,
  CatalogCommentService,
  CatalogReadService,
  CommunityModerationService,
  CommunityAuthService,
  ArticlePublicationOperatorService,
  CommunitySessionService,
  AgentAdministrationService,
  DirectMessageService,
  PublishingOperatorService,
  ThreadService,
  WorkPublishingService,
} from "@moya/api";
import type { HealthReadinessCheck } from "../health/health-handler.js";

type AllowedMethod = "GET" | "POST" | "GET, POST";

const sendRouteError = (
  response: Parameters<RequestListener>[1],
  status: 400 | 404 | 405,
  message: "Bad Request" | "Method Not Allowed" | "Not Found",
  allow: AllowedMethod = "GET",
): void => {
  sendJson(
    response,
    status,
    { error: { status, message } },
    status === 405 ? { allow } : {},
  );
};

export interface CommunityRouterDependencies {
  /** Separate user-owned Article operations. */
  readonly articleAuthoringService?: ArticleAuthoringService;
  readonly articleDelegation?: BackendApplicationOptions["articleDelegation"];
  readonly articlePublicationOperatorService?: ArticlePublicationOperatorService;
  readonly notificationService?: NotificationService;
  readonly notificationStreams?: NotificationStreams;
  readonly sessionService: CommunitySessionService;
  /** Authentication supplied by the composition root with provider provenance checked. */
  readonly authService?: CommunityAuthService;
  readonly authorService?: AuthorCommunityService;
  /** Work publishing author routes; composed with the author service. */
  readonly publishingService?: WorkPublishingService;
  /** Work publishing operator routes behind the private operator boundary. */
  readonly publishingOperatorService?: PublishingOperatorService;
  /** Agent administration routes; composed only in Development with a port. */
  readonly agentAdministrationService?: AgentAdministrationService;
  readonly contentOperatorPort?: CommunityContentOperatorPort | undefined;
  readonly discussionPort?: DiscussionPort | undefined;
  /** Operator-managed Thread routes. */
  readonly threadService?: ThreadService | undefined;
  /** Owner-only direct-message moderation routes. */
  readonly directMessageService?: DirectMessageService | undefined;
  /** True only under NODE_ENV=development; Production never composes the entry. */
  readonly developmentEntry: boolean;
  /** Present only when a comment port is composed; identity works without it. */
  readonly commentService?: CatalogCommentService;
  readonly moderationService?: CommunityModerationService;
  /**
   * The Owner's operator boundary. An empty credential leaves the internal
   * subpath unreachable, so it is never accidentally open.
   */
  readonly operatorCredential: string;
}

export interface RouterDependencies {
  readonly catalogReadService: CatalogReadService;
  readonly healthReadinessCheck: HealthReadinessCheck;
  readonly community?: CommunityRouterDependencies;
}

export const createRouter =
  ({
    catalogReadService,
    healthReadinessCheck,
    community,
  }: RouterDependencies): RequestListener =>
  (request, response) => {
    // A request target that is not a URL path (for example `//[`) is a client
    // error. This listener runs synchronously, so a throw here would be an
    // uncaught exception that ends the process.
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://request.invalid").pathname;
    } catch {
      sendRouteError(response, 400, "Bad Request");
      return;
    }

    if (pathname === "/health") {
      if (request.method !== "GET") {
        sendRouteError(response, 405, "Method Not Allowed");
        return;
      }

      void healthHandler(request, response, healthReadinessCheck);
      return;
    }

    if (pathname === "/v1/catalog") {
      if (request.method !== "GET") {
        sendRouteError(response, 405, "Method Not Allowed");
        return;
      }

      containRequest(
        response,
        handleCatalogList(request, response, catalogReadService),
        apiFailure,
      );
      return;
    }

    if (pathname === "/v1/catalog-search") {
      if (request.method !== "GET") {
        sendRouteError(response, 405, "Method Not Allowed");
        return;
      }
      containRequest(
        response,
        handleCatalogSearch(request, response, catalogReadService),
        apiFailure,
      );
      return;
    }

    if (pathname === "/v1/me") {
      if (request.method !== "GET") {
        sendRouteError(response, 405, "Method Not Allowed");
        return;
      }
      containRequest(
        response,
        handleCurrentUser(request, response, community?.sessionService),
        apiFailure,
      );
      return;
    }

    if (community?.developmentEntry === true) {
      if (pathname === "/v1/development/sign-in") {
        if (request.method !== "POST") {
          sendRouteError(response, 405, "Method Not Allowed", "POST");
          return;
        }
        containRequest(
          response,
          handleDevelopmentSignIn(request, response, community.sessionService),
          apiFailure,
        );
        return;
      }

      if (pathname === "/v1/development/sign-out") {
        if (request.method !== "POST") {
          sendRouteError(response, 405, "Method Not Allowed", "POST");
          return;
        }
        containRequest(
          response,
          handleDevelopmentSignOut(request, response, community.sessionService),
          apiFailure,
        );
        return;
      }
    }

    if (
      community?.authService !== undefined &&
      pathname.startsWith("/v1/community/auth/")
    ) {
      containRequest(
        response,
        handleCommunityAuth(request, response, community.authService),
        apiFailure,
      );
      return;
    }

    if (
      community?.notificationService &&
      community.notificationStreams &&
      (pathname === "/v1/community/mentions" ||
        pathname === "/v1/community/notifications" ||
        pathname.startsWith("/v1/community/notifications/"))
    ) {
      containRequest(
        response,
        handleNotificationRequest(
          request,
          response,
          community.notificationService,
          community.sessionService,
          community.notificationStreams,
        ),
        apiFailure,
      );
      return;
    }

    const articlePrefix = "/v1/community/article-authoring";
    if (community?.articleDelegation !== undefined) {
      const delegated = community.articleDelegation;
      const resource = new URL(delegated.resource);
      if (
        pathname === resource.pathname ||
        pathname === `/.well-known/oauth-protected-resource${resource.pathname}`
      ) {
        containRequest(response, delegated.mcp(request, response), apiFailure);
        return;
      }
      if (pathname.startsWith(`${articlePrefix}/`)) {
        const segments = pathname.slice(articlePrefix.length + 1).split("/");
        if (
          ["connections", "consents", "approvals"].includes(segments[0] ?? "")
        ) {
          containRequest(
            response,
            handleArticleDelegationHttpRequest(
              request,
              response,
              segments,
              community.sessionService,
              delegated.human,
            ),
            apiFailure,
          );
          return;
        }
      }
    }
    if (
      community?.articleAuthoringService !== undefined &&
      (pathname === articlePrefix || pathname.startsWith(`${articlePrefix}/`))
    ) {
      // These names belong to the separate delegation boundary above. When it
      // is absent, never reinterpret them as human Article IDs or commands.
      const articleOperation = pathname
        .slice(articlePrefix.length + 1)
        .split("/")[0];
      if (
        ["connections", "consents", "approvals"].includes(
          articleOperation ?? "",
        )
      ) {
        sendRouteError(response, 404, "Not Found");
        return;
      }
      containRequest(
        response,
        handleArticleAuthoringRequest(
          request,
          response,
          pathname === articlePrefix
            ? []
            : pathname.slice(articlePrefix.length + 1).split("/"),
          community.articleAuthoringService,
          community.sessionService,
        ),
        apiFailure,
      );
      return;
    }

    if (
      community?.authorService !== undefined &&
      pathname.startsWith("/v1/community/")
    ) {
      containRequest(
        response,
        handleAuthorRequest(
          request,
          response,
          community.authorService,
          community.sessionService,
          community.publishingService,
        ),
        apiFailure,
      );
      return;
    }

    const commentService = community?.commentService;
    if (community !== undefined && commentService !== undefined) {
      const comments = {
        commentService,
        sessionService: community.sessionService,
      };
      const commentsRoute = /^\/v1\/catalog\/([^/]+)\/comments$/.exec(pathname);
      if (commentsRoute !== null) {
        const catalogId = commentsRoute[1] ?? "";
        if (request.method === "GET") {
          containRequest(
            response,
            handleReadComments(request, response, catalogId, comments),
            apiFailure,
          );
          return;
        }
        if (request.method === "POST") {
          containRequest(
            response,
            handleCreateComment(request, response, catalogId, comments),
            apiFailure,
          );
          return;
        }
        sendRouteError(response, 405, "Method Not Allowed", "GET, POST");
        return;
      }

      const repliesRoute =
        /^\/v1\/catalog\/([^/]+)\/comments\/([^/]+)\/replies$/.exec(pathname);
      if (repliesRoute !== null) {
        const catalogId = repliesRoute[1] ?? "";
        const commentId = repliesRoute[2] ?? "";
        if (request.method === "GET") {
          containRequest(
            response,
            handleReadReplies(
              request,
              response,
              catalogId,
              commentId,
              comments,
            ),
            apiFailure,
          );
          return;
        }
        if (request.method === "POST") {
          containRequest(
            response,
            handleCreateReply(
              request,
              response,
              catalogId,
              commentId,
              comments,
            ),
            apiFailure,
          );
          return;
        }
        sendRouteError(response, 405, "Method Not Allowed", "GET, POST");
        return;
      }
    }

    // Loopback-only operator boundary: never exposed by the public ingress and
    // never part of the Public API document.
    const moderationService = community?.moderationService;
    if (
      moderationService !== undefined &&
      pathname.startsWith("/internal/community/")
    ) {
      containRequest(
        response,
        handleOperatorRequest(request, response, pathname, {
          moderationService,
          articlePublicationOperatorService:
            community?.articlePublicationOperatorService,
          contentOperatorPort: community?.contentOperatorPort,
          discussionPort: community?.discussionPort,
          publishingOperatorService: community?.publishingOperatorService,
          agentAdministrationService: community?.agentAdministrationService,
          threadService: community?.threadService,
          directMessageService: community?.directMessageService,
          operatorCredential: community?.operatorCredential ?? "",
        }),
        operatorFailure,
      );
      return;
    }

    const detailRoute = /^\/v1\/catalog\/([^/]+)$/.exec(pathname);
    if (detailRoute !== null) {
      if (request.method !== "GET") {
        sendRouteError(response, 405, "Method Not Allowed");
        return;
      }

      containRequest(
        response,
        handleCatalogDetail(
          request,
          detailRoute[1] ?? "",
          response,
          catalogReadService,
        ),
        apiFailure,
      );
      return;
    }

    sendRouteError(response, 404, "Not Found");
  };
