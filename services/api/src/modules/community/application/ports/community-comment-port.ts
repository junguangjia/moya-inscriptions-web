import type {
  CatalogCommentId,
  CatalogId,
  PublicUserId,
} from "@moya/contracts";
import type {
  CommentModerationState,
  ModerationEventAction as ContractModerationEventAction,
  OperatorComment,
  OperatorCommentKind,
  PublicationPolicy,
} from "@moya/contracts/internal/community-operator";

import type {
  CatalogCommentRecord,
  CatalogCommentReplyRecord,
  CatalogCommentWithReplies,
  CommentListingRecord,
  CommentPageRecord,
} from "../../domain/catalog-comment.js";

export interface CommentPageQuery {
  readonly catalogId: CatalogId;
  readonly page: number;
  readonly pageSize: number;
  /** Bounded first page of replies embedded in each returned comment. */
  readonly embeddedReplyLimit: number;
  /**
   * Upper bound of the hot section selected by the store: visible roots with
   * at least one visible reply, most replies first, then newest, then id.
   * 0 when the caller pinned a set instead of asking for a fresh selection.
   */
  readonly hotLimit: number;
  /** Roots the latest list excludes in addition to the hot ones selected here. */
  readonly pinned: readonly CatalogCommentId[];
}

export interface ReplyPageQuery {
  readonly rootCommentId: CatalogCommentId;
  readonly page: number;
  readonly pageSize: number;
}

export interface CommentInsert {
  readonly id: CatalogCommentId;
  readonly catalogId: CatalogId;
  readonly authorId: PublicUserId;
  readonly text: string;
  readonly moderation: CommentModerationState;
  readonly createdAt: Date;
}

export interface ReplyInsert {
  readonly id: CatalogCommentId;
  readonly rootCommentId: CatalogCommentId;
  readonly authorId: PublicUserId;
  readonly text: string;
  readonly moderation: CommentModerationState;
  readonly createdAt: Date;
  /** A sibling reply under the same root; the adapter rejects any other target. */
  readonly replyToReplyId?: CatalogCommentId;
}

/** Every comment action is also an audit action (the service's `record` relies on it). */
export type ModerationEventAction = ContractModerationEventAction;

/**
 * The execution receipt of one command (Issue #141 r4). `requestId` is the
 * stable identity of one operation target and `fingerprint` binds the exact
 * command it stands for. The store writes it in the same transaction as the
 * mutation and its audit row: a repeated identical command returns the stored
 * result without mutating again, and the same identity carrying a different
 * command is a conflict.
 */
export interface CommandReceipt {
  readonly requestId: string;
  readonly fingerprint: string;
  /**
   * The execution attempt this command belongs to, when it belongs to one.
   * Deliberately NOT part of `fingerprint`: the fingerprint is the business
   * identity of the command and must survive a retry and a lease take-over, so
   * a legitimate retry replays its own receipt instead of conflicting with it.
   */
  readonly fence?: ExecutionFence;
}

/**
 * The right to execute, checked where it has to be checked: inside the very
 * transaction that performs the mutation, after any lock wait, against current
 * state.
 *
 * A pre-transaction check in JavaScript proves nothing — an executor can stall
 * between claiming its lease and opening its transaction, lose the lease to a
 * cancellation or a newer attempt, and still commit afterwards. Rejecting its
 * later progress write does not help either, because by then the domain
 * mutation has already committed. Holding this row until COMMIT is also what
 * makes a concurrent cancellation wait rather than race.
 */
export interface ExecutionFence {
  /** The operation whose lease authorises this mutation. */
  readonly operationId: string;
  /** The lease holder that claimed it; a take-over replaces this value. */
  readonly leaseOwner: string;
}

export interface ModerationEvent {
  readonly id: string;
  readonly occurredAt: Date;
  readonly operatorLabel: string;
  readonly action: ModerationEventAction;
  readonly subjectKind: "comment" | "reply" | "user" | "setting";
  readonly subjectId: string;
  readonly detail?: string;
}

/**
 * The audit row a comment transition writes with it: everything except the
 * subject, which the store fills from the row it actually changed.
 */
export type ModerationEventDraft = Omit<
  ModerationEvent,
  "subjectKind" | "subjectId"
> & { readonly reason?: string };

/** What the moderation write actually changed; null when the id is unknown. */
export interface ModeratedSubject {
  readonly id: CatalogCommentId;
  readonly kind: "comment" | "reply";
  readonly moderation: CommentModerationState;
}

/**
 * The review listing: bounded filters, a plain substring search over text and
 * author handle/display name, and a review order that is never the public hot
 * ordering. Counts come back for the same filters, from the same snapshot.
 */
