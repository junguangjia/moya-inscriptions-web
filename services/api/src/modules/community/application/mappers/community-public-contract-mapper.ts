import {
  catalogCommentPageSchema,
  catalogCommentReplyPageSchema,
  catalogCommentReplySchema,
  catalogCommentSchema,
  publicUserProfileSchema,
} from "@moya/contracts/schemas";

/** The contract's bound is the only definition; the service reads it here. */
export { COMMENT_HOT_LIMIT } from "@moya/contracts/schemas";

import type {
  CatalogComment,
  CatalogCommentPage,
  CatalogCommentReply,
  CatalogCommentReplyPage,
  PublicUserProfile,
} from "@moya/contracts";

import type {
  CatalogCommentRecord,
  CatalogCommentReplyRecord,
  CommentListingRecord,
  CommentPageRecord,
} from "../../domain/catalog-comment.js";
import type { PublicUserRecord } from "../../domain/public-user.js";

/** The only public projection of a public user; status and timestamps never leave the Backend. */
export const mapPublicUserProfile = (
  user: PublicUserRecord,
): PublicUserProfile =>
  publicUserProfileSchema.parse({
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    ...(user.studioName === undefined ? {} : { studioName: user.studioName }),
  });

const isoUtc = (value: Date): string =>
  value.toISOString().replace(/\.\d{3}Z$/, ".000Z");

export const mapCatalogCommentReply = (
  reply: CatalogCommentReplyRecord,
): CatalogCommentReply =>
  catalogCommentReplySchema.parse({
    id: reply.id,
    author: {
      id: reply.author.id,
      displayName: reply.author.displayName,
      ...(reply.author.studioName === undefined
        ? {}
        : { studioName: reply.author.studioName }),
    },
    text: reply.text,
    createdAt: isoUtc(reply.createdAt),
    ...(reply.replyTo === undefined
      ? {}
      : {
          replyTo: {
            id: reply.replyTo.id,
            displayName: reply.replyTo.displayName,
            ...(reply.replyTo.studioName === undefined
              ? {}
              : { studioName: reply.replyTo.studioName }),
          },
        }),
  });

/** Moderation state never appears in a Public DTO. */
export const mapCatalogComment = (
  comment: CatalogCommentRecord,
  replies: readonly CatalogCommentReplyRecord[],
  replyTotal: number,
): CatalogComment =>
  catalogCommentSchema.parse({
    id: comment.id,
    catalogId: comment.catalogId,
    author: {
      id: comment.author.id,
      displayName: comment.author.displayName,
      ...(comment.author.studioName === undefined
        ? {}
        : { studioName: comment.author.studioName }),
    },
    text: comment.text,
    createdAt: isoUtc(comment.createdAt),
    replies: replies.map(mapCatalogCommentReply),
    replyTotal,
  });

const totalPages = (total: number, pageSize: number): number =>
  total === 0 ? 0 : Math.ceil(total / pageSize);

export const mapCatalogCommentPage = (
  page: CommentListingRecord<CatalogComment>,
): CatalogCommentPage =>
  catalogCommentPageSchema.parse({
    hot: page.hot,
    items: page.items,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    totalPages: totalPages(page.total, page.pageSize),
  });

export const mapCatalogCommentReplyPage = (
  page: CommentPageRecord<CatalogCommentReplyRecord>,
): CatalogCommentReplyPage =>
  catalogCommentReplyPageSchema.parse({
    items: page.items.map(mapCatalogCommentReply),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    totalPages: totalPages(page.total, page.pageSize),
  });
