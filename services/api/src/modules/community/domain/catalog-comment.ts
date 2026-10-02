import type {
  CatalogCommentId,
  CatalogId,
  PublicUserId,
} from "@moya/contracts";
import type { CommentModerationState } from "@moya/contracts/internal/community-operator";

/** The author fields the read side carries; never a credential or a status. */
export interface CommentAuthorRecord {
  readonly id: PublicUserId;
  readonly displayName: string;
  readonly studioName?: string;
}

/** Internal comment record. It is neither a Public DTO nor a persistence row. */
export interface CatalogCommentRecord {
  readonly id: CatalogCommentId;
  readonly catalogId: CatalogId;
  readonly author: CommentAuthorRecord;
  readonly text: string;
  readonly createdAt: Date;
  readonly moderation: CommentModerationState;
}

export interface CatalogCommentReplyRecord {
  readonly id: CatalogCommentId;
  readonly rootCommentId: CatalogCommentId;
  readonly author: CommentAuthorRecord;
  readonly text: string;
  readonly createdAt: Date;
  readonly moderation: CommentModerationState;
  /** Resolved from the sibling reply this one answers, when there is one. */
  readonly replyTo?: CommentAuthorRecord;
}

/** A root comment together with the bounded first page of its visible replies. */
export interface CatalogCommentWithReplies extends CatalogCommentRecord {
  readonly replies: readonly CatalogCommentReplyRecord[];
  /** Currently visible replies under this root; the hot score. */
  readonly replyTotal: number;
}

export interface CommentPageRecord<Item> {
  readonly items: readonly Item[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * The combined root listing: the hot section first, then the latest page.
 * `total` counts the latest roots only; a root is never in both lists.
 */
export interface CommentListingRecord<Item> extends CommentPageRecord<Item> {
  readonly hot: readonly Item[];
}
