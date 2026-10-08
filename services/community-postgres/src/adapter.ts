import {
  requestOwnerPublicationSync,
  type PublicationSyncOptions,
} from "./publishing/publication-sync.js";
import { asCommunityOperationError } from "./availability.js";
import {
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

import type { PublicUserRow } from "./row-mapper.js";
import type {
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
   * returns the unchanged user and records nothing.
   */
  async setUserStatus(
    id: PublicUserId,
    status: PublicUserRecord["status"],
    at: Date,
    audit?: ModerationEventDraft,
  ): Promise<{
    readonly user: PublicUserRecord;
    readonly revokedSessions: number;
  } | null> {
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<
        PublicUserRow & { readonly changed: unknown }
      >(setUserStatusSql, [id, status, at]);
      const row = updated.rows[0];
      if (row === undefined) {
        await client.query("ROLLBACK");
        return null;
      }
      const user = mapPublicUserRow(row);
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
      await client.query("COMMIT");
      return { user, revokedSessions: revoked?.rowCount ?? 0 };
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
