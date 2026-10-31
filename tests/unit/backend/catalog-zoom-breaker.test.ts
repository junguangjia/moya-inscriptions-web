import {
  CATALOG_ZOOM_USAGE_CACHE_MS,
  CATALOG_ZOOM_USAGE_LIMITS,
  catalogZoomBreakerTripped,
  catalogZoomUsageAt,
  createCatalogZoomGate,
} from "@moya/backend-production/internal/media-publication-worker";
import {
  MEDIA_CATALOG_ZOOM_BLOCKS,
  parseCatalogZoomSwitch,
} from "@moya/backend-production/internal/publishing-config";
import { describe, expect, it, vi } from "vitest";

import type { CatalogZoomDayUsage } from "@moya/backend-production/internal/media-publication-worker";

/*
 * catalog-deep-zoom-v1 (Issue #295), criteria 13 and 21: the Backend's
 * deep-zoom gate. With edge delivery the breaker fails closed (no row for
 * today, or an observation older than an hour, hides blocks) and trips at
 * 150,000 requests or 0.4 GB (catalog-deep-zoom-self-master-v1; it was 5 GB,
 * and the warning 0.25 GB, was 3 GB); without edge delivery (Development's relay) only
 * a row for today that reaches a trip threshold trips it. The usage row is
 * read at most once a minute; the switch accepts only on or off.
 */

// 2026-10-08 20:00 Asia/Shanghai; the cap's day began at 2026-10-07T16:00Z.
const NOW = new Date("2026-10-08T12:00:00.000Z");
const TODAY = new Date("2026-10-07T16:00:00.000Z");
const row = (
  extra: Partial<CatalogZoomDayUsage> = {},
): CatalogZoomDayUsage => ({
  dayStart: TODAY,
  requests: 1_000,
  bytes: 10_000_000,
  observedAt: new Date(NOW.getTime() - 10 * 60_000),
  ...extra,
});

describe("the deep-zoom breaker", () => {
  it("with edge delivery: closed for a fresh row below the trip points, tripped otherwise", () => {
    expect(catalogZoomBreakerTripped(row(), NOW, true)).toBe(false);
    expect(catalogZoomBreakerTripped(null, NOW, true)).toBe(true);
    expect(
      catalogZoomBreakerTripped(
        row({ dayStart: new Date("2026-10-06T16:00:00.000Z") }),
        NOW,
        true,
      ),
    ).toBe(true);
    expect(
      catalogZoomBreakerTripped(
        row({ observedAt: new Date(NOW.getTime() - 61 * 60_000) }),
        NOW,
        true,
      ),
    ).toBe(true);
    expect(
      catalogZoomBreakerTripped(
        row({ observedAt: new Date(NOW.getTime() - 60 * 60_000) }),
        NOW,
        true,
      ),
    ).toBe(false);
    for (const [requests, bytes, tripped] of [
      [149_999, 399_999_999, false],
      [150_000, 0, true],
      [0, 400_000_000, true],
      [100_000, 250_000_000, false],
      // The old 5 GB trip point is far past the new one.
      [0, 4_999_999_999, true],
    ] as const)
      expect(
        catalogZoomBreakerTripped(row({ requests, bytes }), NOW, true),
        `${requests} ${bytes}`,
      ).toBe(tripped);
    // A provider without a traffic figure trips on requests only.
    expect(
      catalogZoomBreakerTripped(
        row({ requests: 150_000, bytes: null }),
        NOW,
        true,
      ),
    ).toBe(true);
    expect(catalogZoomBreakerTripped(row({ bytes: null }), NOW, true)).toBe(
      false,
    );
  });

  it("without edge delivery: a missing or stale row stays closed; today's tripping row trips it", () => {
    expect(catalogZoomBreakerTripped(null, NOW, false)).toBe(false);
    expect(
      catalogZoomBreakerTripped(
        row({ observedAt: new Date(NOW.getTime() - 5 * 60 * 60_000) }),
        NOW,
        false,
      ),
    ).toBe(false);
    expect(
      catalogZoomBreakerTripped(row({ requests: 150_000 }), NOW, false),
    ).toBe(true);
    // Yesterday's tripping row no longer counts: the breaker resets at the cap's next day.
    expect(
      catalogZoomBreakerTripped(
        row({
          requests: 150_000,
          dayStart: new Date("2026-10-06T16:00:00.000Z"),
        }),
        NOW,
        false,
      ),
    ).toBe(false);
  });

  it("warns at 100,000 requests or 0.25 GB", () => {
    expect(
      catalogZoomUsageAt({ requests: 99_999, bytes: 249_999_999 }, "warning"),
    ).toBe(false);
    expect(catalogZoomUsageAt({ requests: 100_000, bytes: 0 }, "warning")).toBe(
      true,
    );
    expect(
      catalogZoomUsageAt({ requests: 0, bytes: 250_000_000 }, "warning"),
    ).toBe(true);
    // Between the two lines: a warning, no trip.
    expect(
      catalogZoomUsageAt({ requests: 0, bytes: 399_999_999 }, "trip"),
    ).toBe(false);
  });

  it("records the thresholds: requests unchanged, bytes 0.25 GB and 0.4 GB (pending the Owner's confirmation)", () => {
    expect(CATALOG_ZOOM_USAGE_LIMITS).toEqual({
      warningRequests: 100_000,
      warningBytes: 250_000_000,
      tripRequests: 150_000,
      tripBytes: 400_000_000,
      staleMs: 60 * 60 * 1_000,
    });
  });
});

