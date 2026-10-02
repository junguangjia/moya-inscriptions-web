import {
  articleAuthoringGrantSchema,
  articleConnectionIdSchema,
  createArticleAuthoringGrantCommandSchema,
  revokeArticleAuthoringGrantCommandSchema,
  articleApprovalCandidateSchema,
  articleCandidateApprovalSubmissionSchema,
  articleApprovalResultSchema,
  articleApprovalReviewSchema,
  articleConsentReviewSchema,
  articleConsentDecisionSchema,
} from "@moya/contracts/schemas";
import { isCommunityConflictError, isCommunityNotFoundError } from "@moya/api";
import { randomUUID } from "node:crypto";
import type {
  ArticleAuthoringDocument,
  ArticleId,
  PublicUserId,
} from "@moya/contracts";
import type {
  ArticleConsentPort,
  ArticleDelegationPort,
  ArticleAuthoringService,
  PublishedAuthoredArticle,
  CommunitySessionService,
} from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, JsonBodyError } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { sendApiError } from "../http/api-error-response.js";
import { readBearerToken } from "./session-credential.js";

const privateHeaders = {
  "cache-control": "private, no-store",
  vary: "Authorization",
};
export interface ArticleDelegationRuntime {
  readonly consents: ArticleConsentPort;
  readonly connections: ArticleDelegationPort;
  readonly issuer: string;
  readonly authoring: ArticleAuthoringService;
  readPublished(id: ArticleId): Promise<PublishedAuthoredArticle | null>;
  readonly clients: ReadonlyMap<
    string,
    {
      readonly clientId: string;
      readonly label: string;
      readonly redirectUris: readonly string[];
    }
  >;
}

/** Existing human-session boundary; delegated/Admin bearers never identify. */
export const handleArticleDelegationHttpRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  segments: readonly string[],
  sessions: CommunitySessionService,
  runtime: ArticleDelegationRuntime,
): Promise<void> => {
  try {
    const token = readBearerToken(request);
    const viewer = token === undefined ? null : await sessions.identify(token);
    if (viewer === null || request.headers["x-author-account"] !== viewer.id) {
      sendApiError(response, "UNAUTHENTICATED", "UNAUTHENTICATED");
      return;
    }
    await handleArticleDelegationRequest(
      request,
      response,
      segments,
      viewer.id,
      runtime,
    );
  } catch {
    sendApiError(response, "SERVICE_UNAVAILABLE", "SERVICE_UNAVAILABLE");
  }
};

/**
 * Mount below the existing human-session author handler. `viewer` must come
 * only from sessions.identify, never from body/header fields or an MCP actor.
 * Web BFF obtains its HttpOnly cookie and enforces same-origin mutation rules.
 */
