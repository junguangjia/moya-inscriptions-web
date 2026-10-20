import { randomBytes, randomUUID } from "node:crypto";
import { AnalyticsService } from "@moya/api";
import type {
  AnalyticsDeliveryPort,
  AnalyticsPolicy,
  AnalyticsPort,
} from "@moya/api";
import { analyticsBatchSchema } from "@moya/contracts/analytics";
import type { AnalyticsBatch } from "@moya/contracts/analytics";
import {
  AnalyticsWorker,
  parseAnalyticsConfiguration,
} from "@moya/backend-production/internal/analytics";
import { describe, expect, it, vi } from "vitest";

const now = new Date("2026-10-19T12:00:00Z");
const batch = (): AnalyticsBatch => ({
  visitorId: randomUUID(),
  sessionId: randomUUID(),
  events: [
    {
      eventId: randomUUID(),
      name: "content_open",
      targetType: "catalog",
      targetId: "catalog-synthetic",
      surface: "detail",
      occurredAt: now.toISOString(),
    },
  ],
});
const policy = (): AnalyticsPolicy => ({
  enabled: true,
  production: true,
  excludedUserIds: new Set(["synthetic-owner", "synthetic-test"]),
  ownerExclusionConfigured: true,
  hmacKey: randomBytes(32).toString("base64url"),
  forwardingConfigured: true,
  eventRetentionDays: 180,
});
const fakePort = () => {
  const delivery: AnalyticsDeliveryPort = {
    pending: vi.fn(async () => []),
    delivered: vi.fn(async () => undefined),
    failed: vi.fn(async () => undefined),
  };
  const port: AnalyticsPort = {
    append: vi.fn(async (input: AnalyticsBatch) => input.events.length),
    status: vi.fn(async () => ({
      last24Hours: { events: 0, visitors: 0, users: 0, sessions: 0 },
      outbox: { pending: 0, failed: 0 },
      lastEventAt: null,
      lastForwardedAt: null,
    })),
    recentIps: vi.fn(async () => ({ items: [] })),
    withDeliveryLock: vi.fn(async (run) => {
      await run(delivery);
      return true;
    }),
    retain: vi.fn(async () => undefined),
  };
  return { port, delivery };
};
describe("bounded analytics contract", () => {
  it("rejects caller identity/IP claims, unknown events, oversized batches and unpaired targets", () => {
    expect(analyticsBatchSchema.safeParse(batch()).success).toBe(true);
    for (const field of ["userId", "ip", "owner", "country"])
      expect(
        analyticsBatchSchema.safeParse({ ...batch(), [field]: "forged" })
          .success,
      ).toBe(false);
    const base = batch();
    for (const event of [
      { ...base.events[0], ip: "192.0.2.1" },
      { ...base.events[0], name: "autocapture" },
      { ...base.events[0], targetId: undefined },
      { ...base.events[0], searchQuery: "a".repeat(101) },
    ])
      expect(
        analyticsBatchSchema.safeParse({ ...base, events: [event] }).success,
      ).toBe(false);
    expect(
      analyticsBatchSchema.safeParse({
        ...base,
        events: Array.from({ length: 21 }, () => base.events[0]),
      }).success,
    ).toBe(false);
  });
});
describe("server-owned analytics classification", () => {
  it("discards Owner, test, opted-out and known automation before any persistent operation", async () => {
    const { port } = fakePort(),
      service = new AnalyticsService(port, policy(), () => now);
    for (const context of [
      { userId: "synthetic-owner", excluded: false, userAgent: "Mozilla/5.0" },
      { userId: "synthetic-test", excluded: false, userAgent: "Mozilla/5.0" },
      { userId: null, excluded: true, userAgent: "Mozilla/5.0" },
      { userId: null, excluded: false, userAgent: "HeadlessChrome/130" },
    ])
      expect(
        await service.collect(batch(), { ...context, ip: "192.0.2.1" }),
      ).toEqual({ accepted: 0, excluded: true });
    expect(port.append).not.toHaveBeenCalled();
  });
  it("disabled and non-production never persist or permanently classify visitors as opted out", async () => {
    const { port } = fakePort();
    for (const change of [{ enabled: false }, { production: false }]) {
      const service = new AnalyticsService(
        port,
        { ...policy(), ...change },
        () => now,
      );
      expect(
        await service.collect(batch(), {
          userId: null,
          excluded: false,
          userAgent: "Mozilla/5.0",
          ip: "192.0.2.1",
        }),
      ).toEqual({ accepted: 0, excluded: false });
    }
    expect(port.append).not.toHaveBeenCalled();
  });
  it("derives stable non-reversible user identity server-side, while anonymous visitors stay distinct", async () => {
    const { port } = fakePort(),
      configuration = policy(),
      service = new AnalyticsService(port, configuration, () => now),
      input = batch();
    const context = {
      userId: "synthetic-reader",
      excluded: false,
      userAgent: "Mozilla/5.0",
      ip: "192.0.2.1",
    };
    await service.collect(input, context);
    await service.collect({ ...input, visitorId: randomUUID() }, context);
    await service.collect(input, { ...context, userId: null });
    const calls = vi.mocked(port.append).mock.calls;
    expect(calls[0]![1].distinctId).toMatch(/^[0-9a-f]{40}$/);
    expect(calls[0]![1].distinctId).toBe(calls[1]![1].distinctId);
    expect(calls[0]![1].distinctId).not.toBe(calls[2]![1].distinctId);
    expect(calls[0]![1].userId).toBe("synthetic-reader");
    await expect(
      service.collect(
        {
          ...input,
          events: [{ ...input.events[0]!, occurredAt: "2026-10-17T00:00:00Z" }],
        },
        context,
      ),
    ).rejects.toThrow("time");
    expect(port.append).toHaveBeenCalledTimes(3);
  });
});
describe("analytics configuration", () => {
  const environment = () => ({
    MOYA_ANALYTICS_ENABLED: "true",
    ANALYTICS_OWNER_USER_IDS: "synthetic-owner,synthetic-owner-two",
    ANALYTICS_TEST_USER_IDS: "synthetic-test",
    ANALYTICS_HMAC_KEY: randomBytes(32).toString("base64url"),
    ANALYTICS_RELAY_TOKEN: randomBytes(32).toString("base64url"),
    UMAMI_ORIGIN: "http://127.0.0.1:3010",
    UMAMI_WEBSITE_ID: randomUUID(),
  });
  it("fails closed before startup without Owner exclusions or separated protected relay material", () => {
    expect(() =>
      parseAnalyticsConfiguration(
        { ...environment(), ANALYTICS_OWNER_USER_IDS: "" },
        "production",
      ),
    ).toThrow("OWNER_USER_IDS");
    expect(() =>
      parseAnalyticsConfiguration(
        { ...environment(), ANALYTICS_RELAY_TOKEN: "placeholder" },
        "production",
      ),
    ).toThrow("ANALYTICS_RELAY_TOKEN");
    expect(() =>
      parseAnalyticsConfiguration(
        { ...environment(), UMAMI_ORIGIN: "https://external.example.invalid" },
        "production",
      ),
    ).toThrow("loopback");
    expect(() =>
      parseAnalyticsConfiguration(
        { ...environment(), DATABASE_POOL_MAX: "1" },
        "production",
      ),
    ).toThrow("at least 2");
    const configured = parseAnalyticsConfiguration(environment(), "production");
    expect([...configured.policy.excludedUserIds]).toEqual([
      "synthetic-owner",
      "synthetic-owner-two",
      "synthetic-test",
    ]);
    expect(configured.policy.eventRetentionDays).toBe(180);
    expect(
      parseAnalyticsConfiguration(environment(), "development").policy.enabled,
    ).toBe(false);
  });
});
describe("Umami bounded forwarding", () => {
  it("sends true source/UA/HMAC per event and retries only failed indices", async () => {
    const { port, delivery } = fakePort();
    const eventIds = [randomUUID(), randomUUID()];
    vi.mocked(delivery.pending).mockResolvedValue(
      eventIds.map((eventId) => ({
        eventId,
        attempts: 0,
        payload: {
          ip: "192.0.2.1",
          userAgent: "Mozilla/5.0",
          id: "opaque-id",
          url: "/analytics/detail/catalog/example",
          name: "content_open",
        },
      })),
    );
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        size: 2,
        processed: 1,
        errors: 1,
        details: [{ index: 1, response: { error: "synthetic" } }],
      }),
    );
    const worker = new AnalyticsWorker(
      port,
      { origin: "http://127.0.0.1:3010", websiteId: randomUUID() },
      180,
      fetcher,
      () => now,
    );
    await worker.tick();
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:3010/admin/analytics-workspace/api/batch",
    );
    const sent = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(sent[0].payload).toMatchObject({
      ip: "192.0.2.1",
      userAgent: "Mozilla/5.0",
      id: "opaque-id",
    });
    expect(delivery.delivered).toHaveBeenCalledWith([eventIds[0]], now);
    expect(delivery.failed).toHaveBeenCalledWith([eventIds[1]], now);
    expect(port.retain).toHaveBeenCalledTimes(1);
  });
  it("bounds network time, retains durable retries, and never throws into the Product", async () => {
    const { port, delivery } = fakePort(),
      eventId = randomUUID();
    vi.mocked(delivery.pending).mockResolvedValue([
      { eventId, attempts: 0, payload: { ip: "192.0.2.1" } },
    ]);
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new Error("synthetic outage");
    });
    const worker = new AnalyticsWorker(
      port,
      { origin: "http://127.0.0.1:3010", websiteId: randomUUID() },
      180,
      fetcher,
      () => now,
    );
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(delivery.failed).toHaveBeenCalledWith([eventId], now);
    expect(delivery.delivered).not.toHaveBeenCalled();
  });
});
