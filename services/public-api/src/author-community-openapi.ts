/** Phase 4 and work publishing application routes. Composition remains Development-only. */
const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (schema: string) => ({
  description: "Committed result; private responses are never cached.",
  content: { "application/json": { schema: reference(schema) } },
});
const failure = (description: string) => ({
  description,
  content: { "application/json": { schema: reference("ApiError") } },
});
const listParameters = [
  {
    name: "page",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 10000, default: 1 },
  },
  {
    name: "pageSize",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  },
];
const opaquePathPrefixes: Record<string, string> = {
  workId: "work",
  draftId: "work-draft",
  itemId: "media-item",
  componentId: "media-component",
  sessionId: "publishing-session",
  articleId: "article",
  collectionId: "collection",
  threadId: "thread",
  conversationId: "dm",
  messageId: "dmsg",
};
const pathSchema = (name: string) => {
  if (name === "type") return { type: "string", enum: ["catalog", "work"] };
  if (name === "commentId" || name === "rootId")
    return reference("CatalogCommentId");
  if (name === "authorId") return reference("PublicUserId");
  const opaque = opaquePathPrefixes[name];
  if (opaque !== undefined)
    return { type: "string", pattern: `^${opaque}-[0-9a-f]{32}$` };
  if (name === "requestId") return { type: "string", format: "uuid" };
  if (name === "role")
    return { type: "string", enum: ["still", "motion", "package"] };
  if (name === "variant")
    return {
      type: "string",
      enum: ["thumb", "display", "full", "motion", "cover"],
    };
  if (name === "editKey")
    return { type: "string", pattern: "^(?:base|[0-9a-f]{32})$" };
  return {
    type: "string",
    minLength: 1,
    description:
      "Stored opaque identity; never derive a Catalog identity from a user work.",
  };
};
const discussionParameters = [
  {
    name: "page",
    in: "query",
    schema: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      default: 1,
    },
  },
  listParameters[1],
  {
    name: "pinned",
    in: "query",
    description:
      "Up to 3 distinct root comment IDs separated by commas. Omission selects current hot roots; an explicitly empty string pins none. Reuse the same IDs for paging and location.",
    schema: { type: "string", maxLength: 387 },
  },
];
const discoveryParameters = [
  {
    name: "kind",
    in: "query",
    schema: {
      type: "string",
      enum: ["all", "inscription", "calligraphy"],
      default: "all",
    },
  },
  {
    name: "pageSize",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 50, default: 12 },
  },
  {
    name: "search",
    in: "query",
    schema: { type: "string", maxLength: 200, default: "" },
  },
  {
    name: "sequence",
    in: "query",
    description:
      "24-hour viewer/query-bound browsing sequence. A new sequence fixes membership order; live eligibility is rechecked at each page.",
    schema: { type: "string", format: "uuid" },
  },
  {
    name: "after",
    in: "query",
    schema: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      default: 0,
    },
  },
  {
    name: "filters",
    in: "query",
    description:
      "JSON-encoded InscriptionFilters; nonempty only for inscription. OR within each dimension, AND across dimensions. @unknown and @unsupplied are reserved states, not historical values.",
    content: {
      "application/json": { schema: reference("InscriptionFilters") },
    },
  },
];
const operation = (
  name: string,
  path: string,
  output: string | null,
  input: string | null,
  privateOnly: boolean,
  list: boolean | "collection" | "discussion" | "discovery" = false,
) => ({
  operationId: name,
  description:
    "Phase 4 Development only; absent in Production. Optional sessions personalize eligibility; malformed supplied credentials reject. All reads are private, no-store with Vary: Authorization. Unknown or duplicate query fields reject. JSON writes accept no query. RequestIdentity commands are replay-safe for their actor; comment submissions do not have a replay receipt. Removing an own work moves it to the recycle bin.",
  security: privateOnly ? [{ session: [] }] : [{}, { session: [] }],
  parameters: [
    ...[...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: pathSchema(m[1]!),
    })),
    ...(input
      ? [
          {
            name: "x-author-account",
            in: "header",
            required: false,
            description:
              "Optional assertion of the authenticated account; mismatch rejects. Does not authorize a request.",
            schema: { type: "string" },
          },
        ]
      : []),
    ...(list === "discovery"
      ? discoveryParameters
      : list === "discussion"
        ? discussionParameters
        : list
          ? listParameters
          : []),
    ...(list === "collection"
      ? [
          {
            name: "search",
            in: "query",
            schema: { type: "string", maxLength: 200, default: "" },
          },
          {
            name: "kind",
            in: "query",
            schema: {
              type: "string",
              enum: ["all", "inscription", "calligraphy"],
              default: "all",
            },
          },
        ]
      : []),
  ],
  ...(input
    ? {
        requestBody: {
          required: true,
          content: { "application/json": { schema: reference(input) } },
        },
      }
    : {}),
  responses: {
    [output === "DiscussionSubmitResult" ? "201" : "200"]: output
      ? response(output)
      : { description: "Mutation and audit committed." },
    "401": failure("A valid session is required"),
    "404": failure("Unavailable or private subject"),
    "409": failure(
      "Version, request identity or New York avatar-date conflict",
    ),
    "422": failure("Strict input validation failed"),
    "503": failure("Service unavailable; no success is claimed"),
  },
});
const routes: readonly [
  string,
  string,
  string,
  string | null,
  string | null,
  boolean,
  (boolean | "collection" | "discussion" | "discovery")?,
][] = [
  [
    "/v1/community/discover",
    "get",
    "discoverContent",
    "DiscoveryPage",
    null,
    false,
    "discovery",
  ],
  [
    "/v1/community/filter-options",
    "get",
    "readInscriptionFilterOptions",
    "InscriptionFilterOptions",
    null,
    false,
  ],
  [
    "/v1/community/content/{type}/{id}/card",
    "get",
    "readContentCard",
    "ContentCard",
    null,
    false,
  ],
  [
    "/v1/community/content/{type}/{id}/state",
    "get",
    "readOwnContentState",
    "ContentState",
    null,
    false,
  ],
  [
    "/v1/community/authors/{authorId}/favorites",
    "get",
    "readAuthorFavorites",
    "ContentCollectionPage",
    null,
    false,
    "collection",
  ],
  [
    "/v1/community/authors/{authorId}/likes",
    "get",
    "readAuthorLikes",
    "ContentCollectionPage",
    null,
    false,
    "collection",
  ],
  [
    "/v1/community/discussion/{type}/{id}",
    "get",
    "readDiscussion",
    "DiscussionPage",
    null,
    false,
    "discussion",
  ],
  [
    "/v1/community/discussion/{type}/{id}",
    "post",
    "submitDiscussion",
    "DiscussionSubmitResult",
    "CreateCatalogCommentRequest",
    true,
  ],
  [
    "/v1/community/discussion/{type}/{id}/replies/{rootId}",
    "get",
    "readDiscussionReplies",
    "DiscussionReplyPage",
    null,
    false,
    true,
  ],
  [
    "/v1/community/discussion/{type}/{id}/replies/{rootId}",
    "post",
    "submitDiscussionReply",
    "DiscussionSubmitResult",
    "CreateCatalogCommentReplyRequest",
    true,
  ],
  [
    "/v1/community/discussion/{type}/{id}/locate/{commentId}",
    "get",
    "locateOwnDiscussion",
    "DiscussionLocation",
    null,
    true,
    "discussion",
  ],
  [
    "/v1/community/discussion/items/{commentId}/like",
    "post",
    "setCommentLike",
    "SavedResult",
    "CommentLikeUpdate",
    true,
  ],
  [
    "/v1/community/discussion/items/{commentId}/body",
    "delete",
    "deleteOwnCommentBody",
    "DeletedResult",
    "RequestIdentity",
    true,
  ],
  [
    "/v1/community/me/comments",
    "get",
    "readOwnComments",
    "OwnCommentPage",
    null,
    true,
    true,
  ],

  [
    "/v1/community/authors/{authorId}",
    "get",
    "readAuthor",
    "AuthorProfile",
    null,
    false,
  ],
  [
    "/v1/community/authors/{authorId}/works",
    "get",
    "readAuthorWorks",
    "WorkPage",
    null,
    false,
    true,
  ],
  [
    "/v1/community/authors/{authorId}/following",
    "get",
    "readFollowing",
    "AuthorPeoplePage",
    null,
    false,
    true,
  ],
  [
    "/v1/community/authors/{authorId}/followers",
    "get",
    "readFollowers",
    "AuthorPeoplePage",
    null,
    false,
    true,
  ],
  [
    "/v1/community/me/blocks",
    "get",
    "readOwnBlocks",
    "AuthorPeoplePage",
    null,
    true,
    true,
  ],
  [
    "/v1/community/me/profile",
    "post",
    "updateOwnProfile",
    "SavedResult",
    "ProfileUpdate",
    true,
  ],
  [
    "/v1/community/me/privacy",
    "post",
    "updateOwnPrivacy",
    "SavedResult",
    "PrivacyUpdate",
    true,
  ],
  [
    "/v1/community/me/avatar",
    "post",
    "changeOwnAvatar",
    "AvatarUpdateResult",
    "AvatarUpdate",
    true,
  ],
  [
    "/v1/community/me/background",
    "post",
    "changeOwnBackground",
    "SavedResult",
    "BackgroundUpdate",
    true,
  ],
  [
    "/v1/community/relationships/follow",
    "post",
    "setFollowing",
    "SavedResult",
    "RelationshipUpdate",
    true,
  ],
  [
    "/v1/community/relationships/block",
    "post",
    "setBlocking",
    "SavedResult",
    "RelationshipUpdate",
    true,
  ],
  [
    "/v1/community/content/favorite",
    "post",
    "setContentFavorite",
    "SavedResult",
    "ContentRelationUpdate",
    true,
  ],
  [
    "/v1/community/content/like",
    "post",
    "setContentLike",
    "SavedResult",
    "ContentRelationUpdate",
    true,
  ],
  [
    "/v1/community/favorites/merge",
    "post",
    "mergeGuestFavorites",
    "GuestFavoriteMergeResult",
    "GuestFavoriteMerge",
    true,
  ],
  [
    "/v1/community/works/{workId}",
    "get",
    "readExistingWork",
    "UserWork",
    null,
    false,
  ],
  [
    "/v1/community/works/{workId}",
    "delete",
    "deleteOwnWorkPermanently",
    "DeletedResult",
    "RequestIdentity",
    true,
  ],
];
export const authorCommunityPaths: Record<string, Record<string, unknown>> = {};
for (const [path, method, name, output, input, privateOnly, list] of routes) {
  authorCommunityPaths[path] ??= {};
  authorCommunityPaths[path][method] = operation(
    name,
    path,
    output,
    input,
    privateOnly,
    list,
  );
}
authorCommunityPaths["/v1/community/media"] = {
  post: {
    ...operation(
      "uploadOwnedMedia",
      "/v1/community/media",
      "AuthorMedia",
      null,
      true,
    ),
    parameters: [
      {
        name: "x-request-id",
        in: "header",
        required: true,
        schema: { type: "string", format: "uuid" },
        description:
          "Stable upload request identity; a replay with different bytes conflicts.",
      },
      {
        name: "x-author-account",
        in: "header",
        required: false,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "image/png": {
          schema: {
            type: "string",
            format: "binary",
            description:
              "Bounded RGB/RGBA PNG, at most 4 MiB, 8192 pixels per dimension and 16 megapixels.",
          },
        },
      },
    },
    responses: {
      "201": response("AuthorMedia"),
      "401": failure("Authentication required"),
      "409": failure("Upload identity reused with different bytes"),
      "422": failure("Invalid or oversized PNG"),
      "503": failure("Service unavailable"),
    },
  },
};
authorCommunityPaths["/v1/community/media/{mediaId}"] = {
  get: {
    ...operation(
      "readEligibleOwnedMedia",
      "/v1/community/media/{mediaId}",
      null,
      null,
      false,
    ),
    responses: {
      "200": {
        description: "Authorized PNG; private, no-store.",
        content: {
          "image/png": { schema: { type: "string", format: "binary" } },
        },
      },
      "401": failure("Invalid credential"),
      "404": failure("Unavailable media"),
      "503": failure("Service unavailable"),
    },
  },
};

