import { randomBytes, randomUUID } from "node:crypto";

import { CommunityConflictError, CommunityNotFoundError } from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  operatorAccountCapacitySchema,
  operatorPublishingJobSchema,
  workPublishingSettingsSchema,
  workSubmissionModerationResultSchema,
} from "@moya/contracts/internal/community-operator";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";

import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
} from "./community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

import type {
  AuthorCommunityPort,
  PublishingMediaByteRange,
  PublishingMediaReadResult,
  PublishingMediaStorePort,
  PublishingOperatorPort,
} from "@moya/api";
import type { NodeEnvironment } from "@moya/backend-runtime";
import type { WorkPublishingSettings } from "@moya/contracts/internal/community-operator";
import type { Server } from "node:http";

const now = new Date("2026-09-14T15:30:00.000Z");
const iso = now.toISOString();
const credential = "synthetic-operator-credential-for-unit-tests";
const revisionId = `work-revision-${"1".repeat(32)}`;
const workId = `work-${"2".repeat(32)}`;
const itemId = `media-item-${"3".repeat(32)}`;
const accountId = `user-${"4".repeat(32)}`;
const jobId = `publishing-job-${"5".repeat(32)}`;
const storageKey = `blobs/ab/cd/${"6".repeat(32)}`;

const settings: WorkPublishingSettings = {
  policy: "DIRECT_PUBLICATION",
  maxItemsPerWork: 50,
  originalItemMaxBytes: 134_217_728,
  standardComponentMaxBytes: 268_435_456,
  ordinaryAccountCapacityBytes: 10_737_418_240,
  ownerAccountCapacityBytes: 21_474_836_480,
  maxActiveDrafts: 100,
  dailyNewWorkLimit: 100,
  historyLimit: 20,
  trashRetentionDays: 30,
  orphanGraceDays: 7,
  unsavedSessionLeaseMinutes: 360,
  version: 3,
  updatedAt: iso,
  updatedBy: "owner",
};

const {
  version: _version,
  updatedAt: _at,
  updatedBy: _by,
  ...limits
} = settings;
void [_version, _at, _by];

const capacity = {
  accountId,
  capacityClass: "owner",
  capacityBytes: 21_474_836_480,
  committedBytes: 0,
  reservedBytes: 0,
  version: 1,
  updatedAt: iso,
} as const;

const job = {
  id: jobId,
  kind: "purge_item",
  subjectId: itemId,
  state: "queued",
  attempts: 0,
  maxAttempts: 8,
  runAfter: iso,
  leaseExpiresAt: null,
  lastErrorCode: null,
  createdAt: iso,
  updatedAt: iso,
  finishedAt: null,
} as const;

const page = { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };

interface PortCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

const fakeOperatorPort = (
  overrides: Partial<Record<keyof PublishingOperatorPort, unknown>>,
) => {
  const calls: PortCall[] = [];
  const port = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== "string" || name === "then") return undefined;
        return async (...args: unknown[]) => {
          calls.push({ name, args });
          const implementation =
            overrides[name as keyof PublishingOperatorPort];
          if (typeof implementation !== "function")
            throw new Error(`unexpected port call ${name}`);
          return (implementation as (...values: unknown[]) => unknown)(...args);
        };
      },
    },
  ) as PublishingOperatorPort;
  const named = (name: string) => calls.filter((call) => call.name === name);
  return { port, calls, named };
};

/** Read-only store with one derivative; writes are never expected here. */
const singleBlobStore = (bytes: Buffer): PublishingMediaStorePort => ({
  writeStream: async () => {
    throw new Error("the operator proxy never writes");
  },
  openRead: async (
    key: string,
    range?: PublishingMediaByteRange,
  ): Promise<PublishingMediaReadResult | null> => {
    if (key !== storageKey) return null;
    const byteSize = bytes.byteLength;
    const start =
      range === undefined
        ? 0
        : "suffixLength" in range
          ? Math.max(0, byteSize - range.suffixLength)
          : range.start;
    const end =
      range !== undefined && "start" in range && range.end !== undefined
        ? Math.min(range.end, byteSize - 1)
        : byteSize - 1;
    if (start >= byteSize || start > end)
      return { status: "range_not_satisfiable", byteSize };
    const slice = bytes.subarray(start, end + 1);
    return {
      status: "ok",
      byteSize,
      start,
      end,
      contentLength: slice.byteLength,
      body: (async function* () {
        yield slice;
      })(),
      close: async () => undefined,
    };
  },
  remove: async () => undefined,
  listBlobs: async () => ({ entries: [], nextAfter: null }),
});

