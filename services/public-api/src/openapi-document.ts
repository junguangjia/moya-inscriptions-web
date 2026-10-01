import { authPaths } from "./auth-openapi.js";
import { authorCommunityPaths } from "./author-community-openapi.js";
import {
  authJsonSchemas,
  authorCommunityJsonSchemas,
  workPublishingJsonSchemas,
} from "@moya/contracts/json-schema";
import type { ApiErrorCode } from "@moya/contracts";
import {
  apiErrorJsonSchema,
  catalogCitationScopeJsonSchema,
  catalogCommentIdJsonSchema,
  catalogCommentJsonSchema,
  catalogCommentPageJsonSchema,
  catalogCommentReplyJsonSchema,
  catalogCommentReplyPageJsonSchema,
  catalogCommentListingTransportQueryJsonSchema,
  catalogCommentTransportQueryJsonSchema,
  catalogContributorJsonSchema,
  catalogContributorRoleJsonSchema,
  catalogDetailJsonSchema,
  catalogIdJsonSchema,
  commentAuthorJsonSchema,
  createCatalogCommentReplyRequestJsonSchema,
  createCatalogCommentRequestJsonSchema,
  catalogKindJsonSchema,
  catalogListTransportQueryJsonSchema,
  catalogPageJsonSchema,
  catalogSummaryJsonSchema,
  catalogSearchMatchKindJsonSchema,
  catalogSearchTransportQueryJsonSchema,
  catalogSearchItemJsonSchema,
  catalogSearchPageJsonSchema,
  healthResponseJsonSchema,
  mediaIdJsonSchema,
  publicMediaJsonSchema,
  publicSourceCitationJsonSchema,
  publicUserIdJsonSchema,
  publicUserProfileJsonSchema,
} from "@moya/contracts/json-schema";

type JsonObject = Record<string, unknown>;
type JsonValue = JsonObject | JsonValue[] | boolean | number | string | null;

const asJsonObject = (value: unknown): JsonObject => value as JsonObject;

const schemaProperty = (schema: unknown, propertyName: string): JsonObject => {
  const properties = asJsonObject(asJsonObject(schema).properties);
  const property = properties[propertyName];
  if (property === undefined) {
    throw new Error(`Missing contract schema property: ${propertyName}`);
  }
  return asJsonObject(property);
};

const queryParameter = (name: string, schema: JsonObject) => ({
  name,
  in: "query",
  required: false,
  schema,
});

const jsonResponse = (description: string, schemaName: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: `#/components/schemas/${schemaName}` },
    },
  },
});

const apiErrorResponse = (description: string, code: ApiErrorCode) =>
  jsonResponse(`${description}; error code ${code}.`, "ApiError");

const listQueryParameters = ["kind", "page", "pageSize"].map((name) =>
  queryParameter(
    name,
    schemaProperty(catalogListTransportQueryJsonSchema, name),
  ),
);

const pathParameter = (
  name: string,
  schemaName: string,
  description: string,
) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { $ref: `#/components/schemas/${schemaName}` },
});

const jsonRequestBody = (description: string, schemaName: string) => ({
  description,
  required: true,
  content: {
    "application/json": {
      schema: { $ref: `#/components/schemas/${schemaName}` },
    },
  },
});

const catalogIdPathParameter = pathParameter(
  "catalogId",
  "CatalogId",
  "Opaque platform CatalogId of a currently published record.",
);
const commentIdPathParameter = pathParameter(
  "commentId",
  "CatalogCommentId",
  "Opaque platform id of a visible root comment.",
);
const commentPageParameters = ["page", "pageSize"].map((name) =>
  queryParameter(
    name,
    schemaProperty(catalogCommentTransportQueryJsonSchema, name),
  ),
);

/** The root listing adds `pinned`; the reply page keeps the plain page query. */
const commentListingParameters = ["page", "pageSize", "pinned"].map((name) =>
  queryParameter(
    name,
    schemaProperty(catalogCommentListingTransportQueryJsonSchema, name),
  ),
);

/** Shared by both comment write operations (amendment decision 1). */
const commentWriteResponses = (
  createdDescription: string,
  schemaName: string,
) => ({
  "201": jsonResponse(createdDescription, schemaName),
  "202": jsonResponse(
    `${createdDescription} It entered moderation under PRE_MODERATION and is not visible until the Owner approves it.`,
    schemaName,
  ),
  "400": apiErrorResponse("Invalid query", "INVALID_QUERY"),
  "401": apiErrorResponse("A valid session is required", "UNAUTHENTICATED"),
  "404": apiErrorResponse(
    "The Catalog record or root comment is not available",
    "ITEM_NOT_FOUND",
  ),
  "422": apiErrorResponse("The submitted body is invalid", "INVALID_INPUT"),
  "500": apiErrorResponse("Internal service error", "INTERNAL_ERROR"),
  "503": apiErrorResponse(
    "Service is temporarily unavailable",
    "SERVICE_UNAVAILABLE",
  ),
});

