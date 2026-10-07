import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProductionCosStorageUrlResolver,
  productionCosOptions,
} from "@moya/backend-production/internal/production-cos";
import type { CosReadOptions } from "@moya/backend-production/internal/cos-read";
import type { CosSdkClient } from "@moya/backend-production/internal/cos-sdk";
import { createCosSdk } from "@moya/backend-production/internal/cos-sdk";

const now = 1_788_820_000_000;
const options = (): CosReadOptions => ({
  bucket: "synthetic-example-1250000000",
  region: "ap-guangzhou",
  mediaOrigin: "https://media.example.invalid",
  credentials: async () => ({
    secretId: "synthetic-unit-id",
    secretKey: "synthetic-unit-secret",
  }),
});
const locator = {
  mediaId: `media_${"a".repeat(32)}`,
  objectKey: `display/v1/media_${"a".repeat(32)}/${"b".repeat(64)}.webp`,
};

afterEach(() => vi.useRealTimers());

describe("production COS signing without Pilot policy", () => {
  it("signs more than 20 authorized database keys without a manifest or network", async () => {
    const network = vi.fn(() => {
      throw new Error("unexpected network");
    });
    const resolver = new ProductionCosStorageUrlResolver(options(), {
      now: () => now,
      nativeRequest: network,
    });
    const locators = Array.from({ length: 35 }, (_, index) => ({
      mediaId: `catalog-media-${index}`,
      objectKey: `editorial/${"a".repeat(64)}/${index.toString(16).padStart(64, "0")}-${"b".repeat(64)}.webp`,
    }));
    const result = await resolver.resolveMany(locators);
    expect(result.size).toBe(35);
    expect(
      new URL(result.get("catalog-media-34")!).searchParams.get("q-sign-time"),
    ).toBe(`${now / 1000};${now / 1000 + 300}`);
    expect(network).not.toHaveBeenCalled();
    expect(resolver).not.toHaveProperty("ensureObject");
  });

  it("resolves no Catalog rendition key in increment 1 and signs nothing for one", async () => {
    const network = vi.fn(() => {
      throw new Error("unexpected network");
    });
    const credentials = vi.fn(options().credentials);
    const resolver = new ProductionCosStorageUrlResolver(
      { ...options(), credentials },
      { now: () => now, nativeRequest: network },
    );
    const resolved = await resolver.resolveKeys([
      `media-rendition-${"1".repeat(32)}`,
      `blobs/aa/bb/${"2".repeat(32)}`,
      locator.objectKey,
    ]);
    // Production Catalog rendition delivery stays off: the approved image
    // keeps its signed src, and no identity signs a rendition read.
    expect(resolved.size).toBe(0);
    expect(credentials).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("preserves approved keys and refreshes short signatures on every read", async () => {
    let time = now;
    const resolver = new ProductionCosStorageUrlResolver(options(), {
      now: () => time,
    });
    const first = new URL(
      (await resolver.resolveMany([locator])).get(locator.mediaId)!,
    );
    expect(decodeURIComponent(first.pathname.slice(1))).toBe(locator.objectKey);
    expect(first.origin).toBe(options().mediaOrigin);
    expect(first.searchParams.get("response-cache-control")).toBe("no-store");
    time += 350_000;
    const refreshed = new URL(
      (await resolver.resolveMany([locator])).get(locator.mediaId)!,
    );
    const [, expiry] = first.searchParams
      .get("q-sign-time")!
      .split(";")
      .map(Number);
    expect(time / 1000).toBeGreaterThan(expiry!);
    expect(refreshed.href).not.toBe(first.href);
    expect(refreshed.searchParams.get("q-sign-time")).toBe(
      `${time / 1000};${time / 1000 + 300}`,
    );
    expect(refreshed.pathname).toBe(first.pathname);
  });

  it("binds the official SDK signature to the object, custom host and signed query", async () => {
    const resolver = new ProductionCosStorageUrlResolver(options(), {
      now: () => now,
    });
    const signed = new URL(
      (await resolver.resolveMany([locator])).get(locator.mediaId)!,
    );
    // Recompute the requested URL with the official SDK. This is an offline
    // signature check, not a claim about a live bucket's authorization setup.
    const expectedSignature = (url: URL): Promise<string | null> =>
      new Promise((resolve, reject) => {
        const { client } = createCosSdk({
          secretId: "synthetic-unit-id",
          secretKey: "synthetic-unit-secret",
          startsAt: now / 1000,
          expiresAt: now / 1000 + 300,
          timeoutMs: 1000,
        });
        client.getObjectUrl(
          {
            Bucket: options().bucket,
            Region: options().region,
            Key: decodeURIComponent(url.pathname.slice(1)),
            Domain: url.host,
            Protocol: "https:",
            Method: "GET",
            Sign: true,
            Expires: 300,
            Query: {
              "response-cache-control": url.searchParams.get(
                "response-cache-control",
              )!,
            },
          },
          (error, data) => {
            if (error) reject(new Error("synthetic signing failed"));
            else resolve(new URL(data.Url).searchParams.get("q-signature"));
          },
        );
      });
    expect(await expectedSignature(signed)).toBe(
      signed.searchParams.get("q-signature"),
    );
    const changedObject = new URL(signed);
    changedObject.pathname = changedObject.pathname.replace(
      "b".repeat(64),
      "c".repeat(64),
    );
    const changedHost = new URL(signed);
    changedHost.hostname = "other-media.example.invalid";
    const changedQuery = new URL(signed);
    changedQuery.searchParams.set("response-cache-control", "public");
    for (const tampered of [changedObject, changedHost, changedQuery])
      expect(await expectedSignature(tampered)).not.toBe(
        tampered.searchParams.get("q-signature"),
      );
  });

  it("bounds signed STS reads by credential expiry and signs the encoded token", async () => {
    const resolver = new ProductionCosStorageUrlResolver(
      {
        ...options(),
        credentials: async () => ({
          secretId: "synthetic-unit-id",
          secretKey: "synthetic-unit-secret",
          securityToken: ["synthetic-unit-token", "+/="].join(""),
          expiresAt: now / 1000 + 90,
        }),
      },
      { now: () => now },
    );
    const url = new URL(
      (await resolver.resolveMany([locator])).get(locator.mediaId)!,
    );
    expect(url.searchParams.get("q-sign-time")).toBe(
      `${now / 1000};${now / 1000 + 90}`,
    );
    expect(url.searchParams.get("x-cos-security-token")).toBe(
      ["synthetic-unit-token", "+/="].join(""),
    );
    expect(url.searchParams.get("q-url-param-list")).toContain(
      "x-cos-security-token",
    );
  });

  it.each([
    "",
    "/outside",
    "originals/../outside",
    "originals/./outside",
    "originals\\outside",
    "originals/\u0000outside",
    "catalog-originals/approved existing/原圖 100%.webp",
    "originals/person@example.invalid.webp",
    "/Users/synthetic-owner/Desktop/原图.webp",
    `editorial/${"a".repeat(64)}/original-title.webp`,
  ])(
    "rejects unsafe object key before credential access",
    async (objectKey) => {
      const credentials = vi.fn(options().credentials);
      const resolver = new ProductionCosStorageUrlResolver({
        ...options(),
        credentials,
      });
      await expect(
        resolver.resolveMany([{ ...locator, objectKey }]),
      ).rejects.toThrow("COS object key invalid");
      expect(credentials).not.toHaveBeenCalled();
    },
  );

  it.each([
    { signedUrlTtlSeconds: 59 },
    { signedUrlTtlSeconds: 601 },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 120_001 },
    { bucket: "wrong" },
    { region: "wrong" },
    { mediaOrigin: "http://media.example.invalid" },
    {
      mediaOrigin:
        "https://synthetic-example-1250000000.cos.ap-guangzhou.myqcloud.com",
    },
    {
      mediaOrigin:
        "https://synthetic-example-1250000000.cos.ap-guangzhou.tencentcos.cn",
    },
  ])("fails closed on invalid storage configuration", (invalid) => {
    expect(
      () => new ProductionCosStorageUrlResolver({ ...options(), ...invalid }),
    ).toThrow(/^COS /);
  });

  it("redacts credential and SDK failures", async () => {
    const resolver = new ProductionCosStorageUrlResolver({
      ...options(),
      credentials: async () => {
        throw new Error("unit-only-private-detail");
      },
    });
    await expect(resolver.resolveMany([locator])).rejects.toThrow(
      /^COS credentials unavailable$/,
    );
    const failed = new ProductionCosStorageUrlResolver(options(), {
      now: () => now,
      sdkFactory: () => {
        throw new Error("unit-only-signed-request");
      },
    });
    await expect(failed.resolveMany([locator])).rejects.toThrow(
      /^COS URL signing failed$/,
    );
  });

  it("stops issuing new URLs after temporary credentials expire", async () => {
    let time = now;
    const resolver = new ProductionCosStorageUrlResolver(
      {
        ...options(),
        credentials: async () => ({
          secretId: "synthetic-unit-id",
          secretKey: "synthetic-unit-secret",
          securityToken: "synthetic-unit-token",
          expiresAt: now / 1000 + 90,
        }),
      },
      { now: () => time },
    );
    await expect(resolver.resolveMany([locator])).resolves.toHaveProperty(
      "size",
      1,
    );
    time += 90_000;
    await expect(resolver.resolveMany([locator])).rejects.toThrow(
      /^COS credentials expired or insufficient validity$/,
    );
  });

  it("applies an absolute deadline to stalled credential resolution and SDK callbacks", async () => {
    vi.useFakeTimers();
    const waiting = new ProductionCosStorageUrlResolver({
      ...options(),
      requestTimeoutMs: 10,
      credentials: () => new Promise(() => {}),
    });
    const credentials = expect(waiting.resolveMany([locator])).rejects.toThrow(
      /^COS URL signing failed$/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await credentials;
    const stalled = new ProductionCosStorageUrlResolver(
      { ...options(), requestTimeoutMs: 10 },
      {
        now: () => now,
        sdkFactory: () =>
          ({ getObjectUrl: () => {} }) as unknown as CosSdkClient,
      },
    );
    const callback = expect(stalled.resolveMany([locator])).rejects.toThrow(
      /^COS URL signing failed$/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await callback;
  });
});

describe("production COS environment", () => {
  const environment = {
    COS_BUCKET: "synthetic-example-1250000000",
    COS_REGION: "ap-guangzhou",
    COS_MEDIA_ORIGIN: "https://media.example.invalid",
    COS_SECRET_ID: "synthetic-unit-id",
    COS_SECRET_KEY: "synthetic-unit-secret",
  };

  it.each(Object.keys(environment))(
    "requires %s without reading files or making cloud requests",
    (key) => {
      expect(() =>
        productionCosOptions({ ...environment, [key]: undefined }),
      ).toThrow(`Production COS configuration missing or invalid: ${key}`);
    },
  );

  it("does not use Pilot files and rejects malformed optional limits or partial STS", () => {
    expect(
      () =>
        new ProductionCosStorageUrlResolver(
          productionCosOptions({
            ...environment,
            MOYA_PILOT_SCOPE_FILE: "unused",
            MOYA_PILOT_MEDIA_FILE: "unused",
          }),
        ),
    ).not.toThrow();
    expect(() =>
      productionCosOptions({
        ...environment,
        COS_SECURITY_TOKEN: "synthetic-unit-token",
      }),
    ).toThrow("COS_CREDENTIAL_EXPIRES_AT");
    expect(() =>
      productionCosOptions({ ...environment, COS_REQUEST_TIMEOUT_MS: "1e3" }),
    ).toThrow("COS_REQUEST_TIMEOUT_MS");
  });
});