const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

const start = async (
  port: PublishingOperatorPort,
  options: {
    readonly store?: PublishingMediaStorePort;
    readonly nodeEnv?: NodeEnvironment;
  } = {},
) => {
  const nodeEnv = options.nodeEnv ?? "development";
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv,
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      communityCommentPort: new InMemoryCommunityCommentPort(),
      catalogPublicationPort: new FixtureCatalogPublicationPort(),
      communityOperatorCredential: credential,
      authorCommunityPort: {} as AuthorCommunityPort,
      publishingOperatorPort: port,
      publishingClock: () => now,
      ...(options.store === undefined
        ? {}
        : { publishingMediaStore: options.store }),
      ...(nodeEnv === "production"
        ? {
            catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
            storageUrlResolver: new UnconfiguredStorageUrlResolver(),
          }
        : {}),
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  return `http://${address.address}:${address.port}/internal/community/publishing`;
};

const operatorHeaders = (json = false) => ({
  authorization: `Bearer ${credential}`,
  ...(json ? { "content-type": "application/json" } : {}),
});

const expectOperatorError = async (
  response: Response,
  status: number,
  code: string,
) => {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: { status, code } });
};

describe("work publishing operator HTTP surface", () => {
  it.each(["development", "production"] as const)(
    "requires the operator credential on publishing routes in %s",
    async (nodeEnv) => {
      const fake = fakeOperatorPort({ readSettings: () => settings });
      const base = await start(fake.port, { nodeEnv });
      for (const authorization of [
        undefined,
        "Bearer wrong",
        `Basic ${credential}`,
        `Bearer ${credential} extra`,
      ]) {
        const response = await fetch(`${base}/settings`, {
          headers: authorization === undefined ? {} : { authorization },
        });
        await expectOperatorError(response, 401, "OPERATOR_UNAUTHORIZED");
      }
      // A session credential of the Public API is not an operator credential.
      await expectOperatorError(
        await fetch(`${base}/jobs`, {
          headers: { authorization: `Bearer ${"A".repeat(43)}` },
        }),
        401,
        "OPERATOR_UNAUTHORIZED",
      );
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each(["development", "production"] as const)(
    "reads and replaces settings with the fixed operator and injected clock in %s",
    async (nodeEnv) => {
      const fake = fakeOperatorPort({
        readSettings: () => settings,
        setSettings: () => ({ ...settings, version: 4 }),
      });
      const base = await start(fake.port, { nodeEnv });
      const read = await fetch(`${base}/settings`, {
        headers: operatorHeaders(),
      });
      expect(read.status).toBe(200);
      expect(workPublishingSettingsSchema.parse(await read.json())).toEqual(
        settings,
      );

      const command = {
        requestId: randomUUID(),
        expectedVersion: 3,
        ...limits,
        policy: "PRE_MODERATION",
      };
      const saved = await fetch(`${base}/settings`, {
        method: "PUT",
        headers: operatorHeaders(true),
        body: JSON.stringify(command),
      });
      expect(saved.status).toBe(200);
      expect(fake.named("setSettings")[0]?.args).toEqual([
        "owner",
        command,
        now,
      ]);

      // The configurable item maximum stays within 100 (a full draft save must
      // fit the JSON command limit).
      const bounded = await fetch(`${base}/settings`, {
        method: "PUT",
        headers: operatorHeaders(true),
        body: JSON.stringify({ ...command, maxItemsPerWork: 100 }),
      });
      expect(bounded.status).toBe(200);
      for (const body of [
        { ...command, operator: "someone" },
        { ...command, maxItemsPerWork: 0 },
        { ...command, maxItemsPerWork: 101 },
        { ...command, maxItemsPerWork: 500 },
        { ...command, requestId: "not-a-uuid" },
      ])
        await expectOperatorError(
          await fetch(`${base}/settings`, {
            method: "PUT",
            headers: operatorHeaders(true),
            body: JSON.stringify(body),
          }),
          400,
          "INVALID_COMMAND",
        );
      await expectOperatorError(
        await fetch(`${base}/settings?x=1`, { headers: operatorHeaders() }),
        400,
        "INVALID_COMMAND",
      );
      await expectOperatorError(
        await fetch(`${base}/settings`, {
          method: "PUT",
          headers: operatorHeaders(),
          body: "{}",
        }),
        400,
        "INVALID_COMMAND",
      );
      await expectOperatorError(
        await fetch(`${base}/settings`, {
          method: "POST",
          headers: operatorHeaders(true),
          body: "{}",
        }),
        405,
        "METHOD_NOT_ALLOWED",
      );
      expect(
        fake.named("setSettings").map((call) => call.args[1]),
      ).toMatchObject([
        { maxItemsPerWork: limits.maxItemsPerWork },
        { maxItemsPerWork: 100 },
      ]);
    },
  );

  it("lists and moderates explicit submissions with strict queries and stale-version conflicts", async () => {
    const fake = fakeOperatorPort({
      listSubmissions: () => page,
      readSubmission: () => {
        throw new CommunityNotFoundError();
      },
      moderateSubmission: (
        _revision: string,
        _operator: string,
        command: { expectedVersion: number },
      ) => {
        if (command.expectedVersion !== 1)
          throw new CommunityConflictError("stale");
        return {
          revisionId,
          workId,
          disposition: "approved",
          version: 2,
        };
      },
    });
    const base = await start(fake.port);

    const listed = await fetch(
      `${base}/submissions?state=pending&pageSize=10`,
      {
        headers: operatorHeaders(),
      },
    );
    expect(listed.status).toBe(200);
    expect(fake.named("listSubmissions")[0]?.args).toEqual([
      { state: "pending", page: 1, pageSize: 10 },
    ]);
    for (const query of [
      "?state=not_required",
      "?state=pending&state=approved",
      "?search=title",
      "?page=0",
    ])
      await expectOperatorError(
        await fetch(`${base}/submissions${query}`, {
          headers: operatorHeaders(),
        }),
        400,
        "INVALID_COMMAND",
      );

    await expectOperatorError(
      await fetch(`${base}/submissions/${revisionId}`, {
        headers: operatorHeaders(),
      }),
      404,
      "NOT_FOUND",
    );
    await expectOperatorError(
      await fetch(`${base}/submissions/revision-1`, {
        headers: operatorHeaders(),
      }),
      404,
      "NOT_FOUND",
    );

    const moderate = (expectedVersion: number) =>
      fetch(`${base}/submissions/${revisionId}/moderation`, {
        method: "POST",
        headers: operatorHeaders(true),
        body: JSON.stringify({
          requestId: randomUUID(),
          action: "approve",
          expectedVersion,
        }),
      });
    const approved = await moderate(1);
    expect(approved.status).toBe(200);
    expect(
      workSubmissionModerationResultSchema.parse(await approved.json()),
    ).toMatchObject({ disposition: "approved", version: 2 });
    const [call] = fake.named("moderateSubmission");
    expect(call?.args[0]).toBe(revisionId);
    expect(call?.args[1]).toBe("owner");
    expect(call?.args[3]).toBe(now);
    await expectOperatorError(await moderate(0), 409, "STATE_CONFLICT");
    await expectOperatorError(
      await fetch(`${base}/submissions/${revisionId}/moderation`, {
        method: "GET",
        headers: operatorHeaders(),
      }),
      405,
      "METHOD_NOT_ALLOWED",
    );
    expect(fake.named("readSubmission")).toHaveLength(1);
  });

  it("serves authorized legacy PNG previews with bounded ranges and denies guests", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const fake = fakeOperatorPort({
      resolveMediaRead: () => ({ legacyPng: bytes, sha256: "b".repeat(64) }),
    });
    const base = await start(fake.port);
    const url = `${base}/media/${revisionId}/${itemId}/display/base`;
    const guest = await fetch(url);
    expect(guest.status).toBe(401);
    expect(fake.named("resolveMediaRead")).toHaveLength(0);
    const whole = await fetch(url, { headers: operatorHeaders() });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("image/png");
    expect(whole.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(bytes);
    for (const [range, expected] of [
      ["bytes=1-3", bytes.subarray(1, 4)],
      ["bytes=-2", bytes.subarray(6)],
    ] as const) {
      const response = await fetch(url, {
        headers: { ...operatorHeaders(), range },
      });
      expect(response.status).toBe(206);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    }
    const invalid = await fetch(url, {
      headers: { ...operatorHeaders(), range: "bytes=20-" },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */8");
    await invalid.arrayBuffer();
    const head = await fetch(url, {
      method: "HEAD",
      headers: operatorHeaders(),
    });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("proxies submission derivatives with ranges and answers 503 without a store", async () => {
    const bytes = randomBytes(2048);
    const fake = fakeOperatorPort({
      resolveMediaRead: (revision: string, item: string, variant: string) =>
        revision === revisionId && item === itemId && variant === "display"
          ? {
              storageKey,
              contentType: "image/webp",
              byteSize: bytes.byteLength,
              sha256: "0".repeat(64),
            }
          : null,
    });
    const base = await start(fake.port, { store: singleBlobStore(bytes) });
    const url = `${base}/media/${revisionId}/${itemId}/display/base`;

    const whole = await fetch(url, { headers: operatorHeaders() });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("image/webp");
    expect(whole.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(bytes);

    const part = await fetch(url, {
      headers: { ...operatorHeaders(), range: "bytes=100-199" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/2048");
    expect(Buffer.from(await part.arrayBuffer())).toEqual(
      bytes.subarray(100, 200),
    );
    const outside = await fetch(url, {
      headers: { ...operatorHeaders(), range: "bytes=4096-" },
    });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("content-range")).toBe("bytes */2048");
    await outside.arrayBuffer();

    await expectOperatorError(
      await fetch(`${base}/media/${revisionId}/${itemId}/thumb/base`, {
        headers: operatorHeaders(),
      }),
      404,
      "NOT_FOUND",
    );
    await expectOperatorError(
      await fetch(`${base}/media/${revisionId}/${itemId}/original/base`, {
        headers: operatorHeaders(),
      }),
      404,
      "NOT_FOUND",
    );
    await expectOperatorError(
      await fetch(url, { method: "DELETE", headers: operatorHeaders() }),
      405,
      "METHOD_NOT_ALLOWED",
    );

    // Resolve the authorized representation first: legacy PNGs are database
    // backed; a publishing derivative still requires the private blob store.
    const storeless = fakeOperatorPort({
      resolveMediaRead: () => ({
        storageKey,
        contentType: "image/webp",
        byteSize: bytes.byteLength,
        sha256: "0".repeat(64),
      }),
    });
    const unavailable = await start(storeless.port);
    await expectOperatorError(
      await fetch(`${unavailable}/media/${revisionId}/${itemId}/display/base`, {
        headers: operatorHeaders(),
      }),
      503,
      "STORE_UNAVAILABLE",
    );
    expect(storeless.named("resolveMediaRead")).toHaveLength(1);
  });

  it("designates account capacity on the immutable account id and manages content-free jobs", async () => {
    const fake = fakeOperatorPort({
      readCapacity: () => ({ ...capacity, capacityClass: "ordinary" }),
      setCapacity: () => capacity,
      listJobs: () => ({ ...page, items: [job], total: 1, totalPages: 1 }),
      retryJob: () => job,
      abandonJob: () => ({ ...job, state: "abandoned", finishedAt: iso }),
    });
    const base = await start(fake.port);

    const read = await fetch(`${base}/accounts/${accountId}/capacity`, {
      headers: operatorHeaders(),
    });
    expect(
      operatorAccountCapacitySchema.parse(await read.json()).capacityClass,
    ).toBe("ordinary");
    const command = {
      requestId: randomUUID(),
      capacityClass: "owner",
      expectedVersion: 0,
    };
    const set = await fetch(`${base}/accounts/${accountId}/capacity`, {
      method: "PUT",
      headers: operatorHeaders(true),
      body: JSON.stringify(command),
    });
    expect(set.status).toBe(200);
    expect(fake.named("setCapacity")[0]?.args).toEqual([
      accountId,
      "owner",
      command,
      now,
    ]);
    // Never a handle or a display name.
    await expectOperatorError(
      await fetch(`${base}/accounts/dev-user-01/capacity`, {
        headers: operatorHeaders(),
      }),
      404,
      "NOT_FOUND",
    );

    const jobs = await fetch(`${base}/jobs?state=queued&kind=purge_item`, {
      headers: operatorHeaders(),
    });
    expect(jobs.status).toBe(200);
    expect(fake.named("listJobs")[0]?.args).toEqual([
      { state: "queued", kind: "purge_item", page: 1, pageSize: 20 },
    ]);
    await expectOperatorError(
      await fetch(`${base}/jobs?kind=unknown`, { headers: operatorHeaders() }),
      400,
      "INVALID_COMMAND",
    );
    const retried = await fetch(`${base}/jobs/${jobId}/retry`, {
      method: "POST",
      headers: operatorHeaders(true),
      body: JSON.stringify({ requestId: randomUUID() }),
    });
    expect(operatorPublishingJobSchema.parse(await retried.json()).id).toBe(
      jobId,
    );
    const abandoned = await fetch(`${base}/jobs/${jobId}/abandon`, {
      method: "POST",
      headers: operatorHeaders(true),
      body: JSON.stringify({ requestId: randomUUID() }),
    });
    expect(
      operatorPublishingJobSchema.parse(await abandoned.json()).state,
    ).toBe("abandoned");
    expect(fake.named("abandonJob")[0]?.args.slice(1)).toEqual([
      "owner",
      expect.objectContaining({ requestId: expect.any(String) }),
      now,
    ]);
    await expectOperatorError(
      await fetch(`${base}/jobs/${jobId}/retry?now=1`, {
        method: "POST",
        headers: operatorHeaders(true),
        body: JSON.stringify({ requestId: randomUUID() }),
      }),
      400,
      "INVALID_COMMAND",
    );
    await expectOperatorError(
      await fetch(`${base}/jobs/${jobId}/purge`, {
        method: "POST",
        headers: operatorHeaders(true),
        body: JSON.stringify({ requestId: randomUUID() }),
      }),
      404,
      "NOT_FOUND",
    );
  });

  it.each(["test", "production"] as const)(
    "mounts explicitly supplied publishing operator reads in %s without crossing the public identity boundary",
    async (nodeEnv) => {
      const fake = fakeOperatorPort({ readSettings: () => settings });
      const base = await start(fake.port, { nodeEnv });
      await expectOperatorError(
        await fetch(`${base}/settings`),
        401,
        "OPERATOR_UNAUTHORIZED",
      );
      const response = await fetch(`${base}/settings`, {
        headers: operatorHeaders(),
      });
      expect(response.status).toBe(200);
      expect(workPublishingSettingsSchema.parse(await response.json())).toEqual(
        settings,
      );
      expect(fake.named("readSettings")).toHaveLength(1);
      expect(
        (
          await fetch(
            `${new URL(base).origin}/v1/community/publishing/settings`,
            {
              headers: operatorHeaders(),
            },
          )
        ).status,
      ).toBe(401);
    },
  );

  it("is never reachable through the Public API prefix", async () => {
    const fake = fakeOperatorPort({ readSettings: () => settings });
    const base = await start(fake.port);
    const origin = new URL(base).origin;
    expect(
      (await fetch(`${origin}/v1/community/publishing/settings`)).status,
    ).toBe(404);
    // The operator credential is not a session credential there.
    expect(
      (
        await fetch(`${origin}/v1/community/publishing/settings`, {
          headers: operatorHeaders(),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/v1/internal/community/publishing/settings`, {
          headers: operatorHeaders(),
        })
      ).status,
    ).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });
});
