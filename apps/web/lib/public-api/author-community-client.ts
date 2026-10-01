import {
  notificationPageSchema,
  mentionLookupPageSchema,
  authorProfileSchema,
  authorMediaSchema,
  authorPeoplePageSchema,
  workSchema,
  workPageSchema,
  avatarUpdateResultSchema,
  guestFavoriteMergeResultSchema,
  discussionPageSchema,
  discussionReplyPageSchema,
  ownCommentPageSchema,
  discussionSubmitResultSchema,
  discussionLocationSchema,
  savedResultSchema,
  deletedResultSchema,
  publicUserProfileSchema,
  contentCardSchema,
  discoveryPageSchema,
  contentCollectionPageSchema,
  inscriptionFilterOptionsSchema,
  contentStateSchema,
  articlePageSchema,
  articleDetailSchema,
  articleCollectionPageSchema,
  articleCollectionDetailSchema,
  threadPageSchema,
  threadSummarySchema,
  threadReadResultSchema,
  directConversationPageSchema,
  directConversationLookupSchema,
  directConversationSchema,
  directMessagePageSchema,
  directMessageSchema,
  directMessageUnreadSchema,
} from "@moya/contracts/schemas";
import type {
  ArticleListQuery,
  ContentIdentity,
  DiscoveryQuery,
  DiscussionTarget,
  MentionReference,
} from "@moya/contracts";
interface Parser<T> {
  parse: (value: unknown) => T;
}
let expectedAccount: string | null = null;
let accountEpoch = 0;
export class AuthorRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The machine reason a refused request named (for example
     * `dm_request_pending`), for features that map it to their own text.
     * It is never shown as is.
     */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}
