import {
  catalogCommentPageSchema,
  catalogCommentReplyPageSchema,
  catalogCommentReplySchema,
  catalogCommentListingTransportQuerySchema,
  catalogCommentSchema,
  catalogCommentTransportQuerySchema,
  createCatalogCommentReplyRequestSchema,
  createCatalogCommentRequestSchema,
} from "@moya/contracts/schemas";

import type {
  CatalogComment,
  CatalogCommentPage,
  CatalogCommentReply,
  CatalogCommentListingTransportQuery,
  CatalogCommentReplyPage,
  CatalogCommentTransportQuery,
} from "@moya/contracts";

export interface CatalogCommentTransportContext {
  readonly baseUrl: URL;
  readonly fetch: typeof globalThis.fetch;
}

export type CommentPageTransportResult =
  | { readonly state: "success"; readonly page: CatalogCommentPage }
  | {
      readonly state:
        "invalid-query" | "not-found" | "unavailable" | "unexpected-error";
    };

export type CommentReplyPageTransportResult =
  | { readonly state: "success"; readonly page: CatalogCommentReplyPage }
  | {
      readonly state:
        "invalid-query" | "not-found" | "unavailable" | "unexpected-error";
    };

/** `awaitingApproval` mirrors the Backend's 202: the item is not visible yet. */
export type CommentSubmissionTransportResult<Item> =
  | {
      readonly state: "success";
      readonly item: Item;
      readonly awaitingApproval: boolean;
    }
  | {
      readonly state:
        | "invalid-input"
        | "unauthenticated"
        | "not-found"
        | "unavailable"
        | "unexpected-error";
    };

export const parseCatalogCommentQuery = (
  candidate: unknown,
): CatalogCommentTransportQuery | null => {
  const parsed = catalogCommentTransportQuerySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

/** The root listing query: the page query plus the pinned hot ids. */
export const parseCatalogCommentListingQuery = (
  candidate: unknown,
): CatalogCommentListingTransportQuery | null => {
  const parsed = catalogCommentListingTransportQuerySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

const withQuery = (
  url: URL,
  query: CatalogCommentListingTransportQuery,
): URL => {
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url;
};

const readInit = (signal?: AbortSignal, token?: string): RequestInit => ({
  method: "GET",
  cache: "no-store",
  redirect: "error",
  headers: {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  ...(signal === undefined ? {} : { signal }),
});

/**
 * account-switching-v1: `account` is the confirmed account the browser wrote
 * for; the Backend refuses the write when the session now belongs to another.
 */
const writeInit = (
  token: string,
  body: string,
  account?: string,
): RequestInit => ({
  method: "POST",
  cache: "no-store",
  redirect: "error",
  signal: AbortSignal.timeout(15_000),
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(account === undefined ? {} : { "x-author-account": account }),
  },
  body,
});

const commentsUrl = (baseUrl: URL, catalogId: string): URL =>
  new URL(`v1/catalog/${encodeURIComponent(catalogId)}/comments`, baseUrl);

const repliesUrl = (baseUrl: URL, catalogId: string, commentId: string): URL =>
  new URL(
    `v1/catalog/${encodeURIComponent(catalogId)}/comments/${encodeURIComponent(
      commentId,
    )}/replies`,
    baseUrl,
  );

const readPage = async <Page>(
  context: CatalogCommentTransportContext,
  url: URL,
  query: CatalogCommentListingTransportQuery,
  parse: (candidate: unknown) => Page | null,
  signal?: AbortSignal,
  token?: string,
): Promise<
  | { state: "success"; page: Page }
  | {
      state: "invalid-query" | "not-found" | "unavailable" | "unexpected-error";
    }
> => {
  try {
    const response = await context.fetch(
      withQuery(url, query).toString(),
      readInit(signal, token),
    );
    if (response.status === 400) return { state: "invalid-query" };
    if (response.status === 404) return { state: "not-found" };
    if (response.status === 503) return { state: "unavailable" };
    if (response.status !== 200) return { state: "unexpected-error" };
    const page = parse(await response.json());
    return page === null
      ? { state: "unexpected-error" }
      : { state: "success", page };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { state: "unexpected-error" };
  }
};

const submit = async <Item>(
  context: CatalogCommentTransportContext,
  url: URL,
  token: string,
  body: unknown,
  parse: (candidate: unknown) => Item | null,
  account?: string,
): Promise<CommentSubmissionTransportResult<Item>> => {
  try {
    const response = await context.fetch(
      url.toString(),
      writeInit(token, JSON.stringify(body), account),
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
      : { state: "success", item, awaitingApproval: response.status === 202 };
  } catch {
    return { state: "unexpected-error" };
  }
};

const parseWith =
  <Item>(schema: {
    safeParse: (candidate: unknown) => { success: boolean; data?: unknown };
  }) =>
  (candidate: unknown): Item | null => {
    const parsed = schema.safeParse(candidate);
    return parsed.success ? (parsed.data as Item) : null;
  };

export const fetchCatalogCommentPage = async (
  context: CatalogCommentTransportContext,
  catalogId: string,
  query: CatalogCommentListingTransportQuery = {},
  signal?: AbortSignal,
  token?: string,
): Promise<CommentPageTransportResult> =>
  readPage(
    context,
    commentsUrl(context.baseUrl, catalogId),
    query,
    parseWith<CatalogCommentPage>(catalogCommentPageSchema),
    signal,
    token,
  );

export const fetchCatalogCommentReplyPage = async (
  context: CatalogCommentTransportContext,
  catalogId: string,
  commentId: string,
  query: CatalogCommentTransportQuery = {},
  signal?: AbortSignal,
  token?: string,
): Promise<CommentReplyPageTransportResult> =>
  readPage(
    context,
    repliesUrl(context.baseUrl, catalogId, commentId),
    query,
    parseWith<CatalogCommentReplyPage>(catalogCommentReplyPageSchema),
    signal,
    token,
  );

export const createCatalogComment = async (
  context: CatalogCommentTransportContext,
  catalogId: string,
  token: string,
  body: unknown,
  account?: string,
): Promise<CommentSubmissionTransportResult<CatalogComment>> => {
  const request = createCatalogCommentRequestSchema.safeParse(body);
  if (!request.success) return { state: "invalid-input" };
  return submit(
    context,
    commentsUrl(context.baseUrl, catalogId),
    token,
    request.data,
    parseWith<CatalogComment>(catalogCommentSchema),
    account,
  );
};

export const createCatalogCommentReply = async (
  context: CatalogCommentTransportContext,
  catalogId: string,
  commentId: string,
  token: string,
  body: unknown,
  account?: string,
): Promise<CommentSubmissionTransportResult<CatalogCommentReply>> => {
  const request = createCatalogCommentReplyRequestSchema.safeParse(body);
  if (!request.success) return { state: "invalid-input" };
  return submit(
    context,
    repliesUrl(context.baseUrl, catalogId, commentId),
    token,
    request.data,
    parseWith<CatalogCommentReply>(catalogCommentReplySchema),
    account,
  );
};
