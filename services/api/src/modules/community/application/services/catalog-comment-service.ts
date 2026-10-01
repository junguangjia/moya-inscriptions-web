import {
  CommunityInputError,
  CommunityNotFoundError,
} from "../errors/community-request-errors.js";
import {
  COMMENT_HOT_LIMIT,
  mapCatalogComment,
  mapCatalogCommentPage,
  mapCatalogCommentReply,
  mapCatalogCommentReplyPage,
} from "../mappers/community-public-contract-mapper.js";
import { defaultRandomBytes, generateOpaqueId } from "../session-token.js";

import type {
  CatalogComment,
  CatalogCommentId,
  CatalogCommentPage,
  CatalogCommentReply,
  CatalogCommentReplyPage,
  CatalogId,
  CreateCatalogCommentReplyRequest,
  CreateCatalogCommentRequest,
  PublicUserId,
  DiscussionReply,
  DiscussionComment,
} from "@moya/contracts";
import type { DiscussionPort } from "../ports/discussion-port.js";
import type { CommunityCommentPort } from "../ports/community-comment-port.js";
import type { CatalogPublicationPort } from "../ports/catalog-publication-port.js";
import type { RandomBytes } from "../session-token.js";

export interface CatalogCommentServiceOptions {
  readonly clock?: () => Date;
  readonly discussionPort?: DiscussionPort;
  readonly randomBytes?: RandomBytes;
}

export interface CommentSubmission<Item> {
  readonly item: Item;
  /** `pending` under PRE_MODERATION; the transport turns it into 202 vs 201. */
  readonly awaitingApproval: boolean;
}

/**
 * How many visible replies a comment page carries inline before the reader
 * pages the thread. Fixed by the Mission 2B Contract review.
 */
export const COMMENT_EMBEDDED_REPLY_LIMIT = 3;

export interface CommentPageInput {
  readonly page: number;
  readonly pageSize: number;
}

/**
 * The root listing input. `pinned` carries the hot ids a browsing sequence
 * already holds: when present, no fresh hot selection is made and the latest
 * pages exclude exactly those roots, so load-more never repeats or drops a
 * root because the hot section moved underneath it.
 */
export interface CommentListingInput extends CommentPageInput {
  readonly pinned?: readonly CatalogCommentId[];
}

/**
 * The three comment operations plus bounded reply pagination. Public reads
 * return `visible` items only; a reply never bypasses a root that is not
 * visible, and moderation state never leaves the Backend.
 */
export class CatalogCommentService {
  private readonly discussion: DiscussionPort | undefined;
  private readonly clock: () => Date;
  private readonly randomBytes: RandomBytes;

  constructor(
    private readonly commentPort: CommunityCommentPort,
    private readonly catalogPublicationPort: CatalogPublicationPort,
    options: CatalogCommentServiceOptions = {},
  ) {
    this.discussion = options.discussionPort;
    this.clock = options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
  }

  /**
   * One combined list: up to COMMENT_HOT_LIMIT hot roots (visible roots
   * ranked by their visible replies, positive scores only, ties to the newer
   * then the greater id), then the latest roots newest first with the hot and
   * pinned ones removed. Pending and hidden rows never count anywhere.
   */
  async readComments(
    catalogId: CatalogId,
    query: CommentListingInput,
    viewer: PublicUserId | null = null,
  ): Promise<CatalogCommentPage> {
    await this.assertPublishedCatalog(catalogId);
    if (this.discussion) {
      const page = await this.discussion.readDiscussion(
        { type: "catalog", id: catalogId },
        viewer,
        query,
      );
      return {
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
        totalPages: page.totalPages,
        hot: page.hot.map((r) => legacyRoot(r, catalogId)),
        items: page.items.map((r) => legacyRoot(r, catalogId)),
      };
    }
    const listing = await this.commentPort.readVisibleComments({
      catalogId,
      page: query.page,
      pageSize: query.pageSize,
      embeddedReplyLimit: COMMENT_EMBEDDED_REPLY_LIMIT,
      hotLimit: query.pinned === undefined ? COMMENT_HOT_LIMIT : 0,
      pinned: query.pinned ?? [],
    });
    const toDto = (comment: (typeof listing.items)[number]) =>
      mapCatalogComment(comment, comment.replies, comment.replyTotal);
    return mapCatalogCommentPage({
      hot: listing.hot.map(toDto),
      items: listing.items.map(toDto),
      total: listing.total,
      page: listing.page,
      pageSize: listing.pageSize,
    });
  }

