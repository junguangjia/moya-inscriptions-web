import { handleReportingOperatorRequest } from "./reporting-handler.js";
import type { ReportingOperatorRoutes } from "./reporting-handler.js";
import { timingSafeEqual } from "node:crypto";
import type { readBoundedArticleThumbnail } from "./article-runtime-read.js";

import {
  requireHumanModerationReason,
  CommunityInputError,
  CommunityNotFoundError,
  CommunityContentOperatorService,
  isCommunityConflictError,
  isCommunityIdempotencyConflictError,
  isCommunityInputError,
  isCommunityNotFoundError,
  isCommunityReadTimedOutError,
  isCommunityStoreUnavailableError,
} from "@moya/api";
import {
  catalogCommentIdSchema,
  publicUserIdSchema,
} from "@moya/contracts/schemas";
import {
  catalogRecipePolicySchema,
  catalogThumbnailRequestSchema,
  type CatalogThumbnailRequest,
  catalogDeliveryReadinessRequestSchema,
  catalogDeliveryReadinessSchema,
  catalogPublishedRenditionsRequestSchema,
  catalogPublishedRenditionsSchema,
  catalogRenderBacklogSchema,
  type CatalogDeliveryReadiness,
  type CatalogPublishedRenditions,
  type CatalogPublishedRenditionsRequest,
  type CatalogRecipePolicy,
  type CatalogRenderBacklogReport,
} from "@moya/contracts/internal/editorial";
import {
  AI_OPERATOR_CREDENTIALS,
  AI_OPERATOR_LABEL,
  AI_OPERATOR_RUN_HEADER,
  aiOperatorRouteFor,
  aiOperatorRouteId,
  isAiRunHeader,
  SELF_ONLY_OWNER_REVIEW,
  type AiOperatorCredential,
  type AiOperatorReader,
} from "@moya/contracts/internal/admin-mcp";

import {
  aiCommentReceipt,
  aiInputRefusal,
  aiPolicyReceipt,
  aiRecordRefusal,
  aiUserReceipt,
  featuringSelfOnly,
  handleAiOperatorRead,
} from "./ai-operator.js";
import { deliverPublishingMedia } from "./publishing-media-read.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { sendCommentJson } from "../http/comment-json-response.js";
import { failureLabel } from "../http/request-boundary.js";
import { collectTransportQuery } from "../http/transport-query.js";
import { handleAgentRequest } from "./agent-handler.js";
import { handlePublishingOperatorRequest } from "./work-publishing-handler.js";
import {
  handleFeedbackOperatorRequest,
  handleFeedbackOperatorImageRequest,
} from "./feedback-handler.js";
import { handleThreadOperatorRequest } from "./thread-handler.js";
import { handleDirectMessageOperatorRequest } from "./direct-message-handler.js";
import { handleArticlePublicationOperatorRequest } from "./article-publication-operator-handler.js";

import type {
  AgentAdministrationService,
  ArticlePublicationOperatorService,
  CommunityContentOperatorPort,
  DiscussionPort,
  CommunityModerationService,
  DirectMessageService,
  PublishingOperatorService,
  ThreadService,
  FeedbackService,
} from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The services that record who acted: one bundle per audit label. */
export interface OperatorLabelledServices {
  readonly moderationService: CommunityModerationService;
  readonly reportingService?: ReportingOperatorRoutes | undefined;
  readonly publishingOperatorService?: PublishingOperatorService | undefined;
  readonly articlePublicationOperatorService?:
    ArticlePublicationOperatorService | undefined;
}

