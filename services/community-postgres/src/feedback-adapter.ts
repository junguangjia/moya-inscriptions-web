import { randomUUID } from "node:crypto";
import { CommunityConflictError, CommunityInputError } from "@moya/api";
import {
  FEEDBACK_IMAGE_LIMITS,
  feedbackReceiptSchema,
} from "@moya/contracts/schemas";
import { operatorFeedbackPageSchema } from "@moya/contracts/internal/community-operator";
import { asCommunityOperationError } from "./availability.js";
import { derivativeReadSql, mediaReadTarget } from "./publishing/media-read.js";
import type { FeedbackPort, PublishingMediaReadTarget } from "@moya/api";
import type {
  FeedbackReceipt,
  FeedbackImageVariant,
  SubmitFeedbackRequest,
} from "@moya/contracts";
import type {
  OperatorFeedbackPage,
  OperatorFeedbackQuery,
} from "@moya/contracts/internal/community-operator";
import type { Pool, PoolClient } from "pg";

type FeedbackRow = { id: string; message: string; created_at: Date };

export class PostgresFeedbackAdapter implements FeedbackPort {
  constructor(private readonly pool: Pool) {}

  private async run<T>(
    write: boolean,
    action: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query(
        write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await action(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }

  submitFeedback(
    actor: string,
    input: SubmitFeedbackRequest,
  ): Promise<FeedbackReceipt> {
    return this.run(true, async (db) => {
      const user = await db.query(
        "SELECT id FROM community.public_users WHERE id=$1 AND status='active' FOR SHARE",
        [actor],
      );
      if (!user.rows[0])
        throw new CommunityConflictError("Account is no longer active");
      const imageIds = input.imageIds ?? [];
      const inserted = await db.query<FeedbackRow>(
        `INSERT INTO community.feedback(id,user_id,submission_id,message) VALUES($1,$2,$3,$4)
         ON CONFLICT (user_id,submission_id) DO NOTHING RETURNING id,message,created_at`,
        [
          `feedback-${randomUUID().replaceAll("-", "")}`,
          actor,
          input.submissionId,
          input.message,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await db.query<FeedbackRow>(
            "SELECT id,message,created_at FROM community.feedback WHERE user_id=$1 AND submission_id=$2",
            [actor, input.submissionId],
          )
        ).rows[0]!;
      if (!inserted.rows[0]) {
        const previous = (
          await db.query<{ item_id: string }>(
            "SELECT item_id FROM community.feedback_images WHERE feedback_id=$1 ORDER BY position",
            [row.id],
          )
        ).rows.map((x) => x.item_id);
        if (
          row.message !== input.message ||
          JSON.stringify(previous) !== JSON.stringify(imageIds)
        )
          throw new CommunityConflictError("Submission identity already used");
      } else if (imageIds.length) {
        // Session discard/purge takes the same item locks and rechecks all refs.
        const items = (
          await db.query<{
            id: string;
            owner_id: string;
            purpose: string;
            kind: string;
            state: string;
            ready: boolean;
          }>(
            `SELECT i.id,i.owner_id,i.purpose,i.kind,i.state,
            (i.cancelled_at IS NULL AND i.purged_at IS NULL AND i.declared_total_bytes<=$2::bigint AND i.received_total_bytes=i.declared_total_bytes AND i.received_total_bytes>0 AND
              EXISTS (SELECT 1 FROM community.media_renditions d JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed'
                WHERE d.item_id=i.id AND d.role='thumb' AND d.edit_key='base' AND d.state='ready' AND d.content_type='image/webp') AND
              EXISTS (SELECT 1 FROM community.media_renditions d JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed'
                WHERE d.item_id=i.id AND d.role='display' AND d.edit_key='base' AND d.state='ready' AND d.content_type='image/webp')) AS ready
           FROM community.media_items i WHERE i.id=ANY($1::text[]) ORDER BY i.id FOR UPDATE OF i`,
            [imageIds, FEEDBACK_IMAGE_LIMITS.maxBytes],
          )
        ).rows;
        if (
          items.length !== imageIds.length ||
          items.some(
            (i) =>
              i.owner_id !== actor ||
              i.purpose !== "feedback" ||
              i.kind !== "static" ||
              i.state !== "ready" ||
              !i.ready,
          )
        )
          throw new CommunityInputError("Invalid feedback image selection");
        for (const [position, itemId] of imageIds.entries()) {
          await db.query(
            "INSERT INTO community.feedback_images(feedback_id,item_id,position) VALUES($1,$2,$3)",
            [row.id, itemId, position],
          );
          await db.query(
            "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'feedback',$2)",
            [itemId, row.id],
          );
        }
      }
      return feedbackReceiptSchema.parse({
        id: row.id,
        createdAt: row.created_at.toISOString(),
      });
    });
  }

  operatorListFeedback(
    query: OperatorFeedbackQuery,
  ): Promise<OperatorFeedbackPage> {
    return this.run(false, async (db) => {
      const total = Number(
        (
          await db.query<{ total: string }>(
            "SELECT count(*) AS total FROM community.feedback",
          )
        ).rows[0]!.total,
      );
      const rows = (
        await db.query<FeedbackRow & { user_id: string; display_name: string }>(
          `SELECT f.id,f.message,f.created_at,f.user_id,u.display_name
         FROM community.feedback f JOIN community.public_users u ON u.id=f.user_id
         ORDER BY f.created_at DESC,f.id DESC LIMIT $1 OFFSET $2`,
          [query.pageSize, (query.page - 1) * query.pageSize],
        )
      ).rows;
      const images = rows.length
        ? (
            await db.query<{
              feedback_id: string;
              item_id: string;
              width: number;
              height: number;
            }>(
              `SELECT a.feedback_id,a.item_id,d.width,d.height FROM community.feedback_images a
         JOIN community.media_items i ON i.id=a.item_id AND i.purpose='feedback' AND i.state='ready' AND i.cancelled_at IS NULL AND i.purged_at IS NULL
         JOIN community.media_renditions d ON d.item_id=i.id AND d.role='display' AND d.edit_key='base' AND d.state='ready' AND d.content_type='image/webp'
         JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed'
         WHERE a.feedback_id=ANY($1::text[]) ORDER BY a.feedback_id,a.position`,
              [rows.map((x) => x.id)],
            )
          ).rows
        : [];
      return operatorFeedbackPageSchema.parse({
        items: rows.map((row) => ({
          id: row.id,
          message: row.message,
          user: { id: row.user_id, displayName: row.display_name },
          createdAt: row.created_at.toISOString(),
          images: images
            .filter((x) => x.feedback_id === row.id)
            .map((x) => ({
              id: x.item_id,
              width: x.width,
              height: x.height,
              thumbSrc: `/api/community-moderation/feedback-media/${row.id}/${x.item_id}/thumb`,
              src: `/api/community-moderation/feedback-media/${row.id}/${x.item_id}/display`,
            })),
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
      });
    });
  }

  resolveFeedbackImage(
    feedbackId: string,
    itemId: string,
    variant: FeedbackImageVariant,
  ): Promise<PublishingMediaReadTarget | null> {
    return this.run(false, async (db) => {
      const row = (
        await db.query<{
          storage_key: string;
          content_type: string;
          byte_size: string;
          sha256: string;
        }>(
          `${derivativeReadSql} AND i.purpose='feedback' AND i.state='ready' AND i.cancelled_at IS NULL AND i.purged_at IS NULL
          AND d.content_type='image/webp' AND EXISTS (SELECT 1 FROM community.feedback_images a WHERE a.feedback_id=$4 AND a.item_id=i.id)`,
          [itemId, variant, "base", feedbackId],
        )
      ).rows[0];
      return mediaReadTarget(row);
    });
  }
}