// content-community-completion-v1: anonymous reads of the exact published
// editorial revisions. Development only; absent in Production.
const editorialDescription =
  "Published editorial content, Development only; absent in Production. Anonymous reads return only the exact currently published revision; drafts, pending replacements and withdrawn documents are absent (404). Collection members that are no longer published are omitted without reordering the rest. Responses are private, no-store.";
const editorialOperation = (
  name: string,
  path: string,
  output: string,
  parameters: readonly Record<string, unknown>[],
) => ({
  operationId: name,
  description: editorialDescription,
  security: [{}],
  parameters: [
    ...[...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: pathSchema(m[1]!),
    })),
    ...parameters,
  ],
  responses: {
    "200": response(output),
    "400": failure("Invalid query"),
    "404": failure("No published revision"),
    "503": failure("Service unavailable"),
  },
});
const editorialListParameters = [
  {
    name: "page",
    in: "query",
    schema: { type: "integer", minimum: 1, default: 1 },
  },
  {
    name: "pageSize",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 50, default: 12 },
  },
];
authorCommunityPaths["/v1/community/editorial/articles"] = {
  get: editorialOperation(
    "listPublishedArticles",
    "/v1/community/editorial/articles",
    "ArticlePage",
    [
      ...editorialListParameters,
      {
        name: "presentation",
        in: "query",
        schema: { type: "string", enum: ["news", "academic"] },
      },
    ],
  ),
};
authorCommunityPaths["/v1/community/editorial/articles/{articleId}"] = {
  get: editorialOperation(
    "readPublishedArticle",
    "/v1/community/editorial/articles/{articleId}",
    "ArticleDetail",
    [],
  ),
};
authorCommunityPaths["/v1/community/editorial/collections"] = {
  get: editorialOperation(
    "listPublishedArticleCollections",
    "/v1/community/editorial/collections",
    "ArticleCollectionPage",
    editorialListParameters,
  ),
};
authorCommunityPaths["/v1/community/editorial/collections/{collectionId}"] = {
  get: editorialOperation(
    "readPublishedArticleCollection",
    "/v1/community/editorial/collections/{collectionId}",
    "ArticleCollectionDetail",
    [],
  ),
};

