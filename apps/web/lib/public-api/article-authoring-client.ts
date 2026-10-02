import {
  articleAuthoringArticleIdSchema,
  articleCandidateCommandSchema,
  articleDraftListQuerySchema,
  articleDraftPageSchema,
  articleOwnMediaListQuerySchema,
  articleOwnMediaPageSchema,
  articleDraftSchema,
  articleDocumentSchema,
  articleSafeLinkSchema,
  extractArticleText,
  articleCodePointLength,
  ARTICLE_DOCUMENT_LIMITS,
  articlePreviewSchema,
  articlePublishResultSchema,
  articleValidationResultSchema,
  createArticleDraftCommandSchema,
  updateArticleDraftCommandSchema,
  deleteArticleDraftCommandSchema,
  articleDraftDeletionResultSchema,
  catalogIdSchema,
  emptyArticleDocument,
} from "@moya/contracts/schemas";
import type {
  ArticleCandidateCommand,
  ArticleOwnMediaListQuery,
  ArticleDraft,
  ArticleDraftListQuery,
  ArticleDocument,
  CreateArticleDraftCommand,
  UpdateArticleDraftCommand,
  DeleteArticleDraftCommand,
} from "@moya/contracts";
import { authorClient } from "./author-community-client";

export class ArticleRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    readonly outcomeUnknown: boolean,
  ) {
    super("article_request_failed");
  }
}
interface Parser<Value> {
  parse(value: unknown): Value;
}
const request = async <Value>(
  path: string,
  parser: Parser<Value>,
  options: {
    readonly method?: "GET" | "POST" | "PUT" | "DELETE";
    readonly body?: unknown;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<Value> => {
  const account = authorClient.account();
  const epoch = authorClient.accountEpoch();
  if (account === null) throw new ArticleRequestError(401, null, false);
  const write = options.body !== undefined;
  let response: Response;
  try {
    response = await fetch(`/api/community/article-authoring${path}`, {
      method: options.method ?? (write ? "POST" : "GET"),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      headers: {
        "x-author-account": account,
        accept: "application/json",
        ...(write ? { "content-type": "application/json" } : {}),
      },
      ...(write ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ArticleRequestError(0, null, write);
  }
  if (
    authorClient.accountEpoch() !== epoch ||
    authorClient.account() !== account
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ArticleRequestError(401, "article_account_changed", write);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ArticleRequestError(
      response.status,
      null,
      write && (response.ok || response.status >= 500),
    );
  }
  if (!response.ok) {
    const reason =
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "object" &&
      value.error !== null &&
      "code" in value.error &&
      typeof value.error.code === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/u.test(value.error.code)
        ? value.error.code
        : null;
    throw new ArticleRequestError(
      response.status,
      reason,
      write && response.status >= 500,
    );
  }
  try {
    const parsed = parser.parse(value);
    if (
      authorClient.accountEpoch() !== epoch ||
      authorClient.account() !== account
    )
      throw new ArticleRequestError(401, "article_account_changed", write);
    return parsed;
  } catch (error) {
    if (error instanceof ArticleRequestError) throw error;
    // A malformed success may represent a committed write. Retry its identity.
    throw new ArticleRequestError(502, "article_invalid_response", write);
  }
};
const segment = (id: string) =>
  encodeURIComponent(articleAuthoringArticleIdSchema.parse(id));
export const articleAuthoringClient = {
  ownMedia: (
    query: ArticleOwnMediaListQuery = { pageSize: 20 },
    signal?: AbortSignal,
  ) => {
    const parsed = articleOwnMediaListQuerySchema.parse(query);
    const search = new URLSearchParams({ pageSize: String(parsed.pageSize) });
    if (parsed.cursor) search.set("cursor", parsed.cursor);
    return request(`/media?${search}`, articleOwnMediaPageSchema, { signal });
  },
  list: (
    query: ArticleDraftListQuery = { pageSize: 20 },
    signal?: AbortSignal,
  ) => {
    const parsed = articleDraftListQuerySchema.parse(query);
    const search = new URLSearchParams({ pageSize: String(parsed.pageSize) });
    if (parsed.cursor !== undefined) search.set("cursor", parsed.cursor);
    return request(`?${search}`, articleDraftPageSchema, { signal });
  },
  create: (command: CreateArticleDraftCommand, signal?: AbortSignal) =>
    request("", articleDraftSchema, {
      body: parseArticleCreateCommand(command),
      signal,
    }),
  read: (id: ArticleDraft["id"], signal?: AbortSignal) =>
    request(`/${segment(id)}`, articleDraftSchema, { signal }),
  save: (
    id: ArticleDraft["id"],
    command: UpdateArticleDraftCommand,
    signal?: AbortSignal,
  ) =>
    request(`/${segment(id)}`, articleDraftSchema, {
      method: "PUT",
      body: updateArticleDraftCommandSchema.parse(command),
      signal,
    }),
  deleteDraft: (
    id: ArticleDraft["id"],
    command: DeleteArticleDraftCommand,
    signal?: AbortSignal,
  ) =>
    request(`/${segment(id)}`, articleDraftDeletionResultSchema, {
      method: "DELETE",
      body: deleteArticleDraftCommandSchema.parse(command),
      signal,
    }),
  validate: (
    id: ArticleDraft["id"],
    candidate: ArticleCandidateCommand,
    signal?: AbortSignal,
  ) =>
    request(`/${segment(id)}/validate`, articleValidationResultSchema, {
      body: articleCandidateCommandSchema.parse(candidate),
      signal,
    }),
  preview: (
    id: ArticleDraft["id"],
    candidate: ArticleCandidateCommand,
    signal?: AbortSignal,
  ) =>
    request(`/${segment(id)}/preview`, articlePreviewSchema, {
      body: articleCandidateCommandSchema.parse(candidate),
      signal,
    }),
  publish: (
    id: ArticleDraft["id"],
    candidate: ArticleCandidateCommand,
    signal?: AbortSignal,
  ) =>
    request(`/${segment(id)}/publish`, articlePublishResultSchema, {
      body: articleCandidateCommandSchema.parse(candidate),
      signal,
    }),
};

// Browser feature modules use this thin public transport boundary. All runtime
// contract parsing stays here, following the existing repository architecture.
export const articleAuthoringLimits = ARTICLE_DOCUMENT_LIMITS;
export const createEmptyArticleDocument = emptyArticleDocument;
export const parseArticleCreateCommand = (command: CreateArticleDraftCommand) =>
  createArticleDraftCommandSchema.parse(command);
export const articleTextLength = articleCodePointLength;
export const articleDocumentPlainText = extractArticleText;
export const isArticleSafeLink = (href: string): boolean =>
  articleSafeLinkSchema.safeParse(href).success;
const blockNoteNoContentTypes = new Set([
  "divider",
  "managedImage",
  "imageGallery",
  "catalogReference",
]);
// BlockNote's content:none blocks expose content:undefined in memory. Remove
// only that non-JSON property; defined content and unknown properties still fail
// canonical validation. This runs at save capture, never on selection changes.
const canonicalEditorBlocks = (blocks: unknown, depth = 1): unknown => {
  if (!Array.isArray(blocks) || blocks.length > articleAuthoringLimits.blocks)
    return blocks;
  return blocks.map((value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    const block = { ...(value as Record<string, unknown>) };
    if (
      typeof block.type === "string" &&
      blockNoteNoContentTypes.has(block.type) &&
      Object.hasOwn(block, "content") &&
      block.content === undefined
    )
      delete block.content;
    if (depth < articleAuthoringLimits.depth && Array.isArray(block.children))
      block.children = canonicalEditorBlocks(block.children, depth + 1);
    return block;
  });
};
export const parseArticleEditorDocument = (
  blocks: unknown,
  attachments: Pick<ArticleDocument, "references" | "galleries">,
): ArticleDocument =>
  articleDocumentSchema.parse({
    format: "blocknote",
    version: 1,
    blocks: canonicalEditorBlocks(blocks),
    references: attachments.references,
    galleries: attachments.galleries,
  });
export const parseArticleCatalogIdentity = (value: string) => {
  const result = catalogIdSchema.safeParse(value);
  return result.success ? result.data : null;
};
