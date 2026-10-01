/** Human session routes only. MCP and staff operator authority are separate. */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (schema: string) => ({
  "application/json": { schema: ref(schema) },
});
const response = (schema: string) => ({
  description: "Exact committed result; private, no-store.",
  content: content(schema),
});
const path = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 256 },
});
const operation = (
  operationId: string,
  result: string | null,
  input?: string,
  parameters: unknown[] = [],
  success = "200",
) => ({
  operationId,
  tags: ["ArticleAuthoring"],
  description:
    "Development only. Current human session and x-author-account are required on reads and writes. Owner identity is server bound. Expected version and fingerprint fences are checked before mutation. Agents use the separate delegated MCP resource; this session route grants no staff or Admin authority.",
  security: [{ session: [] }],
  parameters: [
    {
      name: "x-author-account",
      in: "header",
      required: true,
      schema: ref("PublicUserId"),
    },
    ...parameters,
  ],
  ...(input === undefined
    ? {}
    : { requestBody: { required: true, content: content(input) } }),
  responses: {
    [success]:
      result === null
        ? { description: "Committed revocation; no response body." }
        : response(result),
    "401": {
      description: "Missing session or stale account.",
      content: content("ApiError"),
    },
    "404": {
      description: "Unavailable or foreign owned identity.",
      content: content("ApiError"),
    },
    "409": {
      description:
        "Stale candidate, changed grant, receipt or reference conflict.",
      content: content("ApiError"),
    },
    "422": {
      description: "Invalid bounded document, command or query.",
      content: content("ApiError"),
    },
    "503": {
      description: "Required infrastructure unavailable.",
      content: content("ApiError"),
    },
  },
});
const root = "/v1/community/article-authoring";
const article = `${root}/{articleId}`;
export const articleAuthoringPaths: Record<string, unknown> = {
  [root]: {
    get: operation("listOwnedArticleDrafts", "ArticleDraftPage", undefined, [
      {
        name: "cursor",
        in: "query",
        schema: { type: "string", maxLength: 512 },
      },
      {
        name: "pageSize",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    ]),
    post: operation(
      "createOwnedArticleDraft",
      "ArticleDraft",
      "CreateArticleDraftCommand",
      [],
      "201",
    ),
  },
  [article]: {
    get: operation("readOwnedArticleDraft", "ArticleDraft", undefined, [
      path("articleId"),
    ]),
    put: operation(
      "saveOwnedArticleDraft",
      "ArticleDraft",
      "UpdateArticleDraftCommand",
      [path("articleId")],
    ),
  },
  [`${root}/media`]: {
    get: operation(
      "listOwnReadyArticleMedia",
      "ArticleOwnMediaPage",
      undefined,
      [
        {
          name: "cursor",
          in: "query",
          schema: { type: "string", maxLength: 512 },
        },
        {
          name: "pageSize",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
    ),
  },
  [`${article}/blocks`]: {
    post: operation(
      "editOwnedArticleBlocks",
      "ArticleDraft",
      "ArticleBlockEditsCommand",
      [path("articleId")],
    ),
  },
  [`${article}/validate`]: {
    post: operation(
      "validateOwnedArticleCandidate",
      "ArticleValidationResult",
      "ArticleCandidateCommand",
      [path("articleId")],
    ),
  },
  [`${article}/preview`]: {
    post: operation(
      "previewOwnedArticleCandidate",
      "ArticlePreview",
      "ArticleCandidateCommand",
      [path("articleId")],
    ),
  },
  [`${article}/publish`]: {
    post: operation(
      "publishOwnedArticleCandidate",
      "ArticlePublicationResult",
      "ArticleCandidateCommand",
      [path("articleId")],
    ),
  },
  [`${article}/withdraw`]: {
    post: operation(
      "withdrawOwnedArticle",
      "ArticleDraft",
      "ArticleCandidateCommand",
      [path("articleId")],
    ),
  },
  [`${root}/connections`]: {
    get: operation(
      "listOwnArticleAgentConnections",
      "ArticleAuthoringConnections",
    ),
  },
  [`${root}/connections/{connectionId}/revoke`]: {
    post: operation(
      "revokeOwnArticleAgentConnection",
      null,
      "RevokeArticleAuthoringGrantCommand",
      [path("connectionId")],
      "204",
    ),
  },
  [`${root}/consents/{uid}`]: {
    get: operation(
      "reviewOwnArticleAgentConsent",
      "ArticleConsentReview",
      undefined,
      [path("uid")],
    ),
  },
  [`${root}/consents/{uid}/approve`]: {
    post: operation(
      "approveOwnArticleAgentConsent",
      "ArticleConsentDecision",
      "CreateArticleAuthoringGrantCommand",
      [path("uid")],
    ),
  },
  [`${root}/consents/{uid}/deny`]: {
    post: operation(
      "denyOwnArticleAgentConsent",
      "ArticleConsentDecision",
      "CreateArticleAuthoringGrantCommand",
      [path("uid")],
    ),
  },
  [`${root}/approvals/review`]: {
    post: operation(
      "reviewOwnArticleAgentCandidate",
      "ArticleApprovalReview",
      "ArticleApprovalCandidate",
    ),
  },
  [`${root}/approvals`]: {
    post: operation(
      "approveOwnArticleAgentCandidate",
      "ArticleApprovalResult",
      "ArticleCandidateApprovalSubmission",
      [],
      "201",
    ),
  },
};
