import { randomUUID } from "node:crypto";
import { CommunityConflictError } from "@moya/api";
import { feedbackReceiptSchema } from "@moya/contracts/schemas";
import { operatorFeedbackPageSchema } from "@moya/contracts/internal/community-operator";
import { asCommunityOperationError } from "./availability.js";
import type { FeedbackPort } from "@moya/api";
import type { FeedbackReceipt, SubmitFeedbackRequest } from "@moya/contracts";
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
      // Suspension and persistence cannot pass each other after session validation.
      const user = await db.query(
        "SELECT id FROM community.public_users WHERE id=$1 AND status='active' FOR SHARE",
        [actor],
      );
      if (!user.rows[0])
        throw new CommunityConflictError("Account is no longer active");
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
      // A separate statement sees a concurrent winning INSERT after its commit.
      const row =
        inserted.rows[0] ??
        (
          await db.query<FeedbackRow>(
            "SELECT id,message,created_at FROM community.feedback WHERE user_id=$1 AND submission_id=$2",
            [actor, input.submissionId],
          )
        ).rows[0]!;
      if (row.message !== input.message)
        throw new CommunityConflictError("Submission identity already used");
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
      return operatorFeedbackPageSchema.parse({
        items: rows.map((row) => ({
          id: row.id,
          message: row.message,
          user: { id: row.user_id, displayName: row.display_name },
          createdAt: row.created_at.toISOString(),
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
      });
    });
  }
}
