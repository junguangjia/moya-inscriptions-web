import { randomUUID } from "node:crypto";
import { CommunityInputError, CommunityNotFoundError } from "@moya/api";
import type {
  NotificationJobClaim,
  NotificationPort,
  NotificationQuery,
  NotificationReadResult,
  NotificationWorkerPort,
} from "@moya/api";
import type {
  MentionReference,
  NotificationItem,
  NotificationReason,
} from "@moya/contracts";
import {
  catalogCommentIdSchema,
  mentionLookupPageSchema,
} from "@moya/contracts/schemas";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { asCommunityOperationError } from "../availability.js";
import { recipientEligibleSql, sourceFactsSql } from "./source.js";

type Facts = QueryResultRow & {
  action_key: string;
  kind: string;
  actor_id: string;
  created_at: Date;
  target_type: "catalog" | "work" | "article";
  target_id: string;
  comment_id: string | null;
  root_author: string | null;
  reply_recipient: string | null;
  work_author: string | null;
  comment_author: string | null;
  mentions: MentionReference[] | null;
  eligible: boolean;
};
const opaque = () => `notification-${randomUUID().replaceAll("-", "")}`;
const reasonOrder: NotificationReason[] = [
  "reply",
  "mention",
  "comment",
  "like",
];
const readSql = `WITH source AS (${sourceFactsSql}
  WHERE s.action_key IN (SELECT action_key FROM community.notification_deliveries WHERE recipient_id=$1 AND revision<=$2::bigint)),
  facts AS (SELECT f.*,d.group_id,d.revision,d.delivered_at,
    (${recipientEligibleSql} AND (NOT (d.reasons=ARRAY['mention']::text[])
      OR COALESCE(f.mentions,'[]'::jsonb) @> jsonb_build_array(jsonb_build_object('userId',$1::text)))) AS allowed
    FROM source f JOIN community.notification_deliveries d USING(action_key)
    JOIN community.public_users u ON u.id=d.recipient_id WHERE d.recipient_id=$1 AND d.revision<=$2::bigint),
  grouped AS (SELECT g.id,g.reason,g.read_through,max(f.revision) AS revision,
    COALESCE(bool_or(f.allowed),false) AS available,
    COALESCE(bool_or(f.allowed AND f.revision>g.read_through),false) AS unread,
    count(DISTINCT f.actor_id) FILTER (WHERE f.allowed)::integer AS actor_count,
    (array_agg(jsonb_build_object('id',f.actor_id,'handle',f.handle,'displayName',f.display_name) ORDER BY f.revision DESC) FILTER(WHERE f.allowed))[1:3] AS actors,
    (array_agg(jsonb_build_object('type',f.target_type,'id',f.target_id) ORDER BY f.revision DESC) FILTER(WHERE f.allowed))[1] AS target,
    (array_agg(f.comment_id ORDER BY f.revision DESC) FILTER(WHERE f.allowed))[1] AS comment_id,
    (array_agg(f.text ORDER BY f.revision DESC) FILTER(WHERE f.allowed))[1] AS text,
    min(f.delivered_at) AS created_at
    FROM community.notification_groups g JOIN facts f ON f.group_id=g.id
    WHERE g.recipient_id=$1 GROUP BY g.id),
  page AS (SELECT * FROM grouped WHERE ($3::bigint IS NULL OR revision<$3::bigint)
    AND ($4='all' OR ($4='likes' AND reason='like') OR ($4='comments' AND reason IN ('comment','reply')) OR ($4='mentions' AND reason='mention'))
    ORDER BY revision DESC,id DESC LIMIT $5)
  SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) || jsonb_build_object('revision',page.revision::text) ORDER BY revision DESC,id DESC) FROM page),'[]'::jsonb) AS items,
    jsonb_build_object('total',count(*) FILTER(WHERE unread),'likes',count(*) FILTER(WHERE unread AND reason='like'),
      'comments',count(*) FILTER(WHERE unread AND reason IN ('comment','reply')),'mentions',count(*) FILTER(WHERE unread AND reason='mention')) AS unread
  FROM grouped`;

