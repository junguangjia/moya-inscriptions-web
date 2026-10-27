import {
  catalogCommentIdSchema,
  catalogCommentPageSchema,
  catalogCommentReplyPageSchema,
  catalogCommentReplySchema,
  catalogCommentSchema,
  catalogIdSchema,
  publicUserProfileSchema,
} from "@moya/contracts/schemas";

import type {
  CommentPageTransportResult,
  CommentReplyPageTransportResult,
  CommentSubmissionTransportResult,
} from "./catalog-comments";
import type { CurrentUserTransportResult } from "./community-session";
import type { CatalogComment, CatalogCommentReply } from "@moya/contracts";

/**
 * Browser-side transport for the same-origin comment bridges. It never talks
 * to the Backend directly and never sees the session credential: the HttpOnly
 * cookie travels with `credentials: "same-origin"` and the route handler
 * relays it. Every response is re-validated against the Public Contract.
 */
export interface CatalogCommentClientContext {
  readonly baseUrl: URL;
  readonly fetch: typeof globalThis.fetch;
}

const defaultContext = (): CatalogCommentClientContext => ({
  baseUrl: new URL(globalThis.location.href),
  fetch: globalThis.fetch,
});

/** The root listing query; `pinned` carries the hot ids a sequence holds. */
export interface CommentListingClientQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly pinned?: readonly string[];
}

export interface CommentReplyPageClientQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

const readInit = (signal?: AbortSignal): RequestInit => ({
  credentials: "same-origin",
  headers: { Accept: "application/json" },
  method: "GET",
  ...(signal === undefined ? {} : { signal }),
});

/**
 * account-switching-v1: the account each transport (the page's `fetch`) last
 * confirmed through `fetchSameOriginCurrentUser`. A comment or reply names it,
 * so one written before another tab switched accounts is refused rather than
 * posted as the account that is current now.
 */
const confirmedAccounts = new WeakMap<typeof globalThis.fetch, string>();

const writeInit = (
  body: unknown,
  account: string | undefined,
): RequestInit => ({
  body: JSON.stringify(body),
  credentials: "same-origin",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(account === undefined ? {} : { "x-author-account": account }),
  },
  method: "POST",
});

const commentsUrl = (
  baseUrl: URL,
  catalogId: string,
  query: CommentListingClientQuery,
): URL => {
  const url = new URL(
    `/api/catalog/${encodeURIComponent(catalogId)}/comments`,
    baseUrl,
  );
  if (query.page !== undefined)
    url.searchParams.set("page", String(query.page));
  if (query.pageSize !== undefined)
    url.searchParams.set("pageSize", String(query.pageSize));
  if (query.pinned !== undefined && query.pinned.length > 0)
    url.searchParams.set("pinned", query.pinned.join(","));
  return url;
};

const repliesUrl = (
  baseUrl: URL,
  catalogId: string,
  commentId: string,
  query: CommentReplyPageClientQuery,
): URL => {
  const url = new URL(
    `/api/catalog/${encodeURIComponent(catalogId)}/comments/${encodeURIComponent(
      commentId,
    )}/replies`,
    baseUrl,
  );
  if (query.page !== undefined)
    url.searchParams.set("page", String(query.page));
  if (query.pageSize !== undefined)
    url.searchParams.set("pageSize", String(query.pageSize));
  return url;
};

const readPage = async <Page>(
  context: CatalogCommentClientContext,
  url: URL,
  parse: (candidate: unknown) => Page | null,
  signal?: AbortSignal,
): Promise<
  | { readonly state: "success"; readonly page: Page }
  | {
      readonly state:
        "invalid-query" | "not-found" | "unavailable" | "unexpected-error";
    }
> => {
  try {
    const response = await context.fetch.call(
      globalThis,
      url,
      readInit(signal),
    );
    if (response.status === 400) return { state: "invalid-query" };
    if (response.status === 404) return { state: "not-found" };
    if (response.status === 503) return { state: "unavailable" };
    if (response.status !== 200) return { state: "unexpected-error" };
    const page = parse(await response.json());
    return page === null
      ? { state: "unexpected-error" }
      : { page, state: "success" };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { state: "unexpected-error" };
  }
};

