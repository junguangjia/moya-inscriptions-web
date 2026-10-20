import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AnalyticsService } from "@moya/api";
import type { AnalyticsWriteContext } from "@moya/api";
import type { AnalyticsBatch } from "@moya/contracts/analytics";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAnalyticsAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const databaseUrl = requireSyntheticTestDatabaseUrl();
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: databaseUrl }),
);
const adapter = new PostgresAnalyticsAdapter(pool);
const visitors = new Set<string>();
const now = new Date();
const input = (): AnalyticsBatch => {
  const visitorId = randomUUID();
  visitors.add(visitorId);
  return {
    visitorId,
    sessionId: randomUUID(),
    events: [
      {
        eventId: randomUUID(),
        name: "content_impression",
        surface: "browse",
        targetType: "catalog",
        targetId: "catalog-synthetic-analytics",
        position: 2,
        sequenceId: "synthetic-sequence",
        rankingVersion: "synthetic-v1",
        occurredAt: now.toISOString(),
      },
    ],
  };
};
const context = (at = now): AnalyticsWriteContext => ({
  userId: null,
  distinctId: "0123456789abcdef0123456789abcdef01234567",
  ip: "192.0.2.11",
  userAgent: "Mozilla/5.0 synthetic analytics fixture",
  receivedAt: at,
  forward: true,
});
beforeAll(async () => {
  await runCommunityMigrations(
    pool,
    fileURLToPath(
      new URL("../../../database/community-migrations", import.meta.url),
    ),
  );
});
afterAll(async () => {
  await pool.query(
    "DELETE FROM community.analytics_events WHERE visitor_id=ANY($1::uuid[])",
    [[...visitors]],
  );
  await pool.query(
    "DELETE FROM community.analytics_ip_observations WHERE visitor_id=ANY($1::uuid[])",
    [[...visitors]],
  );
  await pool.end();
});
describe("canonical analytics PostgreSQL ingestion", () => {
  it("deduplicates event ids atomically and preserves ranking context, with one IP observation per new batch", async () => {
    const batch = input();
    batch.events.push({
      ...batch.events[0]!,
      eventId: randomUUID(),
      name: "content_open",
    });
    expect(await adapter.append(batch, context())).toBe(2);
    expect(await adapter.append(batch, context())).toBe(0);
    const result = await pool.query<{ event_data: Record<string, unknown> }>(
      "SELECT event_data FROM community.analytics_events WHERE visitor_id=$1::uuid",
      [batch.visitorId],
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.event_data).toMatchObject({
      sequenceId: "synthetic-sequence",
      rankingVersion: "synthetic-v1",
      position: 2,
    });
    expect(JSON.stringify(result.rows)).not.toContain("192.0.2.11");
    expect(
      (
        await pool.query(
          "SELECT id FROM community.analytics_ip_observations WHERE visitor_id=$1::uuid",
          [batch.visitorId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT o.event_id FROM community.analytics_outbox o JOIN community.analytics_events e USING(event_id) WHERE e.visitor_id=$1::uuid",
          [batch.visitorId],
        )
      ).rowCount,
    ).toBe(2);
    await adapter.withDeliveryLock(async (delivery) => {
      const events = (await delivery.pending(100, now)).filter((event) =>
        batch.events.some((input) => input.eventId === event.eventId),
      );
      expect(events).toHaveLength(2);
      expect(events[0]!.payload).toMatchObject({
        ip: "192.0.2.11",
        userAgent: context().userAgent,
        id: context().distinctId,
      });
      expect(String(events[0]!.payload.url)).not.toContain("?");
      await delivery.delivered(
        batch.events.map((event) => event.eventId),
        now,
      );
    });
    expect(
      (
        await pool.query(
          "SELECT forwarded_at FROM community.analytics_events WHERE visitor_id=$1::uuid AND forwarded_at IS NOT NULL",
          [batch.visitorId],
        )
      ).rowCount,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT event_id FROM community.analytics_outbox WHERE event_id=ANY($1::uuid[])",
          [batch.events.map((event) => event.eventId)],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("excludes Owner and test identities before either canonical or IP persistence", async () => {
    const service = new AnalyticsService(
      adapter,
      {
        enabled: true,
        production: true,
        excludedUserIds: new Set(["synthetic-owner", "synthetic-test"]),
        ownerExclusionConfigured: true,
        hmacKey: randomBytes(32).toString("base64url"),
        forwardingConfigured: true,
        eventRetentionDays: 180,
      },
      () => now,
    );
    for (const userId of ["synthetic-owner", "synthetic-test"]) {
      const batch = input();
      expect(
        await service.collect(batch, {
          userId,
          ip: "192.0.2.11",
          userAgent: "Mozilla/5.0",
          excluded: false,
        }),
      ).toEqual({ accepted: 0, excluded: true });
      expect(
        (
          await pool.query(
            "SELECT event_id FROM community.analytics_events WHERE visitor_id=$1::uuid",
            [batch.visitorId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT id FROM community.analytics_ip_observations WHERE visitor_id=$1::uuid",
            [batch.visitorId],
          )
        ).rowCount,
      ).toBe(0);
    }
  });
  it("has one delivery owner across connections and releases the lock after failure", async () => {
    let unblock: () => void = () => undefined;
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const first = adapter.withDeliveryLock(async () => {
      ready();
      await blocked;
    });
    await started;
    expect(
      await new PostgresAnalyticsAdapter(pool).withDeliveryLock(async () => {
        throw new Error("must not run");
      }),
    ).toBe(false);
    unblock();
    expect(await first).toBe(true);
    await expect(
      adapter.withDeliveryLock(async () => {
        throw new Error("synthetic rejection");
      }),
    ).rejects.toThrow("synthetic rejection");
    expect(await adapter.withDeliveryLock(async () => undefined)).toBe(true);
  });
  it("bounds retry attempts and preserves canonical events after forwarding failure", async () => {
    const batch = input();
    await adapter.append(batch, context());
    await adapter.withDeliveryLock(async (delivery) => {
      for (let attempt = 0; attempt < 9; attempt++)
        await delivery.failed([batch.events[0]!.eventId], now);
    });
    const row = (
      await pool.query<{ attempts: number; failed_at: Date }>(
        "SELECT attempts,failed_at FROM community.analytics_outbox WHERE event_id=$1::uuid",
        [batch.events[0]!.eventId],
      )
    ).rows[0]!;
    expect(row.attempts).toBe(8);
    expect(row.failed_at).toBeInstanceOf(Date);
    expect(
      (
        await pool.query(
          "SELECT event_id FROM community.analytics_events WHERE event_id=$1::uuid",
          [batch.events[0]!.eventId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("never exposes expired IP observations or forwards using the backend IP, and keeps event retention separate", async () => {
    const eightDaysAgo = new Date(now.getTime() - 8 * 86400000),
      old = input();
    await adapter.append(old, context(eightDaysAgo));
    const ancient = input();
    await adapter.append(
      ancient,
      context(new Date(now.getTime() - 181 * 86400000)),
    );
    expect(
      (await adapter.recentIps(now)).items.some(
        (item) => item.visitorId === old.visitorId,
      ),
    ).toBe(false);
    await adapter.withDeliveryLock(async (delivery) => {
      expect(
        (await delivery.pending(100, now)).some(
          (event) => event.eventId === old.events[0]!.eventId,
        ),
      ).toBe(false);
    });
    await adapter.retain(now, 180);
    expect(
      (
        await pool.query(
          "SELECT id FROM community.analytics_ip_observations WHERE visitor_id=ANY($1::uuid[])",
          [[old.visitorId, ancient.visitorId]],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT event_id FROM community.analytics_events WHERE visitor_id=$1::uuid",
          [old.visitorId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT event_id FROM community.analytics_events WHERE visitor_id=$1::uuid",
          [ancient.visitorId],
        )
      ).rowCount,
    ).toBe(0);
  });
});