export interface OperatorRouteDependencies extends OperatorLabelledServices {
  /** Built for `ai-admin`; absent, an AI credential reaches none of them. */
  readonly aiServices?: OperatorLabelledServices | undefined;
  /** The AI-only reads and the current visibility check on the AI path. */
  readonly aiOperatorReader?: AiOperatorReader | undefined;
  readonly catalogThumbnail?:
    | ((
        input: CatalogThumbnailRequest,
      ) => ReturnType<typeof readBoundedArticleThumbnail>)
    | undefined;
  readonly catalogDeliveryReadiness?:
    | ((intentId: string) => Promise<CatalogDeliveryReadiness | null>)
    | undefined;
  readonly catalogRecipePolicy?:
    (() => Promise<CatalogRecipePolicy>) | undefined;
  /** Admin publish gate: App facts only, read with the Backend's own role. */
  readonly catalogPublishedRenditions?:
    | ((
        media: CatalogPublishedRenditionsRequest["media"],
      ) => Promise<CatalogPublishedRenditions>)
    | undefined;
  /** Pacing of bulk Catalog work (catalog-scale-v1 I9): the App's render
   * backlog, counts only, read with the Backend's own role. */
  readonly catalogRenderBacklog?:
    (() => Promise<CatalogRenderBacklogReport>) | undefined;
  readonly contentOperatorPort?: CommunityContentOperatorPort | undefined;
  readonly discussionPort?: DiscussionPort | undefined;
  /** Agent administration (Development only); absent leaves agent/* unrouted. */
  readonly agentAdministrationService?: AgentAdministrationService | undefined;
  /** Threads (content-community-completion-v1, Development only); absent leaves threads/* unrouted. */
  readonly threadService?: ThreadService | undefined;
  readonly feedbackService?: FeedbackService | undefined;
  /** DM moderation (content-community-completion-v1, Development only). */
  readonly directMessageService?: DirectMessageService | undefined;
  /** Shared credential the Owner's Payload Admin holds server-side. */
  readonly operatorCredential: string;
  /** Absent or empty: that AI credential is accepted nowhere. */
  readonly aiCredentials?: OperatorAiCredentials | undefined;
}

export type OperatorAiCredentials = Readonly<
  Partial<Record<AiOperatorCredential, string>>
>;

/** Who is calling, which the route and every audit row take from here. */
export type OperatorActor =
  | { readonly label: "owner" }
  | {
      readonly label: typeof AI_OPERATOR_LABEL;
      readonly credential: AiOperatorCredential;
    };

/** The operator boundary is not the Public API: it returns bare codes, no ApiError. */
const sendOperatorError = (
  response: ServerResponse,
  status: 400 | 401 | 403 | 404 | 405 | 409 | 500 | 503,
  code: string,
): void => sendJson(response, status, { error: { status, code } });

const constantTimeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

export const isAuthorizedOperator = (
  request: IncomingMessage,
  credential: string,
): boolean => {
  const header = request.headers.authorization;
  if (typeof header !== "string" || credential.length === 0) return false;
  const presented = /^Bearer (\S+)$/.exec(header)?.[1];
  return presented !== undefined && constantTimeEquals(presented, credential);
};

export const resolveOperatorActor = (
  request: IncomingMessage,
  ownerCredential: string,
  aiCredentials: OperatorAiCredentials = {},
): OperatorActor | null => {
  if (isAuthorizedOperator(request, ownerCredential)) return { label: "owner" };
  const credential = AI_OPERATOR_CREDENTIALS.find((name) =>
    isAuthorizedOperator(request, aiCredentials[name] ?? ""),
  );
  return credential === undefined
    ? null
    : { label: AI_OPERATOR_LABEL, credential };
};

/**
 * What stands between an AI credential and a route. Default deny: only a row of
 * the route table naming this credential passes, so `agent/*` refuses on every AI
 * credential. No sensitive category is provisioned on this path yet, so a sensitive
 * row refuses, binary routes included.
 */
export const aiOperatorRefusal = (
  request: IncomingMessage,
  pathname: string,
  credential: AiOperatorCredential,
): string | null => {
  const route = aiOperatorRouteFor(
    request.method ?? "GET",
    pathname,
    new URL(request.url ?? "/", "http://request.invalid").searchParams,
  );
  if (route === undefined || !route.credentials.includes(credential))
    return "AI_ROUTE_FORBIDDEN";
  // Only a run id passes: a header any caller could fill with a word is no run.
  if (
    route.klass === "irreversible" &&
    !isAiRunHeader(request.headers[AI_OPERATOR_RUN_HEADER])
  )
    return "AI_RUN_REQUIRED";
  if (route.klass.startsWith("sensitive:")) return "SENSITIVE_SWITCH_OFF";
  return null;
};

