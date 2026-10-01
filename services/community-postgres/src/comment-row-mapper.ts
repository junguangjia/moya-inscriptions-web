import type {
  CatalogCommentRecord,
  CatalogCommentReplyRecord,
  CommentAuthorRecord,
  ModerationEvent,
  OperatorCommentRecord,
} from "@moya/api";
import type { ModerationEventAction } from "@moya/contracts/internal/community-operator";
import type { QueryResultRow } from "pg";

export interface CommentRow extends QueryResultRow {
  readonly id: unknown;
  readonly catalog_id?: unknown;
  readonly root_comment_id?: unknown;
  readonly text: unknown;
  readonly created_at: unknown;
  readonly moderation: unknown;
  readonly author_id: unknown;
  readonly author_display_name: unknown;
  readonly author_studio_name?: unknown;
  readonly reply_to_author_id?: unknown;
  readonly reply_to_display_name?: unknown;
  readonly reply_to_studio_name?: unknown;
}

export interface OperatorCommentRow extends CommentRow {
  readonly kind: unknown;
  readonly target_type?: unknown;
  readonly body_deleted_at?: unknown;
  readonly thread_removed_at?: unknown;
  readonly thread_affected_count?: unknown;
  readonly reply_to_reply_id?: unknown;
  readonly author_handle: unknown;
  readonly author_status: unknown;
}

export interface ModerationEventRow extends QueryResultRow {
  readonly id: unknown;
  readonly occurred_at: unknown;
  readonly operator_label: unknown;
  readonly action: unknown;
  readonly subject_kind: unknown;
  readonly subject_id: unknown;
  readonly detail: unknown;
}

const commentIdPattern = /^comment-[0-9a-f]{32}$/;
const publicUserIdPattern = /^user-[0-9a-f]{32}$/;
const handlePattern = /^[a-z][a-z0-9-]{2,31}$/;
const moderationStates = ["pending", "visible", "hidden"] as const;
const invalid = (): never => {
  throw new Error("Invalid PostgreSQL community comment row");
};

type Moderation = (typeof moderationStates)[number];

const asCommentId = (value: unknown): string =>
  typeof value === "string" && commentIdPattern.test(value) ? value : invalid();

const asText = (value: unknown): string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length >= 1 &&
  value.length <= 1_000
    ? value
    : invalid();

const asDate = (value: unknown): Date =>
  value instanceof Date && Number.isFinite(value.getTime()) ? value : invalid();

const asModeration = (value: unknown): Moderation =>
  typeof value === "string" &&
  moderationStates.some((candidate) => candidate === value)
    ? (value as Moderation)
    : invalid();

const asDisplayName = (value: unknown): string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length >= 1 &&
  value.length <= 40
    ? value
    : invalid();

const asCatalogId = (value: unknown): string =>
  typeof value === "string" && /^\S{1,128}$/.test(value) ? value : invalid();

const asHandle = (value: unknown): string =>
  typeof value === "string" && handlePattern.test(value) ? value : invalid();

const asUserStatus = (value: unknown): "active" | "suspended" =>
  value === "active" || value === "suspended" ? value : invalid();

const asAuthor = (
  id: unknown,
  displayName: unknown,
  studioName?: unknown,
): CommentAuthorRecord => {
  if (
    studioName !== undefined &&
    (typeof studioName !== "string" ||
      studioName.trim() !== studioName ||
      [...studioName].length > 7 ||
      studioName.includes("\u0000") ||
      /[\uD800-\uDFFF]/u.test(studioName))
  )
    invalid();
  if (typeof id !== "string" || !publicUserIdPattern.test(id)) invalid();
  return {
    id: id as CommentAuthorRecord["id"],
    displayName: asDisplayName(displayName),
    ...(typeof studioName === "string" ? { studioName } : {}),
  };
};

/** Fails closed on any row the schema constraints should have made impossible. */
export const mapCommentRow = (row: CommentRow): CatalogCommentRecord => {
  return {
    id: asCommentId(row.id) as CatalogCommentRecord["id"],
    catalogId: asCatalogId(row.catalog_id) as CatalogCommentRecord["catalogId"],
    author: asAuthor(
      row.author_id,
      row.author_display_name,
      row.author_studio_name,
    ),
    text: asText(row.text),
    createdAt: asDate(row.created_at),
    moderation: asModeration(row.moderation),
  };
};