const commentReadResponses = (description: string, schemaName: string) => ({
  "200": jsonResponse(description, schemaName),
  "400": apiErrorResponse("Invalid query", "INVALID_QUERY"),
  "404": apiErrorResponse(
    "The Catalog record or root comment is not available",
    "ITEM_NOT_FOUND",
  ),
  "500": apiErrorResponse("Internal service error", "INTERNAL_ERROR"),
  "503": apiErrorResponse(
    "Service is temporarily unavailable",
    "SERVICE_UNAVAILABLE",
  ),
});

export const openApiDocument: JsonObject = {
  openapi: "3.1.1",
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "由艺（Yoyi）Public API",
    version: "1.0.0",
    description:
      "Inscription-first, read-only access to the public Catalog, plus the Community V1 current-user identity. Operational health is unversioned; public contracts use /v1.",
  },
  paths: {
    ...authorCommunityPaths,
    ...authPaths,
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Operational readiness",
        description:
          "Unversioned operational endpoint. Query parameters are not accepted.",
        responses: {
          "200": jsonResponse("Service is ready.", "HealthResponse"),
          "400": apiErrorResponse("Invalid query", "INVALID_QUERY"),
          "503": apiErrorResponse(
            "Service is temporarily unavailable",
            "SERVICE_UNAVAILABLE",
          ),
        },
      },
    },
    "/v1/catalog": {
      get: {
        operationId: "listCatalog",
        summary: "List public Catalog entries",
        description:
          "Only kind, page, and pageSize are accepted. Unknown, duplicate, or invalid query parameters return INVALID_QUERY.",
        parameters: listQueryParameters,
        responses: {
          "200": jsonResponse(
            "A page of public Catalog entries.",
            "CatalogPage",
          ),
          "400": apiErrorResponse("Invalid query", "INVALID_QUERY"),
          "500": apiErrorResponse("Internal service error", "INTERNAL_ERROR"),
          "503": apiErrorResponse(
            "Service is temporarily unavailable",
            "SERVICE_UNAVAILABLE",
          ),
        },
      },
    },
    "/v1/catalog-search": {
      get: {
        operationId: "searchCatalog",
        summary: "Search the public Catalog",
        description:
          "Required nonblank q (at most 200 UTF-16 code units), optional kind/page/pageSize. Unknown, duplicate or invalid parameters return INVALID_QUERY. Fixed OpenCC 1.4.1 t2s normalization and whitespace-separated same-record AND; percent, underscore and backslash are literal. Original title exact, existing alias exact, normalized exact, title/alias partial, structured and body tiers apply before deterministic CatalogId pagination. No typo correction, unapproved variants, historicalContext or scholarlyResearch. Missing/stale derived data is SERVICE_UNAVAILABLE, never an empty-result fallback.",
        parameters: ["q", "kind", "page", "pageSize"].map((name) => ({
          ...queryParameter(
            name,
            schemaProperty(catalogSearchTransportQueryJsonSchema, name),
          ),
          required: name === "q",
        })),
        responses: {
          "200": jsonResponse(
            "A page of ordered Catalog search results with truthful matchKind; query text is not echoed.",
            "CatalogSearchPage",
          ),
          "400": apiErrorResponse("Invalid query", "INVALID_QUERY"),
          "500": apiErrorResponse("Internal service error", "INTERNAL_ERROR"),
          "503": apiErrorResponse(
            "Service is temporarily unavailable",
            "SERVICE_UNAVAILABLE",
          ),
        },
      },
    },
    "/v1/catalog/{catalogId}": {
      get: {
        operationId: "getCatalogById",
        summary: "Get one public Catalog entry",
        description: "Catalog detail lookup accepts no query parameters.",
        parameters: [
          {
            name: "catalogId",
            in: "path",
            required: true,
            description: "Opaque platform CatalogId.",
            schema: { $ref: "#/components/schemas/CatalogId" },
          },
        ],
        responses: {
          "200": jsonResponse(
            "The requested public Catalog entry.",
            "CatalogDetail",
          ),
          "400": apiErrorResponse("Invalid query", "INVALID_QUERY"),
          "404": apiErrorResponse("Catalog entry not found", "ITEM_NOT_FOUND"),
          "500": apiErrorResponse("Internal service error", "INTERNAL_ERROR"),
          "503": apiErrorResponse(
            "Service is temporarily unavailable",
            "SERVICE_UNAVAILABLE",
          ),
        },
      },
    },
    "/v1/catalog/{catalogId}/comments": {
      get: {
        operationId: "listCatalogComments",
        summary: "List visible comments on one Catalog record",
        description:
          "Anonymous read returning one combined list: `hot`, at most three visible root comments ranked by their number of currently visible replies (positive scores only; ties to the newer comment, then the greater id), followed by `items`, the remaining visible roots newest first. A root never appears in both. Each root carries a bounded first page of its visible replies (oldest first) and its visible reply total. Without `pinned` the hot section is selected afresh; a load-more request passes the hot ids it already holds as `pinned`, receives an empty `hot` and pages the latest list with exactly those roots excluded, so the sequence neither repeats nor drops a root when the hot selection moves. Offset pagination is still not stable under concurrent inserts; a client refreshes the whole list to resynchronize. Pending and hidden items never count and never appear.",
        parameters: [catalogIdPathParameter, ...commentListingParameters],
        responses: commentReadResponses(
          "The hot section and one page of the latest visible comments.",
          "CatalogCommentPage",
        ),
      },
      post: {
        operationId: "createCatalogComment",
        summary: "Create a comment on one Catalog record",
        description:
          "Requires the session credential. Plain text only, trimmed and bounded; no rich text, mentions, links, media or attachments. Under PRE_MODERATION the comment enters moderation and the response is 202.",
        security: [{ session: [] }],
        parameters: [catalogIdPathParameter],
        requestBody: jsonRequestBody(
          "The comment text.",
          "CreateCatalogCommentRequest",
        ),
        responses: commentWriteResponses(
          "The created comment.",
          "CatalogComment",
        ),
      },
    },
    "/v1/catalog/{catalogId}/comments/{commentId}/replies": {
      get: {
        operationId: "listCatalogCommentReplies",
        summary: "List visible replies under one root comment",
        description:
          "Anonymous read supporting bounded load-more. Reply depth is one: a reply never owns children, and a reply under a root that is not visible is never returned.",
        parameters: [
          catalogIdPathParameter,
          commentIdPathParameter,
          ...commentPageParameters,
        ],
        responses: commentReadResponses(
          "A page of visible replies.",
          "CatalogCommentReplyPage",
        ),
      },
      post: {
        operationId: "createCatalogCommentReply",
        summary: "Reply to one root comment",
        description:
          "Requires the session credential. An answer to a sibling reply stays a sibling under the same root and carries its author as replyTo. Under PRE_MODERATION the reply enters moderation and the response is 202.",
        security: [{ session: [] }],
        parameters: [catalogIdPathParameter, commentIdPathParameter],
        requestBody: jsonRequestBody(
          "The reply text and an optional sibling reply to answer.",
          "CreateCatalogCommentReplyRequest",
        ),
        responses: commentWriteResponses(
          "The created reply.",
          "CatalogCommentReply",
        ),
      },
    },
    "/v1/me": {
      get: {
        operationId: "getCurrentUser",
        summary: "Current public user",
        description:
          "Identifies the session owner behind the opaque bearer credential that the same-origin Web route relays from its HttpOnly cookie. Accepts no query parameters. Sessions are issued, validated, expired and revoked only by the Backend; Production has no sign-in path until a provider is separately authorized.",
        security: [{ session: [] }],
        responses: {
          "200": jsonResponse(
            "The session owner's public profile.",
            "PublicUserProfile",
          ),
          "400": apiErrorResponse("Invalid query", "INVALID_QUERY"),
          "401": apiErrorResponse(
            "Missing, malformed, expired, revoked or suspended session",
            "UNAUTHENTICATED",
          ),
          "500": apiErrorResponse("Internal service error", "INTERNAL_ERROR"),
          "503": apiErrorResponse(
            "Service is temporarily unavailable",
            "SERVICE_UNAVAILABLE",
          ),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: "http",
        scheme: "bearer",
        description:
          "Opaque Backend-issued session credential; never a JWT and never readable by browser JavaScript.",
      },
    },
    schemas: {
      ...authorCommunityJsonSchemas,
      ...authJsonSchemas,
      ...workPublishingJsonSchemas,
      CatalogId: catalogIdJsonSchema,
      CatalogKind: catalogKindJsonSchema,
      CatalogContributorRole: catalogContributorRoleJsonSchema,
      CatalogContributor: catalogContributorJsonSchema,
      CatalogCitationScope: catalogCitationScopeJsonSchema,
      MediaId: mediaIdJsonSchema,
      PublicMedia: publicMediaJsonSchema,
      PublicSourceCitation: publicSourceCitationJsonSchema,
      CatalogSummary: catalogSummaryJsonSchema,
      CatalogDetail: catalogDetailJsonSchema,
      CatalogPage: catalogPageJsonSchema,
      CatalogSearchMatchKind: catalogSearchMatchKindJsonSchema,
      CatalogSearchItem: catalogSearchItemJsonSchema,
      CatalogSearchPage: catalogSearchPageJsonSchema,
      PublicUserId: publicUserIdJsonSchema,
      PublicUserProfile: publicUserProfileJsonSchema,
      CatalogCommentId: catalogCommentIdJsonSchema,
      CommentAuthor: commentAuthorJsonSchema,
      CatalogCommentReply: catalogCommentReplyJsonSchema,
      CatalogComment: catalogCommentJsonSchema,
      CatalogCommentPage: catalogCommentPageJsonSchema,
      CatalogCommentReplyPage: catalogCommentReplyPageJsonSchema,
      CreateCatalogCommentRequest: createCatalogCommentRequestJsonSchema,
      CreateCatalogCommentReplyRequest:
        createCatalogCommentReplyRequestJsonSchema,
      HealthResponse: healthResponseJsonSchema,
      ApiError: apiErrorJsonSchema,
    },
  },
};

const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry as JsonValue)]),
    );
  }
  return value;
};

export const serializeOpenApiDocument = (): string =>
  `${JSON.stringify(canonicalize(openApiDocument as JsonValue), null, 2)}\n`;