const sendFailure = (response: ServerResponse, error: unknown): void => {
  // A handler that failed after it answered has nothing left to fail; one
  // that failed while answering cannot be answered twice. Both still leave a
  // diagnosable trace without private data.
  if (response.headersSent) {
    console.error(
      `[backend-runtime] operator request failed after answering (${failureLabel(error)})`,
    );
    if (!response.writableEnded) response.destroy();
    return;
  }
  if (isCommunityNotFoundError(error)) {
    sendOperatorError(response, 404, "NOT_FOUND");
    return;
  }
  if (isCommunityIdempotencyConflictError(error)) {
    sendOperatorError(response, 409, "IDEMPOTENCY_CONFLICT");
    return;
  }
  if (isCommunityConflictError(error)) {
    // The subject moved on; the caller refreshes rather than retries.
    sendOperatorError(response, 409, "STATE_CONFLICT");
    return;
  }
  if (isCommunityInputError(error)) {
    sendOperatorError(response, 400, "INVALID_COMMAND");
    return;
  }
  if (isCommunityStoreUnavailableError(error)) {
    sendOperatorError(response, 503, "STORE_UNAVAILABLE");
    return;
  }
  if (isCommunityReadTimedOutError(error)) {
    sendOperatorError(response, 503, "READ_TIMED_OUT");
    return;
  }
  // Unmapped: leave a diagnosable trace without private data.
  console.error(
    `[backend-runtime] operator request failed (${failureLabel(error)})`,
  );
  sendOperatorError(response, 500, "INTERNAL_ERROR");
};

/**
 * Duplicate or non-string query values must fail, not be silently dropped:
 * an unfiltered moderation queue is not what the Owner asked for.
 */
const numericQuery = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d{0,5}$/.test(value))
    throw new CommunityInputError("Operator query is invalid");
  return Number(value);
};

/** A malformed percent escape is a missing subject, never a 500. */
const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

const queryOf = (request: IncomingMessage) =>
  collectTransportQuery(
    new URL(request.url ?? "/", "http://request.invalid").searchParams,
  );

/**
 * The whole query, as the service's strict schema reads it: a key no schema knows is
 * refused there, never dropped here, so a filter the Owner set always reaches the SQL.
 * Only the page numbers are read as numbers first.
 */
const pagedQueryOf = (request: IncomingMessage) => {
  const { page, pageSize, ...query } = queryOf(request);
  return {
    ...query,
    ...(page === undefined ? {} : { page: numericQuery(page) }),
    ...(pageSize === undefined ? {} : { pageSize: numericQuery(pageSize) }),
  };
};

/**
 * Routes, all behind the operator credential:
 *   GET  /internal/community/publication-policy
 *   PUT  /internal/community/publication-policy
 *   GET  /internal/community/comments?moderation&kind&catalogId&search&authorId&from&to&order&page&pageSize
 *   POST /internal/community/comments/moderation          (selected items, bounded)
 *   GET  /internal/community/comments/{id}                (detail with context)
 *   GET  /internal/community/comments/{id}/analysis       (advisory state only)
 *   POST /internal/community/comments/{id}/moderation
 *   POST /internal/community/users/{id}/status
 *   GET  /internal/community/moderation-events?subjectId&action&page&pageSize
 *   GET  /internal/community/summary?range
 *   …    /internal/community/publishing/*                  (work-publishing-handler.ts)
 * The subject id always travels in the route; a body carries the command only.
 */