export const mapReplyRow = (row: CommentRow): CatalogCommentReplyRecord => {
  const replyTo =
    row.reply_to_author_id === null || row.reply_to_author_id === undefined
      ? undefined
      : asAuthor(
          row.reply_to_author_id,
          row.reply_to_display_name,
          row.reply_to_studio_name,
        );
  return {
    id: asCommentId(row.id) as CatalogCommentReplyRecord["id"],
    rootCommentId: asCommentId(
      row.root_comment_id,
    ) as CatalogCommentReplyRecord["rootCommentId"],
    author: asAuthor(
      row.author_id,
      row.author_display_name,
      row.author_studio_name,
    ),
    text: asText(row.text),
    createdAt: asDate(row.created_at),
    moderation: asModeration(row.moderation),
    ...(replyTo === undefined ? {} : { replyTo }),
  };
};

const isoUtc = (value: Date): string =>
  value.toISOString().replace(/\.\d{3}Z$/, ".000Z");

/** The operator view carries the moderation state the Public DTOs never expose. */
export const mapOperatorCommentRow = (
  row: OperatorCommentRow,
): OperatorCommentRecord => {
  const kind =
    row.kind === "comment" || row.kind === "reply" ? row.kind : invalid();
  const author = asAuthor(row.author_id, row.author_display_name);
  const replyToId =
    row.reply_to_reply_id === null || row.reply_to_reply_id === undefined
      ? undefined
      : (asCommentId(row.reply_to_reply_id) as OperatorCommentRecord["id"]);
  return {
    id: asCommentId(row.id) as OperatorCommentRecord["id"],
    kind,
    catalogId:
      row.target_type === "work"
        ? null
        : (asCatalogId(row.catalog_id) as OperatorCommentRecord["catalogId"]),
    ...(row.target_type === "work"
      ? {
          target: {
            type: "work" as const,
            id:
              typeof row.catalog_id === "string" &&
              /^work-[0-9a-f]{32}$/u.test(row.catalog_id)
                ? row.catalog_id
                : invalid(),
          },
        }
      : {}),
    ...(row.body_deleted_at ? { bodyDeleted: true } : {}),
    ...(row.thread_removed_at ? { threadRemoved: true } : {}),
    ...(typeof row.thread_affected_count === "number"
      ? { threadAffectedCount: row.thread_affected_count }
      : {}),
    ...(kind === "reply"
      ? {
          rootCommentId: asCommentId(
            row.root_comment_id,
          ) as OperatorCommentRecord["id"],
        }
      : {}),
    ...(replyToId === undefined ? {} : { replyToId }),
    author: {
      id: author.id,
      handle: asHandle(row.author_handle),
      displayName: author.displayName,
      status: asUserStatus(row.author_status),
    },
    text: asText(row.text),
    createdAt: isoUtc(asDate(row.created_at)),
    moderation: asModeration(row.moderation),
  };
};

const eventActions: readonly ModerationEventAction[] = [
  "approve",
  "reject",
  "hide",
  "unhide",
  "suspend",
  "reinstate",
  "set_publication_policy",
  "delete_body",
  "remove_thread",
];
const subjectKinds = ["comment", "reply", "user", "setting"] as const;

/** One authoritative audit row; fails closed like every other mapper here. */
export const mapModerationEventRow = (
  row: ModerationEventRow,
): ModerationEvent => {
  const action = eventActions.find((candidate) => candidate === row.action);
  const subjectKind = subjectKinds.find(
    (candidate) => candidate === row.subject_kind,
  );
  if (
    typeof row.id !== "string" ||
    !/^moderation-[0-9a-f]{32}$/.test(row.id) ||
    action === undefined ||
    subjectKind === undefined ||
    typeof row.operator_label !== "string" ||
    typeof row.subject_id !== "string"
  )
    invalid();
  const detail =
    row.detail === null || row.detail === undefined
      ? undefined
      : typeof row.detail === "string"
        ? row.detail
        : invalid();
  return {
    id: row.id as string,
    occurredAt: asDate(row.occurred_at),
    operatorLabel: row.operator_label as string,
    action: action as ModerationEventAction,
    subjectKind: subjectKind as ModerationEvent["subjectKind"],
    subjectId: row.subject_id as string,
    ...(detail === undefined ? {} : { detail }),
  };
};

export const parseCommentTotal = (value: unknown): number => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) invalid();
  const total = Number(value);
  return Number.isSafeInteger(total) ? total : invalid();
};
