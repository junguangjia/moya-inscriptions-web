import {
  COMMENT_REPLY_PAGE_SIZE_DEFAULT,
  isCommunityInputError,
  isCommunityNotFoundError,
  isCommunityStoreUnavailableError,
  parseCommentListingQuery,
  parseCommentPageQuery,
  parseCreateCommentRequest,
  parseCreateReplyRequest,
} from "@moya/api";
import {
  catalogCommentIdSchema,
  catalogIdSchema,
} from "@moya/contracts/schemas";

import { sendApiError } from "../http/api-error-response.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { collectTransportQuery } from "../http/transport-query.js";
import { readBearerToken } from "./session-credential.js";

import type {
  CatalogCommentService,
  CommentListingRequest,
  CommentPageRequest,
  CommentSubmission,
  CommunitySessionService,
} from "@moya/api";
import type {
  CatalogCommentId,
  CatalogId,
  PublicUserId,
} from "@moya/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface CommentRouteDependencies {
  readonly commentService: CatalogCommentService;
  readonly sessionService: CommunitySessionService;
}

const sendFailure = (response: ServerResponse, error: unknown): void => {
  if (error instanceof InvalidSession) {
    sendApiError(response, "UNAUTHENTICATED", "A valid session is required");
    return;
  }
  if (isCommunityNotFoundError(error)) {
    sendApiError(
      response,
      "ITEM_NOT_FOUND",
      "The requested item was not found",
    );
    return;
  }
  if (isCommunityInputError(error)) {
    sendApiError(response, "INVALID_INPUT", "The submitted comment is invalid");
    return;
  }
  if (isCommunityStoreUnavailableError(error)) {
    sendApiError(
      response,
      "SERVICE_UNAVAILABLE",
      "Service temporarily unavailable",
    );
    return;
  }
  sendApiError(response, "INTERNAL_ERROR", "Internal server error");
};

const sendNotFound = (response: ServerResponse): void =>
  sendApiError(response, "ITEM_NOT_FOUND", "The requested item was not found");

/** A malformed percent escape is a missing item, never an unhandled rejection. */
const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

const parseCatalogId = (
  response: ServerResponse,
  catalogId: string,
): CatalogId | undefined => {
  const decoded = decodeSegment(catalogId);
  const parsed =
    decoded === undefined ? undefined : catalogIdSchema.safeParse(decoded);
  if (parsed?.success !== true) {
    sendNotFound(response);
    return undefined;
  }
  return parsed.data;
};

const parseCommentId = (
  response: ServerResponse,
  commentId: string,
): CatalogCommentId | undefined => {
  const decoded = decodeSegment(commentId);
  const parsed =
    decoded === undefined
      ? undefined
      : catalogCommentIdSchema.safeParse(decoded);
  if (parsed?.success !== true) {
    sendNotFound(response);
    return undefined;
  }
  return parsed.data;
};

/** An invalid page query is a transport error, not a body error. */
const parseQuery = <Parsed>(
  request: IncomingMessage,
  response: ServerResponse,
  parse: (query: ReturnType<typeof collectTransportQuery>) => Parsed,
): Parsed | undefined => {
  const url = new URL(request.url ?? "/", "http://request.invalid");
  try {
    return parse(collectTransportQuery(url.searchParams));
  } catch {
    sendApiError(response, "INVALID_QUERY", "Invalid comment query");
    return undefined;
  }
};

/** The root listing accepts the pinned hot ids; the reply page does not. */
const parseListing = (
  request: IncomingMessage,
  response: ServerResponse,
): CommentListingRequest | undefined =>
  parseQuery(request, response, parseCommentListingQuery);

const parsePage = (
  request: IncomingMessage,
  response: ServerResponse,
  fallbackPageSize?: number,
): CommentPageRequest | undefined =>
  parseQuery(request, response, (query) =>
    parseCommentPageQuery(query, fallbackPageSize),
  );

/**
 * Resolves the session owner; undefined means the request is unauthenticated.
 * account-switching-v1: a present `x-author-account` must still name that
 * owner, so a comment written for one account is never posted as another.
 */