  async readReplies(
    catalogId: CatalogId,
    rootCommentId: CatalogCommentId,
    query: CommentPageInput,
    viewer: PublicUserId | null = null,
  ): Promise<CatalogCommentReplyPage> {
    if (this.discussion) {
      await this.assertPublishedCatalog(catalogId);
      const page = await this.discussion.readDiscussionReplies(
        { type: "catalog", id: catalogId },
        rootCommentId,
        viewer,
        query,
      );
      return {
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
        totalPages: page.totalPages,
        items: page.items.map(legacyReply),
      };
    }
    await this.assertVisibleRoot(catalogId, rootCommentId);
    return mapCatalogCommentReplyPage(
      await this.commentPort.readVisibleReplies({
        rootCommentId,
        page: query.page,
        pageSize: query.pageSize,
      }),
    );
  }

  async createComment(
    catalogId: CatalogId,
    authorId: PublicUserId,
    request: CreateCatalogCommentRequest,
  ): Promise<CommentSubmission<CatalogComment>> {
    await this.assertPublishedCatalog(catalogId);
    if (this.discussion) {
      const sent = await this.discussion.submitDiscussion(
        { type: "catalog", id: catalogId },
        authorId,
        request.text,
        undefined,
        undefined,
        request.mentions,
      );
      return {
        item: {
          ...legacyReply(sent.item),
          catalogId,
          replies: [],
          replyTotal: 0,
        },
        awaitingApproval: sent.awaitingApproval,
      };
    }
    const moderation = await this.entryModerationState();
    const created = await this.commentPort.insertComment({
      id: generateOpaqueId("comment", this.randomBytes) as CatalogCommentId,
      catalogId,
      authorId,
      text: request.text,
      moderation,
      createdAt: this.clock(),
    });
    return {
      item: mapCatalogComment(created, [], 0),
      awaitingApproval: moderation === "pending",
    };
  }

  async createReply(
    catalogId: CatalogId,
    rootCommentId: CatalogCommentId,
    authorId: PublicUserId,
    request: CreateCatalogCommentReplyRequest,
  ): Promise<CommentSubmission<CatalogCommentReply>> {
    if (this.discussion) {
      await this.assertPublishedCatalog(catalogId);
      const sent = await this.discussion.submitDiscussion(
        { type: "catalog", id: catalogId },
        authorId,
        request.text,
        rootCommentId,
        request.replyTo,
        request.mentions,
      );
      return {
        item: legacyReply(sent.item),
        awaitingApproval: sent.awaitingApproval,
      };
    }
    await this.assertVisibleRoot(catalogId, rootCommentId);
    if (request.replyTo !== undefined) {
      const target = await this.commentPort.findReply(request.replyTo);
      if (
        target === null ||
        target.rootCommentId !== rootCommentId ||
        target.moderation !== "visible"
      )
        throw new CommunityInputError(
          "replyTo must be a visible reply under the same root comment",
        );
    }
    const moderation = await this.entryModerationState();
    const created = await this.commentPort.insertReply({
      id: generateOpaqueId("comment", this.randomBytes) as CatalogCommentId,
      rootCommentId,
      authorId,
      text: request.text,
      moderation,
      createdAt: this.clock(),
      ...(request.replyTo === undefined
        ? {}
        : { replyToReplyId: request.replyTo }),
    });
    return {
      item: mapCatalogCommentReply(created),
      awaitingApproval: moderation === "pending",
    };
  }

  /** The setting is read per submission, so a switch needs no restart. */
  private async entryModerationState(): Promise<"pending" | "visible"> {
    const { policy } = await this.commentPort.readPublicationPolicy();
    return policy === "DIRECT_PUBLICATION" ? "visible" : "pending";
  }

  private async assertPublishedCatalog(catalogId: CatalogId): Promise<void> {
    if (!(await this.catalogPublicationPort.isPublished(catalogId)))
      throw new CommunityNotFoundError("Catalog record is not published");
  }

  private async assertVisibleRoot(
    catalogId: CatalogId,
    rootCommentId: CatalogCommentId,
  ): Promise<void> {
    await this.assertPublishedCatalog(catalogId);
    const root = await this.commentPort.findComment(rootCommentId);
    if (
      root === null ||
      root.catalogId !== catalogId ||
      root.moderation !== "visible"
    )
      throw new CommunityNotFoundError("Root comment is not visible");
  }
}

const legacyReply = (r: DiscussionReply): CatalogCommentReply => ({
  id: r.id,
  author: r.author,
  text: r.text,
  createdAt: r.createdAt,
  ...(r.replyTo ? { replyTo: r.replyTo } : {}),
});
const legacyRoot = (
  r: DiscussionComment,
  catalogId: CatalogId,
): CatalogComment => ({
  ...legacyReply(r),
  catalogId,
  replies: r.replies.map(legacyReply),
  replyTotal: r.replyTotal,
});