export const handleOperatorRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  {
    moderationService: ownerModerationService,
    reportingService: ownerReportingService,
    publishingOperatorService: ownerPublishingOperatorService,
    articlePublicationOperatorService: ownerArticlePublicationOperatorService,
    aiServices,
    aiOperatorReader,
    catalogRecipePolicy,
    catalogThumbnail,
    catalogDeliveryReadiness,
    catalogPublishedRenditions,
    catalogRenderBacklog,
    operatorCredential,
    aiCredentials,
    contentOperatorPort,
    discussionPort,
    agentAdministrationService,
    threadService,
    feedbackService,
    directMessageService,
  }: OperatorRouteDependencies,
): Promise<void> => {
  if (/^\/internal\/community\/comments\/[^/]+\/images\//u.test(pathname)) {
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("vary", "Authorization");
  }
  const actor = resolveOperatorActor(
    request,
    operatorCredential,
    aiCredentials,
  );
  if (actor === null) {
    sendOperatorError(response, 401, "OPERATOR_UNAUTHORIZED");
    return;
  }
  if (actor.label === AI_OPERATOR_LABEL) {
    const refusal = aiOperatorRefusal(request, pathname, actor.credential);
    if (refusal !== null) {
      sendOperatorError(response, 403, refusal);
      return;
    }
  }
  const method = request.method ?? "GET";
  const methodNotAllowed = () =>
    sendOperatorError(response, 405, "METHOD_NOT_ALLOWED");
  const services: OperatorLabelledServices | undefined =
    actor.label === AI_OPERATOR_LABEL
      ? aiServices
      : {
          moderationService: ownerModerationService,
          reportingService: ownerReportingService,
          publishingOperatorService: ownerPublishingOperatorService,
          articlePublicationOperatorService:
            ownerArticlePublicationOperatorService,
        };
  if (services === undefined) {
    sendOperatorError(response, 503, "OPERATOR_UNAVAILABLE");
    return;
  }
  const {
    moderationService,
    reportingService,
    publishingOperatorService,
    articlePublicationOperatorService,
  } = services;
  try {
    if (actor.label === AI_OPERATOR_LABEL) {
      const invalid = aiInputRefusal(request, pathname);
      if (invalid !== null) {
        sendOperatorError(response, invalid.status, invalid.code);
        return;
      }
      const route = aiOperatorRouteFor(
        method,
        pathname,
        new URL(request.url ?? "/", "http://request.invalid").searchParams,
      );
      if (route?.selfOnly !== undefined) {
        if (aiOperatorReader === undefined) {
          sendOperatorError(response, 503, "OPERATOR_UNAVAILABLE");
          return;
        }
        const id = decodeSegment(aiOperatorRouteId(route, pathname) ?? "");
        const refusal =
          id === undefined
            ? null
            : await aiRecordRefusal(request, route, id, aiOperatorReader);
        if (refusal !== null) {
          sendOperatorError(response, 403, refusal);
          return;
        }
      }
      if (
        await handleAiOperatorRead(
          request,
          response,
          pathname,
          aiOperatorReader,
        )
      )
        return;
    }
    if (pathname === "/internal/community/catalog-delivery/thumbnail") {
      if (method !== "GET") return methodNotAllowed();
      if (!catalogThumbnail)
        return sendOperatorError(
          response,
          503,
          "CATALOG_DELIVERY_NOT_CONFIGURED",
        );
      const input = catalogThumbnailRequestSchema.safeParse(
        collectTransportQuery(
          new URL(request.url ?? "/", "http://request.invalid").searchParams,
        ),
      );
      if (!input.success)
        return sendOperatorError(response, 400, "INVALID_INPUT");
      const result = await catalogThumbnail(input.data);
      response.writeHead(200, {
        "Content-Type": result.mimeType,
        "Content-Length": result.bytes.byteLength,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      response.end(result.bytes);
      return;
    }
    if (
      feedbackService !== undefined &&
      pathname === "/internal/community/feedback"
    ) {
      await handleFeedbackOperatorRequest(request, response, feedbackService);
      return;
    }
    const feedbackImage =
      /^\/internal\/community\/feedback\/(feedback-[0-9a-f]{32})\/images\/(media-item-[0-9a-f]{32})\/(thumb|display|full)$/u.exec(
        pathname,
      );
    if (feedbackService !== undefined && feedbackImage) {
      await handleFeedbackOperatorImageRequest(
        request,
        response,
        feedbackService,
        feedbackImage.slice(1),
      );
      return;
    }
    if (
      reportingService &&
      (pathname === "/internal/community/reports" ||
        pathname.startsWith("/internal/community/reports/"))
    ) {
      await handleReportingOperatorRequest(
        request,
        response,
        pathname,
        reportingService,
        actor.label === AI_OPERATOR_LABEL,
      );
      return;
    }
    if (pathname === "/internal/community/catalog-delivery/readiness") {
      if (method !== "POST") return methodNotAllowed();
      if (!catalogDeliveryReadiness)
        return sendOperatorError(
          response,
          503,
          "CATALOG_DELIVERY_NOT_CONFIGURED",
        );
      const input = catalogDeliveryReadinessRequestSchema.safeParse(
        await readJsonBody(request),
      );
      if (!input.success)
        return sendOperatorError(response, 400, "INVALID_INPUT");
      const result = await catalogDeliveryReadiness(input.data.intentId);
      if (!result)
        return sendOperatorError(response, 404, "CATALOG_DELIVERY_NOT_FOUND");
      sendJson(response, 200, catalogDeliveryReadinessSchema.parse(result));
      return;
    }
    if (
      pathname === "/internal/community/catalog-delivery/published-renditions"
    ) {
      if (method !== "POST") return methodNotAllowed();
      if (!catalogPublishedRenditions)
        return sendOperatorError(
          response,
          503,
          "CATALOG_DELIVERY_NOT_CONFIGURED",
        );
      // A record may name up to 2,000 media; editorial keys are ~200 bytes.
      const input = catalogPublishedRenditionsRequestSchema.safeParse(
        await readJsonBody(request, 1_048_576),
      );
      if (!input.success)
        return sendOperatorError(response, 400, "INVALID_INPUT");
      sendJson(
        response,
        200,
        catalogPublishedRenditionsSchema.parse(
          await catalogPublishedRenditions(input.data.media),
        ),
      );
      return;
    }
    // Read-only and content-free: the CLI paces its prepare waves on it
    // (Owner decision D5); nothing is refused or written because of it.
    if (pathname === "/internal/community/catalog-delivery/render-backlog") {
      if (method !== "GET") return methodNotAllowed();
      if (!catalogRenderBacklog)
        return sendOperatorError(
          response,
          503,
          "CATALOG_DELIVERY_NOT_CONFIGURED",
        );
      sendJson(
        response,
        200,
        catalogRenderBacklogSchema.parse(await catalogRenderBacklog()),
      );
      return;
    }
    if (pathname === "/internal/community/catalog-delivery/recipe-policy") {
      if (method !== "GET") return methodNotAllowed();
      if (!catalogRecipePolicy)
        return sendOperatorError(
          response,
          503,
          "CATALOG_DELIVERY_NOT_CONFIGURED",
        );
      sendJson(
        response,
        200,
        catalogRecipePolicySchema.parse(await catalogRecipePolicy()),
      );
      return;
    }
    if (
      articlePublicationOperatorService !== undefined &&
      (await handleArticlePublicationOperatorRequest(
        request,
        response,
        pathname,
        articlePublicationOperatorService,
      ))
    )
      return;
    // Every operator route family, including the Agent, publishing, direct-
    // message and Thread handlers, runs inside this boundary: an error they do
    // not map themselves becomes a bounded operator failure for this request.
    if (
      agentAdministrationService !== undefined &&
      (await handleAgentRequest(
        request,
        response,
        pathname,
        agentAdministrationService,
      ))
    )
      return;
    if (
      publishingOperatorService !== undefined &&
      (await handlePublishingOperatorRequest(
        request,
        response,
        pathname,
        publishingOperatorService,
      ))
    )
      return;
    if (
      directMessageService !== undefined &&
      (await handleDirectMessageOperatorRequest(
        request,
        response,
        pathname,
        directMessageService,
        actor.label,
      ))
    )
      return;
    if (
      threadService !== undefined &&
      (await handleThreadOperatorRequest(
        request,
        response,
        pathname,
        threadService,
        actor.label,
      ))
    )
      return;
    const operatorService = new CommunityContentOperatorService(
      contentOperatorPort,
      discussionPort,
      actor.label,
    );
    const commandBody = async () => {
      if (new URL(request.url ?? "/", "http://request.invalid").search)
        throw new CommunityInputError("Unexpected query");
      return readJsonBody(request, 100000);
    };
    if (contentOperatorPort) {
      if (pathname === "/internal/community/users" && method === "GET") {
        sendJson(
          response,
          200,
          await operatorService.readUsers(queryOf(request)),
        );
        return;
      }
      if (
        pathname === "/internal/community/users/recommendation" &&
        method === "PUT"
      ) {
        sendJson(
          response,
          200,
          await operatorService.recommendUser(await commandBody()),
        );
        return;
      }
      if (pathname === "/internal/community/works" && method === "GET") {
        sendJson(
          response,
          200,
          await operatorService.readWorks(queryOf(request)),
        );
        return;
      }
      if (pathname === "/internal/community/featured" && method === "GET") {
        sendJson(
          response,
          200,
          await operatorService.readFeatured(queryOf(request)),
        );
        return;
      }
      if (pathname === "/internal/community/featured" && method === "PUT") {
        const command = await commandBody();
        if (actor.label === AI_OPERATOR_LABEL) {
          if (aiOperatorReader === undefined) {
            sendOperatorError(response, 503, "OPERATOR_UNAVAILABLE");
            return;
          }
          if (await featuringSelfOnly(command, aiOperatorReader)) {
            sendOperatorError(response, 403, SELF_ONLY_OWNER_REVIEW);
            return;
          }
        }
        sendJson(response, 200, await operatorService.setFeatured(command));
        return;
      }
      if (
        pathname === "/internal/community/featured/settings" &&
        method === "PUT"
      ) {
        sendJson(
          response,
          200,
          await operatorService.setFeaturedQuantity(await commandBody()),
        );
        return;
      }
      const work =
        /^\/internal\/community\/works\/(work-[0-9a-f]{32})\/moderation$/u.exec(
          pathname,
        );
      if (work && method === "POST") {
        sendJson(
          response,
          200,
          await operatorService.moderateWork(
            work[1]!,
            requireHumanModerationReason(await commandBody()),
          ),
        );
        return;
      }
    }
    if (discussionPort) {
      const imagePath =
        /^\/internal\/community\/comments\/(comment-[0-9a-f]{32})\/images\/(media-item-[0-9a-f]{32})\/(thumb|display|full)$/u.exec(
          pathname,
        );
      if (
        imagePath &&
        discussionPort.resolveDiscussionImage &&
        publishingOperatorService
      ) {
        if (method !== "GET" && method !== "HEAD") {
          response.writeHead(405, {
            allow: "GET, HEAD",
            "cache-control": "private, no-store",
          });
          response.end();
          return;
        }
        if (new URL(request.url ?? "/", "http://request.invalid").search)
          throw new CommunityInputError();
        const id = imagePath[1]! as import("@moya/contracts").CatalogCommentId;
        // This separately credentialed review follows retained moderation
        // detail, rather than public target/thread admission. The byte lookup
        // still rejects permanently deleted bodies and unrelated media items.
        await moderationService.readCommentDetail(id);
        await deliverPublishingMedia(
          request,
          response,
          async (range) => {
            const image = await discussionPort.resolveDiscussionImage!(
              id,
              imagePath[2]!,
              imagePath[3] as "thumb" | "display" | "full",
              null,
              true,
            );
            if (!image) throw new CommunityNotFoundError();
            return publishingOperatorService.openAuthorizedMedia(image, range);
          },
          { "cache-control": "private, no-store", vary: "Authorization" },
        );
        return;
      }
      const deletion =
        /^\/internal\/community\/comments\/(comment-[0-9a-f]{32})\/(delete-body|remove-thread)$/u.exec(
          pathname,
        );
      if (deletion && method === "POST") {
        if (deletion[2] === "delete-body") {
          sendJson(
            response,
            200,
            await operatorService.deleteBody(
              deletion[1]!,
              requireHumanModerationReason(await commandBody()),
            ),
          );
        } else {
          sendJson(
            response,
            200,
            await operatorService.removeThread(
              deletion[1]!,
              requireHumanModerationReason(await commandBody()),
            ),
          );
        }
        return;
      }
    }
    if (pathname === "/internal/community/publication-policy") {
      if (method === "GET") {
        sendJson(
          response,
          200,
          await moderationService.readPublicationPolicy(),
        );
        return;
      }
      if (method === "PUT") {
        const command = await readJsonBody(request);
        sendJson(
          response,
          200,
          await moderationService.setPublicationPolicy(
            command,
            actor.label === AI_OPERATOR_LABEL
              ? aiPolicyReceipt(request, command)
              : undefined,
          ),
        );
        return;
      }
      methodNotAllowed();
      return;
    }

    if (pathname === "/internal/community/comments") {
      if (method !== "GET") {
        methodNotAllowed();
        return;
      }
      sendCommentJson(
        request,
        response,
        200,
        await moderationService.readComments(pagedQueryOf(request)),
      );
      return;
    }

    if (pathname === "/internal/community/comments/moderation") {
      if (method !== "POST") {
        methodNotAllowed();
        return;
      }
      sendJson(
        response,
        200,
        await moderationService.moderateComments(
          requireHumanModerationReason(await readJsonBody(request)),
        ),
      );
      return;
    }

    if (pathname === "/internal/community/moderation-events") {
      if (method !== "GET") {
        methodNotAllowed();
        return;
      }
      sendJson(
        response,
        200,
        await moderationService.readModerationEvents(pagedQueryOf(request)),
      );
      return;
    }

    if (pathname === "/internal/community/summary") {
      if (method !== "GET") {
        methodNotAllowed();
        return;
      }
      sendJson(
        response,
        200,
        await moderationService.readSummary(queryOf(request)),
      );
      return;
    }

    const commentRoute =
      /^\/internal\/community\/comments\/([^/]+)(?:\/(moderation|analysis))?$/.exec(
        pathname,
      );
    if (commentRoute !== null) {
      const decoded = decodeSegment(commentRoute[1] ?? "");
      const id =
        decoded === undefined
          ? undefined
          : catalogCommentIdSchema.safeParse(decoded);
      if (id?.success !== true) {
        sendOperatorError(response, 404, "NOT_FOUND");
        return;
      }
      const leaf = commentRoute[2];
      if (leaf === undefined) {
        if (method !== "GET") {
          methodNotAllowed();
          return;
        }
        sendCommentJson(
          request,
          response,
          200,
          await moderationService.readCommentDetail(id.data),
        );
        return;
      }
      if (leaf === "analysis") {
        if (method !== "GET") {
          methodNotAllowed();
          return;
        }
        const detail = await moderationService.readCommentDetail(id.data);
        sendJson(response, 200, detail.analysis);
        return;
      }
      if (method !== "POST") {
        methodNotAllowed();
        return;
      }
      const command = requireHumanModerationReason(await readJsonBody(request));
      sendJson(
        response,
        200,
        await moderationService.moderateComment(
          id.data,
          command,
          actor.label === AI_OPERATOR_LABEL
            ? aiCommentReceipt(request, id.data, command)
            : undefined,
        ),
      );
      return;
    }

    const userRoute = /^\/internal\/community\/users\/([^/]+)\/status$/.exec(
      pathname,
    );
    if (userRoute !== null) {
      if (method !== "POST") {
        methodNotAllowed();
        return;
      }
      const decoded = decodeSegment(userRoute[1] ?? "");
      const id =
        decoded === undefined
          ? undefined
          : publicUserIdSchema.safeParse(decoded);
      if (id?.success !== true) {
        sendOperatorError(response, 404, "NOT_FOUND");
        return;
      }
      const command = requireHumanModerationReason(await readJsonBody(request));
      sendJson(
        response,
        200,
        await moderationService.moderateUser(
          id.data,
          command,
          actor.label === AI_OPERATOR_LABEL
            ? aiUserReceipt(request, id.data, command)
            : undefined,
        ),
      );
      return;
    }

    sendOperatorError(response, 404, "NOT_FOUND");
  } catch (error) {
    if (error instanceof JsonBodyError && !response.headersSent) {
      sendOperatorError(response, 400, "INVALID_COMMAND");
      return;
    }
    sendFailure(response, error);
  }
};
