import {
  captureStaffSubject,
  recordStaffModeration,
} from "./staff-moderation-reporting.js";
import {
  requestOwnerPublicationSync,
  type PublicationSyncOptions,
} from "./publishing/publication-sync.js";
import { limitAiWrite } from "./ai-write-limit.js";
import { asCommunityOperationError } from "./availability.js";
import {
  findCommandReceiptSql,
  insertCommandReceiptSql,
  insertModerationEventSql,
  revokeUserSessionsSql,
  setUserStatusSql,
} from "./comment-queries.js";
import {
  findDevelopmentAccountByHandleSql,
  findSessionUserSql,
  insertSessionSql,
  revokeSessionSql,
} from "./queries.js";
import { mapPublicUserRow } from "./row-mapper.js";
import { CommunityIdempotencyConflictError } from "@moya/api";

import type { PublicUserRow } from "./row-mapper.js";
import type {
  CommandReceipt,
  CommunityIdentityPort,
  ModerationEventDraft,
  PublicUserRecord,
  SessionRecordInput,
} from "@moya/api";
import type { PublicUserId } from "@moya/contracts";
import type { Pool } from "pg";

/** App-role adapter: DML only on the community namespace, never DDL. */
export class PostgresCommunityIdentityAdapter implements CommunityIdentityPort {
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      readonly requireProductionSession?: boolean;
      readonly publication?: PublicationSyncOptions;
    } = {},
  ) {}

  async findDevelopmentAccountByHandle(
    handle: string,
  ): Promise<PublicUserRecord | null> {
    const result = await this.query<PublicUserRow>(
      findDevelopmentAccountByHandleSql,
      [handle],
    );
    const row = result[0];
    return row === undefined ? null : mapPublicUserRow(row);
  }

  async createSession(session: SessionRecordInput): Promise<void> {
    await this.query(insertSessionSql, [
      session.id,
      session.tokenHash,
      session.userId,
      session.issuedAt,
      session.expiresAt,
    ]);
  }

  async findSessionUser(
    tokenHash: string,
    now: Date,
  ): Promise<PublicUserRecord | null> {
    const result = await this.query<PublicUserRow>(findSessionUserSql, [
      tokenHash,
      now,
      this.options.requireProductionSession === true,
    ]);
    const row = result[0];
    return row === undefined ? null : mapPublicUserRow(row);
  }

  async revokeSession(tokenHash: string, now: Date): Promise<boolean> {
    const client = await this.connect();
    try {
      const result = await client.query(revokeSessionSql, [tokenHash, now]);
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw asCommunityOperationError(error, "query");
    } finally {
      client.release();
    }
  }

  /**
   * Status, session revocation and the audit row move together or not at
   * all. The UPDATE matches only a real transition, so a repeated suspend
   * returns the unchanged user and records nothing. A deleted account is
   * terminal: the UPDATE never matches it and nothing else is written. Under
   * a receipt the replay comes first, and the receipt holds ids and counts and
   * no name, because it outlives an account's deletion.
   */
  async setUserStatus(
    id: PublicUserId,
    status: Exclude<PublicUserRecord["status"], "deleted">,
    at: Date,
    audit?: ModerationEventDraft,
    receipt?: CommandReceipt,
  ): Promise<{
    readonly user: Pick<PublicUserRecord, "id" | "status">;
    readonly revokedSessions: number;
    readonly unchanged?: true;
    readonly replayed?: true;
  } | null> {
    const operator = audit?.operatorLabel ?? "owner";
    const client = await this.connect();
    const stored = async () => {
      if (receipt === undefined) return null;
      const prior = (
        await client.query<{
          fingerprint: string;
          result: Pick<PublicUserRecord, "id" | "status"> & {
            readonly revokedSessions: number;
          };
        }>(findCommandReceiptSql, [operator, receipt.requestId])
      ).rows[0];
      if (prior === undefined) return null;
      if (prior.fingerprint !== receipt.fingerprint)
        throw new CommunityIdempotencyConflictError(
          "Reused command identity with other content",
        );
      const { revokedSessions, ...user } = prior.result;
      return { user, revokedSessions, replayed: true as const };
    };
    try {
      await client.query("BEGIN");
      await limitAiWrite(operator, (sql) => client.query(sql));
      const replay = await stored();
      if (replay !== null) {
        await client.query("COMMIT");
        return replay;
      }
      const staff = await captureStaffSubject(
        client,
        { type: "user", id },
        audit?.reason,
      );
      const updated = await client.query<
        PublicUserRow & { readonly changed: unknown }
      >(setUserStatusSql, [id, status, at]);
      const row = updated.rows[0];
      if (row === undefined) {
        await client.query("ROLLBACK");
        return null;
      }
      const user = mapPublicUserRow(row);
      if (user.status === "deleted") {
        await client.query("ROLLBACK");
        return { user, revokedSessions: 0 };
      }
      // Nothing changed: a holder of this very key may have committed it while
      // this one waited on the row, and the receipt decides, not a guess.
      if (row.changed !== true) {
        const concurrent = await stored();
        if (concurrent !== null) {
          await client.query("COMMIT");
          return concurrent;
        }
      }
      if (row.changed === true && audit !== undefined)
        await client.query(insertModerationEventSql, [
          audit.id,
          audit.occurredAt,
          audit.operatorLabel,
          audit.action,
          "user",
          user.id,
          audit.detail ?? null,
        ]);
      const revoked =
        status === "suspended"
          ? await client.query(revokeUserSessionsSql, [id, at])
          : undefined;
      if (row.changed === true)
        await requestOwnerPublicationSync(
          client,
          id,
          status === "active" ? "publish" : "withdraw",
          at,
          this.options.publication,
        );
      if (row.changed === true)
        await recordStaffModeration(
          client,
          staff,
          audit?.operatorLabel ?? "owner",
          status === "suspended" ? "suspend" : "restore",
          at,
        );
      if (receipt !== undefined)
        await client.query(insertCommandReceiptSql, [
          operator,
          receipt.requestId,
          receipt.fingerprint,
          JSON.stringify({
            id: user.id,
            status: user.status,
            revokedSessions: revoked?.rowCount ?? 0,
          }),
          at,
        ]);
      await client.query("COMMIT");
      return {
        user,
        revokedSessions: revoked?.rowCount ?? 0,
        ...(row.changed === true ? {} : { unchanged: true as const }),
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw asCommunityOperationError(error, "query");
    } finally {
      client.release();
    }
  }

  private async connect() {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw asCommunityOperationError(error, "connect");
    }
  }

  private async query<Row extends PublicUserRow = PublicUserRow>(
    sql: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    const client = await this.connect();
    try {
      const result = await client.query<Row>(sql, [...values]);
      return result.rows;
    } catch (error) {
      throw asCommunityOperationError(error, "query");
    } finally {
      client.release();
    }
  }
}