const submit = async <Item>(
  context: CatalogCommentClientContext,
  url: URL,
  body: unknown,
  parse: (candidate: unknown) => Item | null,
): Promise<CommentSubmissionTransportResult<Item>> => {
  try {
    const response = await context.fetch.call(
      globalThis,
      url,
      writeInit(body, confirmedAccounts.get(context.fetch)),
    );
    if (response.status === 401) return { state: "unauthenticated" };
    if (response.status === 404) return { state: "not-found" };
    if (response.status === 422 || response.status === 400)
      return { state: "invalid-input" };
    if (response.status === 503) return { state: "unavailable" };
    if (response.status !== 201 && response.status !== 202)
      return { state: "unexpected-error" };
    const item = parse(await response.json());
    return item === null
      ? { state: "unexpected-error" }
      : { awaitingApproval: response.status === 202, item, state: "success" };
  } catch {
    return { state: "unexpected-error" };
  }
};

const parseWith =
  <Value>(schema: { safeParse: (candidate: unknown) => unknown }) =>
  (candidate: unknown): Value | null => {
    const parsed = schema.safeParse(candidate) as
      { success: true; data: Value } | { success: false };
    return parsed.success ? parsed.data : null;
  };

export const fetchSameOriginCatalogCommentPage = async (
  catalogId: string,
  query: CommentListingClientQuery = {},
  signal?: AbortSignal,
  context: CatalogCommentClientContext = defaultContext(),
): Promise<CommentPageTransportResult> => {
  const parsedId = catalogIdSchema.safeParse(catalogId);
  if (!parsedId.success) return { state: "not-found" };
  return readPage(
    context,
    commentsUrl(context.baseUrl, parsedId.data, query),
    parseWith(catalogCommentPageSchema),
    signal,
  );
};

export const fetchSameOriginCatalogCommentReplyPage = async (
  catalogId: string,
  commentId: string,
  query: CommentReplyPageClientQuery = {},
  signal?: AbortSignal,
  context: CatalogCommentClientContext = defaultContext(),
): Promise<CommentReplyPageTransportResult> => {
  const parsedId = catalogIdSchema.safeParse(catalogId);
  const parsedCommentId = catalogCommentIdSchema.safeParse(commentId);
  if (!parsedId.success || !parsedCommentId.success)
    return { state: "not-found" };
  return readPage(
    context,
    repliesUrl(context.baseUrl, parsedId.data, parsedCommentId.data, query),
    parseWith(catalogCommentReplyPageSchema),
    signal,
  );
};

export const createSameOriginCatalogComment = async (
  catalogId: string,
  body: { readonly text: string },
  context: CatalogCommentClientContext = defaultContext(),
): Promise<CommentSubmissionTransportResult<CatalogComment>> => {
  const parsedId = catalogIdSchema.safeParse(catalogId);
  if (!parsedId.success) return { state: "not-found" };
  return submit(
    context,
    commentsUrl(context.baseUrl, parsedId.data, {}),
    body,
    parseWith(catalogCommentSchema),
  );
};

export const createSameOriginCatalogCommentReply = async (
  catalogId: string,
  commentId: string,
  body: { readonly text: string; readonly replyTo?: string },
  context: CatalogCommentClientContext = defaultContext(),
): Promise<CommentSubmissionTransportResult<CatalogCommentReply>> => {
  const parsedId = catalogIdSchema.safeParse(catalogId);
  const parsedCommentId = catalogCommentIdSchema.safeParse(commentId);
  if (!parsedId.success || !parsedCommentId.success)
    return { state: "not-found" };
  return submit(
    context,
    repliesUrl(context.baseUrl, parsedId.data, parsedCommentId.data, {}),
    body,
    parseWith(catalogCommentReplySchema),
  );
};

/** Who the HttpOnly session cookie identifies; 401 is the signed-out state. */
export const fetchSameOriginCurrentUser = async (
  signal?: AbortSignal,
  context: CatalogCommentClientContext = defaultContext(),
): Promise<CurrentUserTransportResult> => {
  try {
    const response = await context.fetch.call(
      globalThis,
      new URL("/api/community/me", context.baseUrl),
      readInit(signal),
    );
    if (response.status === 401) {
      confirmedAccounts.delete(context.fetch);
      return { state: "unauthenticated" };
    }
    if (response.status === 503) return { state: "unavailable" };
    if (response.status !== 200) return { state: "unexpected-error" };
    const profile = publicUserProfileSchema.safeParse(await response.json());
    if (!profile.success) return { state: "unexpected-error" };
    confirmedAccounts.set(context.fetch, profile.data.id);
    return { profile: profile.data, state: "success" };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { state: "unexpected-error" };
  }
};
