import { randomUUID } from "node:crypto";
import {
  ANALYTICS_IP_RETENTION_DAYS,
  analyticsClientHintsSchema,
} from "@moya/contracts/analytics";
import type {
  AnalyticsBatch,
  AnalyticsIpObservations,
  AnalyticsStatus,
} from "@moya/contracts/analytics";
import type {
  AnalyticsDelivery,
  AnalyticsDeliveryPort,
  AnalyticsPort,
  AnalyticsWriteContext,
} from "@moya/api";
import type { Pool, PoolClient } from "pg";
import { asCommunityOperationError } from "./availability.js";

const deliveryLock = "735052184219";
const enqueueLock = "735052184220";
const maximumPending = 10000;
const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/** Uses the existing App-role pool. No IP enters the canonical event payload. */
export class PostgresAnalyticsAdapter implements AnalyticsPort {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(
    run: (db: PoolClient) => Promise<T>,
    existing?: PoolClient,
  ): Promise<T> {
    const db =
      existing ??
      (await this.pool.connect().catch((error: unknown) => {
        throw asCommunityOperationError(error, "connect");
      }));
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout='3s'");
      const result = await run(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(error, "query");
    } finally {
      if (!existing) db.release();
    }
  }
  async append(
    batch: AnalyticsBatch,
    context: AnalyticsWriteContext,
  ): Promise<number> {
    const hints = analyticsClientHintsSchema.safeParse(batch.clientHints);
    return this.transaction(async (db) => {
      const result = await db.query<{ event_id: string }>(
        `
        INSERT INTO community.analytics_events
          (event_id,visitor_id,session_id,user_id,distinct_id,event_name,target_type,target_id,surface,event_data,occurred_at,received_at)
        SELECT (e->>'eventId')::uuid,$2::uuid,$3::uuid,$4,$5,e->>'name',e->>'targetType',e->>'targetId',e->>'surface',e,(e->>'occurredAt')::timestamptz,$6::timestamptz
        FROM jsonb_array_elements($1::jsonb) e
        ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [
          JSON.stringify(
            batch.events.map((event) => ({
              ...event,
              ...(hints.success ? { moyaClientHints: hints.data } : {}),
            })),
          ),
          batch.visitorId,
          batch.sessionId,
          context.userId,
          context.distinctId,
          context.receivedAt,
        ],
      );
      if (!result.rows.length) return 0;
      const observationId = randomUUID();
      await db.query(
        `INSERT INTO community.analytics_ip_observations
        (id,visitor_id,user_id,ip,user_agent,received_at,expires_at)
        VALUES($1::uuid,$2::uuid,$3,$4::inet,$5,$6::timestamptz,$6::timestamptz+($7::integer * INTERVAL '1 day'))`,
        [
          observationId,
          batch.visitorId,
          context.userId,
          context.ip,
          context.userAgent.slice(0, 512),
          context.receivedAt,
          ANALYTICS_IP_RETENTION_DAYS,
        ],
      );
      if (context.forward) {
        // Serialize only this tiny enqueue decision; canonical ingestion is always retained.
        await db.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          enqueueLock,
        ]);
        await db.query(
          `INSERT INTO community.analytics_outbox(event_id,observation_id,next_attempt_at)
          SELECT e::uuid,$2::uuid,$3::timestamptz FROM unnest($1::text[]) e
          LIMIT GREATEST(0,$4-(SELECT count(*) FROM community.analytics_outbox))`,
          [
            result.rows.map((row) => row.event_id),
            observationId,
            context.receivedAt,
            maximumPending,
          ],
        );
      }
      return result.rows.length;
    });
  }
  async status(
    now: Date,
  ): Promise<
    Pick<
      AnalyticsStatus,
      "last24Hours" | "outbox" | "lastEventAt" | "lastForwardedAt"
    >
  > {
    return this.transaction(async (db) => {
      const row = (
        await db.query<{
          events: string;
          visitors: string;
          users: string;
          sessions: string;
          last_event: Date | null;
          last_forwarded: Date | null;
        }>(
          `
        SELECT count(*)::text AS events,count(DISTINCT visitor_id)::text AS visitors,count(DISTINCT user_id)::text AS users,
          count(DISTINCT session_id)::text AS sessions,
          (SELECT max(received_at) FROM community.analytics_events) AS last_event,
          (SELECT max(forwarded_at) FROM community.analytics_events WHERE forwarded_at IS NOT NULL) AS last_forwarded
        FROM community.analytics_events WHERE received_at >= $1::timestamptz - INTERVAL '24 hours'`,
          [now],
        )
      ).rows[0]!;
      const queue = (
        await db.query<{ pending: string; failed: string }>(
          `SELECT count(*) FILTER(WHERE failed_at IS NULL)::text AS pending,count(*) FILTER(WHERE failed_at IS NOT NULL)::text AS failed FROM community.analytics_outbox`,
        )
      ).rows[0]!;
      return {
        last24Hours: {
          events: Number(row.events),
          visitors: Number(row.visitors),
          users: Number(row.users),
          sessions: Number(row.sessions),
        },
        outbox: {
          pending: Number(queue.pending),
          failed: Number(queue.failed),
        },
        lastEventAt: iso(row.last_event),
        lastForwardedAt: iso(row.last_forwarded),
      };
    });
  }
  async recentIps(now: Date): Promise<AnalyticsIpObservations> {
    return this.transaction(async (db) => {
      const result = await db.query<{
        id: string;
        ip: string;
        visitor_id: string;
        user_id: string | null;
        user_agent: string;
        received_at: Date;
        expires_at: Date;
      }>(
        `
        SELECT id,host(ip) AS ip,visitor_id,user_id,user_agent,received_at,expires_at FROM community.analytics_ip_observations
        WHERE expires_at > $1::timestamptz ORDER BY received_at DESC,id DESC LIMIT 50`,
        [now],
      );
      return {
        items: result.rows.map((row) => ({
          id: row.id,
          ip: row.ip,
          visitorId: row.visitor_id,
          userId: row.user_id,
          userAgent: row.user_agent,
          receivedAt: row.received_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
        })),
      };
    });
  }
  async withDeliveryLock(
    run: (delivery: AnalyticsDeliveryPort) => Promise<void>,
  ): Promise<boolean> {
    const db = await this.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await db.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock($1::bigint) AS locked",
            [deliveryLock],
          )
        ).rows[0]?.locked === true;
      if (locked)
        await run({
          pending: (limit, now) => this.pending(db, limit, now),
          delivered: (eventIds, now) => this.delivered(db, eventIds, now),
          failed: (eventIds, now) => this.failed(db, eventIds, now),
        });
      return locked;
    } finally {
      try {
        if (locked)
          await db.query("SELECT pg_advisory_unlock($1::bigint)", [
            deliveryLock,
          ]);
      } finally {
        db.release();
      }
    }
  }
  private async pending(
    connection: PoolClient,
    limit: number,
    now: Date,
  ): Promise<readonly AnalyticsDelivery[]> {
    return this.transaction(async (db) => {
      // Expired IPs cannot supply geography; stop forwarding rather than invent a backend visitor.
      await db.query(
        `UPDATE community.analytics_outbox o SET failed_at=$1::timestamptz
        WHERE o.failed_at IS NULL AND NOT EXISTS(SELECT 1 FROM community.analytics_ip_observations i WHERE i.id=o.observation_id AND i.expires_at>$1::timestamptz)`,
        [now],
      );
      const rows = (
        await db.query<{
          event_id: string;
          attempts: number;
          event_data: AnalyticsBatch["events"][number];
          distinct_id: string;
          visitor_id: string;
          user_id: string | null;
          ip: string;
          user_agent: string;
        }>(
          `
        SELECT o.event_id,o.attempts,e.event_data,e.distinct_id,e.visitor_id,e.user_id,host(i.ip) AS ip,i.user_agent
        FROM community.analytics_outbox o JOIN community.analytics_events e USING(event_id)
        JOIN community.analytics_ip_observations i ON i.id=o.observation_id
        WHERE o.failed_at IS NULL AND o.next_attempt_at<=$1::timestamptz AND i.expires_at>$1::timestamptz
        ORDER BY o.next_attempt_at,o.event_id LIMIT $2`,
          [now, Math.min(100, Math.max(1, limit))],
        )
      ).rows;
      return rows.map((row) => {
        const event = row.event_data;
        const data: Record<string, unknown> = {
          ...event,
          eventId: row.event_id,
        };
        const hints = analyticsClientHintsSchema.safeParse(
          data.moyaClientHints,
        );
        // Reserved metadata always comes from canonical server-side columns.
        delete data.moyaBrowserId;
        delete data.moyaAccountId;
        delete data.moyaClientHints;
        data.moyaBrowserId = row.visitor_id;
        if (row.user_id !== null) data.moyaAccountId = row.distinct_id;
        if (hints.success) data.moyaClientHints = hints.data;
        const url =
          event.surface === "home" && event.targetType === undefined
            ? "/"
            : `/analytics/${event.surface}${event.targetType === undefined ? "" : `/${event.targetType}/${event.targetId}`}`;
        return {
          eventId: row.event_id,
          attempts: row.attempts,
          payload: {
            ip: row.ip,
            userAgent: row.user_agent,
            id: row.distinct_id,
            timestamp: Math.floor(new Date(event.occurredAt).getTime() / 1000),
            url,
            ...(event.name === "page_view" ? {} : { name: event.name }),
            data,
          },
        };
      });
    }, connection);
  }
  private async delivered(
    connection: PoolClient,
    eventIds: readonly string[],
    now: Date,
  ): Promise<void> {
    if (!eventIds.length) return;
    await this.transaction(async (db) => {
      await db.query(
        "UPDATE community.analytics_events SET forwarded_at=$2::timestamptz WHERE event_id=ANY($1::uuid[])",
        [eventIds, now],
      );
      await db.query(
        "DELETE FROM community.analytics_outbox WHERE event_id=ANY($1::uuid[])",
        [eventIds],
      );
    }, connection);
  }
  private async failed(
    connection: PoolClient,
    eventIds: readonly string[],
    now: Date,
  ): Promise<void> {
    if (!eventIds.length) return;
    await this.transaction(async (db) => {
      await db.query(
        `UPDATE community.analytics_outbox SET attempts=attempts+1,
        next_attempt_at=$2::timestamptz+(LEAST(3600,10*power(2,attempts)) * INTERVAL '1 second'),
        failed_at=CASE WHEN attempts>=7 THEN $2::timestamptz ELSE NULL END
        WHERE event_id=ANY($1::uuid[]) AND failed_at IS NULL`,
        [eventIds, now],
      );
    }, connection);
  }
  async retain(now: Date, eventRetentionDays: number): Promise<void> {
    await this.transaction(async (db) => {
      await db.query(
        `DELETE FROM community.analytics_ip_observations WHERE id IN
        (SELECT id FROM community.analytics_ip_observations WHERE expires_at <= $1::timestamptz ORDER BY expires_at LIMIT 1000)`,
        [now],
      );
      await db.query(
        `DELETE FROM community.analytics_events WHERE event_id IN
        (SELECT event_id FROM community.analytics_events WHERE received_at < $1::timestamptz - ($2 * INTERVAL '1 day') ORDER BY received_at LIMIT 1000)`,
        [now, eventRetentionDays],
      );
      await db.query(
        `DELETE FROM community.analytics_outbox WHERE event_id IN
        (SELECT event_id FROM community.analytics_outbox WHERE failed_at < $1::timestamptz - INTERVAL '7 days' LIMIT 1000)`,
        [now],
      );
    });
  }
}