const identify = async (
  request: IncomingMessage,
  response: ServerResponse,
  sessionService: CommunitySessionService,
): Promise<PublicUserId | undefined> => {
  const token = readBearerToken(request);
  const profile =
    token === undefined ? null : await sessionService.identify(token);
  if (profile === null) {
    sendApiError(response, "UNAUTHENTICATED", "A valid session is required");
    return undefined;
  }
  const asserted = request.headers["x-author-account"];
  if (asserted !== undefined && asserted !== profile.id) {
    sendApiError(response, "UNAUTHENTICATED", "Account changed");
    return undefined;
  }
  return profile.id;
};

const sendSubmission = <Item>(
  response: ServerResponse,
  submission: CommentSubmission<Item>,
): void => {
  // 202 tells the author the submission is awaiting Owner approval under
  // PRE_MODERATION; the body shape is the same Public DTO either way.
  sendJson(response, submission.awaitingApproval ? 202 : 201, submission.item);
};

const sendBodyFailure = (response: ServerResponse, error: unknown): void => {
  if (error instanceof JsonBodyError) {
    sendApiError(response, "INVALID_INPUT", "The submitted comment is invalid");
    return;
  }
  sendFailure(response, error);
};

export const handleReadComments = async (
  request: IncomingMessage,
  response: ServerResponse,
  rawCatalogId: string,
  { commentService, sessionService }: CommentRouteDependencies,
): Promise<void> => {
  const catalogId = parseCatalogId(response, rawCatalogId);
  if (catalogId === undefined) return;
  const listing = parseListing(request, response);
  if (listing === undefined) return;
  try {
    sendJson(
      response,
      200,
      await commentService.readComments(
        catalogId,
        listing,
        await optionalViewer(request, sessionService),
      ),
      { "cache-control": "private, no-store", vary: "Authorization" },
    );
  } catch (error) {
    sendFailure(response, error);
  }
};

export const handleCreateComment = async (
  request: IncomingMessage,
  response: ServerResponse,
  rawCatalogId: string,
  dependencies: CommentRouteDependencies,
): Promise<void> => {
  const catalogId = parseCatalogId(response, rawCatalogId);
  if (catalogId === undefined) return;
  const authorId = await identify(
    request,
    response,
    dependencies.sessionService,
  );
  if (authorId === undefined) return;
  try {
    const body = parseCreateCommentRequest(await readJsonBody(request));
    sendSubmission(
      response,
      await dependencies.commentService.createComment(
        catalogId,
        authorId,
        body,
      ),
    );
  } catch (error) {
    sendBodyFailure(response, error);
  }
};

export const handleReadReplies = async (
  request: IncomingMessage,
  response: ServerResponse,
  rawCatalogId: string,
  rawCommentId: string,
  { commentService, sessionService }: CommentRouteDependencies,
): Promise<void> => {
  const catalogId = parseCatalogId(response, rawCatalogId);
  if (catalogId === undefined) return;
  const commentId = parseCommentId(response, rawCommentId);
  if (commentId === undefined) return;
  const page = parsePage(request, response, COMMENT_REPLY_PAGE_SIZE_DEFAULT);
  if (page === undefined) return;
  try {
    sendJson(
      response,
      200,
      await commentService.readReplies(
        catalogId,
        commentId,
        page,
        await optionalViewer(request, sessionService),
      ),
      { "cache-control": "private, no-store", vary: "Authorization" },
    );
  } catch (error) {
    sendFailure(response, error);
  }
};

export const handleCreateReply = async (
  request: IncomingMessage,
  response: ServerResponse,
  rawCatalogId: string,
  rawCommentId: string,
  dependencies: CommentRouteDependencies,
): Promise<void> => {
  const catalogId = parseCatalogId(response, rawCatalogId);
  if (catalogId === undefined) return;
  const commentId = parseCommentId(response, rawCommentId);
  if (commentId === undefined) return;
  const authorId = await identify(
    request,
    response,
    dependencies.sessionService,
  );
  if (authorId === undefined) return;
  try {
    const body = parseCreateReplyRequest(await readJsonBody(request));
    sendSubmission(
      response,
      await dependencies.commentService.createReply(
        catalogId,
        commentId,
        authorId,
        body,
      ),
    );
  } catch (error) {
    sendBodyFailure(response, error);
  }
};

class InvalidSession extends Error {}
const optionalViewer = async (
  request: IncomingMessage,
  sessions: CommunitySessionService,
): Promise<PublicUserId | null> => {
  const token = readBearerToken(request);
  if (token === undefined) return null;
  const profile = await sessions.identify(token);
  if (!profile) throw new InvalidSession();
  return profile.id;
};
