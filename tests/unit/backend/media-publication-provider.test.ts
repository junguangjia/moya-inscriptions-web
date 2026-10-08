import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowsEdgeDelivery,
  allowsPublication,
  parsePublicationConfig,
  createEdgeWithdrawalVerifier,
  createLocalPublicationProvider,
  publishedObjectUrl,
  validatePublishedKey,
  validatePurgeTarget,
  PUBLICATION_CACHE_CONTROL,
  publicationPlanMonth,
  createPublisherRoleCredentials,
  createTencentPublicationApi,
  createTencentPublicationProvider,
} from "@moya/backend-production/internal/publication";
import { PublishingCosResponseError } from "@moya/backend-production/internal/publishing-media-store";

import type { RequestOptions, request as httpsRequest } from "node:https";
import type { IncomingMessage, RequestListener } from "node:http";
import type {
  PublicationConfig,
  TencentPublicationApi,
} from "@moya/backend-production/internal/publication";
import type { PublishingCosTransport } from "@moya/backend-production/internal/publishing-media-store";

const origin = "https://media.synthetic.test";
const key = `v1/${"a".repeat(32)}/${"b".repeat(32)}/base/display.r1.webp`;
const target = `${origin}/${key}`;
const bytes = Buffer.from("synthetic-derived-media");
const digest = createHash("md5").update(bytes).digest("hex");
const credentials = async () => ({
  secretId: "synthetic-unit-id",
  secretKey: "synthetic-unit-secret",
});
const configured = {
  PRODUCT_ACCESS_MODE: "public",
  MEDIA_PUBLICATION: "on",
  MEDIA_PUBLIC_DELIVERY: "edge",
  MEDIA_PUBLISHED_ORIGIN: origin,
  MEDIA_PUBLISHED_COS_BUCKET: "synthetic-published-12345",
  MEDIA_PUBLISHED_COS_REGION: "ap-guangzhou",
  MEDIA_PUBLISHER_ROLE_ARN: "qcs::cam::uin/12345:roleName/synthetic-publisher",
  MEDIA_EDGE_ZONE_ID: "zone-synthetic",
};
const config = parsePublicationConfig(configured, "production");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const unit = {
  objectKey: key,
  contentType: "image/webp" as const,
  byteSize: bytes.length,
};

const fixture = (
  settings: {
    readonly wrongHash?: boolean;
    readonly absent?: boolean;
    readonly headStatus?: number;
  } = {},
) => {
  const calls: { method: string; parameters: Record<string, unknown> }[] = [];
  const transport: PublishingCosTransport = {
    async request<T>(
      method: Parameters<PublishingCosTransport["request"]>[0],
      parameters: Record<string, unknown>,
    ) {
      calls.push({ method, parameters });
      if (method === "headObject" && settings.headStatus)
        throw new PublishingCosResponseError(settings.headStatus);
      if (method === "headObject" && settings.absent)
        throw new PublishingCosResponseError(404);
      if (method === "putObject") {
        for await (const chunk of parameters.Body as Readable)
          expect(Buffer.isBuffer(chunk)).toBe(true);
      }
      return {
        statusCode: 200,
        headers: {
          "content-length": String(bytes.length),
          etag: `"${settings.wrongHash ? "c".repeat(32) : digest}"`,
        },
        ETag: `"${digest}"`,
        rawBody: Buffer.alloc(0),
      } as unknown as T & { rawBody: Buffer };
    },
  };
  const apiCalls: {
    action: string;
    input: Readonly<Record<string, unknown>>;
  }[] = [];
  let response: Readonly<Record<string, unknown>> = {
    JobId: "synthetic-job",
    FailedList: [],
  };
  const api: TencentPublicationApi = {
    async call(action, input) {
      apiCalls.push({ action, input });
      return response;
    },
  };
  const verifyGone = vi.fn(async () => true);
  const provider = createTencentPublicationProvider(
    config,
    { credentials },
    { cosTransport: transport, api, verifyGone },
  );
  return {
    provider,
    transport,
    api,
    verifyGone,
    calls,
    apiCalls,
    respond: (value: Readonly<Record<string, unknown>>) => {
      response = value;
    },
  };
};