// content-community-completion-v1: Threads over Works (Development only).
const threadDescription =
  "Threads over Works, Development only; absent in Production. A Thread post is a Work published through the publishing submission with threadId. Lists are ranked at a server anchor instant (heat = Σ weight·2^(-age_days/7); work 1, comment/reply 2, active like 1; ties by latest activity then id) and only count publicly eligible activity; pass the returned anchor back for later pages. `unread` is null for anonymous readers. Responses are private, no-store.";
const threadOperation = (
  name: string,
  path: string,
  output: string,
  parameters: readonly Record<string, unknown>[],
  method: "get" | "post" = "get",
) => ({
  operationId: name,
  description: threadDescription,
  security: method === "post" ? [{ session: [] }] : [{}, { session: [] }],
  parameters: [
    ...[...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: pathSchema(m[1]!),
    })),
    ...parameters,
  ],
  responses: {
    "200": response(output),
    "400": failure("Invalid query"),
    ...(method === "post"
      ? { "401": failure("A valid session is required") }
      : {}),
    "404": failure("Unavailable Thread"),
    "503": failure("Service unavailable"),
  },
});
authorCommunityPaths["/v1/community/threads"] = {
  get: threadOperation("listThreads", "/v1/community/threads", "ThreadPage", [
    {
      name: "page",
      in: "query",
      schema: { type: "integer", minimum: 1, default: 1 },
    },
    {
      name: "pageSize",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 50, default: 22 },
    },
    {
      name: "anchor",
      in: "query",
      schema: { type: "string", format: "date-time" },
    },
  ]),
};
authorCommunityPaths["/v1/community/threads/{threadId}"] = {
  get: threadOperation(
    "readThread",
    "/v1/community/threads/{threadId}",
    "ThreadSummary",
    [],
  ),
};
authorCommunityPaths["/v1/community/threads/{threadId}/posts"] = {
  get: threadOperation(
    "listThreadPosts",
    "/v1/community/threads/{threadId}/posts",
    "WorkPage",
    listParameters,
  ),
};
authorCommunityPaths["/v1/community/threads/{threadId}/read"] = {
  post: threadOperation(
    "markThreadRead",
    "/v1/community/threads/{threadId}/read",
    "ThreadReadResult",
    [],
    "post",
  ),
};