export interface OperatorCommentQueryInput {
  readonly moderation?: CommentModerationState;
  readonly kind?: OperatorCommentKind;
  readonly catalogId?: CatalogId;
  readonly search?: string;
  readonly order: "newest" | "oldest";
  readonly page: number;
  readonly pageSize: number;
}

export interface OperatorQueueCountsRecord {
  readonly pending: number;
  readonly visible: number;
  readonly hidden: number;
  readonly all: number;
}

/** A review item as the store knows it; the Catalog title is added by the service. */
export type OperatorCommentRecord = Omit<
  OperatorComment,
  "catalogTitle" | "contentTitle"
>;

export interface OperatorCommentListing extends CommentPageRecord<OperatorCommentRecord> {
  readonly counts: OperatorQueueCountsRecord;
}

export interface ModerationEventQueryInput {
  readonly subjectId?: string;
  readonly action?: ModerationEventAction;
  readonly page: number;
  readonly pageSize: number;
}

export interface ModerationSummaryRecord {
  readonly queue: OperatorQueueCountsRecord;
  readonly actions: Readonly<Record<ModerationEventAction, number>>;
  readonly recentEvents: readonly ModerationEvent[];
}

/**
 * Application-owned comment, moderation and setting port for the community
 * namespace. The Backend is the sole writer; nothing here deletes a row.
 */
export interface CommunityCommentPort {
  /**
   * The combined listing for one Catalog record: the hot section, then the
   * latest page excluding hot and pinned roots. Read in one snapshot, so the
   * two lists and the total agree with each other.
   */
  readVisibleComments(
    query: CommentPageQuery,
  ): Promise<CommentListingRecord<CatalogCommentWithReplies>>;

  /** Visible replies under one visible root, in server order. */
  readVisibleReplies(
    query: ReplyPageQuery,
  ): Promise<CommentPageRecord<CatalogCommentReplyRecord>>;

  /** The root comment regardless of moderation state, for write and moderation paths. */
  findComment(id: CatalogCommentId): Promise<CatalogCommentRecord | null>;

  findReply(id: CatalogCommentId): Promise<CatalogCommentReplyRecord | null>;

  insertComment(comment: CommentInsert): Promise<CatalogCommentRecord>;

  insertReply(reply: ReplyInsert): Promise<CatalogCommentReplyRecord>;

  /**
   * Applies the moderation transition to a root comment or a reply. `from`
   * lists the states the edge may leave, so an out-of-machine transition
   * matches no row and returns null (the service reports a conflict when the
   * subject exists, 404 when it does not). When `audit` is given, the
   * transition and its audit row are written in one transaction, and nothing
   * is recorded when no row matches.
   */
  applyCommentModeration(
    id: CatalogCommentId,
    moderation: CommentModerationState,
    from: readonly CommentModerationState[],
    operatorLabel: string,
    at: Date,
    audit?: ModerationEventDraft,
    receipt?: CommandReceipt,
  ): Promise<ModeratedSubject | null>;

  /**
   * The authoritative result this exact command already committed, or null when
   * it committed nothing. Read-only: it never writes and never mutates the
   * subject, so a caller that must not act (a cancelled chunk deciding whether
   * a target was already applied) can still read the truth. A receipt stored
   * under the same identity with a different command answers null, because it
   * is not this command's result.
   */
  findCommandReceipt(
    operatorLabel: string,
    receipt: CommandReceipt,
  ): Promise<ModeratedSubject | null>;

  /** Bounded operator listing with its status counts; V1 keeps no large review queue. */
  readOperatorComments(
    query: OperatorCommentQueryInput,
  ): Promise<OperatorCommentListing>;

  /** One review item by id, whichever table holds it; null when unknown. */
  findOperatorComment(
    id: CatalogCommentId,
  ): Promise<OperatorCommentRecord | null>;

  /** The audit trail, newest first, optionally for one subject or action. */
  readModerationEvents(
    query: ModerationEventQueryInput,
  ): Promise<CommentPageRecord<ModerationEvent>>;

  /** Queue counts now, action counts inside [from, to), the last few events. */
  readModerationSummary(range: {
    readonly from: Date;
    readonly to: Date;
  }): Promise<ModerationSummaryRecord>;

  readPublicationPolicy(): Promise<{
    readonly policy: PublicationPolicy;
    readonly updatedAt: Date;
    readonly updatedBy: string;
  }>;

  /**
   * Writes the mode; a write of the mode already in force changes nothing.
   * When `audit` is given, the switch and its moderation event commit in one
   * transaction, and nothing is recorded when no row changed.
   */
  writePublicationPolicy(
    policy: PublicationPolicy,
    operatorLabel: string,
    at: Date,
    audit?: ModerationEventDraft,
  ): Promise<void>;

  recordModerationEvent(event: ModerationEvent): Promise<void>;
}
