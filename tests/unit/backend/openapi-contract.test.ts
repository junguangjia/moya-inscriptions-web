import { readFile } from "node:fs/promises";

import {
  authJsonSchemas,
  authorCommunityJsonSchemas,
  workPublishingJsonSchemas,
  articleAuthoringJsonSchemas,
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
  catalogSearchItemJsonSchema,
  catalogSearchPageJsonSchema,
  healthResponseJsonSchema,
  mediaIdJsonSchema,
  publicMediaJsonSchema,
  publicSourceCitationJsonSchema,
  publicUserIdJsonSchema,
  publicUserProfileJsonSchema,
} from "@moya/contracts/json-schema";
import { openApiDocument, serializeOpenApiDocument } from "@moya/public-api";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => value as JsonObject;
const paths = asObject(openApiDocument.paths);
const schemas = asObject(asObject(openApiDocument.components).schemas);
const getOperation = (path: string): JsonObject =>
  asObject(asObject(paths[path]).get);
const parametersFor = (path: string): JsonObject[] =>
  ((getOperation(path).parameters ?? []) as unknown[]).map(asObject);
const parameterMapFor = (path: string): Map<string, JsonObject> =>
  new Map(
    parametersFor(path).map((parameter) => [String(parameter.name), parameter]),
  );
const responseDescription = (path: string, status: string): string =>
  String(asObject(asObject(getOperation(path).responses)[status]).description);
const schemaProperty = (schema: unknown, propertyName: string): JsonObject =>
  asObject(asObject(asObject(schema).properties)[propertyName]);
const requiredProperties = (schema: unknown): string[] =>
  (asObject(schema).required ?? []) as string[];

/** Work publishing author routes (design §10); the retired Phase 4 draft routes are gone. */
const publishingMethods: Record<string, string[]> = {
  "/v1/community/publishing/limits": ["get"],
  "/v1/community/publishing/drafts": ["post", "get"],
  "/v1/community/publishing/drafts/{draftId}": ["get", "delete"],
  "/v1/community/publishing/drafts/{draftId}/save": ["post"],
  "/v1/community/publishing/drafts/{draftId}/snapshot": ["post"],
  "/v1/community/publishing/drafts/{draftId}/history": ["get"],
  "/v1/community/publishing/drafts/{draftId}/restore": ["post"],
  "/v1/community/publishing/drafts/{draftId}/resolve": ["post"],
  "/v1/community/publishing/drafts/{draftId}/readiness": ["post"],
  "/v1/community/publishing/works/{workId}/draft": ["post"],
  "/v1/community/publishing/works/{workId}/editable": ["get"],
  "/v1/community/publishing/works/{workId}/visibility": ["post"],
  "/v1/community/publishing/sessions": ["post"],
  "/v1/community/publishing/sessions/{sessionId}/heartbeat": ["post"],
  "/v1/community/publishing/sessions/{sessionId}/discard": ["post"],
  "/v1/community/publishing/sessions/{sessionId}/readiness": ["post"],
  "/v1/community/publishing/items": ["post"],
  "/v1/community/publishing/items/{itemId}": ["get"],
  "/v1/community/publishing/items/{itemId}/cancel": ["post"],
  "/v1/community/publishing/items/{itemId}/components/{role}/reset": ["post"],
  "/v1/community/publishing/uploads/{componentId}": ["post"],
  "/v1/community/publishing/media/{itemId}/{variant}/{editKey}": ["get"],
  "/v1/community/publishing/submissions": ["post"],
  "/v1/community/publishing/submissions/{requestId}": ["get"],
};

const articleAuthoringMethods: Record<string, string[]> = {
  "/v1/community/article-authoring": ["get", "post"],
  "/v1/community/article-authoring/media": ["get"],
  "/v1/community/article-authoring/{articleId}": ["get", "put"],
  ...Object.fromEntries(
    ["blocks", "validate", "preview", "publish", "withdraw"].map((action) => [
      `/v1/community/article-authoring/{articleId}/${action}`,
      ["post"],
    ]),
  ),
  "/v1/community/article-authoring/connections": ["get"],
  "/v1/community/article-authoring/connections/{connectionId}/revoke": ["post"],
  "/v1/community/article-authoring/consents/{uid}": ["get"],
  "/v1/community/article-authoring/consents/{uid}/approve": ["post"],
  "/v1/community/article-authoring/consents/{uid}/deny": ["post"],
  "/v1/community/article-authoring/approvals/review": ["post"],
  "/v1/community/article-authoring/approvals": ["post"],
};