describe("the Backend's deep-zoom gate", () => {
  it("is closed where blocks cannot be delivered, without reading usage", async () => {
    const readUsage = vi.fn(async () => row());
    const gate = createCatalogZoomGate({
      readUsage,
      edgeDelivery: () => false,
      development: false,
      clock: () => NOW,
    });
    expect(await gate.isOpen()).toBe(false);
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("reads the usage row at most once a minute and evaluates each call", async () => {
    let now = NOW;
    let usage: CatalogZoomDayUsage | null = row();
    const readUsage = vi.fn(async () => usage);
    const gate = createCatalogZoomGate({
      readUsage,
      edgeDelivery: () => true,
      development: false,
      clock: () => now,
    });
    expect(await gate.isOpen()).toBe(true);
    usage = row({ requests: 200_000 });
    now = new Date(NOW.getTime() + CATALOG_ZOOM_USAGE_CACHE_MS - 1);
    expect(await gate.isOpen()).toBe(true);
    expect(readUsage).toHaveBeenCalledTimes(1);
    now = new Date(NOW.getTime() + CATALOG_ZOOM_USAGE_CACHE_MS);
    expect(await gate.isOpen()).toBe(false);
    expect(readUsage).toHaveBeenCalledTimes(2);
  });

  it("treats a failed usage read as missing: closed with edge delivery, open on the Development relay", async () => {
    const logger = { error: vi.fn() };
    const failing = vi.fn(async (): Promise<CatalogZoomDayUsage | null> => {
      throw new Error("pool unavailable");
    });
    expect(
      await createCatalogZoomGate({
        readUsage: failing,
        edgeDelivery: () => true,
        development: false,
        clock: () => NOW,
        logger,
      }).isOpen(),
    ).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "[catalog-zoom] usage_unavailable",
    );
    expect(
      await createCatalogZoomGate({
        readUsage: failing,
        edgeDelivery: () => false,
        development: true,
        clock: () => NOW,
        logger,
      }).isOpen(),
    ).toBe(true);
  });
});

describe("MEDIA_CATALOG_ZOOM_BLOCKS", () => {
  it("accepts only on or off; missing means on in Development and off in Production", () => {
    expect(MEDIA_CATALOG_ZOOM_BLOCKS).toBe("MEDIA_CATALOG_ZOOM_BLOCKS");
    expect(
      parseCatalogZoomSwitch({}, MEDIA_CATALOG_ZOOM_BLOCKS, "development"),
    ).toBe(true);
    expect(
      parseCatalogZoomSwitch({}, MEDIA_CATALOG_ZOOM_BLOCKS, "production"),
    ).toBe(false);
    expect(
      parseCatalogZoomSwitch(
        { MEDIA_CATALOG_ZOOM_BLOCKS: "off" },
        MEDIA_CATALOG_ZOOM_BLOCKS,
        "development",
      ),
    ).toBe(false);
    expect(() =>
      parseCatalogZoomSwitch(
        { MEDIA_CATALOG_ZOOM_BLOCKS: "true" },
        MEDIA_CATALOG_ZOOM_BLOCKS,
        "production",
      ),
    ).toThrow(/MEDIA_CATALOG_ZOOM_BLOCKS must be on or off/u);
  });
});