// content-community-completion-v1: one-to-one direct messages (Development only).
const dmDescription =
  "Direct messages, Development only; absent in Production. Every route requires the session; the sender is the session account. A new pair is a request: the initiator commits exactly one message until the recipient's committed reply activates it (later sends answer INVALID_INPUT dm_request_pending). Limits: 2,000 code points, 20 new conversations per UTC day, 20 accepted messages per minute (dm_daily_limit, dm_rate_limited). Hide is for the viewer only; read markers are monotonic and clamped. Responses are private, no-store.";
const dmOperation = (
  name: string,
  path: string,
  output: string | null,
  input: string | null,
  parameters: readonly Record<string, unknown>[] = [],
  status: "200" | "201" = "200",
) => ({
  operationId: name,
  description: dmDescription,
  security: [{ session: [] }],
  parameters: [
    ...[...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: pathSchema(m[1]!),
    })),
    ...(input
      ? [
          {
            name: "x-author-account",
            in: "header",
            required: false,
            schema: { type: "string" },
          },
        ]
      : []),
    ...parameters,
  ],
  ...(input
    ? {
        requestBody: {
          required: true,
          content: { "application/json": { schema: reference(input) } },
        },
      }
    : {}),
  responses: {
    [status]: output ? response(output) : { description: "Committed." },
    "401": failure("A valid session is required"),
    "404": failure("Unavailable conversation"),
    "409": failure("Request identity reused with different content"),
    "422": failure(
      "Refused: dm_self, dm_recipient_unavailable, dm_blocked, dm_request_pending, dm_daily_limit, dm_rate_limited or dm_text_invalid",
    ),
    "503": failure("Service unavailable"),
  },
});
authorCommunityPaths["/v1/community/messages"] = {
  get: dmOperation(
    "listDirectConversations",
    "/v1/community/messages",
    "DirectConversationPage",
    null,
    [
      {
        name: "cursor",
        in: "query",
        schema: { type: "string", maxLength: 200 },
      },
      {
        name: "pageSize",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    ],
  ),
  post: dmOperation(
    "sendDirectMessage",
    "/v1/community/messages",
    "DirectMessage",
    "SendDirectMessageCommand",
    [],
    "201",
  ),
};
authorCommunityPaths["/v1/community/messages/unread"] = {
  get: dmOperation(
    "readDirectMessageUnread",
    "/v1/community/messages/unread",
    "DirectMessageUnread",
    null,
  ),
};
authorCommunityPaths["/v1/community/messages/with/{authorId}"] = {
  get: dmOperation(
    "findDirectConversationWith",
    "/v1/community/messages/with/{authorId}",
    null,
    null,
  ),
};
authorCommunityPaths["/v1/community/messages/{conversationId}"] = {
  get: dmOperation(
    "readDirectConversation",
    "/v1/community/messages/{conversationId}",
    "DirectMessagePage",
    null,
    [
      { name: "before", in: "query", schema: { type: "integer", minimum: 1 } },
      { name: "after", in: "query", schema: { type: "integer", minimum: 0 } },
      {
        name: "pageSize",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 50, default: 30 },
      },
    ],
  ),
};
for (const leaf of ["hide", "unhide", "mute", "unmute"] as const)
  authorCommunityPaths[`/v1/community/messages/{conversationId}/${leaf}`] = {
    post: dmOperation(
      `${leaf}DirectConversation`,
      `/v1/community/messages/{conversationId}/${leaf}`,
      "DirectConversation",
      "RequestIdentity",
    ),
  };