const request = async <T>(
  path: string,
  schema: Parser<T>,
  options: {
    method?: string;
    accountScoped?: boolean;
    body?: unknown;
    signal?: AbortSignal;
    upload?: Blob;
    requestId?: string;
  } = {},
): Promise<T> => {
  const epoch = accountEpoch;
  const method = options.method ?? "GET";
  if ((method !== "GET" || options.accountScoped) && expectedAccount === null)
    throw new AuthorRequestError(401, "请先确认当前账户");
  const identityHeaders =
    method === "GET" && !options.accountScoped
      ? {}
      : { "x-author-account": expectedAccount! };
  const response = await fetch(`/api/community/${path}`, {
    method: options.method ?? "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    headers: options.upload
      ? {
          ...identityHeaders,
          "content-type": "image/png",
          "x-request-id": options.requestId ?? "",
        }
      : options.body === undefined
        ? { ...identityHeaders, accept: "application/json" }
        : { ...identityHeaders, "content-type": "application/json" },
    ...(options.upload
      ? { body: options.upload }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    let message =
      response.status === 401
        ? "请先登录"
        : response.status === 404
          ? "内容不可用或此列表未公开"
          : response.status === 409
            ? "状态已变化，请检查后重试"
            : "暂时无法完成，请重试";
    let reason: string | null = null;
    try {
      const value = await response.json();
      if (response.status === 409 && typeof value?.error?.message === "string")
        message = value.error.message;
      if (
        response.status === 422 &&
        typeof value?.error?.message === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/u.test(value.error.message)
      )
        reason = value.error.message;
    } catch {
      /* Preserve the transport failure. */
    }
    throw new AuthorRequestError(response.status, message, reason);
  }
  const result = schema.parse(await response.json());
  if (epoch !== accountEpoch)
    throw new AuthorRequestError(401, "账户状态已变化，请重试读取");
  return result;
};
const targetPath = (t: DiscussionTarget) =>
  `${t.type}/${encodeURIComponent(t.id)}`;
const query = (q: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(q)
      .filter(
        (entry): entry is [string, string | number] => entry[1] !== undefined,
      )
      .map(([k, v]) => [k, String(v)]),
  ).toString();
export const authorClient = {
  setAccount: (id: string | null) => {
    if (expectedAccount !== id) accountEpoch++;
    expectedAccount = id;
  },
  account: () => expectedAccount,
  /** Increases on every account change, so a late answer from an earlier account (even A→B→A) is detectable. */
  accountEpoch: () => accountEpoch,
  notifications: (
    filter: "all" | "likes" | "comments" | "mentions" = "all",
    cursor?: string,
    signal?: AbortSignal,
  ) =>
    request(
      `notifications?${query({ filter, cursor, limit: 20 })}`,
      notificationPageSchema,
      { accountScoped: true, ...(signal ? { signal } : {}) },
    ),
  readNotifications: (observation: string) =>
    request(
      "notifications/read",
      {
        parse: (value: unknown) => {
          if (
            !value ||
            typeof value !== "object" ||
            !("read" in value) ||
            value.read !== true
          )
            throw Error("Invalid read response");
          return true;
        },
      },
      { method: "POST", body: { observation } },
    ),
  mentionPeople: (q: string, signal?: AbortSignal) =>
    request(`mentions?${query({ q })}`, mentionLookupPageSchema, {
      ...(signal ? { signal } : {}),
    }),
  me: (signal?: AbortSignal) =>
    request("me", publicUserProfileSchema, { ...(signal ? { signal } : {}) }),
  profile: (id: string, signal?: AbortSignal) =>
    request(`authors/${encodeURIComponent(id)}`, authorProfileSchema, {
      ...(signal ? { signal } : {}),
    }),
  people: (id: string, list: "following" | "followers" | "blocks", page = 1) =>
    request(
      `${list === "blocks" ? "me" : `authors/${encodeURIComponent(id)}`}/${list}?page=${page}&pageSize=20`,
      authorPeoplePageSchema,
    ),
  works: (id: string, page = 1) =>
    request(
      `authors/${encodeURIComponent(id)}/works?page=${page}&pageSize=12`,
      workPageSchema,
    ),
  work: (id: string, signal?: AbortSignal) =>
    request(`works/${encodeURIComponent(id)}`, workSchema, {
      ...(signal ? { signal } : {}),
    }),
  command: (path: string, body: unknown, method = "POST") =>
    request<unknown>(
      path,
      method === "DELETE" ? deletedResultSchema : savedResultSchema,
      { method, body },
    ),
  upload: (blob: Blob, requestId: string) =>
    request("media", authorMediaSchema, {
      method: "POST",
      upload: blob,
      requestId,
    }),
  avatar: (body: unknown) =>
    request("me/avatar", avatarUpdateResultSchema, { method: "POST", body }),
  background: async (body: unknown): Promise<void> => {
    await request("me/background", savedResultSchema, { method: "POST", body });
  },
  merge: (body: unknown) =>
    request("favorites/merge", guestFavoriteMergeResultSchema, {
      method: "POST",
      body,
    }),
  discovery: (q: DiscoveryQuery, signal?: AbortSignal) =>
    request(
      `discover?${query({ kind: q.kind, pageSize: q.pageSize, filters: JSON.stringify(q.filters), sequence: q.sequence, after: q.after, search: q.search })}`,
      discoveryPageSchema,
      { ...(signal ? { signal } : {}) },
    ),
  filters: () => request("filter-options", inscriptionFilterOptionsSchema),
  collection: (
    id: string,
    list: "favorites" | "likes",
    page: number,
    search = "",
    kind = "all",
  ) =>
    request(
      `authors/${id}/${list}?${query({ page, pageSize: 12, search, kind })}`,
      contentCollectionPageSchema,
    ),
  card: (target: ContentIdentity) =>
    request(`content/${targetPath(target)}/card`, contentCardSchema),
  state: (target: ContentIdentity) =>
    request(`content/${targetPath(target)}/state`, contentStateSchema),
  // content-community-completion-v1: direct messages (session required).
  messages: {
    list: (cursor?: string, signal?: AbortSignal) =>
      request(
        `messages?${query({ cursor, pageSize: 20 })}`,
        directConversationPageSchema,
        { ...(signal ? { signal } : {}) },
      ),
    unread: (signal?: AbortSignal) =>
      request("messages/unread", directMessageUnreadSchema, {
        ...(signal ? { signal } : {}),
      }),
    with: (userId: string, signal?: AbortSignal) =>
      request(
        `messages/with/${encodeURIComponent(userId)}`,
        directConversationLookupSchema,
        { ...(signal ? { signal } : {}) },
      ),
    history: (
      id: string,
      q: { before?: number; after?: number; pageSize?: number } = {},
      signal?: AbortSignal,
    ) =>
      request(
        `messages/${encodeURIComponent(id)}?${query({ pageSize: 30, ...q })}`,
        directMessagePageSchema,
        { ...(signal ? { signal } : {}) },
      ),
    send: (
      body:
        | { requestId: string; recipientId: string; text: string }
        | { requestId: string; conversationId: string; text: string },
    ) => request("messages", directMessageSchema, { method: "POST", body }),
    participant: (
      id: string,
      action: "hide" | "unhide" | "mute" | "unmute",
      requestId: string,
    ) =>
      request(
        `messages/${encodeURIComponent(id)}/${action}`,
        directConversationSchema,
        { method: "POST", body: { requestId } },
      ),
    read: (id: string, sequence: number, requestId: string) =>
      request(
        `messages/${encodeURIComponent(id)}/read`,
        directConversationSchema,
        { method: "POST", body: { requestId, sequence } },
      ),
  },
  // content-community-completion-v1: Threads over Works.
  threads: {
    list: (
      q: { page?: number; pageSize?: number; anchor?: string } = {},
      signal?: AbortSignal,
    ) =>
      request(`threads?${query(q)}`, threadPageSchema, {
        ...(signal ? { signal } : {}),
      }),
    read: (id: string, signal?: AbortSignal) =>
      request(`threads/${encodeURIComponent(id)}`, threadSummarySchema, {
        ...(signal ? { signal } : {}),
      }),
    posts: (id: string, page: number, signal?: AbortSignal) =>
      request(
        `threads/${encodeURIComponent(id)}/posts?${query({ page, pageSize: 20 })}`,
        workPageSchema,
        { ...(signal ? { signal } : {}) },
      ),
    markRead: (id: string) =>
      request(
        `threads/${encodeURIComponent(id)}/read`,
        threadReadResultSchema,
        {
          method: "POST",
          body: {},
        },
      ),
  },
  // content-community-completion-v1: anonymous published editorial reads.
  editorial: {
    articles: (q: Partial<ArticleListQuery> = {}, signal?: AbortSignal) =>
      request(`editorial/articles?${query(q)}`, articlePageSchema, {
        ...(signal ? { signal } : {}),
      }),
    article: (id: string, signal?: AbortSignal) =>
      request(
        `editorial/articles/${encodeURIComponent(id)}`,
        articleDetailSchema,
        { ...(signal ? { signal } : {}) },
      ),
    collections: (
      q: { page?: number; pageSize?: number } = {},
      signal?: AbortSignal,
    ) =>
      request(
        `editorial/collections?${query(q)}`,
        articleCollectionPageSchema,
        {
          ...(signal ? { signal } : {}),
        },
      ),
    collection: (id: string, signal?: AbortSignal) =>
      request(
        `editorial/collections/${encodeURIComponent(id)}`,
        articleCollectionDetailSchema,
        { ...(signal ? { signal } : {}) },
      ),
  },
  discussion: (
    target: DiscussionTarget,
    page: number,
    pinned?: readonly string[],
    signal?: AbortSignal,
  ) =>
    request(
      `discussion/${targetPath(target)}?${query({ page, pageSize: 10, pinned: pinned?.join(",") })}`,
      discussionPageSchema,
      { ...(signal ? { signal } : {}) },
    ),
  replies: (target: DiscussionTarget, root: string, page: number) =>
    request(
      `discussion/${targetPath(target)}/replies/${root}?page=${page}&pageSize=10`,
      discussionReplyPageSchema,
    ),
  send: (
    target: DiscussionTarget,
    text: string,
    root?: string,
    replyTo?: string,
    mentions: readonly MentionReference[] = [],
  ) =>
    request(
      `discussion/${targetPath(target)}${root ? `/replies/${root}` : ""}`,
      discussionSubmitResultSchema,
      {
        method: "POST",
        body: { text, mentions, ...(replyTo ? { replyTo } : {}) },
      },
    ),
  locate: (target: DiscussionTarget, id: string, pinned: readonly string[]) =>
    request(
      `discussion/${targetPath(target)}/locate/${id}?${query({ page: 1, pageSize: 10, pinned: pinned.join(",") })}`,
      discussionLocationSchema,
    ),
  comments: (page = 1) =>
    request(`me/comments?page=${page}&pageSize=20`, ownCommentPageSchema),
};