describe("publication access-mode preparation", () => {
  it("refuses Beta publication and unsigned URL delivery even if both switches are enabled", async () => {
    const beta = parsePublicationConfig(
      { ...configured, PRODUCT_ACCESS_MODE: "closed-beta" },
      "production",
    );
    expect(allowsPublication(beta)).toBe(false);
    expect(allowsEdgeDelivery(beta)).toBe(false);
    const f = fixture();
    let streamed = false;
    let acquired = false;
    const source = (async function* () {
      streamed = true;
      yield bytes;
    })();
    const provider = createTencentPublicationProvider(
      beta,
      {
        credentials: async () => {
          acquired = true;
          return credentials();
        },
      },
      { cosTransport: f.transport, api: f.api },
    );
    await expect(provider.write(unit, source)).rejects.toMatchObject({
      code: "disabled",
    });
    expect({ streamed, acquired }).toEqual({
      streamed: false,
      acquired: false,
    });
    expect(f.calls).toEqual([]);
    expect(f.apiCalls).toEqual([]);
  });
  it("defaults to off/relay and a missing worker production mode conservatively denies", () => {
    const disabled = parsePublicationConfig({}, "production");
    expect(disabled).toMatchObject({
      productMode: "closed-beta",
      publication: "off",
      delivery: "relay",
    });
    expect(allowsPublication(disabled)).toBe(false);
    expect(allowsEdgeDelivery(disabled)).toBe(false);
    expect(() =>
      parsePublicationConfig(
        { PRODUCT_ACCESS_MODE: "invalid-synthetic-value" },
        "production",
      ),
    ).toThrow("PRODUCT_ACCESS_MODE");
    expect(() =>
      parsePublicationConfig(
        { PRODUCT_ACCESS_MODE: "public", MEDIA_PUBLICATION: "on" },
        "production",
      ),
    ).toThrow("MEDIA_PUBLISHED_ORIGIN");
    expect(() =>
      parsePublicationConfig(
        { MEDIA_PUBLISHED_LOCAL_ROOT: "/private/tmp/synthetic" },
        "production",
      ),
    ).toThrow("MEDIA_PUBLISHED_LOCAL_ROOT");
  });
  it("keeps delivery independent so public/off/edge can use existing complete groups", () => {
    const retained = parsePublicationConfig(
      { ...configured, MEDIA_PUBLICATION: "off" },
      "production",
    );
    expect(allowsPublication(retained)).toBe(false);
    expect(allowsEdgeDelivery(retained)).toBe(true);
    expect(
      parsePublicationConfig(configured, "production", "closed-beta")
        .productMode,
    ).toBe("closed-beta");
  });
  it("does not disclose invalid environment values in validation errors", () => {
    for (const name of [
      "MEDIA_PUBLISHED_ORIGIN",
      "MEDIA_PUBLISHED_COS_BUCKET",
      "MEDIA_PUBLISHED_COS_REGION",
      "MEDIA_PUBLISHER_ROLE_ARN",
      "MEDIA_EDGE_ZONE_ID",
      "MEDIA_EDGE_VERIFY_CONNECT_HOST",
    ]) {
      try {
        parsePublicationConfig(
          { ...configured, [name]: "synthetic-private-diagnostic" },
          "production",
        );
        throw new Error("unexpected pass");
      } catch (error) {
        expect(String(error)).toContain(name);
        expect(String(error)).not.toContain("synthetic-private-diagnostic");
      }
    }
  });
});