authorCommunityPaths["/v1/community/messages/{conversationId}/read"] = {
  post: dmOperation(
    "readDirectMessagesUpTo",
    "/v1/community/messages/{conversationId}/read",
    "DirectConversation",
    "DirectMessageReadCommand",
  ),
};

const publishingDescription =
  "Work publishing, Development only; absent in Production. Requires the session credential; responses are private, no-store with Vary: Authorization. Commands require x-author-account equal to the session account and accept no query; list reads accept only page and pageSize, and other reads accept no query. A rule rejection answers INVALID_INPUT whose message is the rule code; a stale state answers CONFLICT; a conflicting draft save answers 200 with status conflict and keeps both versions. RequestIdentity commands are replay-safe for their actor. A readiness check names the holder's current content: the Backend starts any missing edit derivative at once and answers which item keys still wait or failed, plus the thumb edit key of ready edited items; it has no other effect and is not receipted.";
const publishingFailures = {
  "401": failure("A valid session is required"),
  "404": failure(
    "Unavailable, private, deleted or not owned subject; includes a late write to a deleted draft",
  ),
  "409": failure(
    "Stale state (for example a draft already submitted or an ended session), or a request identity reused with different content",
  ),
  "422": failure(
    "Strict input validation failed or a publishing rule rejected the command; the message carries the rule code",
  ),
  "503": failure("Service or media unavailable; no success is claimed"),
};
const accountAssertion = {
  name: "x-author-account",
  in: "header",
  required: true,
  description:
    "The authenticated account; a missing or different account rejects. Does not authorize a request.",
  schema: { type: "string", pattern: "^user-[0-9a-f]{32}$" },
};
interface PublishingOperationOptions {
  readonly list?: boolean;
  readonly created?: boolean;
  /** Replaces the generic CONFLICT description. */
  readonly conflict?: string;
}
const publishingOperation = (
  name: string,
  path: string,
  output: string,
  input: string | null,
  options: PublishingOperationOptions = {},
) => {
  const base = operation(name, path, output, input, true, options.list);
  return {
    ...base,
    description: publishingDescription,
    parameters: base.parameters.map((parameter) =>
      parameter?.name === "x-author-account" ? accountAssertion : parameter,
    ),
    responses: {
      [options.created ? "201" : "200"]: response(output),
      ...publishingFailures,
      ...(options.conflict === undefined
        ? {}
        : { "409": failure(options.conflict) }),
    },
  };
};
const publishingRoutes: readonly [
  string,
  string,
  string,
  string,
  string | null,
  PublishingOperationOptions?,
][] = [
  [
    "/v1/community/publishing/limits",
    "get",
    "readPublishingLimits",
    "PublishingLimits",
    null,
  ],
  [
    "/v1/community/publishing/drafts",
    "post",
    "createPublishingDraft",
    "PublishingDraft",
    "CreatePublishingDraftCommand",
    { created: true },
  ],
  [
    "/v1/community/publishing/drafts",
    "get",
    "listPublishingDrafts",
    "PublishingDraftPage",
    null,
    { list: true },
  ],
  [
    "/v1/community/publishing/drafts/{draftId}",
    "get",
    "readPublishingDraft",
    "PublishingDraft",
    null,
  ],
  [
    "/v1/community/publishing/drafts/{draftId}",
    "delete",
    "deletePublishingDraft",
    "PublishingDraftDeletionResult",
    "PublishingDraftDeletionCommand",
    {
      conflict:
        "With expectedRevision, the draft revision differs from it or the draft has an unresolved conflict copy (message draft_changed; nothing was deleted); or the draft is no longer active, or a request identity was reused with different content",
    },
  ],
  [
    "/v1/community/publishing/drafts/{draftId}/save",
    "post",
    "savePublishingDraft",
    "PublishingDraftSaveResult",
    "SavePublishingDraftCommand",
  ],
  [
    "/v1/community/publishing/drafts/{draftId}/snapshot",
    "post",
    "savePublishingDraftNow",
    "PublishingDraftSaveResult",
    "SavePublishingDraftCommand",
  ],
  [
    "/v1/community/publishing/drafts/{draftId}/history",
    "get",
    "readPublishingDraftHistory",
    "PublishingSnapshotPage",
    null,
    { list: true },
  ],
  [
    "/v1/community/publishing/drafts/{draftId}/restore",
    "post",
    "restorePublishingSnapshot",
    "PublishingDraft",
    "RestorePublishingSnapshotCommand",
  ],
  [
    "/v1/community/publishing/drafts/{draftId}/resolve",
    "post",
    "resolvePublishingConflict",
    "PublishingDraft",
    "ResolvePublishingConflictCommand",
  ],
  [
    "/v1/community/publishing/drafts/{draftId}/readiness",
    "post",
    "checkPublishingDraftReadiness",
    "PublishingReadiness",
    "PublishingReadinessCommand",
    { conflict: "The draft is no longer active (already submitted)" },
  ],
  [
    "/v1/community/publishing/works/{workId}/draft",
    "post",
    "openWorkEditDraft",
    "PublishingOpenedEditDraft",
    "OpenWorkEditDraftCommand",
  ],
  [
    "/v1/community/publishing/works/{workId}/editable",
    "get",
    "readEditableWork",
    "EditableWork",
    null,
  ],
  [
    "/v1/community/publishing/works/{workId}/visibility",
    "post",
    "setWorkVisibility",
    "WorkVisibilityResult",
    "WorkVisibilityCommand",
  ],
  [
    "/v1/community/publishing/sessions",
    "post",
    "createPublishingSession",
    "PublishingSession",
    "CreatePublishingSessionCommand",
    { created: true },
  ],
  [
    "/v1/community/publishing/sessions/{sessionId}/heartbeat",
    "post",
    "renewPublishingSession",
    "PublishingSession",
    "PublishingSessionHeartbeatCommand",
  ],
  [
    "/v1/community/publishing/sessions/{sessionId}/discard",
    "post",
    "discardPublishingSession",
    "DiscardedResult",
    "RequestIdentity",
  ],
  [
    "/v1/community/publishing/sessions/{sessionId}/readiness",
    "post",
    "checkPublishingSessionReadiness",
    "PublishingReadiness",
    "PublishingReadinessCommand",
    { conflict: "The session has ended (discarded or submitted)" },
  ],
  [
    "/v1/community/publishing/items",
    "post",
    "registerMediaItem",
    "PublishingMediaItem",
    "RegisterMediaItemCommand",
    { created: true },
  ],
  [
    "/v1/community/publishing/items/{itemId}",
    "get",
    "readMediaItem",
    "PublishingMediaItem",
    null,
  ],
  [
    "/v1/community/publishing/items/{itemId}/cancel",
    "post",
    "cancelMediaItem",
    "PublishingMediaItem",
    "RequestIdentity",
  ],
  [
    "/v1/community/publishing/items/{itemId}/components/{role}/reset",
    "post",
    "resetMediaComponent",
    "PublishingMediaItem",
    "RequestIdentity",
  ],
  [
    "/v1/community/publishing/submissions",
    "post",
    "submitWork",
    "WorkSubmissionResult",
    "WorkSubmissionCommand",
  ],
  [
    "/v1/community/publishing/submissions/{requestId}",
    "get",
    "readWorkSubmissionReceipt",
    "WorkSubmissionReceipt",
    null,
  ],
];
// Permanently deleting an own work is a publishing command: the account
// assertion is required like on every other publishing command.
const deleteOperation = authorCommunityPaths["/v1/community/works/{workId}"]!
  .delete as { readonly parameters: readonly { readonly name?: string }[] };