describe("inscription-first OpenAPI 3.1.1 contract", () => {
  it("contains exactly the approved Catalog, Community V1, Phase 4 and work publishing routes", () => {
    expect(openApiDocument.openapi).toBe("3.1.1");
    expect(openApiDocument.jsonSchemaDialect).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(asObject(openApiDocument.info).version).toBe("1.0.0");
    expect(Object.keys(paths).sort()).toEqual(
      [
        "/health",
        "/v1/catalog",
        "/v1/catalog/{catalogId}",
        "/v1/catalog/{catalogId}/comments",
        "/v1/catalog/{catalogId}/comments/{commentId}/replies",
        "/v1/catalog-search",
        "/v1/me",
        "/v1/community/discover",
        "/v1/community/filter-options",
        "/v1/community/content/{type}/{id}/card",
        "/v1/community/content/{type}/{id}/state",
        "/v1/community/authors/{authorId}/favorites",
        "/v1/community/authors/{authorId}/likes",
        "/v1/community/discussion/{type}/{id}",
        "/v1/community/discussion/{type}/{id}/replies/{rootId}",
        "/v1/community/discussion/{type}/{id}/locate/{commentId}",
        "/v1/community/discussion/items/{commentId}/like",
        "/v1/community/discussion/items/{commentId}/body",
        "/v1/community/me/comments",
        "/v1/community/notifications",
        "/v1/community/notifications/read",
        "/v1/community/notifications/stream",
        "/v1/community/mentions",
        "/v1/community/authors/{authorId}",
        "/v1/community/authors/{authorId}/followers",
        "/v1/community/authors/{authorId}/following",
        "/v1/community/authors/{authorId}/works",
        "/v1/community/content/favorite",
        "/v1/community/content/like",
        "/v1/community/favorites/merge",
        "/v1/community/me/avatar",
        "/v1/community/me/background",
        "/v1/community/me/blocks",
        "/v1/community/me/privacy",
        "/v1/community/me/profile",
        "/v1/community/media",
        "/v1/community/media/{mediaId}",
        "/v1/community/relationships/block",
        "/v1/community/relationships/follow",
        "/v1/community/auth/account",
        "/v1/community/auth/capabilities",
        "/v1/community/works/{workId}",
        "/v1/community/editorial/articles",
        "/v1/community/editorial/articles/{articleId}",
        "/v1/community/editorial/collections",
        "/v1/community/editorial/collections/{collectionId}",
        "/v1/community/threads",
        "/v1/community/threads/{threadId}",
        "/v1/community/threads/{threadId}/posts",
        "/v1/community/threads/{threadId}/read",
        "/v1/community/messages",
        "/v1/community/messages/unread",
        "/v1/community/messages/with/{authorId}",
        "/v1/community/messages/{conversationId}",
        "/v1/community/messages/{conversationId}/hide",
        "/v1/community/messages/{conversationId}/unhide",
        "/v1/community/messages/{conversationId}/mute",
        "/v1/community/messages/{conversationId}/unmute",
        "/v1/community/messages/{conversationId}/read",
        ...Object.keys(publishingMethods),
        "/v1/community/article-authoring",
        "/v1/community/article-authoring/media",
        "/v1/community/article-authoring/{articleId}",
        ...["blocks", "validate", "preview", "publish", "withdraw"].map(
          (action) => `/v1/community/article-authoring/{articleId}/${action}`,
        ),
        "/v1/community/article-authoring/connections",
        "/v1/community/article-authoring/connections/{connectionId}/revoke",
        "/v1/community/article-authoring/consents/{uid}",
        "/v1/community/article-authoring/consents/{uid}/approve",
        "/v1/community/article-authoring/consents/{uid}/deny",
        "/v1/community/article-authoring/approvals/review",
        "/v1/community/article-authoring/approvals",
      ].sort(),
    );
    // The Development session lifecycle is not a Public API operation, and the
    // Owner's operator boundary is an internal subpath, never documented here.
    expect(paths).not.toHaveProperty("/v1/development/sign-in");
    expect(paths).not.toHaveProperty("/v1/development/sign-out");
    expect(paths).not.toHaveProperty("/v1/items");
    expect(paths).not.toHaveProperty("/v1/items/{id}");
    expect(paths).not.toHaveProperty("/v1/search");
    expect(paths).not.toHaveProperty("/v1/categories");
    expect(paths).not.toHaveProperty("/v1/taxonomies");
    for (const name of Object.keys(paths))
      expect(name).not.toMatch(/internal|moderation|publication|operator/iu);
    const operationIds = Object.values(paths).flatMap((pathItem) =>
      Object.values(asObject(pathItem)).map((operation) =>
        String(asObject(operation).operationId),
      ),
    );
    for (const operationId of operationIds)
      expect(operationId).not.toMatch(
        /internal|moderate|publication|operator|suspend/iu,
      );

    const writePaths = new Set([
      "/v1/catalog/{catalogId}/comments",
      "/v1/catalog/{catalogId}/comments/{commentId}/replies",
    ]);
    const authorMethods: Record<string, string[]> = {
      "/v1/community/notifications": ["get"],
      "/v1/community/notifications/read": ["post"],
      "/v1/community/notifications/stream": ["get"],
      "/v1/community/mentions": ["get"],
      "/v1/community/discover": ["get"],
      "/v1/community/filter-options": ["get"],
      "/v1/community/content/{type}/{id}/card": ["get"],
      "/v1/community/content/{type}/{id}/state": ["get"],
      "/v1/community/authors/{authorId}/favorites": ["get"],
      "/v1/community/authors/{authorId}/likes": ["get"],
      "/v1/community/discussion/{type}/{id}": ["get", "post"],
      "/v1/community/discussion/{type}/{id}/replies/{rootId}": ["get", "post"],
      "/v1/community/discussion/{type}/{id}/locate/{commentId}": ["get"],
      "/v1/community/discussion/items/{commentId}/like": ["post"],
      "/v1/community/discussion/items/{commentId}/body": ["delete"],
      "/v1/community/me/comments": ["get"],

      "/v1/community/authors/{authorId}": ["get"],
      "/v1/community/authors/{authorId}/followers": ["get"],
      "/v1/community/authors/{authorId}/following": ["get"],
      "/v1/community/authors/{authorId}/works": ["get"],
      "/v1/community/content/favorite": ["post"],
      "/v1/community/content/like": ["post"],
      "/v1/community/favorites/merge": ["post"],
      "/v1/community/me/avatar": ["post"],
      "/v1/community/me/background": ["post"],
      "/v1/community/me/blocks": ["get"],
      "/v1/community/me/privacy": ["post"],
      "/v1/community/me/profile": ["post"],
      "/v1/community/media": ["post"],
      "/v1/community/media/{mediaId}": ["get"],
      "/v1/community/relationships/block": ["post"],
      "/v1/community/relationships/follow": ["post"],
      "/v1/community/auth/account": ["get"],
      "/v1/community/auth/capabilities": ["get"],
      "/v1/community/works/{workId}": ["get", "delete"],
      "/v1/community/editorial/articles": ["get"],
      "/v1/community/editorial/articles/{articleId}": ["get"],
      "/v1/community/editorial/collections": ["get"],
      "/v1/community/editorial/collections/{collectionId}": ["get"],
      "/v1/community/threads": ["get"],
      "/v1/community/threads/{threadId}": ["get"],
      "/v1/community/threads/{threadId}/posts": ["get"],
      "/v1/community/threads/{threadId}/read": ["post"],
      "/v1/community/messages": ["get", "post"],
      "/v1/community/messages/unread": ["get"],
      "/v1/community/messages/with/{authorId}": ["get"],
      "/v1/community/messages/{conversationId}": ["get"],
      "/v1/community/messages/{conversationId}/hide": ["post"],
      "/v1/community/messages/{conversationId}/unhide": ["post"],
      "/v1/community/messages/{conversationId}/mute": ["post"],
      "/v1/community/messages/{conversationId}/unmute": ["post"],
      "/v1/community/messages/{conversationId}/read": ["post"],
      ...publishingMethods,
      ...articleAuthoringMethods,
    };
    for (const [name, pathItem] of Object.entries(paths)) {
      expect(Object.keys(asObject(pathItem))).toEqual(
        authorMethods[name] ??
          (writePaths.has(name) ? ["get", "post"] : ["get"]),
      );
    }

    expect(
      Object.keys(asObject(getOperation("/health").responses)).sort(),
    ).toEqual(["200", "400", "503"]);
    expect(
      Object.keys(asObject(getOperation("/v1/catalog").responses)).sort(),
    ).toEqual(["200", "400", "500", "503"]);
    expect(
      Object.keys(
        asObject(getOperation("/v1/catalog/{catalogId}").responses),
      ).sort(),
    ).toEqual(["200", "400", "404", "500", "503"]);
    expect(getOperation("/v1/catalog").operationId).toBe("listCatalog");
    expect(getOperation("/v1/catalog/{catalogId}").operationId).toBe(
      "getCatalogById",
    );
    expect(
      Object.keys(asObject(getOperation("/v1/me").responses)).sort(),
    ).toEqual(["200", "400", "401", "500", "503"]);
    expect(getOperation("/v1/me").operationId).toBe("getCurrentUser");
    expect(getOperation("/v1/me").security).toEqual([{ session: [] }]);
    expect(parametersFor("/v1/me")).toEqual([]);
    expect(
      asObject(asObject(openApiDocument.components).securitySchemes),
    ).toEqual({
      session: expect.objectContaining({ type: "http", scheme: "bearer" }),
    });
    for (const operation of [
      "/health",
      "/v1/catalog",
      "/v1/catalog/{catalogId}",
      "/v1/catalog-search",
      // Comment reads stay anonymous.
      "/v1/catalog/{catalogId}/comments",
      "/v1/catalog/{catalogId}/comments/{commentId}/replies",
    ])
      expect(getOperation(operation)).not.toHaveProperty("security");
  });

  it("documents the comment operations, their session requirement and the pending outcome", () => {
    const commentsPath = "/v1/catalog/{catalogId}/comments";
    const repliesPath = "/v1/catalog/{catalogId}/comments/{commentId}/replies";
    const postOperation = (name: string): JsonObject =>
      asObject(asObject(paths[name]).post);

    expect(getOperation(commentsPath).operationId).toBe("listCatalogComments");
    expect(getOperation(repliesPath).operationId).toBe(
      "listCatalogCommentReplies",
    );
    expect(postOperation(commentsPath).operationId).toBe(
      "createCatalogComment",
    );
    expect(postOperation(repliesPath).operationId).toBe(
      "createCatalogCommentReply",
    );

    for (const name of [commentsPath, repliesPath]) {
      expect(
        Object.keys(asObject(getOperation(name).responses)).sort(),
      ).toEqual(["200", "400", "404", "500", "503"]);
      // 202 is the truthful outcome while PRE_MODERATION holds the submission.
      expect(
        Object.keys(asObject(postOperation(name).responses)).sort(),
      ).toEqual(["201", "202", "400", "401", "404", "422", "500", "503"]);
      expect(postOperation(name).security).toEqual([{ session: [] }]);
      expect(
        asObject(asObject(postOperation(name).requestBody).content),
      ).toHaveProperty("application/json");
      const pageParameters = parametersFor(name).filter(
        (parameter) => parameter.in === "query",
      );
      // Only the root listing takes the pinned hot ids of a load-more sequence.
      const listing = name === commentsPath;
      expect(pageParameters.map((parameter) => parameter.name)).toEqual(
        listing ? ["page", "pageSize", "pinned"] : ["page", "pageSize"],
      );
      for (const parameter of pageParameters)
        expect(asObject(parameter.schema)).toEqual(
          schemaProperty(
            listing
              ? catalogCommentListingTransportQueryJsonSchema
              : catalogCommentTransportQueryJsonSchema,
            String(parameter.name),
          ),
        );
    }
    expect(getOperation(commentsPath).description).toContain("hot");
    expect(
      asObject(asObject(schemas.CatalogCommentPage).properties),
    ).toHaveProperty("hot");
    expect(
      asObject(asObject(schemas.CatalogComment).properties),
    ).toHaveProperty("replyTotal");

    expect(asObject(getOperation(commentsPath).responses)["200"]).toMatchObject(
      {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CatalogCommentPage" },
          },
        },
      },
    );
    expect(asObject(getOperation(repliesPath).responses)["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/CatalogCommentReplyPage" },
        },
      },
    });
    expect(responseDescription(commentsPath, "404")).toContain(
      "ITEM_NOT_FOUND",
    );
    expect(
      String(
        asObject(asObject(postOperation(commentsPath).responses)["422"])
          .description,
      ),
    ).toContain("INVALID_INPUT");
  });

  it("keeps moderation state and operator shapes out of the public comment DTOs", () => {
    for (const name of [
      "CatalogComment",
      "CatalogCommentReply",
      "CatalogCommentPage",
      "CatalogCommentReplyPage",
      "CommentAuthor",
    ])
      expect(JSON.stringify(schemas[name]).toLowerCase()).not.toMatch(
        /moderation|pending|hidden|status|handle|operator/u,
      );
    expect(
      Object.keys(asObject(asObject(schemas.CatalogComment).properties)),
    ).toEqual([
      "id",
      "catalogId",
      "author",
      "text",
      "createdAt",
      "replies",
      "replyTotal",
    ]);
    expect(
      Object.keys(asObject(asObject(schemas.CatalogCommentReply).properties)),
    ).toEqual(["id", "author", "text", "createdAt", "replyTo"]);
    expect(requiredProperties(schemas.CatalogCommentReply)).not.toContain(
      "replyTo",
    );
    expect(
      Object.keys(asObject(asObject(schemas.CommentAuthor).properties)),
    ).toEqual(["id", "displayName"]);
    expect(asObject(schemas.CatalogComment).additionalProperties).toBe(false);
    expect(
      asObject(
        schemaProperty(
          asObject(asObject(schemas.CatalogCommentPage).properties).pageSize
            ? schemas.CatalogCommentPage
            : {},
          "pageSize",
        ),
      ).maximum,
    ).toBe(50);
  });

  it("exposes only the approved kind and bounded page parameters", () => {
    const listParameters = parameterMapFor("/v1/catalog");

    expect([...listParameters.keys()]).toEqual(["kind", "page", "pageSize"]);
    expect(parametersFor("/v1/catalog")).toEqual(
      ["kind", "page", "pageSize"].map((name) => ({
        name,
        in: "query",
        required: false,
        schema: schemaProperty(catalogListTransportQueryJsonSchema, name),
      })),
    );
    expect(asObject(listParameters.get("kind")?.schema)).toEqual(
      schemaProperty(catalogListTransportQueryJsonSchema, "kind"),
    );
    expect(asObject(listParameters.get("page")?.schema)).toEqual(
      schemaProperty(catalogListTransportQueryJsonSchema, "page"),
    );
    expect(asObject(listParameters.get("pageSize")?.schema)).toEqual(
      schemaProperty(catalogListTransportQueryJsonSchema, "pageSize"),
    );
    expect(paths).not.toHaveProperty("/v1/search");
    expect(paths).not.toHaveProperty("/v1/categories");
  });

  it("declares strict-query errors for endpoints without query parameters", () => {
    expect(parametersFor("/health")).toEqual([]);
    expect(parametersFor("/v1/catalog/{catalogId}")).toHaveLength(1);
    expect(responseDescription("/health", "400")).toContain("INVALID_QUERY");
    expect(responseDescription("/v1/catalog/{catalogId}", "400")).toContain(
      "INVALID_QUERY",
    );
  });

  it("uses the opaque CatalogId for Catalog lookup", () => {
    const idParameter = parameterMapFor("/v1/catalog/{catalogId}").get(
      "catalogId",
    );
    expect(idParameter).toMatchObject({
      in: "path",
      required: true,
      schema: { $ref: "#/components/schemas/CatalogId" },
    });
    expect(schemas.CatalogId).toEqual(catalogIdJsonSchema);
  });

  it("uses only contract-derived public components", () => {
    // Embedding changes only each component's local definition location.
    const standalone = JSON.parse(
      JSON.stringify(schemas, (key, value: unknown) =>
        key === "$ref" && typeof value === "string"
          ? value.replace(
              /^#\/components\/schemas\/[^/]+\/(\$defs\/.*)$/u,
              "#/$1",
            )
          : value,
      ),
    ) as unknown;
    expect(standalone).toEqual({
      ...authorCommunityJsonSchemas,
      ...authJsonSchemas,
      ...workPublishingJsonSchemas,
      ...articleAuthoringJsonSchemas,
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
    });
    expect(schemas.PublicUserProfile).toMatchObject({
      additionalProperties: false,
      required: ["id", "handle", "displayName"],
      type: "object",
    });
    expect(
      Object.keys(asObject(asObject(schemas.PublicUserProfile).properties)),
    ).toEqual(["id", "handle", "displayName"]);
    expect(JSON.stringify(schemas.PublicUserProfile).toLowerCase()).not.toMatch(
      /status|token|credential|email|phone|avatar/u,
    );
    expect(schemas.CatalogContributorRole).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      enum: ["textAuthor", "calligrapher"],
      type: "string",
    });
    expect(schemas.CatalogContributor).toEqual(catalogContributorJsonSchema);
    expect(schemas.CatalogContributor).toMatchObject({
      additionalProperties: false,
      required: ["name", "role"],
      type: "object",
    });
    expect(
      Object.keys(asObject(asObject(schemas.CatalogContributor).properties)),
    ).toEqual(["name", "role"]);
    expect(schemas.CatalogCitationScope).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      enum: [
        "record",
        "description",
        "transcription",
        "historicalContext",
        "scholarlyResearch",
      ],
      type: "string",
    });
    expect(schemas.CatalogKind).toMatchObject({
      enum: ["inscription", "calligraphy"],
      type: "string",
    });
    expect(schemas.PublicMedia).toMatchObject({
      properties: {
        src: {
          allOf: [
            { format: "uri", type: "string" },
            {
              pattern: "^[Hh][Tt][Tt][Pp][Ss]?:\\/\\/",
              type: "string",
            },
          ],
        },
      },
    });

    // Catalog's public boundary remains unchanged. Author-owned document,
    // preview and human consent contracts intentionally use candidate/review
    // vocabulary; they do not expose staff Catalog curation fields.
    const authorSchemaNames = new Set([
      ...Object.keys(authorCommunityJsonSchemas),
      ...Object.keys(authJsonSchemas),
      ...Object.keys(workPublishingJsonSchemas),
      ...Object.keys(articleAuthoringJsonSchemas),
    ]);
    const serialized = JSON.stringify({
      paths: Object.fromEntries(
        Object.entries(paths).filter(
          ([name]) => !name.startsWith("/v1/community/"),
        ),
      ),
      schemas: Object.fromEntries(
        Object.entries(schemas).filter(
          ([name]) => !authorSchemaNames.has(name),
        ),
      ),
    }).toLowerCase();
    for (const term of [
      "rawsource",
      "candidate",
      "evidence",
      "review",
      "lifecycle",
      "objectkey",
      "object_key",
      "bucket",
      "storageprovider",
      "storage_provider",
      "resolverconfiguration",
      "images",
      "relateditem",
      "categoryids",
      "city",
      "sourceid",
      "source_id",
      "personid",
      "scriptstyleid",
      "citationid",
      "workflow",
    ]) {
      expect(serialized).not.toContain(term);
    }
  });

  it("exposes the bounded content fields only on CatalogDetail", () => {
    const detailProperties = asObject(
      asObject(schemas.CatalogDetail).properties,
    );
    const summaryProperties = asObject(
      asObject(schemas.CatalogSummary).properties,
    );
    const contentFields = [
      "contributors",
      "scriptStyle",
      "transcription",
      "historicalContext",
      "scholarlyResearch",
    ];

    expect(Object.keys(summaryProperties).sort()).toEqual(
      [
        "id",
        "kind",
        "title",
        "aliases",
        "summary",
        "periodLabel",
        "province",
        "representativeMedia",
      ].sort(),
    );
    expect(Object.keys(detailProperties).sort()).toEqual(
      [
        ...Object.keys(summaryProperties),
        "dynasty",
        "dateText",
        "prefecture",
        "county",
        "currentLocation",
        "currentCustodian",
        "description",
        "sourceCitations",
        "media",
        ...contentFields,
      ].sort(),
    );

    for (const field of contentFields) {
      expect(detailProperties).toHaveProperty(field);
      expect(summaryProperties).not.toHaveProperty(field);
      expect(requiredProperties(schemas.CatalogDetail)).not.toContain(field);
    }

    expect(requiredProperties(schemas.CatalogSummary)).toEqual([
      "id",
      "kind",
      "title",
      "aliases",
    ]);
    expect(requiredProperties(schemas.CatalogDetail)).toEqual([
      "id",
      "kind",
      "title",
      "aliases",
      "sourceCitations",
      "media",
    ]);
    expect(schemaProperty(schemas.CatalogDetail, "contributors")).toMatchObject(
      {
        type: "array",
        minItems: 1,
        maxItems: 50,
        uniqueItems: true,
        items: {
          additionalProperties: false,
          required: ["name", "role"],
          type: "object",
        },
      },
    );
    expect(
      schemaProperty(
        schemaProperty(schemas.CatalogDetail, "contributors").items,
        "name",
      ),
    ).toMatchObject({ minLength: 1, maxLength: 500, type: "string" });
    expect(
      schemaProperty(
        schemaProperty(schemas.CatalogDetail, "contributors").items,
        "role",
      ),
    ).toMatchObject({
      enum: ["textAuthor", "calligrapher"],
      type: "string",
    });
    expect(schemaProperty(schemas.CatalogDetail, "scriptStyle")).toMatchObject({
      minLength: 1,
      maxLength: 2000,
      type: "string",
    });
    expect(
      schemaProperty(schemas.CatalogDetail, "transcription"),
    ).toMatchObject({ minLength: 1, maxLength: 100000, type: "string" });
    for (const field of ["historicalContext", "scholarlyResearch"]) {
      expect(schemaProperty(schemas.CatalogDetail, field)).toMatchObject({
        minLength: 1,
        maxLength: 20000,
        type: "string",
      });
    }
    expect(asObject(schemas.CatalogDetail).additionalProperties).toBe(false);
    expect(asObject(schemas.CatalogSummary).additionalProperties).toBe(false);
  });

  it("exposes optional bounded citation scopes without changing citation identity", () => {
    const citation = asObject(schemas.PublicSourceCitation);
    const appliesTo = schemaProperty(citation, "appliesTo");

    expect(Object.keys(asObject(citation.properties)).sort()).toEqual(
      ["label", "citation", "url", "appliesTo"].sort(),
    );
    expect(requiredProperties(citation)).toEqual(["label"]);
    expect(requiredProperties(citation)).not.toContain("appliesTo");
    expect(appliesTo).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: {
        enum: [
          "record",
          "description",
          "transcription",
          "historicalContext",
          "scholarlyResearch",
        ],
        type: "string",
      },
    });
    expect(citation.additionalProperties).toBe(false);
    expect(citation).not.toHaveProperty("default");
    expect(appliesTo).not.toHaveProperty("default");
  });

  it("documents the work publishing operations with their session, transfer and range rules", () => {
    const operationOf = (path: string, method: string): JsonObject =>
      asObject(asObject(paths[path])[method]);
    for (const [path, methods] of Object.entries(publishingMethods))
      for (const method of methods) {
        const operation = operationOf(path, method);
        const header = ((operation.parameters ?? []) as unknown[])
          .map(asObject)
          .find((parameter) => parameter.name === "x-author-account");
        if (path.endsWith("/{editKey}")) {
          // Eligible public derivatives are readable without a session.
          expect(operation.security).toEqual([{}, { session: [] }]);
          expect(header).toBeUndefined();
          continue;
        }
        expect(operation.security).toEqual([{ session: [] }]);
        // Every command asserts the session account; reads do not.
        if (method === "get") expect(header).toBeUndefined();
        else expect(header).toMatchObject({ in: "header", required: true });
        expect(Object.keys(asObject(operation.responses))).toEqual(
          expect.arrayContaining(["401", "404", "422", "503"]),
        );
      }
    for (const path of [
      "/v1/community/publishing/drafts",
      "/v1/community/publishing/sessions",
      "/v1/community/publishing/items",
    ])
      expect(
        Object.keys(asObject(operationOf(path, "post").responses)),
      ).toContain("201");

    // A draft deletion may be confirmed against the revision the author saw.
    const draftDeletion = operationOf(
      "/v1/community/publishing/drafts/{draftId}",
      "delete",
    );
    expect(asObject(draftDeletion.requestBody)).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/PublishingDraftDeletionCommand",
          },
        },
      },
    });
    expect(
      asObject(asObject(draftDeletion.responses)["409"]).description,
    ).toContain("draft_changed");
    expect(schemas.PublishingDraftDeletionCommand).toMatchObject({
      additionalProperties: false,
      required: ["requestId"],
      properties: {
        expectedRevision: { type: "integer", minimum: 1 },
      },
    });
    expect(
      asObject(asObject(draftDeletion.responses)["409"]).description,
    ).toContain("unresolved conflict copy");

    // Opening an edit draft says whether this request created it.
    expect(
      asObject(
        operationOf("/v1/community/publishing/works/{workId}/draft", "post")
          .responses,
      )["200"],
    ).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/PublishingOpenedEditDraft" },
        },
      },
    });
    expect(schemas.PublishingOpenedEditDraft).toMatchObject({
      additionalProperties: false,
      required: ["draft", "created"],
      properties: { created: { type: "boolean" } },
    });
    // Readiness checks are holder commands answering the holder's readiness.
    for (const path of [
      "/v1/community/publishing/drafts/{draftId}/readiness",
      "/v1/community/publishing/sessions/{sessionId}/readiness",
    ]) {
      const readiness = operationOf(path, "post");
      expect(asObject(readiness.requestBody)).toEqual({
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/PublishingReadinessCommand",
            },
          },
        },
      });
      expect(asObject(readiness.responses)["200"]).toMatchObject({
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/PublishingReadiness" },
          },
        },
      });
      expect(Object.keys(asObject(readiness.responses))).not.toContain("201");
    }
    expect(schemas.PublishingReadinessCommand).toMatchObject({
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: { type: "object", additionalProperties: false },
      },
    });
    expect(schemas.PublishingReadiness).toMatchObject({
      additionalProperties: false,
      required: ["ready", "pendingItemKeys", "failedItemKeys", "editKeys"],
      properties: {
        ready: { type: "boolean" },
        editKeys: { type: "object" },
      },
    });

    // Authorship may be not set (null); a work read may name its card cover.
    expect(
      JSON.stringify(
        asObject(asObject(schemas.WorkDraftContent).properties).authorship,
      ),
    ).toContain('{"type":"null"}');
    // The card cover is an optional media path of a work read, or null.
    expect(asObject(schemas.UserWork).required).not.toContain("coverSrc");
    expect(
      asObject(asObject(asObject(schemas.UserWork).properties).coverSrc),
    ).toEqual({
      anyOf: [
        {
          anyOf: [
            {
              type: "string",
              pattern:
                "^\\/api\\/community\\/publishing\\/media\\/(media-item-[0-9a-f]{32})\\/(thumb|display|full|motion|cover)\\/(?:base|[0-9a-f]{32})$",
            },
            {
              type: "string",
              pattern: "^\\/api\\/community\\/media\\/user-media-[0-9a-f]{32}$",
            },
          ],
        },
        { type: "null" },
      ],
    });

    const upload = operationOf(
      "/v1/community/publishing/uploads/{componentId}",
      "post",
    );
    expect(Object.keys(asObject(asObject(upload.requestBody).content))).toEqual(
      ["application/octet-stream"],
    );
    expect(
      ((upload.parameters ?? []) as unknown[])
        .map(asObject)
        .filter((parameter) => parameter.in === "header")
        .map((parameter) => [parameter.name, parameter.required]),
    ).toEqual([
      ["x-author-account", true],
      ["x-upload-attempt", true],
      ["content-length", true],
    ]);
    expect(Object.keys(asObject(upload.responses)).sort()).toEqual([
      "200",
      "401",
      "404",
      "409",
      "413",
      "422",
      "503",
    ]);

    const media = operationOf(
      "/v1/community/publishing/media/{itemId}/{variant}/{editKey}",
      "get",
    );
    expect(Object.keys(asObject(media.responses)).sort()).toEqual([
      "200",
      "206",
      "401",
      "404",
      "416",
      "422",
      "503",
    ]);
    expect(
      Object.keys(
        asObject(asObject(asObject(media.responses)["206"]).content),
      ).sort(),
    ).toEqual(["image/webp", "video/mp4"]);

    const trash = operationOf("/v1/community/works/{workId}", "delete");
    expect(trash.operationId).toBe("deleteOwnWorkPermanently");
    expect(
      ((trash.parameters ?? []) as unknown[])
        .map(asObject)
        .filter((parameter) => parameter.in === "header")
        .map((parameter) => [parameter.name, parameter.required]),
    ).toEqual([["x-author-account", true]]);
    // The retired Phase 4 work-edit draft shapes are neither referenced nor
    // published as components.
    for (const retired of [
      "WorkDraftPage",
      "WorkDraftResult",
      "WorkApplyResult",
      "WorkDraftSave",
      "WorkDraftApply",
      "WorkEditDraft",
      "WorkText",
    ]) {
      expect(JSON.stringify(openApiDocument)).not.toContain(
        `#/components/schemas/${retired}"`,
      );
      expect(Object.keys(schemas)).not.toContain(retired);
    }
  });

  it("uses stable public error codes", () => {
    expect(
      schemaProperty(schemaProperty(schemas.ApiError, "error"), "code"),
    ).toMatchObject({
      enum: [
        "CONFLICT",
        "INVALID_QUERY",
        "INVALID_INPUT",
        "ITEM_NOT_FOUND",
        "UNAUTHENTICATED",
        "SERVICE_UNAVAILABLE",
        "INTERNAL_ERROR",
      ],
      type: "string",
    });
    expect(responseDescription("/v1/me", "401")).toContain("UNAUTHENTICATED");
    expect(responseDescription("/v1/catalog", "400")).toContain(
      "INVALID_QUERY",
    );
    expect(responseDescription("/v1/catalog/{catalogId}", "404")).toContain(
      "ITEM_NOT_FOUND",
    );
    expect(responseDescription("/health", "503")).toContain(
      "SERVICE_UNAVAILABLE",
    );
    expect(responseDescription("/v1/catalog", "500")).toContain(
      "INTERNAL_ERROR",
    );
  });

  it("regenerates an object equal to the committed artifact", async () => {
    const artifactUrl = new URL(
      "../../../services/public-api/openapi/openapi.json",
      import.meta.url,
    );
    const committedArtifact = await readFile(artifactUrl, "utf8");
    const regenerated = serializeOpenApiDocument();
    // generate:openapi formats the serialized JSON with the repository config.
    const formatted = await format(regenerated, {
      ...(await resolveConfig(artifactUrl)),
      parser: "json",
    });

    expect(JSON.parse(regenerated)).toEqual(JSON.parse(committedArtifact));
    expect(formatted).toBe(committedArtifact);
    expect(serializeOpenApiDocument()).toBe(regenerated);
  });
});

