import {
  createSameOriginCatalogComment,
  createSameOriginCatalogCommentReply,
  fetchSameOriginCatalogCommentPage,
  fetchSameOriginCatalogCommentReplyPage,
  fetchSameOriginCurrentUser,
} from "../../lib/public-api/catalog-comments-client";

import type {
  CatalogCommentClientContext,
  CommentListingClientQuery,
  CommentReplyPageClientQuery,
} from "../../lib/public-api/catalog-comments-client";
import type {
  CommentPageTransportResult,
  CommentReplyPageTransportResult,
  CommentSubmissionTransportResult,
} from "../../lib/public-api/catalog-comments";
import type { CurrentUserTransportResult } from "../../lib/public-api/community-session";
import type {
  CatalogComment,
  CatalogCommentReply,
  CommentAuthor,
  PublicUserProfile,
} from "@moya/contracts";
import type {
  CommentItem,
  CommentReply,
  CommentUserPresentation,
} from "./comment-types";

/**
 * The one-way mapper from the Comment V1 DTOs to the accepted #106
 * presentation types, kept beside the loader (amendment section 6).
 * Presentation types never feed persistence, Contracts or the API. The Contract
 * carries no likes, so the like fields stay at their zero values and the live
 * composition hides that control.
 */

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** Relative for the first week, then the plain UTC date; never a fake time. */
export const formatCommentTimeLabel = (
  createdAt: string,
  now: Date,
): string => {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return createdAt;
  const elapsed = now.getTime() - created;
  if (elapsed < minute) return "刚刚";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} 分钟前`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} 小时前`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)} 天前`;
  return createdAt.slice(0, 10);
};

export const toCommentUserPresentation = (
  author: CommentAuthor | PublicUserProfile,
): CommentUserPresentation => ({
  avatarSrc: null,
  id: author.id,
  name: author.displayName,
  studioName: author.studioName,
});

export const toCommentReplyPresentation = (
  reply: CatalogCommentReply,
  now: Date,
): CommentReply => ({
  createdAtLabel: formatCommentTimeLabel(reply.createdAt, now),
  id: reply.id,
  likeCount: 0,
  liked: false,
  ...(reply.replyTo === undefined
    ? {}
    : { replyToUser: toCommentUserPresentation(reply.replyTo) }),
  text: reply.text,
  user: toCommentUserPresentation(reply.author),
});

export const toCommentItemPresentation = (
  comment: CatalogComment,
  now: Date,
): CommentItem => ({
  createdAtLabel: formatCommentTimeLabel(comment.createdAt, now),
  id: comment.id,
  isQaGenerated: false,
  likeCount: 0,
  liked: false,
  replies: comment.replies.map((reply) =>
    toCommentReplyPresentation(reply, now),
  ),
  replyTotal: comment.replyTotal,
  text: comment.text,
  user: toCommentUserPresentation(comment.author),
});

/**
 * The transport functions the live hook calls. They are plain functions so a
 * Client Component never references the Web Public API boundary itself; tests
 * pass an explicit context.
 */
export interface LiveCommentSource {
  readonly readListing: (
    catalogId: string,
    query: CommentListingClientQuery,
    signal?: AbortSignal,
  ) => Promise<CommentPageTransportResult>;
  readonly readReplies: (
    catalogId: string,
    commentId: string,
    query: CommentReplyPageClientQuery,
    signal?: AbortSignal,
  ) => Promise<CommentReplyPageTransportResult>;
  readonly submitComment: (
    catalogId: string,
    text: string,
  ) => Promise<CommentSubmissionTransportResult<CatalogComment>>;
  readonly submitReply: (
    catalogId: string,
    commentId: string,
    text: string,
    replyTo?: string,
  ) => Promise<CommentSubmissionTransportResult<CatalogCommentReply>>;
  readonly readViewer: (
    signal?: AbortSignal,
  ) => Promise<CurrentUserTransportResult>;
}

export const createLiveCommentSource = (
  context?: CatalogCommentClientContext,
): LiveCommentSource => ({
  readListing: (catalogId, query, signal) =>
    fetchSameOriginCatalogCommentPage(catalogId, query, signal, context),
  readReplies: (catalogId, commentId, query, signal) =>
    fetchSameOriginCatalogCommentReplyPage(
      catalogId,
      commentId,
      query,
      signal,
      context,
    ),
  submitComment: (catalogId, text) =>
    createSameOriginCatalogComment(catalogId, { text }, context),
  submitReply: (catalogId, commentId, text, replyTo) =>
    createSameOriginCatalogCommentReply(
      catalogId,
      commentId,
      replyTo === undefined ? { text } : { replyTo, text },
      context,
    ),
  readViewer: (signal) => fetchSameOriginCurrentUser(signal, context),
});

/** Bounded by the Contract; Web narrows, never widens. */
export const LIVE_COMMENT_PAGE_SIZE = 10;
export const LIVE_REPLY_PAGE_SIZE = 10;
