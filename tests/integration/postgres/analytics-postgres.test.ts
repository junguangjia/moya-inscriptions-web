import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AnalyticsService } from "@moya/api";
import type { AnalyticsWriteContext } from "@moya/api";
import type { AnalyticsBatch } from "@moya/contracts/analytics";
import { ANALYTICS_IP_RETENTION_DAYS } from "@moya/contracts/analytics";
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
  it("extends only unexpired legacy IP observations and allows 7/60-day rolling writers", async () => {
    const connection = await pool.connect();
    const table = `analytics_retention_${randomUUID().replaceAll("-", "")}`;
    const migration = await readFile(
      new URL(
        "../../../database/community-migrations/20261028010000_analytics_ip_retention_60_days.sql",
        import.meta.url,
      ),
      "utf8",
    );
    try {
      await connection.query("BEGIN");
      await connection.query(`CREATE TEMP TABLE ${table} (
        label TEXT PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT analytics_ip_observations_check CHECK (
          expires_at = received_at + INTERVAL '7 days'
        )
      ) ON COMMIT DROP`);
      await connection.query(`INSERT INTO ${table} VALUES
        ('active', CURRENT_TIMESTAMP - INTERVAL '2 days', CURRENT_TIMESTAMP + INTERVAL '5 days'),
        ('expired', CURRENT_TIMESTAMP - INTERVAL '8 days', CURRENT_TIMESTAMP - INTERVAL '1 day'),
        ('boundary', CURRENT_TIMESTAMP - INTERVAL '7 days', CURRENT_TIMESTAMP)`);
      await connection.query(
        migration.replaceAll("community.analytics_ip_observations", table),
      );
      const result = await connection.query<{ label: string; days: number }>(
        `SELECT label, (EXTRACT(EPOCH FROM expires_at-received_at)/86400)::integer AS days FROM ${table} ORDER BY label`,
      );
      expect(result.rows).toEqual([
        { label: "active", days: 60 },
        { label: "boundary", days: 7 },
        { label: "expired", days: 7 },
      ]);
      await connection.query(`INSERT INTO ${table} VALUES
        ('old-writer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '7 days'),
        ('new-writer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '60 days')`);
      await expect(
        connection.query(`INSERT INTO ${table} VALUES
          ('unapproved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days')`),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  });
  it("retains new IP observations for 60 days across the former seven-day cutoff", async () => {
    const observedAt = new Date(now.getTime() - 8 * 86400000);
    const sample = input();
    await adapter.append(sample, context(observedAt));
    const stored = (
      await pool.query<{ expires_at: Date }>(
        "SELECT expires_at FROM community.analytics_ip_observations WHERE visitor_id=$1::uuid",
        [sample.visitorId],
      )
    ).rows[0]!;
    expect(stored.expires_at.getTime()).toBe(
      observedAt.getTime() + ANALYTICS_IP_RETENTION_DAYS * 86400000,
    );
    const justBeforeExpiry = new Date(stored.expires_at.getTime() - 1);
    expect(
      (await adapter.recentIps(justBeforeExpiry)).items.some(
        (item) => item.visitorId === sample.visitorId,
      ),
    ).toBe(true);
    expect(
      (await adapter.recentIps(stored.expires_at)).items.some(
        (item) => item.visitorId === sample.visitorId,
      ),
    ).toBe(false);
  });
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
  it("forwards canonical browser keys across login while keeping equal-UA/IP browsers distinct and hints optional", async () => {
    const anonymous = input();
    anonymous.clientHints = {
      brands: [{ brand: "Chromium", version: "130" }],
      platform: "Android",
      model: " Pixel 8 ",
      mobile: true,
    };
    const signedIn = input();
    signedIn.visitorId = anonymous.visitorId;
    signedIn.clientHints = anonymous.clientHints;
    const otherBrowser = input();
    const events = [anonymous, signedIn, otherBrowser];
    let received = now.getTime();
    const service = new AnalyticsService(
      adapter,
      {
        enabled: true,
        production: true,
        excludedUserIds: new Set(),
        ownerExclusionConfigured: true,
        hmacKey: randomBytes(32).toString("base64url"),
        forwardingConfigured: true,
        eventRetentionDays: 180,
      },
      () => new Date(received++),
    );
    for (const [index, batch] of events.entries())
      expect(
        await service.collect(batch, {
          userId: index === 1 ? "synthetic-reader" : null,
          excluded: false,
          ip: context().ip,
          userAgent: context().userAgent,
        }),
      ).toEqual({ accepted: 1, excluded: false });
    const stored = (
      await pool.query<{ event_data: Record<string, unknown> }>(
        "SELECT event_data FROM community.analytics_events WHERE event_id=$1::uuid",
        [anonymous.events[0]!.eventId],
      )
    ).rows[0]!.event_data;
    expect(stored.moyaClientHints).toEqual({
      ...anonymous.clientHints,
      model: "Pixel 8",
    });
    expect(stored).not.toHaveProperty("moyaBrowserId");
    expect(stored).not.toHaveProperty("moyaAccountId");
    // Even an out-of-band legacy metadata claim cannot override canonical identity.
    await pool.query(
      "UPDATE community.analytics_events SET event_data=event_data || $2::jsonb WHERE event_id=$1::uuid",
      [
        anonymous.events[0]!.eventId,
        JSON.stringify({
          moyaBrowserId: "forged-browser",
          moyaAccountId: "forged-account",
          moyaClientHints: { model: "a".repeat(129) },
        }),
      ],
    );
    const ids = events.map((batch) => batch.events[0]!.eventId);
    await adapter.withDeliveryLock(async (delivery) => {
      const forwarded = new Map(
        (await delivery.pending(100, new Date(received)))
          .filter((event) => ids.includes(event.eventId))
          .map((event) => [event.eventId, event.payload]),
      );
      expect(forwarded.size).toBe(3);
      const a = forwarded.get(ids[0]!)!;
      const b = forwarded.get(ids[1]!)!;
      const c = forwarded.get(ids[2]!)!;
      const aData = a.data as Record<string, unknown>;
      const bData = b.data as Record<string, unknown>;
      const cData = c.data as Record<string, unknown>;
      expect(aData.moyaBrowserId).toBe(anonymous.visitorId);
      expect(bData.moyaBrowserId).toBe(anonymous.visitorId);
      expect(cData.moyaBrowserId).toBe(otherBrowser.visitorId);
      expect(cData.moyaBrowserId).not.toBe(aData.moyaBrowserId);
      expect(aData).not.toHaveProperty("moyaAccountId");
      expect(cData).not.toHaveProperty("moyaAccountId");
      expect(bData.moyaAccountId).toBe(b.id);
      expect(bData.moyaAccountId).toMatch(/^[0-9a-f]{40}$/u);
      expect(a.id).not.toBe(b.id);
      expect(aData).not.toHaveProperty("moyaClientHints");
      expect(cData).not.toHaveProperty("moyaClientHints");
      expect(bData.moyaClientHints).toEqual({
        ...signedIn.clientHints,
        model: "Pixel 8",
      });
      expect(a.ip).toBe(c.ip);
      expect(a.userAgent).toBe(c.userAgent);
      await delivery.delivered(ids, new Date(received));
    });
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
    const beyondIpRetention = new Date(
        now.getTime() - (ANALYTICS_IP_RETENTION_DAYS + 1) * 86400000,
      ),
      old = input();
    await adapter.append(old, context(beyondIpRetention));
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