describe("immutable derivative transport", () => {
  it("streams one PUT with private bucket defaults, verifies bytes and MD5 with HEAD, and never lists or copies", async () => {
    const f = fixture();
    await expect(
      f.provider.write(unit, Readable.from([bytes])),
    ).resolves.toEqual({ byteSize: bytes.length, etag: digest });
    expect(f.calls.map((call) => call.method)).toEqual([
      "putObject",
      "headObject",
    ]);
    expect(f.calls[0]!.parameters).toMatchObject({
      Bucket: configured.MEDIA_PUBLISHED_COS_BUCKET,
      Region: configured.MEDIA_PUBLISHED_COS_REGION,
      Key: key,
      ContentLength: bytes.length,
      ContentType: "image/webp",
      CacheControl: PUBLICATION_CACHE_CONTROL,
      Headers: { "x-cos-forbid-overwrite": "true" },
    });
    expect(f.calls[0]!.parameters).not.toHaveProperty("ACL");
    expect(f.apiCalls).toEqual([]);
  });
  it("refuses originals/masters, arbitrary paths and oversized or truncated streams", async () => {
    const f = fixture();
    await expect(
      f.provider.write(
        { ...unit, contentType: "image/heic" } as never,
        Readable.from([bytes]),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      f.provider.write(
        { ...unit, objectKey: "originals/private-key" },
        Readable.from([bytes]),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(f.calls).toEqual([]);
    await expect(
      f.provider.write(
        { ...unit, byteSize: bytes.length - 1 },
        Readable.from([bytes]),
      ),
    ).rejects.toMatchObject({ code: "integrity" });
    await expect(
      f.provider.write(
        { ...unit, byteSize: bytes.length + 1 },
        Readable.from([bytes]),
      ),
    ).rejects.toMatchObject({ code: "integrity" });
    expect(f.calls.map((call) => call.method)).toEqual([
      "putObject",
      "putObject",
    ]);
  });
  it("never marks a mismatched HEAD as verified or treats 403 as absent", async () => {
    await expect(
      fixture({ wrongHash: true }).provider.write(unit, Readable.from([bytes])),
    ).rejects.toMatchObject({ code: "integrity" });
    await expect(
      fixture({ headStatus: 403 }).provider.head(key),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      fixture({ absent: true }).provider.head(key),
    ).resolves.toBeUndefined();
  });
  it("does not start any transport when already aborted", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.provider.write(unit, Readable.from([bytes]), controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(f.calls).toEqual([]);
  });
});

describe("purge authority and request accounting", () => {
  it("rejects foreign origins, authorization/query data, normalized traversal and broad prefixes before API I/O", async () => {
    const f = fixture();
    for (const value of [
      target.replace("media.synthetic.test", "foreign.synthetic.test"),
      target + "?synthetic=1",
      target + "#x",
      target.replace("https://", "https://synthetic@"),
      `${origin}/v1/`,
      `${origin}/v1/${"a".repeat(32)}/../${key}`,
      target.replace("/base/", "/%62ase/"),
    ]) {
      await expect(f.provider.purge([value], "file")).rejects.toMatchObject({
        code: "invalid",
      });
    }
    expect(() =>
      validatePurgeTarget(origin, origin + "/v1/", "prefix"),
    ).toThrow();
    expect(f.apiCalls).toEqual([]);
    expect(publishedObjectUrl(origin, key)).toBe(target);
    expect(() =>
      validatePublishedKey(key.replace("b".repeat(32), "1")),
    ).toThrow();
  });
  it("uses only file purge or delete-prefix and tracks every target result", async () => {
    const f = fixture();
    expect(await f.provider.purge([target], "file")).toBe("synthetic-job");
    await f.provider.purge([`${origin}/v1/${"a".repeat(32)}/`], "prefix");
    expect(f.apiCalls[0]!.input).toEqual({
      ZoneId: "zone-synthetic",
      Type: "purge_url",
      Targets: [target],
    });
    expect(f.apiCalls[1]!.input).toMatchObject({
      Type: "purge_prefix",
      Method: "delete",
    });
    f.respond({
      Tasks: [
        {
          JobId: "synthetic-job",
          Status: "processing",
          Target: target,
          Type: "purge_url",
        },
      ],
      TotalCount: 1,
    });
    expect(await f.provider.purgeStatus("synthetic-job")).toBe("pending");
    f.respond({
      Tasks: [
        {
          JobId: "synthetic-job",
          Status: "success",
          Target: target,
          Type: "purge_url",
        },
      ],
      TotalCount: 1,
    });
    expect(await f.provider.purgeStatus("synthetic-job")).toBe("succeeded");
    f.respond({
      Tasks: [
        {
          JobId: "synthetic-job",
          Status: "failed",
          Target: target,
          Type: "purge_url",
        },
      ],
      TotalCount: 1,
    });
    expect(await f.provider.purgeStatus("synthetic-job")).toBe("failed");
    f.respond({
      Tasks: [
        {
          JobId: "synthetic-job",
          Status: "success",
          Target: target,
          Type: "purge_url",
        },
      ],
      TotalCount: 2,
    });
    await expect(f.provider.purgeStatus("synthetic-job")).rejects.toMatchObject(
      { code: "unavailable" },
    );
  });
  it("uses the fourth in Beijing, sums host-filtered request metrics and warns at the exact ceiling", async () => {
    expect(
      publicationPlanMonth(new Date("2026-10-03T15:59:59Z")).toISOString(),
    ).toBe("2026-09-03T16:00:00.000Z");
    expect(
      publicationPlanMonth(new Date("2026-10-03T16:00:00Z")).toISOString(),
    ).toBe("2026-10-03T16:00:00.000Z");
    const f = fixture();
    f.respond({
      Data: [{ TypeValue: [{ MetricName: "l7Flow_request", Sum: 2_000_000 }] }],
      TotalCount: 1,
    });
    const result = await f.provider.monthlyRequests(
      new Date("2026-10-08T00:00:00Z"),
    );
    expect(result).toMatchObject({ requests: 2_000_000, warning: true });
    expect(f.apiCalls[0]!.input).toEqual({
      ZoneIds: ["zone-synthetic"],
      StartTime: "2026-10-03T16:00:00.000Z",
      EndTime: "2026-10-08T00:00:00.000Z",
      Interval: "day",
      MetricNames: ["l7Flow_request"],
      Filters: [
        { Key: "domain", Operator: "equals", Value: ["media.synthetic.test"] },
      ],
    });
  });
});

describe("local publication and rollback drain", () => {
  it("is inspectable without a public server, forbids overwrite, and drains previously registered copies in Beta", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-publication-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const local: PublicationConfig = {
      nodeEnv: "development",
      productMode: "public",
      publication: "on",
      delivery: "edge",
      origin: "http://127.0.0.1:32123",
      localRoot: directory,
    };
    const provider = createLocalPublicationProvider(local);
    expect(await provider.write(unit, Readable.from([bytes]))).toEqual({
      byteSize: bytes.length,
      etag: digest,
    });
    await expect(
      provider.write(unit, Readable.from([bytes])),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await provider.head(key)).toEqual({
      byteSize: bytes.length,
      etag: digest,
    });
    const beta = createLocalPublicationProvider({
      ...local,
      productMode: "closed-beta",
      publication: "off",
      delivery: "relay",
    });
    await expect(
      beta.write(unit, Readable.from([bytes])),
    ).rejects.toMatchObject({ code: "disabled" });
    await beta.remove(key);
    const localTarget = `${local.origin}/${key}`;
    expect(
      await beta.purgeStatus(await beta.purge([localTarget], "file")),
    ).toBe("succeeded");
    expect(await beta.verifyGone(localTarget)).toBe(true);
    expect(await provider.head(key)).toBeUndefined();
  });
  it("rejects symlinked parent directories instead of escaping its local root", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "media-publication-symlink-"),
    );
    const foreign = await mkdtemp(join(tmpdir(), "media-publication-foreign-"));
    cleanups.push(async () => {
      await rm(directory, { recursive: true, force: true });
      await rm(foreign, { recursive: true, force: true });
    });
    await mkdir(join(directory, "v1"));
    await symlink(foreign, join(directory, "v1", "a".repeat(32)));
    const provider = createLocalPublicationProvider({
      nodeEnv: "development",
      productMode: "public",
      publication: "on",
      delivery: "relay",
      origin: "http://localhost:32123",
      localRoot: directory,
    });
    await expect(
      provider.write(unit, Readable.from([bytes])),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

const loopback = async (handler: RequestListener) => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("synthetic server unavailable");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const seen: RequestOptions[] = [];
  const nativeRequest = ((
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    seen.push(options);
    return httpRequest(
      {
        ...options,
        protocol: "http:",
        hostname: "127.0.0.1",
        host: "127.0.0.1",
        port: address.port,
      },
      callback,
    );
  }) as typeof httpsRequest;
  return { nativeRequest, seen };
};

describe("bounded Tencent API and edge verification (loopback fixtures)", () => {
  it("signs only the supported action, preserves the temporary role token and sanitizes quota diagnostics", async () => {
    const f = await loopback((_incoming, response) =>
      response.end(
        JSON.stringify({
          Response: {
            Error: {
              Code: "LimitExceeded.DailyQuota",
              Message: "synthetic-private-diagnostic",
            },
          },
        }),
      ),
    );
    const api = createTencentPublicationApi(
      { region: "ap-guangzhou", timeoutMs: 500 },
      {
        nativeRequest: f.nativeRequest,
        now: () => Date.parse("2026-10-08T00:00:00Z"),
      },
    );
    const temporary = async () => ({
      ...(await credentials()),
      securityToken: "synthetic-token",
      expiresAt: Math.floor(Date.parse("2026-10-08T01:00:00Z") / 1000),
    });
    await expect(
      api.call(
        "CreatePurgeTask",
        { ZoneId: "zone-synthetic", Targets: [target], Type: "purge_url" },
        temporary,
      ),
    ).rejects.toMatchObject({
      code: "quota",
      message: "Media publication failure: quota",
    });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]).toMatchObject({
      protocol: "https:",
      hostname: "teo.tencentcloudapi.com",
      rejectUnauthorized: true,
      method: "POST",
    });
    expect(f.seen[0]!.headers).toMatchObject({
      "X-TC-Token": "synthetic-token",
      "X-TC-Action": "CreatePurgeTask",
    });
    await expect(
      api.call("ModifyZone" as never, {}, credentials),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(f.seen).toHaveLength(1);
  });
  it("bounds unresolved credentials and response bytes without hidden retries", async () => {
    const f = await loopback((_incoming, response) =>
      response.end("x".repeat(1024 * 1024 + 1)),
    );
    const api = createTencentPublicationApi(
      { region: "ap-guangzhou", timeoutMs: 100 },
      { nativeRequest: f.nativeRequest },
    );
    await expect(
      api.call("CreatePurgeTask", {}, () => new Promise(() => {})),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.seen).toHaveLength(0);
    await expect(
      api.call("CreatePurgeTask", {}, credentials),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.seen).toHaveLength(1);
  });
  it("refreshes the keyless publisher role lazily, caches briefly and never widens its request", async () => {
    let calls = 0;
    const now = Date.parse("2026-10-08T00:00:00Z");
    const api: TencentPublicationApi = {
      async call(action, input, acquire) {
        calls++;
        expect(action).toBe("AssumeRole");
        expect(input).toEqual({
          RoleArn: configured.MEDIA_PUBLISHER_ROLE_ARN,
          RoleSessionName: "media-publication-v1",
          DurationSeconds: 3600,
        });
        await acquire();
        return {
          Credentials: {
            TmpSecretId: "synthetic-role-id",
            TmpSecretKey: "synthetic-role-secret",
            Token: "synthetic-role-token",
          },
          ExpiredTime: Math.floor(now / 1000) + 3600,
        };
      },
    };
    const acquire = createPublisherRoleCredentials({
      roleArn: configured.MEDIA_PUBLISHER_ROLE_ARN,
      ugcCredentials: credentials,
      api,
      now: () => now,
    });
    expect(calls).toBe(0);
    await acquire();
    await acquire();
    expect(calls).toBe(1);
  });
  it.each([403, 404, 200, 206])(
    "checks %s with fixed origin TLS identity and one-byte range",
    async (status) => {
      const f = await loopback((_incoming, response) => {
        response.statusCode = status;
        response.end("x".repeat(65_536));
      });
      const verify = createEdgeWithdrawalVerifier(
        { origin, connectHost: "edge.synthetic.test", timeoutMs: 500 },
        { nativeRequest: f.nativeRequest },
      );
      expect(await verify(target)).toBe(status === 403 || status === 404);
      expect(f.seen).toHaveLength(1);
      expect(f.seen[0]).toMatchObject({
        hostname: "edge.synthetic.test",
        servername: "media.synthetic.test",
        rejectUnauthorized: true,
        headers: {
          Host: "media.synthetic.test",
          Range: "bytes=0-0",
          "Accept-Encoding": "identity",
        },
      });
    },
  );
  it("refuses redirects, bounds stalled headers and cancels a pending verification", async () => {
    const redirect = await loopback((_incoming, response) => {
      response.statusCode = 302;
      response.setHeader("Location", "https://foreign.synthetic.test/");
      response.end();
    });
    await expect(
      createEdgeWithdrawalVerifier(
        { origin, timeoutMs: 100 },
        { nativeRequest: redirect.nativeRequest },
      )(target),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(redirect.seen).toHaveLength(1);
    const stalled = await loopback(() => {});
    const verify = createEdgeWithdrawalVerifier(
      { origin, timeoutMs: 100 },
      { nativeRequest: stalled.nativeRequest },
    );
    await expect(verify(target)).rejects.toMatchObject({ code: "unavailable" });
    const controller = new AbortController();
    const pending = verify(target, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(stalled.seen).toHaveLength(2);
  });
});