describe("embedded Article OpenAPI document integrity", () => {
  it("resolves every local JSON pointer against the complete OpenAPI document", () => {
    let refs = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (
          key === "$ref" &&
          typeof item === "string" &&
          item.startsWith("#/")
        ) {
          refs++;
          let target: unknown = openApiDocument;
          for (const segment of item.slice(2).split("/")) {
            expect(target, `unresolved ${item}`).not.toBeNull();
            expect(typeof target, `unresolved ${item}`).toBe("object");
            target =
              asObject(target)[
                segment.replaceAll("~1", "/").replaceAll("~0", "~")
              ];
          }
          expect(target, `unresolved ${item}`).toBeDefined();
        } else visit(item);
      }
    };
    visit(openApiDocument);
    expect(refs).toBeGreaterThan(500);
  });
  it("requires the defined session scheme and account fence for every human Article operation", () => {
    const security = asObject(
      asObject(openApiDocument.components).securitySchemes,
    );
    for (const [name, item] of Object.entries(paths)) {
      if (!name.startsWith("/v1/community/article-authoring")) continue;
      for (const operation of Object.values(asObject(item))) {
        expect(asObject(operation).security).toEqual([{ session: [] }]);
        expect(security.session).toMatchObject({
          type: "http",
          scheme: "bearer",
        });
        expect(asObject(operation).parameters).toContainEqual({
          name: "x-author-account",
          in: "header",
          required: true,
          schema: { $ref: "#/components/schemas/PublicUserId" },
        });
      }
    }
    expect(
      asObject(
        asObject(paths["/v1/community/article-authoring/{articleId}"]).put,
      ).operationId,
    ).toBe("saveOwnedArticleDraft");
  });
});