authorCommunityPaths["/v1/community/works/{workId}"]!.delete = {
  ...deleteOperation,
  parameters: deleteOperation.parameters.map((parameter) =>
    parameter.name === "x-author-account" ? accountAssertion : parameter,
  ),
};
for (const [path, method, name, output, input, options] of publishingRoutes) {
  authorCommunityPaths[path] ??= {};
  authorCommunityPaths[path][method] = publishingOperation(
    name,
    path,
    output,
    input,
    options,
  );
}
authorCommunityPaths["/v1/community/publishing/uploads/{componentId}"] = {
  post: {
    ...publishingOperation(
      "uploadMediaComponent",
      "/v1/community/publishing/uploads/{componentId}",
      "PublishingUploadResult",
      null,
    ),
    description:
      "Work publishing, Development only. One registered media component as a raw byte stream behind an attempt fence: content-length is required and must equal the declared component bytes, and the server checksum is authoritative. No automatic retry: a new attempt follows an explicit component reset. A cancelled or superseded attempt answers CONFLICT and stores nothing. A refusal (including an invalid session or account assertion) may be answered while bytes are still arriving: the answer does not announce a connection close; the server reads on and discards bytes until the body ends or a few seconds passed, and only then closes the connection, so a client that keeps sending longer sees the connection close after the answer. A transfer that delivers no bytes for two minutes is closed without an answer. Private, no-store.",
    parameters: [
      {
        name: "componentId",
        in: "path",
        required: true,
        schema: pathSchema("componentId"),
      },
      accountAssertion,
      {
        name: "x-upload-attempt",
        in: "header",
        required: true,
        description:
          "UUID of this transfer attempt; a later attempt supersedes it.",
        schema: { type: "string", format: "uuid" },
      },
      {
        name: "content-length",
        in: "header",
        required: true,
        description: "Exactly the declared component bytes.",
        schema: { type: "integer", minimum: 1 },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    },
    responses: {
      "200": response("PublishingUploadResult"),
      ...publishingFailures,
      "409": failure(
        "The transfer was cancelled or superseded, or another transfer of the component is in progress; nothing was stored",
      ),
      "413": failure("More bytes than the declared component size"),
      "422": failure(
        "Missing or invalid transfer headers, a length other than the declared size, or fewer bytes than declared",
      ),
    },
  },
};
authorCommunityPaths[
  "/v1/community/publishing/media/{itemId}/{variant}/{editKey}"
] = {
  get: {
    ...operation(
      "readPublishingMedia",
      "/v1/community/publishing/media/{itemId}/{variant}/{editKey}",
      null,
      null,
      false,
    ),
    description:
      "Work publishing, Development only. One derivative of a media item for its edit key; sources and originals are never addressable. The owner reads its own items; anyone else only derivatives of an eligible public work. Supports one byte range; a Range header with another unit or several ranges is ignored and the whole derivative is sent. Accepts no query. Private, no-store with Vary: Authorization.",
    parameters: [
      ...["itemId", "variant", "editKey"].map((name) => ({
        name,
        in: "path",
        required: true,
        schema: pathSchema(name),
      })),
      {
        name: "range",
        in: "header",
        required: false,
        description:
          "One byte range: bytes=start-end, bytes=start- or bytes=-length. Other units and several ranges are ignored.",
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": {
        description: "The whole derivative; private, no-store.",
        content: {
          "image/webp": { schema: { type: "string", format: "binary" } },
          "video/mp4": { schema: { type: "string", format: "binary" } },
        },
      },
      "206": {
        description: "The requested byte range with Content-Range.",
        content: {
          "image/webp": { schema: { type: "string", format: "binary" } },
          "video/mp4": { schema: { type: "string", format: "binary" } },
        },
      },
      "401": failure("Invalid credential"),
      "404": failure("Unavailable media"),
      "416": {
        description:
          "The byte range is malformed or outside the derivative; Content-Range names its length.",
      },
      "422": failure("A query string was supplied"),
      "503": failure("Service or media unavailable"),
    },
  },
};

// messaging-notification-foundation-v1: authenticated Development activity only.
for (const [path, method, id, result, body] of [
  [
    "/v1/community/notifications",
    "get",
    "readNotifications",
    "NotificationPage",
    null,
  ],
  [
    "/v1/community/notifications/read",
    "post",
    "markObservedNotificationsRead",
    null,
    "NotificationRead",
  ],
  [
    "/v1/community/mentions",
    "get",
    "lookupMentionPeople",
    "MentionLookupPage",
    null,
  ],
] as const)
  authorCommunityPaths[path] = {
    [method]: operation(id, path, result, body, true),
  };
authorCommunityPaths["/v1/community/notifications"]!.get = {
  ...(authorCommunityPaths["/v1/community/notifications"]!.get as object),
  parameters: [
    {
      name: "filter",
      in: "query",
      schema: {
        type: "string",
        enum: ["all", "likes", "comments", "mentions"],
        default: "all",
      },
    },
    {
      name: "limit",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
    {
      name: "cursor",
      in: "query",
      schema: { type: "string", maxLength: 4096 },
      description:
        "Owner/filter-scoped signed snapshot cursor; resync when expired.",
    },
  ],
};
authorCommunityPaths["/v1/community/mentions"]!.get = {
  ...(authorCommunityPaths["/v1/community/mentions"]!.get as object),
  parameters: [
    {
      name: "q",
      in: "query",
      required: true,
      schema: { type: "string", minLength: 2, maxLength: 40 },
    },
  ],
};
authorCommunityPaths["/v1/community/notifications/stream"] = {
  get: {
    operationId: "streamNotificationRefresh",
    security: [{ session: [] }],
    description:
      "Development only; one backend process. Authenticated refresh signals, no bodies or resume IDs. Reconnect performs a bounded HTTP resync. Session is revalidated before each signal and every 15 seconds.",
    responses: {
      "200": {
        description: "Unbuffered private stream; disconnect cancels upstream.",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
      "401": failure("Valid session required"),
      "422": failure("Queries and Last-Event-ID are not accepted"),
      "503": failure("Connection bound reached"),
    },
  },
};