export const handleArticleDelegationRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  segments: readonly string[],
  viewer: PublicUserId | null,
  runtime: ArticleDelegationRuntime,
): Promise<void> => {
  try {
    if (
      viewer === null ||
      (request.method !== "GET" &&
        request.headers["x-author-account"] !== viewer)
    ) {
      sendApiError(response, "UNAUTHENTICATED", "UNAUTHENTICATED");
      return;
    }
    const url = new URL(request.url ?? "/", "http://request.invalid");
    if (url.search) {
      sendApiError(response, "INVALID_QUERY", "INVALID_QUERY");
      return;
    }
    const [resource, id, action] = segments;
    if (
      segments.length === 1 &&
      resource === "connections" &&
      request.method === "GET"
    ) {
      sendJson(
        response,
        200,
        {
          items: (await runtime.connections.list(viewer)).map((item) =>
            articleAuthoringGrantSchema.parse(item),
          ),
        },
        privateHeaders,
      );
      return;
    }
    if (
      segments.length === 2 &&
      resource === "consents" &&
      id !== undefined &&
      request.method === "GET"
    ) {
      if (!/^[A-Za-z0-9_-]{1,256}$/u.test(id)) {
        sendApiError(response, "ITEM_NOT_FOUND", "ITEM_NOT_FOUND");
        return;
      }
      const review = await runtime.consents.prepareReview(
        viewer,
        id,
        new Date(),
      );
      const client = runtime.clients.get(review.interaction.clientId);
      if (client === undefined) {
        sendApiError(response, "ITEM_NOT_FOUND", "ITEM_NOT_FOUND");
        return;
      }
      // Never include a provider token, original images or private library.
      sendJson(
        response,
        200,
        articleConsentReviewSchema.parse({
          interactionUid: id,
          clientId: client.clientId,
          clientLabel: client.label,
          redirectUris: client.redirectUris,
          resource: review.interaction.resource,
          scopes: review.interaction.scopes,
          expiresAt: review.interaction.expiresAt,
          consentTicket: review.consentTicket,
        }),
        privateHeaders,
      );
      return;
    }
    if (
      segments.length === 3 &&
      resource === "consents" &&
      id !== undefined &&
      (action === "approve" || action === "deny") &&
      request.method === "POST"
    ) {
      const parsed = createArticleAuthoringGrantCommandSchema.safeParse(
        await readJsonBody(request),
      );
      if (!parsed.success || parsed.data.interactionUid !== id) {
        sendApiError(response, "INVALID_INPUT", "INVALID_INPUT");
        return;
      }
      await runtime.consents.decide(
        viewer,
        { ...parsed.data, decision: action },
        new Date(),
      );
      const resumeUrl = new URL(
        `/article-authoring/consent/${encodeURIComponent(id)}/resume`,
        runtime.issuer,
      ).href;
      // This ordinary interaction name only resumes with the provider's
      // host/path-bound interaction cookie; no authorizing token is in a URL.
      sendJson(
        response,
        200,
        articleConsentDecisionSchema.parse({ decision: action, resumeUrl }),
        privateHeaders,
      );
      return;
    }
    if (
      segments.length === 3 &&
      resource === "connections" &&
      id !== undefined &&
      action === "revoke" &&
      request.method === "POST"
    ) {
      const parsedId = articleConnectionIdSchema.safeParse(id);
      const parsed = revokeArticleAuthoringGrantCommandSchema.safeParse(
        await readJsonBody(request),
      );
      if (!parsedId.success || !parsed.success) {
        sendApiError(response, "INVALID_INPUT", "INVALID_INPUT");
        return;
      }
      await runtime.connections.revoke(
        viewer,
        parsedId.data,
        parsed.data.expectedGeneration,
        new Date(),
      );
      response.writeHead(204, privateHeaders);
      response.end();
      return;
    }
    if (
      segments.length === 2 &&
      resource === "approvals" &&
      id === "review" &&
      request.method === "POST"
    ) {
      const parsed = articleApprovalCandidateSchema.safeParse(
        await readJsonBody(request),
      );
      if (!parsed.success) {
        sendApiError(response, "INVALID_INPUT", "INVALID_INPUT");
        return;
      }
      const input = parsed.data;
      const preview = await runtime.authoring.preview(
        { source: "human", userId: viewer },
        input.articleId,
        {
          requestId: randomUUID(),
          expectedVersion: input.expectedVersion,
          fingerprint: input.fingerprint,
        },
      );
      const connection = (await runtime.connections.list(viewer)).find(
        (row) => row.id === input.connectionId,
      );
      if (
        connection === undefined ||
        connection.status !== "authorized" ||
        !connection.scopes.includes("artvenn:article:publish")
      ) {
        sendApiError(response, "ITEM_NOT_FOUND", "ITEM_NOT_FOUND");
        return;
      }
      if (!preview.validation.valid) {
        sendApiError(response, "CONFLICT", "ARTICLE_CANDIDATE_INVALID");
        return;
      }
      const previous = await runtime.readPublished(input.articleId);
      const proof = await runtime.connections.prepareApprovalReview(
        viewer,
        input,
        new Date(),
      );
      sendJson(
        response,
        200,
        articleApprovalReviewSchema.parse({
          preview,
          connection,
          publishedVersion: previous?.version ?? null,
          changes: candidateChanges(preview.draft, previous),
          ...proof,
        }),
        privateHeaders,
      );
      return;
    }
    if (
      segments.length === 1 &&
      resource === "approvals" &&
      request.method === "POST"
    ) {
      const parsed = articleCandidateApprovalSubmissionSchema.safeParse(
        await readJsonBody(request),
      );
      if (!parsed.success) {
        sendApiError(response, "INVALID_INPUT", "INVALID_INPUT");
        return;
      }
      // Offered only after the platform page presents preview/change summary;
      // caller is the human session, never a delegated token or confirmed flag.
      sendJson(
        response,
        201,
        articleApprovalResultSchema.parse(
          await runtime.connections.approveCandidate(
            viewer,
            parsed.data,
            new Date(),
          ),
        ),
        privateHeaders,
      );
      return;
    }
    sendApiError(response, "ITEM_NOT_FOUND", "ITEM_NOT_FOUND");
  } catch (error) {
    if (error instanceof JsonBodyError)
      sendApiError(response, "INVALID_INPUT", "INVALID_INPUT");
    else if (isCommunityNotFoundError(error))
      sendApiError(response, "ITEM_NOT_FOUND", "ITEM_NOT_FOUND");
    else if (isCommunityConflictError(error))
      sendApiError(response, "CONFLICT", "ARTICLE_CANDIDATE_OR_GRANT_CHANGED");
    else sendApiError(response, "SERVICE_UNAVAILABLE", "SERVICE_UNAVAILABLE");
  }
};

/** Content stays private. Compare each finite block plus its position, including nested blocks. */
const blockMap = (document: ArticleAuthoringDocument): Map<string, string> => {
  const values = new Map<string, string>();
  const visit = (
    blocks: ArticleAuthoringDocument["blocks"],
    parent: string | null,
  ): void => {
    blocks.forEach((block, index) => {
      const { children, ...value } = block;
      values.set(block.id, JSON.stringify({ parent, index, value }));
      if (children.length) visit(children, block.id);
    });
  };
  visit(document.blocks, null);
  return values;
};
const candidateChanges = (
  draft: {
    title: string;
    coverRefId: string | null;
    document: ArticleAuthoringDocument;
  },
  previous: PublishedAuthoredArticle | null,
) => {
  const current = blockMap(draft.document);
  const before =
    previous === null ? new Map<string, string>() : blockMap(previous.document);
  return {
    titleChanged: previous?.title !== draft.title,
    coverChanged:
      previous?.coverRefId !== draft.coverRefId ||
      JSON.stringify(
        draft.coverRefId === null
          ? null
          : draft.document.references[draft.coverRefId],
      ) !==
        JSON.stringify(
          previous?.coverRefId === null || previous?.coverRefId === undefined
            ? null
            : previous.document.references[previous.coverRefId],
        ),
    referencesChanged:
      JSON.stringify(previous?.document.references ?? {}) !==
      JSON.stringify(draft.document.references),
    galleriesChanged:
      JSON.stringify(previous?.document.galleries ?? {}) !==
      JSON.stringify(draft.document.galleries),
    addedBlocks: [...current.keys()].filter((id) => !before.has(id)).length,
    removedBlocks: [...before.keys()].filter((id) => !current.has(id)).length,
    changedBlocks: [...current].filter(
      ([id, value]) => before.has(id) && before.get(id) !== value,
    ).length,
  };
};