/** Private inbox and its dedicated durable worker; never used by Web or CMS directly. */
export class PostgresNotificationAdapter
  implements NotificationPort, NotificationWorkerPort
{
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(
    write: boolean,
    run: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect().catch((error: unknown) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query(
        write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      await db.query("SET LOCAL statement_timeout='8s'");
      const result = await run(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }
  async read(
    recipient: string,
    query: NotificationQuery,
  ): Promise<NotificationReadResult> {
    return this.transaction(false, async (db) => {
      const current = (
        await db.query<{ revision: string }>(
          `SELECT COALESCE(v.revision,0)::text AS revision
        FROM community.public_users u LEFT JOIN community.notification_recipient_versions v ON v.recipient_id=u.id
        WHERE u.id=$1 AND u.status='active'`,
          [recipient],
        )
      ).rows[0];
      if (!current) throw new CommunityNotFoundError();
      const highWater = query.highWater ?? current.revision;
      if (BigInt(highWater) > BigInt(current.revision))
        throw new CommunityInputError("Invalid notification observation");
      type Row = {
        items: (Omit<NotificationItem, "observation"> & {
          revision: string;
          actor_count: number;
          comment_id: string | null;
          created_at: string;
        })[];
        unread: NotificationReadResult["unread"];
      };
      const row = (
        await db.query<Row>(readSql, [
          recipient,
          highWater,
          query.before ?? null,
          query.filter,
          query.limit + 1,
        ])
      ).rows[0]!;
      return {
        highWater,
        unread: row.unread,
        hasMore: row.items.length > query.limit,
        items: row.items.slice(0, query.limit).map((i) => ({
          id: i.id,
          reason: i.reason,
          revision: String(i.revision),
          available: i.available,
          target: i.target,
          commentId:
            i.comment_id === null
              ? null
              : catalogCommentIdSchema.parse(i.comment_id),
          actors: i.actors ?? [],
          actorCount: i.actor_count,
          text: (i.text ?? "").slice(0, 240),
          createdAt: new Date(i.created_at).toISOString(),
          unread: i.unread,
        })),
      };
    });
  }
  async markRead(
    recipient: string,
    through: string,
    groupId?: string,
  ): Promise<void> {
    await this.transaction(true, async (db) => {
      // Recipient serialization also protects mark-all against a newly committing effect.
      const version = (
        await db.query<{ revision: string }>(
          "SELECT revision::text FROM community.notification_recipient_versions WHERE recipient_id=$1 FOR UPDATE",
          [recipient],
        )
      ).rows[0];
      if (BigInt(through) > BigInt(version?.revision ?? "0"))
        throw new CommunityInputError("Invalid notification observation");
      await db.query(
        `UPDATE community.notification_groups SET read_through=greatest(read_through,$2::bigint)
        WHERE recipient_id=$1 AND ($3::text IS NULL OR id=$3)`,
        [recipient, through, groupId ?? null],
      );
    });
  }
  async lookup(actor: string, query: string) {
    return this.transaction(false, async (db) => {
      const rows = (
        await db.query<{ id: string; handle: string; displayName: string }>(
          `SELECT id,handle,display_name AS "displayName" FROM community.public_users
        WHERE status='active' AND community.accounts_can_interact($1,id)
        AND (position(lower($2) in lower(handle))>0 OR position(lower($2) in lower(display_name))>0)
        ORDER BY (handle=lower($2)) DESC,handle,id LIMIT 10`,
          [actor, query],
        )
      ).rows;
      return mentionLookupPageSchema.parse({ items: rows });
    });
  }
  async claim(owner: string, limit: number): Promise<NotificationJobClaim[]> {
    const leaseOwner = `${owner}:${randomUUID()}`;
    return this.transaction(true, async (db) => {
      const rows = await db.query<{ action_key: string; generation: string }>(
        `WITH due AS (
        SELECT action_key FROM community.notification_sources WHERE completed_generation<generation AND attempts<5
        AND run_after<=CURRENT_TIMESTAMP AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP)
        ORDER BY run_after,action_key LIMIT $2 FOR UPDATE SKIP LOCKED)
        UPDATE community.notification_sources s SET lease_owner=$1,lease_until=CURRENT_TIMESTAMP+interval '30 seconds',attempts=attempts+1
        FROM due WHERE s.action_key=due.action_key RETURNING s.action_key,s.generation::text`,
        [leaseOwner, Math.min(20, Math.max(1, limit))],
      );
      return rows.rows.map((r) => ({
        actionKey: r.action_key,
        generation: r.generation,
        leaseOwner,
      }));
    });
  }
  async fail(claim: NotificationJobClaim): Promise<void> {
    await this.transaction(true, async (db) => {
      await db.query(
        `UPDATE community.notification_sources SET lease_owner=NULL,lease_until=NULL,error_code='projection_failed',
        run_after=CURRENT_TIMESTAMP+make_interval(secs=>least(60,power(2,attempts)::integer))
        WHERE action_key=$1 AND lease_owner=$2 AND generation=$3::bigint`,
        [claim.actionKey, claim.leaseOwner, claim.generation],
      );
    });
  }
  async project(claim: NotificationJobClaim): Promise<string[]> {
    return this.transaction(true, async (db) => {
      const locked = await db.query(
        `SELECT action_key FROM community.notification_sources WHERE action_key=$1 AND lease_owner=$2
        AND generation=$3::bigint AND lease_until>CURRENT_TIMESTAMP FOR UPDATE`,
        [claim.actionKey, claim.leaseOwner, claim.generation],
      );
      if (!locked.rowCount) return [];
      const f = (
        await db.query<Facts>(`${sourceFactsSql} WHERE s.action_key=$1`, [
          claim.actionKey,
        ])
      ).rows[0];
      const recipients = new Map<string, Set<NotificationReason>>();
      const add = (
        id: string | null | undefined,
        reason: NotificationReason,
      ) => {
        if (id && id !== f?.actor_id) {
          const reasons = recipients.get(id) ?? new Set();
          reasons.add(reason);
          recipients.set(id, reasons);
        }
      };
      if (f?.eligible) {
        if (f.kind === "work_like") add(f.work_author, "like");
        else if (f.kind === "comment_like") add(f.comment_author, "like");
        else {
          if (f.kind === "comment") {
            add(f.reply_recipient, "reply");
            add(f.work_author, "comment");
          }
          for (const ref of f.mentions ?? []) add(ref.userId, "mention");
        }
      }
      const changed: string[] = [];
      for (const [recipient, reasons] of [...recipients].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const eligible = await db.query(
          `WITH f AS (${sourceFactsSql} WHERE s.action_key=$2)
          SELECT f.action_key FROM f JOIN community.public_users u ON u.id=$1 WHERE ${recipientEligibleSql}`,
          [recipient, claim.actionKey],
        );
        if (!eligible.rowCount) continue;
        // This row lock serializes delivery versions in COMMIT order, unlike a sequence.
        await db.query(
          "INSERT INTO community.notification_recipient_versions(recipient_id) VALUES($1) ON CONFLICT DO NOTHING",
          [recipient],
        );
        await db.query(
          "SELECT revision FROM community.notification_recipient_versions WHERE recipient_id=$1 FOR UPDATE",
          [recipient],
        );
        if (
          (
            await db.query(
              "SELECT 1 FROM community.notification_deliveries WHERE recipient_id=$1 AND action_key=$2",
              [recipient, claim.actionKey],
            )
          ).rowCount
        )
          continue;
        const reason = reasonOrder.find((r) => reasons.has(r))!;
        const groupKey =
          reason === "like"
            ? `${f!.kind}:${f!.target_id}:${f!.comment_id ?? ""}:${f!.created_at.toISOString().slice(0, 10)}`
            : claim.actionKey;
        const group =
          (
            await db.query<{ id: string }>(
              `INSERT INTO community.notification_groups(id,recipient_id,group_key,reason) VALUES($1,$2,$3,$4)
          ON CONFLICT(recipient_id,group_key) DO NOTHING RETURNING id`,
              [opaque(), recipient, groupKey, reason],
            )
          ).rows[0] ??
          (
            await db.query<{ id: string }>(
              "SELECT id FROM community.notification_groups WHERE recipient_id=$1 AND group_key=$2",
              [recipient, groupKey],
            )
          ).rows[0]!;
        const revision = (
          await db.query<{ revision: string }>(
            "UPDATE community.notification_recipient_versions SET revision=revision+1 WHERE recipient_id=$1 RETURNING revision::text",
            [recipient],
          )
        ).rows[0]!.revision;
        await db.query(
          `INSERT INTO community.notification_deliveries(action_key,recipient_id,group_id,revision,reasons) VALUES($1,$2,$3,$4::bigint,$5::text[])`,
          [
            claim.actionKey,
            recipient,
            group.id,
            revision,
            reasonOrder.filter((r) => reasons.has(r)),
          ],
        );
        changed.push(recipient);
      }
      await db.query(
        `UPDATE community.notification_sources SET completed_generation=$3::bigint,lease_owner=NULL,lease_until=NULL,error_code=NULL
        WHERE action_key=$1 AND lease_owner=$2 AND generation=$3::bigint`,
        [claim.actionKey, claim.leaseOwner, claim.generation],
      );
      return changed;
    });
  }
}
