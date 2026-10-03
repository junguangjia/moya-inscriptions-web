import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
  CommunitySessionService,
  PublishingTransferRegistry,
  WorkPublishingService,
} from "@moya/api";
import { createPublishingJobHandlers } from "@moya/backend-production/internal/publishing-job-handlers";
import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  createPublishingTransferRegistry,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  developmentSessionSchema,
  publishingDraftDeletionResultSchema,
  publishingDraftSaveResultSchema,
  publishingDraftSchema,
  publishingLimitsSchema,
  publishingMediaItemSchema,
  publishingOpenedEditDraftSchema,
  publishingReadinessSchema,
  publishingUploadResultSchema,
} from "@moya/contracts/schemas";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";

import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
} from "./community-comment-fixture.js";
import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

import type {
  AuthorCommunityPort,
  PublishingMediaByteRange,
  PublishingMediaProcessorPort,
  PublishingMediaReadResult,
  PublishingMediaStorePort,
  PublishingMediaWriteOptions,
  PublishingMediaWriteResult,
  PublishingUploadFence,
  WorkPublishingPort,
} from "@moya/api";
import type { PublishingWorkerJobClaim } from "@moya/backend-production/internal/publishing-job-handlers";
import type { NodeEnvironment } from "@moya/backend-runtime";
import type { ApiErrorCode, PublishingMediaItem } from "@moya/contracts";
import type { WorkPublishingSettings } from "@moya/contracts/internal/community-operator";
import type { IncomingHttpHeaders, Server } from "node:http";

const now = new Date("2026-09-14T12:00:00.000Z");
const iso = now.toISOString();
const actor = fixtureUsers.active.id;
const other = fixtureUsers.second.id;
const itemId = `media-item-${"1".repeat(32)}`;
const componentId = `media-component-${"2".repeat(32)}`;
const draftId = `work-draft-${"3".repeat(32)}`;
const workId = `work-${"4".repeat(32)}`;
const KiB = 1024;

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
  version: 1,
  updatedAt: iso,
  updatedBy: null,
};

const content = {
  title: "碑帖临写",
  body: "",
  authorship: { kind: "original" },
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
} as const;

const draft = {
  id: draftId,
  kind: "new",
  workId: null,
  baseRevisionId: null,
  revision: 2,
  content,
  mediaItems: [],
  conflict: null,
  deviceClass: null,
  createdAt: iso,
  updatedAt: iso,
} as const;

const mediaItem = (
  byteSize: number,
  state: PublishingMediaItem["state"] = "awaiting_upload",
): PublishingMediaItem => ({
  id: itemId,
  kind: "static",
  qualityMode: "original",
  state,
  failureCode: null,
  components: [
    {
      id: componentId,
      role: "still",
      state: state === "processing" ? "received" : "awaiting",
      byteSize,
      receivedBytes: state === "processing" ? byteSize : 0,
    },
  ],
  presentation: null,
  media: null,
});

const fenceFor = (
  byteSize: number,
  attempt: string,
): PublishingUploadFence => ({
  componentId,
  itemId,
  ownerId: actor,
  attempt,
  role: "still",
  contentType: "image/jpeg",
  byteSize,
  purpose: "original",
});

interface PortCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** A port whose unlisted methods fail loudly; every call is recorded. */
const fakePort = (
  overrides: Partial<Record<keyof WorkPublishingPort, unknown>>,
) => {
  const calls: PortCall[] = [];
  const port = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== "string" || name === "then") return undefined;
        return async (...args: unknown[]) => {
          calls.push({ name, args });
          const implementation = overrides[name as keyof WorkPublishingPort];
          if (typeof implementation !== "function")
            throw new Error(`unexpected port call ${name}`);
          return (implementation as (...values: unknown[]) => unknown)(...args);
        };
      },
    },
  ) as WorkPublishingPort;
  const named = (name: string) => calls.filter((call) => call.name === name);
  return { port, calls, named };
};

/** Shaped like the media store adapter's `PublishingMediaStoreError`. */
const storeFailure = (code: string) =>
  Object.assign(new Error(`store failure ${code}`), {
    name: "PublishingMediaStoreError",
    code,
  });

/** In-memory media store honoring the port's size, abort and range rules. */
class MemoryMediaStore implements PublishingMediaStorePort {
  readonly blobs = new Map<string, Buffer>();
  readonly removed: string[] = [];
  received = 0;

  async writeStream(
    _ownerId: string,
    _purpose: string,
    _contentType: string,
    maxBytes: number,
    source: AsyncIterable<Uint8Array>,
    options: PublishingMediaWriteOptions = {},
  ): Promise<PublishingMediaWriteResult> {
    const { signal } = options;
    if (signal?.aborted) throw storeFailure("aborted");
    const iterator = source[Symbol.asyncIterator]();
    const aborted = new Promise<never>((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(storeFailure("aborted")), {
        once: true,
      }),
    );
    aborted.catch(() => undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) throw storeFailure("size_limit_exceeded");
        chunks.push(Buffer.from(next.value));
        this.received += next.value.byteLength;
      }
    } catch (error) {
      await iterator.return?.();
      throw signal?.aborted ? storeFailure("aborted") : error;
    }
    if (size === 0) throw storeFailure("empty_content");
    if (options.requireExactSize && size !== maxBytes)
      throw storeFailure("size_mismatch");
    const bytes = Buffer.concat(chunks);
    const storageKey = `blobs/aa/bb/${randomBytes(16).toString("hex")}`;
    this.blobs.set(storageKey, bytes);
    return {
      storageKey,
      byteSize: size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async openRead(
    storageKey: string,
    range?: PublishingMediaByteRange,
  ): Promise<PublishingMediaReadResult | null> {
    const bytes = this.blobs.get(storageKey);
    if (bytes === undefined) return null;
    const byteSize = bytes.byteLength;
    let start = 0;
    let end = byteSize - 1;
    if (range !== undefined && "suffixLength" in range)
      start = Math.max(0, byteSize - range.suffixLength);
    else if (range !== undefined) {
      start = range.start;
      end = Math.min(range.end ?? byteSize - 1, byteSize - 1);
    }
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
  }

  async remove(storageKey: string): Promise<void> {
    this.removed.push(storageKey);
    this.blobs.delete(storageKey);
  }

  async listBlobs() {
    return { entries: [], nextAfter: null };
  }
}

const processor: PublishingMediaProcessorPort = {
  process: async () => {
    throw new Error("the HTTP tests never process media");
  },
};

const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

interface StartOptions {
  readonly port: WorkPublishingPort;
  readonly store?: PublishingMediaStorePort;
  readonly media?: boolean;
  readonly nodeEnv?: NodeEnvironment;
  readonly transfers?: PublishingTransferRegistry;
  readonly transferPolicy?: {
    readonly idleTimeoutMs?: number;
    readonly refusalReadMs?: number;
  };
  readonly requestDeadlineMs?: number;
  /** Set `unavailable` on it to make session checks fail. */
  readonly identity?: InMemoryCommunityIdentityPort;
}

const operatorCredential = "synthetic-operator-credential-for-unit-tests";
const start = async ({
  port,
  store,
  media = true,
  nodeEnv = "development",
  transfers,
  transferPolicy,
  requestDeadlineMs,
  identity = new InMemoryCommunityIdentityPort(),
}: StartOptions) => {
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv,
      communityIdentityPort: identity,
      communityCommentPort: new InMemoryCommunityCommentPort(),
      catalogPublicationPort: new FixtureCatalogPublicationPort(),
      communityOperatorCredential: operatorCredential,
      authorCommunityPort: {} as AuthorCommunityPort,
      workPublishingPort: port,
      publishingOperatorPort: port as never,
      publishingClock: () => now,
      ...(store === undefined ? {} : { publishingMediaStore: store }),
      ...(media ? { publishingMediaProcessor: processor } : {}),
      ...(transfers === undefined ? {} : { publishingTransfers: transfers }),
      ...(transferPolicy === undefined
        ? {}
        : { publishingTransferPolicy: transferPolicy }),
      ...(nodeEnv === "production"
        ? {
            catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
            storageUrlResolver: new UnconfiguredStorageUrlResolver(),
          }
        : {}),
    }),
    requestDeadlineMs === undefined ? {} : { requestDeadlineMs },
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://${address.address}:${address.port}`;
  const signIn = async (handle = "dev-user-01") => {
    if (nodeEnv !== "development") {
      // The test seeds the injected identity port; Production has no Development entry.
      const grant = await new CommunitySessionService(
        identity,
      ).signInDevelopmentAccount(handle);
      if (grant === null) throw new Error("Missing synthetic account");
      return grant.token;
    }
    const response = await fetch(`${base}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    return developmentSessionSchema.parse(await response.json()).token;
  };
  return { base, address, signIn, server };
};

const expectApiError = async (
  response: Response,
  status: number,
  code: ApiErrorCode,
  message?: string,
) => {
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  if (message !== undefined) expect(body.error.message).toBe(message);
  return body;
};

const until = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

interface RawAnswer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

/**
 * A raw component transfer over node:http so the test controls when bytes
 * flow, when the body ends and when the client disconnects.
 */
const rawUpload = (
  base: string,
  headers: Record<string, string>,
  path = `/v1/community/publishing/uploads/${componentId}`,
) => {
  let settled = false;
  const client = httpRequest(`${base}${path}`, {
    method: "POST",
    headers,
    agent: false,
  });
  const answer = new Promise<RawAnswer>((resolve, reject) => {
    client.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", () => undefined);
    });
    client.on("error", (error) => {
      // Writes after an early answer may fail once the server closes.
      if (!settled) reject(error);
    });
  });
  answer.catch(() => undefined);
  return { client, answer };
};

const uploadHeaders = (
  token: string,
  length: number,
  attempt: string = randomUUID(),
  extra: Record<string, string> = {},
): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "x-author-account": actor,
  "x-upload-attempt": attempt,
  "content-type": "application/octet-stream",
  "content-length": String(length),
  ...extra,
});

const json = (
  token: string | null,
  body: unknown,
  method = "POST",
  account: string | null = actor,
): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...(account === null ? {} : { "x-author-account": account }),
  },
  body: JSON.stringify(body),
});

interface UploadStart {
  readonly attempt: string;
  readonly contentLength: number;
  readonly supersede: boolean;
}

/**
 * The attempt fence of one component like the adapter keeps it: begin checks
 * ownership, then the state (a component still receiving only with
 * supersede), then the declared length; commit and abort match the attempt.
 */
const componentFence = (declared: number) => {
  const component: {
    state: "awaiting" | "receiving" | "received";
    attempt: string | null;
  } = { state: "awaiting", attempt: null };
  return {
    component,
    beginComponentUpload: (
      actorId: string,
      _component: string,
      start: UploadStart,
    ) => {
      if (actorId !== actor) throw new CommunityNotFoundError();
      if (
        component.state === "received" ||
        (component.state === "receiving" && !start.supersede)
      )
        throw new CommunityConflictError(
          "The component is not awaiting an upload",
        );
      if (start.contentLength > declared)
        throw new CommunityInputError("component_too_large");
      if (start.contentLength < declared)
        throw new CommunityInputError("invalid_input");
      component.state = "receiving";
      component.attempt = start.attempt;
      return fenceFor(declared, start.attempt);
    },
    commitComponentUpload: (
      fence: PublishingUploadFence,
      blob: PublishingMediaWriteResult,
    ) => {
      if (
        component.state !== "receiving" ||
        component.attempt !== fence.attempt
      )
        return { status: "superseded" };
      component.state = "received";
      component.attempt = null;
      return {
        status: "committed",
        result: {
          componentId,
          sha256: blob.sha256,
          receivedBytes: blob.byteSize,
          item: mediaItem(declared, "processing"),
        },
      };
    },
    abortComponentUpload: (fence: PublishingUploadFence) => {
      if (
        component.state === "receiving" &&
        component.attempt === fence.attempt
      ) {
        component.state = "awaiting";
        component.attempt = null;
      }
    },
  };
};

const uploadPort = (
  declared: number,
  extra: Parameters<typeof fakePort>[0] = {},
) => {
  const { component, ...methods } = componentFence(declared);
  return { ...fakePort({ ...methods, ...extra }), component };
};

interface SendingClientResult {
  /** Everything the server sent before it closed the connection. */
  readonly answer: string;
  /** Milliseconds from the first answer byte until the server closed. */
  readonly openAfterAnswerMs: number;
}

/**
 * A raw TCP client that never stops sending body bytes by itself (unlike
 * node:http, which closes once a `Connection: close` answer ended). It
 * resolves when the server closes the connection, with what it answered.
 * `tickMs` paces one chunk per tick; otherwise it writes as fast as the
 * socket drains.
 */
const sendingClient = (
  base: string,
  headers: Record<string, string>,
  { tickMs, capMs = 5_000 }: { tickMs?: number; capMs?: number } = {},
) => {
  const { hostname, port } = new URL(base);
  const socket = connect({ host: hostname, port: Number(port) });
  const chunk = randomBytes(64 * KiB);
  let received = Buffer.alloc(0);
  let answeredAt: number | null = null;
  let done = false;
  socket.on("data", (data: Buffer) => {
    answeredAt ??= Date.now();
    received = Buffer.concat([received, data]);
  });
  const result = new Promise<SendingClientResult>((resolve, reject) => {
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      clearInterval(ticker);
      socket.destroy();
      if (answeredAt === null) reject(new Error("closed without an answer"));
      else
        resolve({
          answer: received.toString("utf8"),
          openAfterAnswerMs: Date.now() - answeredAt,
        });
    };
    const cap = setTimeout(() => {
      finish();
    }, capMs);
    socket.on("end", finish);
    socket.on("error", finish);
    socket.on("close", finish);
  });
  result.catch(() => undefined);
  let ticker: ReturnType<typeof setInterval> | undefined;
  const pump = () => {
    while (!done && socket.write(chunk));
    if (!done) socket.once("drain", pump);
  };
  socket.once("connect", () => {
    socket.write(
      [
        `POST /v1/community/publishing/uploads/${componentId} HTTP/1.1`,
        `host: ${hostname}:${port}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n"),
    );
    if (tickMs === undefined) pump();
    else
      ticker = setInterval(() => {
        if (!done && socket.writableLength < 1024 * KiB) socket.write(chunk);
      }, tickMs);
  });
  return result;
};

const statusOf = (answer: string) => Number(answer.split(" ")[1]);
/** The lowercased response head of a raw answer. */
const headersOf = (answer: string) =>
  answer.slice(0, answer.indexOf("\r\n\r\n")).toLowerCase();
/** Well-formed, but no session has this token. */
const unknownSession = `Bearer ${"A".repeat(43)}`;

interface RelayAnswer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
  /** Body chunks the client had handed to the transfer when the answer arrived. */
  readonly chunksBeforeAnswer: number;
}

/**
 * The Web upload relay's way of talking to the Backend: undici fetch with a
 * streamed half-duplex body of the declared length, pulled chunk by chunk
 * (like the relay's pull from the browser). The answer is read while body
 * bytes are still flowing; the transfer is then aborted, as the relay does
 * once an answer arrived before its last byte.
 */
const relayUpload = (
  base: string,
  headers: Record<string, string>,
  { chunkBytes = 64 * KiB, tickMs = 1 } = {},
) => {
  let chunks = 0;
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        await new Promise((resolve) => setTimeout(resolve, tickMs));
        chunks += 1;
        controller.enqueue(randomBytes(chunkBytes));
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body,
    duplex: "half",
    signal: abort.signal,
  };
  const answer = (async (): Promise<RelayAnswer> => {
    try {
      const response = await fetch(
        `${base}/v1/community/publishing/uploads/${componentId}`,
        init,
      );
      const chunksBeforeAnswer = chunks;
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.json(),
        chunksBeforeAnswer,
      };
    } finally {
      abort.abort();
    }
  })();
  return { answer, chunks: () => chunks };
};

/**
 * A raw TCP client that sends the request head, then after `bodyDelayMs` the
 * whole body in one write. It resolves with everything the server answered
 * once the server closed the connection, or once it stayed silent and open
 * for `idleMs`. `next` is written on the same connection after the first
 * answer arrived.
 */
const finiteClient = (
  base: string,
  headers: Record<string, string>,
  body: Buffer,
  {
    bodyDelayMs = 0,
    idleMs = 1_500,
    next,
  }: { bodyDelayMs?: number; idleMs?: number; next?: string } = {},
) => {
  const { hostname, port } = new URL(base);
  const socket = connect({ host: hostname, port: Number(port) });
  let received = "";
  let bodySentAt: number | null = null;
  let wroteNext = false;
  return new Promise<{
    readonly answer: string;
    readonly answeredBeforeBody: boolean;
    /** Milliseconds from the body write until the server closed; null when it stayed open. */
    readonly closedAfterBodyMs: number | null;
    /**
     * How the connection ended: `end` is the server's graceful FIN, `error`
     * carries the socket error code (a reset), null when it stayed open.
     */
    readonly ending: "end" | `error:${string}` | "close" | null;
  }>((resolve) => {
    let settled = false;
    let answeredBeforeBody = false;
    const settle = (ending: "end" | `error:${string}` | "close" | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      socket.destroy();
      resolve({
        answer: received,
        answeredBeforeBody,
        closedAfterBodyMs:
          ending !== null && bodySentAt !== null
            ? Date.now() - bodySentAt
            : null,
        ending,
      });
    };
    const idle = setTimeout(() => settle(null), idleMs + bodyDelayMs);
    socket.on("data", (data: Buffer) => {
      if (received === "" && bodySentAt === null) answeredBeforeBody = true;
      received += data.toString("utf8");
      idle.refresh();
      if (next !== undefined && !wroteNext && received.includes("}")) {
        wroteNext = true;
        socket.write(next);
      }
    });
    socket.on("end", () => settle("end"));
    socket.on("close", () => settle("close"));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      settle(`error:${error.code ?? "unknown"}`),
    );
    socket.once("connect", () => {
      const head = [
        `POST /v1/community/publishing/uploads/${componentId} HTTP/1.1`,
        `host: ${hostname}:${port}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n");
      const send = () => {
        socket.write(body);
        bodySentAt = Date.now();
      };
      // Without a delay the body travels in the same write as the head, so
      // the server has the complete request before any handler answers.
      if (bodyDelayMs === 0) {
        socket.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
        bodySentAt = Date.now();
      } else {
        socket.write(head, "latin1");
        setTimeout(send, bodyDelayMs);
      }
    });
  });
};

const errorOf = (answer: string) =>
  apiErrorSchema.parse(JSON.parse(answer.slice(answer.indexOf("\r\n\r\n") + 4)))
    .error;

describe("work publishing author HTTP surface", () => {
  it("streams a component, hashes the stored bytes and commits behind the fence", async () => {
    const bytes = randomBytes(300 * KiB);
    const store = new MemoryMediaStore();
    const fake = uploadPort(bytes.byteLength);
    const { base, signIn } = await start({ port: fake.port, store });
    const token = await signIn();
    const attempt = randomUUID();

    const upload = rawUpload(
      base,
      uploadHeaders(token, bytes.byteLength, attempt),
    );
    upload.client.write(bytes.subarray(0, 100 * KiB));
    upload.client.end(bytes.subarray(100 * KiB));
    const answer = await upload.answer;

    expect(answer.status).toBe(200);
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    const result = publishingUploadResultSchema.parse(JSON.parse(answer.text));
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(result).toMatchObject({
      componentId,
      sha256: digest,
      receivedBytes: bytes.byteLength,
    });
    expect([...store.blobs.values()]).toEqual([bytes]);
    const [begin] = fake.named("beginComponentUpload");
    expect(begin?.args).toEqual([
      actor,
      componentId,
      { attempt, contentLength: bytes.byteLength, supersede: false },
      now,
    ]);
    const [commit] = fake.named("commitComponentUpload");
    expect(commit?.args[0]).toEqual(fenceFor(bytes.byteLength, attempt));
    expect(commit?.args[1]).toMatchObject({
      byteSize: bytes.byteLength,
      sha256: digest,
    });
    expect(fake.named("abortComponentUpload")).toHaveLength(0);
  });

  it("refuses transfers whose headers or declared length do not match before storing", async () => {
    const store = new MemoryMediaStore();
    const fake = uploadPort(64 * KiB);
    const { base, signIn } = await start({ port: fake.port, store });
    const token = await signIn();
    const body = randomBytes(64 * KiB);

    // Larger than declared: 413 with the rule code; nothing is streamed.
    const larger = rawUpload(base, uploadHeaders(token, 64 * KiB + 1));
    larger.client.end(Buffer.concat([body, Buffer.from([1])]));
    const tooLarge = await larger.answer;
    expect(tooLarge.status).toBe(413);
    expect(apiErrorSchema.parse(JSON.parse(tooLarge.text)).error).toMatchObject(
      {
        code: "INVALID_INPUT",
        message: "component_too_large",
      },
    );

    // Smaller than declared: a generic invalid input.
    const smaller = rawUpload(base, uploadHeaders(token, 64 * KiB - 1));
    smaller.client.end(body.subarray(1));
    expect((await smaller.answer).status).toBe(422);

    for (const headers of [
      uploadHeaders(token, 64 * KiB, "not-a-uuid"),
      uploadHeaders(token, 64 * KiB, randomUUID(), {
        "content-type": "image/jpeg",
      }),
    ]) {
      const refused = rawUpload(base, headers);
      refused.client.end(body);
      const answer = await refused.answer;
      expect(answer.status).toBe(422);
    }

    // No content-length (chunked): refused before the fence.
    const { "content-length": _omitted, ...chunkedHeaders } = uploadHeaders(
      token,
      64 * KiB,
    );
    void _omitted;
    const chunked = rawUpload(base, chunkedHeaders);
    chunked.client.write(body.subarray(0, KiB));
    chunked.client.end();
    expect((await chunked.answer).status).toBe(422);

    // A query string is refused too.
    const queried = rawUpload(
      base,
      uploadHeaders(token, 64 * KiB),
      `/v1/community/publishing/uploads/${componentId}?retry=1`,
    );
    queried.client.end(body);
    expect((await queried.answer).status).toBe(422);

    expect(fake.named("beginComponentUpload")).toHaveLength(2);
    expect(fake.named("commitComponentUpload")).toHaveLength(0);
    expect(store.blobs.size).toBe(0);
  });

  it("answers 413 when more bytes than the fence allows arrive and stores nothing", async () => {
    const store = new MemoryMediaStore();
    const declared = 32 * KiB;
    // The fence names fewer bytes than the transfer carries: the store limit trips.
    const fake = uploadPort(declared, {
      beginComponentUpload: (
        _a: string,
        _c: string,
        start: { attempt: string },
      ) => fenceFor(declared, start.attempt),
    });
    const { base, signIn } = await start({ port: fake.port, store });
    const token = await signIn();
    const upload = rawUpload(base, uploadHeaders(token, 128 * KiB));
    upload.client.end(randomBytes(128 * KiB));
    const answer = await upload.answer;
    expect(answer.status).toBe(413);
    expect(apiErrorSchema.parse(JSON.parse(answer.text)).error.message).toBe(
      "component_too_large",
    );
    await until(() => fake.named("abortComponentUpload").length === 1, "abort");
    expect(fake.named("commitComponentUpload")).toHaveLength(0);
    expect(store.blobs.size).toBe(0);
  });

  it("stops a transfer cancelled mid-stream with an early 409 and never commits it", async () => {
    const store = new MemoryMediaStore();
    const declared = 1024 * KiB;
    const fake = uploadPort(declared, {
      cancelItem: () => ({
        item: mediaItem(declared, "cancelled"),
        cancelledComponentIds: [componentId],
      }),
    });
    const { base, signIn } = await start({ port: fake.port, store });
    const token = await signIn();
    const upload = rawUpload(base, uploadHeaders(token, declared));
    upload.client.write(randomBytes(64 * KiB));
    await until(() => store.received > 0, "first bytes");

    const cancelled = await fetch(
      `${base}/v1/community/publishing/items/${itemId}/cancel`,
      json(token, { requestId: randomUUID() }),
    );
    expect(cancelled.status).toBe(200);
    expect(publishingMediaItemSchema.parse(await cancelled.json()).state).toBe(
      "cancelled",
    );

    const answer = await upload.answer;
    expect(answer.status).toBe(409);
    expect(apiErrorSchema.parse(JSON.parse(answer.text)).error.code).toBe(
      "CONFLICT",
    );
    upload.client.destroy();
    await until(() => fake.named("abortComponentUpload").length === 1, "abort");
    expect(fake.named("commitComponentUpload")).toHaveLength(0);
    expect(store.blobs.size).toBe(0);
    const [cancel] = fake.named("cancelItem");
    expect(cancel?.args[3]).toBe(now);
  });

  it("refuses a second transfer of a component still streaming and reports superseded commits", async () => {
    const store = new MemoryMediaStore();
    const declared = 256 * KiB;
    const transfers = new PublishingTransferRegistry();
    const fake = uploadPort(declared);
    const { base, signIn } = await start({ port: fake.port, store, transfers });
    const token = await signIn();

    const first = rawUpload(base, uploadHeaders(token, declared));
    first.client.write(randomBytes(16 * KiB));
    await until(() => transfers.isActive(componentId), "active transfer");
    const second = rawUpload(base, uploadHeaders(token, declared));
    second.client.end(randomBytes(declared));
    const refused = await second.answer;
    expect(refused.status).toBe(409);
    // The second attempt was checked without taking over, then refused.
    expect(
      fake
        .named("beginComponentUpload")
        .map((call) => (call.args[2] as UploadStart).supersede),
    ).toEqual([false, false]);
    expect(fake.component.attempt).not.toBeNull();
    first.client.destroy();
    await until(() => !transfers.isActive(componentId), "released transfer");

    // The fence moved on at commit: 409 and the written blob is removed.
    const superseded = uploadPort(declared, {
      commitComponentUpload: () => ({ status: "superseded" }),
    });
    const next = await start({ port: superseded.port, store });
    const nextToken = await next.signIn();
    const late = rawUpload(next.base, uploadHeaders(nextToken, declared));
    late.client.end(randomBytes(declared));
    const answer = await late.answer;
    expect(answer.status).toBe(409);
    expect(store.blobs.size).toBe(0);
    expect(store.removed).toHaveLength(1);
  });

  it("aborts the fence when the client disconnects mid-stream", async () => {
    const store = new MemoryMediaStore();
    const declared = 512 * KiB;
    const transfers = new PublishingTransferRegistry();
    const fake = uploadPort(declared);
    const { base, signIn } = await start({ port: fake.port, store, transfers });
    const token = await signIn();
    const upload = rawUpload(base, uploadHeaders(token, declared));
    upload.client.write(randomBytes(32 * KiB));
    await until(() => store.received > 0, "first bytes");
    upload.client.destroy();

    await until(() => fake.named("abortComponentUpload").length === 1, "abort");
    const [abort] = fake.named("abortComponentUpload");
    expect(abort?.args[0]).toMatchObject({ componentId, byteSize: declared });
    expect(abort?.args[1]).toBe(now);
    expect(fake.named("commitComponentUpload")).toHaveLength(0);
    expect(store.blobs.size).toBe(0);
    await until(() => transfers.size === 0, "released transfer");
  });

  it("delivers an early 409 to a client that keeps sending and reads on for the window", async () => {
    const store = new MemoryMediaStore();
    const declared = 1024 * 1024 * KiB;
    const fake = uploadPort(declared, {
      cancelItem: () => ({
        item: mediaItem(declared, "cancelled"),
        cancelledComponentIds: [componentId],
      }),
    });
    const { base, signIn } = await start({
      port: fake.port,
      store,
      transferPolicy: { refusalReadMs: 400 },
    });
    const token = await signIn();
    const sending = sendingClient(base, uploadHeaders(token, declared), {
      tickMs: 1,
    });
    await until(() => store.received > 0, "first bytes");
    const cancelled = await fetch(
      `${base}/v1/community/publishing/items/${itemId}/cancel`,
      json(token, { requestId: randomUUID() }),
    );
    expect(cancelled.status).toBe(200);

    const { answer, openAfterAnswerMs } = await sending;
    expect(statusOf(answer)).toBe(409);
    // A close announcement would end a half-duplex relay before it read the
    // answer (see the relay-style client test below).
    expect(headersOf(answer)).not.toContain("connection: close");
    expect(errorOf(answer).message).toBe("The transfer was cancelled");
    // The connection stayed open (bytes read and discarded) for the window.
    expect(openAfterAnswerMs).toBeGreaterThanOrEqual(300);
    expect(openAfterAnswerMs).toBeLessThan(3_000);
    await until(() => fake.named("abortComponentUpload").length === 1, "abort");
    expect(fake.named("commitComponentUpload")).toHaveLength(0);
    expect(store.blobs.size).toBe(0);
  });

  it("delivers refusals before the fence to a client that keeps sending", async () => {
    const declared = 64 * KiB;
    const fake = uploadPort(declared);
    const identity = new InMemoryCommunityIdentityPort();
    const { base, signIn } = await start({
      port: fake.port,
      store: new MemoryMediaStore(),
      transferPolicy: { refusalReadMs: 400 },
      identity,
    });
    const token = await signIn();
    // Far more than the client can send during the test.
    const huge = 1024 * 1024 * 1024 * KiB;

    for (const [headers, status, message] of [
      [uploadHeaders(token, huge), 413, "component_too_large"],
      [
        { ...uploadHeaders(token, huge), "x-author-account": other },
        401,
        "A valid session is required",
      ],
      // A well-formed credential of no session: refused before dispatch.
      [
        { ...uploadHeaders(token, huge), authorization: unknownSession },
        401,
        "A valid session is required",
      ],
      [
        uploadHeaders(token, huge, "not-a-uuid"),
        422,
        "Invalid community input",
      ],
    ] as const) {
      const { answer, openAfterAnswerMs } = await sendingClient(base, headers);
      expect(statusOf(answer)).toBe(status);
      expect(headersOf(answer)).not.toContain("connection: close");
      expect(errorOf(answer).message).toBe(message);
      expect(openAfterAnswerMs).toBeGreaterThanOrEqual(300);
      expect(openAfterAnswerMs).toBeLessThan(3_000);
    }

    // The session check itself fails: a 503 answer, read on for the window.
    identity.unavailable = true;
    const { answer, openAfterAnswerMs } = await sendingClient(
      base,
      uploadHeaders(token, huge),
    );
    expect(statusOf(answer)).toBe(503);
    expect(headersOf(answer)).not.toContain("connection: close");
    expect(errorOf(answer)).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Community service is temporarily unavailable",
    });
    expect(openAfterAnswerMs).toBeGreaterThanOrEqual(300);
    expect(openAfterAnswerMs).toBeLessThan(3_000);
    expect(fake.named("beginComponentUpload")).toHaveLength(1);
  });

  it("lets a relay-style half-duplex client read early refusals as their JSON answers", async () => {
    const store = new MemoryMediaStore();
    const declared = 1024 * 1024 * KiB;
    const fake = uploadPort(declared, {
      cancelItem: () => ({
        item: mediaItem(declared, "cancelled"),
        cancelledComponentIds: [componentId],
      }),
    });
    const identity = new InMemoryCommunityIdentityPort();
    const { base, signIn } = await start({
      port: fake.port,
      store,
      transferPolicy: { refusalReadMs: 2_000 },
      identity,
    });
    const token = await signIn();

    // Cancelled mid-stream: the relay still sends when the 409 arrives.
    const cancelled = relayUpload(base, uploadHeaders(token, declared));
    await until(() => store.received >= 256 * KiB, "streamed bytes");
    const cancel = await fetch(
      `${base}/v1/community/publishing/items/${itemId}/cancel`,
      json(token, { requestId: randomUUID() }),
    );
    expect(cancel.status).toBe(200);
    const answer = await cancelled.answer;
    expect(answer.status).toBe(409);
    expect(answer.contentType).toBe("application/json; charset=utf-8");
    expect(apiErrorSchema.parse(answer.body).error).toMatchObject({
      code: "CONFLICT",
      message: "The transfer was cancelled",
    });
    expect(answer.chunksBeforeAnswer).toBeGreaterThan(4);
    expect(answer.chunksBeforeAnswer * 64 * KiB).toBeLessThan(declared);
    await until(() => fake.named("abortComponentUpload").length === 1, "abort");
    expect(fake.named("commitComponentUpload")).toHaveLength(0);
    expect(store.blobs.size).toBe(0);

    // Refused at the head (length, account, session): the same JSON answers.
    for (const [headers, status, message] of [
      [uploadHeaders(token, declared + 1), 413, "component_too_large"],
      [
        { ...uploadHeaders(token, declared), "x-author-account": other },
        401,
        "A valid session is required",
      ],
      [
        { ...uploadHeaders(token, declared), authorization: unknownSession },
        401,
        "A valid session is required",
      ],
    ] as const) {
      const refused = await relayUpload(base, headers).answer;
      expect(refused.status).toBe(status);
      expect(apiErrorSchema.parse(refused.body).error.message).toBe(message);
    }
    identity.unavailable = true;
    const unavailable = await relayUpload(base, uploadHeaders(token, declared))
      .answer;
    expect(unavailable.status).toBe(503);
    expect(apiErrorSchema.parse(unavailable.body).error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Community service is temporarily unavailable",
    });
    expect(fake.named("beginComponentUpload")).toHaveLength(2);
    expect(store.blobs.size).toBe(0);
  });

  it("closes a refused transfer once its body ended and keeps a connection whose body had already arrived", async () => {
    const fake = uploadPort(64 * KiB, { readSettings: () => settings });
    const identity = new InMemoryCommunityIdentityPort();
    const { base, signIn, address } = await start({
      port: fake.port,
      store: new MemoryMediaStore(),
      transferPolicy: { refusalReadMs: 2_000 },
      identity,
    });
    const token = await signIn();

    // The answer precedes the body; the connection ends gracefully (a FIN,
    // no reset) right after the body ended, long before the read window
    // would have passed.
    const lateBody = async (headers: Record<string, string>) => {
      const late = await finiteClient(base, headers, randomBytes(256 * KiB), {
        bodyDelayMs: 150,
      });
      expect(late.answeredBeforeBody).toBe(true);
      expect(headersOf(late.answer)).not.toContain("connection: close");
      expect(late.ending).toBe("end");
      expect(late.closedAfterBodyMs).not.toBeNull();
      expect(late.closedAfterBodyMs).toBeLessThan(1_000);
      return late.answer;
    };
    const wrongAccount = await lateBody({
      ...uploadHeaders(token, 256 * KiB),
      "x-author-account": other,
    });
    expect(statusOf(wrongAccount)).toBe(401);
    expect(errorOf(wrongAccount).code).toBe("UNAUTHENTICATED");
    identity.unavailable = true;
    const unavailable = await lateBody(uploadHeaders(token, 256 * KiB));
    expect(statusOf(unavailable)).toBe(503);
    expect(errorOf(unavailable).code).toBe("SERVICE_UNAVAILABLE");
    identity.unavailable = false;

    // The whole body came with the head: a plain answer, and the same
    // connection serves the next request.
    const kept = await finiteClient(
      base,
      { ...uploadHeaders(token, 16), "x-author-account": other },
      randomBytes(16),
      {
        idleMs: 500,
        next: [
          "GET /v1/community/publishing/limits HTTP/1.1",
          `host: ${address.address}:${address.port}`,
          `authorization: Bearer ${token}`,
          "",
          "",
        ].join("\r\n"),
      },
    );
    expect(statusOf(kept.answer)).toBe(401);
    expect(kept.answer).toContain("HTTP/1.1 200 OK");
    expect(kept.closedAfterBodyMs).toBeNull();
    expect(kept.ending).toBeNull();
    expect(fake.named("beginComponentUpload")).toHaveLength(0);
  });

  it.each([
    [
      "a component reset",
      `items/${itemId}/components/still/reset`,
      "resetComponent",
      { item: mediaItem(1024 * KiB), cancelledComponentIds: [componentId] },
    ],
    [
      "a draft deletion",
      `drafts/${draftId}`,
      "deleteDraft",
      {
        result: {
          deleted: true,
          snapshots: 0,
          conflictCopies: 0,
          mediaItems: 1,
        },
        cancelledComponentIds: [componentId],
      },
    ],
    [
      "a session discard",
      `sessions/publishing-session-${"7".repeat(32)}/discard`,
      "discardSession",
      { result: { discarded: true }, cancelledComponentIds: [componentId] },
    ],
  ] as const)(
    "stops a streaming transfer on %s",
    async (_label, path, method, change) => {
      const store = new MemoryMediaStore();
      const declared = 1024 * KiB;
      const transfers = new PublishingTransferRegistry();
      const fake = uploadPort(declared, { [method]: () => change });
      const { base, signIn } = await start({
        port: fake.port,
        store,
        transfers,
      });
      const token = await signIn();
      const upload = rawUpload(base, uploadHeaders(token, declared));
      upload.client.write(randomBytes(64 * KiB));
      await until(() => transfers.isActive(componentId), "active transfer");

      const commanded = await fetch(
        `${base}/v1/community/publishing/${path}`,
        json(
          token,
          { requestId: randomUUID() },
          method === "deleteDraft" ? "DELETE" : "POST",
        ),
      );
      expect(commanded.status).toBe(200);
      const answer = await upload.answer;
      expect(answer.status).toBe(409);
      upload.client.destroy();
      await until(() => transfers.size === 0, "released transfer");
      expect(fake.named(method)).toHaveLength(1);
      expect(fake.named("commitComponentUpload")).toHaveLength(0);
      expect(fake.named("abortComponentUpload")).toHaveLength(1);
      expect(store.blobs.size).toBe(0);
    },
  );

  it("lets no other account hold a component while its ownership check runs", async () => {
    const store = new MemoryMediaStore();
    const declared = 64 * KiB;
    const transfers = new PublishingTransferRegistry();
    const fence = componentFence(declared);
    let othersWaiting = 0;
    let admitOthers!: () => void;
    const gate = new Promise<void>((resolve) => {
      admitOthers = resolve;
    });
    const fake = fakePort({
      commitComponentUpload: fence.commitComponentUpload,
      abortComponentUpload: fence.abortComponentUpload,
      beginComponentUpload: async (
        actorId: string,
        component: string,
        start: UploadStart,
      ) => {
        if (actorId !== actor) {
          othersWaiting += 1;
          await gate;
        }
        return fence.beginComponentUpload(actorId, component, start);
      },
    });
    const { base, signIn } = await start({ port: fake.port, store, transfers });
    const ownerToken = await signIn();
    const otherToken = await signIn(fixtureUsers.second.handle);

    const foreign = rawUpload(base, {
      ...uploadHeaders(otherToken, declared),
      "x-author-account": other,
    });
    foreign.client.end(randomBytes(declared));
    await until(() => othersWaiting === 1, "foreign ownership check");
    expect(transfers.size).toBe(1);
    expect(transfers.isActive(componentId)).toBe(false);

    const bytes = randomBytes(declared);
    const owned = rawUpload(base, uploadHeaders(ownerToken, declared));
    owned.client.end(bytes);
    const ownedAnswer = await owned.answer;
    expect(ownedAnswer.status).toBe(200);
    expect(
      publishingUploadResultSchema.parse(JSON.parse(ownedAnswer.text)).sha256,
    ).toBe(createHash("sha256").update(bytes).digest("hex"));

    admitOthers();
    const foreignAnswer = await foreign.answer;
    expect(foreignAnswer.status).toBe(404);
    await until(() => transfers.size === 0, "released transfers");
  });

  it("takes over a component left receiving when no transfer of it streams here", async () => {
    const store = new MemoryMediaStore();
    const declared = 64 * KiB;
    const fake = uploadPort(declared);
    fake.component.state = "receiving";
    fake.component.attempt = randomUUID();
    const { base, signIn } = await start({ port: fake.port, store });
    const token = await signIn();
    const attempt = randomUUID();
    const upload = rawUpload(base, uploadHeaders(token, declared, attempt));
    upload.client.end(randomBytes(declared));
    expect((await upload.answer).status).toBe(200);
    expect(
      fake
        .named("beginComponentUpload")
        .map((call) => (call.args[2] as UploadStart).supersede),
    ).toEqual([false, true]);
    expect(fake.component.state).toBe("received");
  });

  it("ends a transfer that stops delivering bytes after the idle timeout", async () => {
    const store = new MemoryMediaStore();
    const declared = 512 * KiB;
    const transfers = new PublishingTransferRegistry();
    const fake = uploadPort(declared);
    const { base, signIn } = await start({
      port: fake.port,
      store,
      transfers,
      transferPolicy: { idleTimeoutMs: 150 },
    });
    const token = await signIn();
    const upload = rawUpload(base, uploadHeaders(token, declared));
    const closed = new Promise<number>((resolve) => {
      const started = Date.now();
      upload.client.on("close", () => resolve(Date.now() - started));
    });
    upload.client.write(randomBytes(16 * KiB));
    await until(() => store.received > 0, "first bytes");

    // The client neither sends nor closes: the server closes after the timeout.
    await expect(upload.answer).rejects.toThrow();
    expect(await closed).toBeGreaterThanOrEqual(150);
    await until(() => fake.named("abortComponentUpload").length === 1, "abort");
    await until(() => transfers.size === 0, "released transfer");
    expect(fake.component.state).toBe("awaiting");
    expect(fake.named("commitComponentUpload")).toHaveLength(0);
    expect(store.blobs.size).toBe(0);
  });

  it("keeps uploads that stream past the request deadline and ends slow command bodies", async () => {
    const store = new MemoryMediaStore();
    const chunks = 12;
    const declared = chunks * 16 * KiB;
    const fake = uploadPort(declared);
    const { base, signIn, server } = await start({
      port: fake.port,
      store,
      requestDeadlineMs: 300,
    });
    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(300);
    const token = await signIn();

    const bytes = randomBytes(declared);
    const upload = rawUpload(base, uploadHeaders(token, declared));
    const started = Date.now();
    for (let index = 0; index < chunks; index += 1) {
      upload.client.write(
        bytes.subarray(index * 16 * KiB, (index + 1) * 16 * KiB),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    upload.client.end();
    const answer = await upload.answer;
    expect(Date.now() - started).toBeGreaterThan(600);
    expect(answer.status).toBe(200);
    expect(store.blobs.size).toBe(1);

    const slow = httpRequest(`${base}/v1/community/publishing/drafts`, {
      method: "POST",
      agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        "x-author-account": actor,
        "content-type": "application/json",
        "content-length": "200",
      },
    });
    const failure = new Promise<Error>((resolve) => {
      slow.on("error", resolve);
      slow.on("response", () => resolve(new Error("answered")));
    });
    slow.write('{"requestId":');
    const error = await failure;
    expect(error.message).not.toBe("answered");
    expect(fake.named("createDraft")).toHaveLength(0);
  });

  it("serves derivatives with single byte ranges, 416 outside them and private headers", async () => {
    const store = new MemoryMediaStore();
    const bytes = randomBytes(1000);
    store.blobs.set(`blobs/aa/bb/${"c".repeat(32)}`, bytes);
    const fake = fakePort({
      resolveMediaRead: (
        _viewer: string | null,
        item: string,
        variant: string,
      ) =>
        item === itemId && variant === "display"
          ? {
              storageKey: `blobs/aa/bb/${"c".repeat(32)}`,
              contentType: "image/webp",
              byteSize: bytes.byteLength,
              sha256: "0".repeat(64),
            }
          : null,
    });
    const { base } = await start({ port: fake.port, store, media: false });
    const url = `${base}/v1/community/publishing/media/${itemId}/display/base`;

    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("image/webp");
    expect(whole.headers.get("content-length")).toBe("1000");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("cache-control")).toBe("private, no-store");
    expect(whole.headers.get("vary")).toBe("Authorization");
    expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(bytes);

    const part = await fetch(url, { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(part.headers.get("content-length")).toBe("10");
    expect(Buffer.from(await part.arrayBuffer())).toEqual(
      bytes.subarray(10, 20),
    );

    const tail = await fetch(url, { headers: { range: "bytes=-5" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 995-999/1000");

    // Another unit or several ranges are ignored (RFC 9110 §14.2).
    for (const range of ["items=0-1", "bytes=0-1,5-6"]) {
      const ignored = await fetch(url, { headers: { range } });
      expect(ignored.status).toBe(200);
      expect(ignored.headers.get("content-range")).toBeNull();
      expect(Buffer.from(await ignored.arrayBuffer())).toEqual(bytes);
    }

    for (const range of ["bytes=1000-", "bytes=20-10", "bytes=-0", "bytes=x"]) {
      const refused = await fetch(url, { headers: { range } });
      expect(refused.status).toBe(416);
      expect(refused.headers.get("content-range")).toBe("bytes */1000");
      await refused.arrayBuffer();
    }

    const head = await fetch(url, {
      method: "HEAD",
      headers: { range: "bytes=0-9" },
    });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("10");

    await expectApiError(
      await fetch(`${base}/v1/community/publishing/media/${itemId}/thumb/base`),
      404,
      "ITEM_NOT_FOUND",
    );
    await expectApiError(
      await fetch(
        `${base}/v1/community/publishing/media/${itemId}/original/base`,
      ),
      404,
      "ITEM_NOT_FOUND",
    );
    await expectApiError(
      await fetch(`${url}?download=1`),
      422,
      "INVALID_INPUT",
    );
    await expectApiError(
      await fetch(url, { headers: { authorization: "Bearer invalid" } }),
      401,
      "UNAUTHENTICATED",
    );
    // Only the well-formed display lookup reached the port.
    expect(
      fake.named("resolveMediaRead").map((call) => call.args[2]),
    ).not.toContain("original");
  });

  it("passes the viewer's account to media authorization", async () => {
    const store = new MemoryMediaStore();
    const storageKey = `blobs/aa/bb/${"d".repeat(32)}`;
    const bytes = randomBytes(64);
    store.blobs.set(storageKey, bytes);
    const fake = fakePort({
      // Private media of the owner: nobody else resolves it.
      resolveMediaRead: (viewer: string | null) =>
        viewer === actor
          ? {
              storageKey,
              contentType: "image/webp",
              byteSize: bytes.byteLength,
              sha256: "0".repeat(64),
            }
          : null,
    });
    const { base, signIn } = await start({ port: fake.port, store });
    const ownerToken = await signIn();
    const otherToken = await signIn(fixtureUsers.second.handle);
    const editKey = "e".repeat(32);
    const url = `${base}/v1/community/publishing/media/${itemId}/thumb/${editKey}`;

    await expectApiError(await fetch(url), 404, "ITEM_NOT_FOUND");
    const owned = await fetch(url, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(owned.status).toBe(200);
    expect(Buffer.from(await owned.arrayBuffer())).toEqual(bytes);
    await expectApiError(
      await fetch(url, { headers: { authorization: `Bearer ${otherToken}` } }),
      404,
      "ITEM_NOT_FOUND",
    );
    expect(fake.named("resolveMediaRead").map((call) => call.args)).toEqual([
      [null, itemId, "thumb", editKey],
      [actor, itemId, "thumb", editKey],
      [other, itemId, "thumb", editKey],
    ]);
  });

  it.each(["development", "production"] as const)(
    "reports unavailable media dependencies honestly in %s",
    async (nodeEnv) => {
      const fake = fakePort({});
      const { base, signIn } = await start({
        port: fake.port,
        media: false,
        nodeEnv,
      });
      const token = await signIn();
      const upload = rawUpload(base, uploadHeaders(token, 16 * KiB));
      upload.client.end(randomBytes(16 * KiB));
      const answer = await upload.answer;
      expect(answer.status).toBe(503);
      expect(apiErrorSchema.parse(JSON.parse(answer.text)).error.code).toBe(
        "SERVICE_UNAVAILABLE",
      );
      await expectApiError(
        await fetch(
          `${base}/v1/community/publishing/items`,
          json(token, { requestId: randomUUID() }),
        ),
        503,
        "SERVICE_UNAVAILABLE",
      );
      await expectApiError(
        await fetch(
          `${base}/v1/community/publishing/media/${itemId}/display/base`,
        ),
        503,
        "SERVICE_UNAVAILABLE",
      );
      // A store without the processor still refuses new media.
      const withStoreOnly = await start({
        port: fake.port,
        store: new MemoryMediaStore(),
        media: false,
        nodeEnv,
      });
      const storeToken = await withStoreOnly.signIn();
      const refused = rawUpload(
        withStoreOnly.base,
        uploadHeaders(storeToken, 16 * KiB),
      );
      refused.client.end(randomBytes(16 * KiB));
      expect((await refused.answer).status).toBe(503);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each(["development", "production"] as const)(
    "requires session and account truth for draft commands in %s",
    async (nodeEnv) => {
      const fake = fakePort({
        readDraft: () => draft,
        createDraft: () => draft,
      });
      const { base, signIn } = await start({
        port: fake.port,
        nodeEnv,
        store: new MemoryMediaStore(),
      });
      const token = await signIn();
      const body = { requestId: randomUUID(), content, deviceClass: null };

      await expectApiError(
        await fetch(`${base}/v1/community/publishing/drafts`, json(null, body)),
        401,
        "UNAUTHENTICATED",
      );
      await expectApiError(
        await fetch(
          `${base}/v1/community/publishing/drafts`,
          json(token, body, "POST", other),
        ),
        401,
        "UNAUTHENTICATED",
      );
      await expectApiError(
        await fetch(
          `${base}/v1/community/publishing/drafts`,
          json(token, body, "POST", null),
        ),
        401,
        "UNAUTHENTICATED",
      );
      await expectApiError(
        await fetch(`${base}/v1/community/publishing/drafts/${draftId}`, {
          headers: { authorization: `Bearer ${"A".repeat(43)}` },
        }),
        401,
        "UNAUTHENTICATED",
      );
      await expectApiError(
        await fetch(`${base}/v1/community/publishing/limits`),
        401,
        "UNAUTHENTICATED",
      );
      const upload = rawUpload(base, {
        ...uploadHeaders(token, KiB),
        "x-author-account": other,
      });
      upload.client.end(randomBytes(KiB));
      const refused = await upload.answer;
      expect(refused.status).toBe(401);
      expect(fake.calls).toHaveLength(0);

      const created = await fetch(
        `${base}/v1/community/publishing/drafts`,
        json(token, body),
      );
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toBe("private, no-store");
      expect(publishingDraftSchema.parse(await created.json()).id).toBe(
        draftId,
      );
      // GET reads need no account assertion.
      const read = await fetch(
        `${base}/v1/community/publishing/drafts/${draftId}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(read.status).toBe(200);
    },
  );

  it("answers an opened edit draft with whether the request created it", async () => {
    const edit = {
      ...draft,
      kind: "edit",
      workId,
      baseRevisionId: `work-revision-${"6".repeat(32)}`,
      content: { ...content, authorship: null },
    } as const;
    let created = true;
    const fake = fakePort({
      openEditDraft: () => ({ draft: edit, created }),
    });
    const { base, signIn } = await start({ port: fake.port });
    const token = await signIn();
    const command = { requestId: randomUUID(), deviceClass: "phone" };
    for (const expected of [true, false]) {
      created = expected;
      const answer = await fetch(
        `${base}/v1/community/publishing/works/${workId}/draft`,
        json(token, command),
      );
      expect(answer.status).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("private, no-store");
      expect(
        publishingOpenedEditDraftSchema.parse(await answer.json()),
      ).toEqual({ draft: edit, created: expected });
    }
    expect(fake.named("openEditDraft").map((call) => call.args)).toEqual([
      [actor, workId, command, now],
      [actor, workId, command, now],
    ]);
  });

  it("parses queries and bodies strictly and surfaces publishing rule codes", async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };
    const fake = fakePort({
      listDrafts: () => page,
      readSettings: () => settings,
      saveDraft: () => {
        throw new CommunityInputError("draft_limit");
      },
      snapshotDraft: () => ({
        status: "conflict",
        draft: { ...draft, conflict: conflictCopy },
        conflict: conflictCopy,
      }),
      readSubmissionReceipt: () => null,
      readEditableWork: () => {
        throw new CommunityNotFoundError();
      },
    });
    const conflictCopy = {
      id: `work-draft-${"5".repeat(32)}`,
      device: { content, baseRevision: 1, deviceClass: "phone", savedAt: iso },
      account: { content, revision: 2, deviceClass: null, updatedAt: iso },
      createdAt: iso,
    } as const;
    const { base, signIn } = await start({ port: fake.port });
    const token = await signIn();
    const auth = { authorization: `Bearer ${token}` };
    const drafts = `${base}/v1/community/publishing/drafts`;

    expect(
      (await fetch(`${drafts}?page=2&pageSize=10`, { headers: auth })).status,
    ).toBe(200);
    expect(fake.named("listDrafts")[0]?.args).toEqual([
      actor,
      { page: 2, pageSize: 10 },
    ]);
    // Removed recycle-bin routes cannot expose or restore historical rows.
    await expectApiError(
      await fetch(`${base}/v1/community/publishing/trash?page=3&pageSize=5`, {
        headers: auth,
      }),
      404,
      "ITEM_NOT_FOUND",
    );
    for (const query of [
      "?page=1&page=2",
      "?extra=1",
      "?page=0",
      "?pageSize=51",
      "?page=1e2",
    ])
      await expectApiError(
        await fetch(`${drafts}${query}`, { headers: auth }),
        422,
        "INVALID_INPUT",
      );
    await expectApiError(
      await fetch(`${base}/v1/community/publishing/limits?x=1`, {
        headers: auth,
      }),
      422,
      "INVALID_INPUT",
    );
    expect(
      publishingLimitsSchema.parse(
        await (
          await fetch(`${base}/v1/community/publishing/limits`, {
            headers: auth,
          })
        ).json(),
      ),
    ).toEqual({
      maxItems: 50,
      originalItemMaxBytes: 134_217_728,
      standardComponentMaxBytes: 268_435_456,
      titleMax: 200,
      bodyMax: 10_000,
    });

    // Contract refinements that name a rule code travel as the message.
    await expectApiError(
      await fetch(
        drafts,
        json(token, {
          requestId: randomUUID(),
          content: { ...content, title: "  " },
          deviceClass: null,
        }),
      ),
      422,
      "INVALID_INPUT",
      "empty_work",
    );
    await expectApiError(
      await fetch(
        drafts,
        json(token, {
          requestId: randomUUID(),
          content: { ...content, title: "题".repeat(201) },
          deviceClass: null,
        }),
      ),
      422,
      "INVALID_INPUT",
      "title_too_long",
    );
    await expectApiError(
      await fetch(
        drafts,
        json(token, {
          requestId: randomUUID(),
          content,
          deviceClass: null,
          extra: 1,
        }),
      ),
      422,
      "INVALID_INPUT",
      "Invalid community input",
    );
    await expectApiError(
      await fetch(
        `${drafts}?x=1`,
        json(token, { requestId: randomUUID(), content, deviceClass: null }),
      ),
      422,
      "INVALID_INPUT",
    );
    const save = { baseRevision: 1, content, deviceClass: null };
    await expectApiError(
      await fetch(`${drafts}/${draftId}/save`, json(token, save)),
      422,
      "INVALID_INPUT",
      "draft_limit",
    );
    await expectApiError(
      await fetch(`${drafts}/${draftId}/save`, {
        ...json(token, save),
        headers: {
          authorization: `Bearer ${token}`,
          "x-author-account": actor,
          "content-type": "text/plain",
        },
      }),
      422,
      "INVALID_INPUT",
    );
    // A conflicting save is a result, not an error.
    const conflict = await fetch(
      `${drafts}/${draftId}/snapshot`,
      json(token, save),
    );
    expect(conflict.status).toBe(200);
    expect(
      publishingDraftSaveResultSchema.parse(await conflict.json()).status,
    ).toBe("conflict");

    await expectApiError(
      await fetch(
        `${base}/v1/community/publishing/trash/${workId}/restore`,
        json(token, { requestId: randomUUID() }),
      ),
      404,
      "ITEM_NOT_FOUND",
    );
    await expectApiError(
      await fetch(
        `${base}/v1/community/publishing/submissions/${randomUUID()}`,
        { headers: auth },
      ),
      404,
      "ITEM_NOT_FOUND",
    );
    await expectApiError(
      await fetch(`${base}/v1/community/publishing/works/${workId}/editable`, {
        headers: auth,
      }),
      404,
      "ITEM_NOT_FOUND",
    );
    // Malformed route ids never reach the port.
    for (const path of [
      "drafts/draft-1",
      "works/work-1/editable",
      "items/../items",
      "submissions/not-a-request",
    ])
      await expectApiError(
        await fetch(`${base}/v1/community/publishing/${path}`, {
          headers: auth,
        }),
        404,
        "ITEM_NOT_FOUND",
      );
    await expectApiError(
      await fetch(`${base}/v1/community/publishing/unknown`, { headers: auth }),
      404,
      "ITEM_NOT_FOUND",
    );
  });

  it("submits first, ensures edit derivatives only when not ready and permanently deletes works on DELETE", async () => {
    const receipt = {
      state: "confirmed",
      requestId: randomUUID(),
      workId,
      revisionId: `work-revision-${"6".repeat(32)}`,
      visibility: "public",
      submittedAt: iso,
    } as const;
    const fake = fakePort({
      ensureEditDerivatives: () => ({ ready: true, items: [] }),
      submit: () => receipt,
      deleteWork: () => ({ deleted: true }),
      deleteDraft: () => ({
        result: {
          deleted: true,
          snapshots: 2,
          conflictCopies: 0,
          mediaItems: 1,
        },
        cancelledComponentIds: [],
      }),
      discardSession: () => ({
        result: { discarded: true },
        cancelledComponentIds: [],
      }),
    });
    const { base, signIn } = await start({ port: fake.port });
    const token = await signIn();
    const command = {
      requestId: receipt.requestId,
      holder: { draftId },
      content,
      baseRevisionId: null,
    };
    const submitted = await fetch(
      `${base}/v1/community/publishing/submissions`,
      json(token, command),
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual(receipt);
    // Ready derivatives: one atomic submission, nothing ensured.
    expect(fake.calls.map((call) => call.name)).toEqual(["submit"]);
    expect(fake.named("submit")[0]?.args).toEqual([actor, command, now]);

    await expectApiError(
      await fetch(
        `${base}/v1/community/works/${workId}`,
        json(token, { requestId: randomUUID() }, "DELETE", null),
      ),
      401,
      "UNAUTHENTICATED",
    );
    expect(fake.named("deleteWork")).toHaveLength(0);
    const trashed = await fetch(
      `${base}/v1/community/works/${workId}`,
      json(token, { requestId: randomUUID() }, "DELETE"),
    );
    expect(trashed.status).toBe(200);
    expect(await trashed.json()).toEqual({ deleted: true });
    expect(fake.named("deleteWork")[0]?.args.slice(0, 2)).toEqual([
      actor,
      workId,
    ]);

    const deleted = await fetch(
      `${base}/v1/community/publishing/drafts/${draftId}`,
      json(token, { requestId: randomUUID() }, "DELETE"),
    );
    expect(await deleted.json()).toEqual({
      deleted: true,
      snapshots: 2,
      conflictCopies: 0,
      mediaItems: 1,
    });
    const discarded = await fetch(
      `${base}/v1/community/publishing/sessions/publishing-session-${"7".repeat(32)}/discard`,
      json(token, { requestId: randomUUID() }),
    );
    expect(await discarded.json()).toEqual({ discarded: true });
    // The retired Phase 4 draft routes are gone.
    for (const [path, method] of [
      [`works/${workId}/drafts`, "GET"],
      [`works/${workId}/drafts`, "POST"],
      [`works/${workId}/drafts/apply`, "POST"],
    ] as const)
      expect(
        (
          await fetch(
            `${base}/v1/community/${path}`,
            method === "GET"
              ? { headers: { authorization: `Bearer ${token}` } }
              : json(token, { requestId: randomUUID() }),
          )
        ).status,
      ).toBe(404);
  });

  it("deletes a draft only at the confirmed revision and answers draft_changed as a conflict", async () => {
    const removal = {
      result: { deleted: true, snapshots: 1, conflictCopies: 1, mediaItems: 0 },
      cancelledComponentIds: [],
    };
    const fake = fakePort({
      deleteDraft: (
        _actor: string,
        _draft: string,
        command: { readonly expectedRevision?: number },
      ) => {
        if (
          command.expectedRevision !== undefined &&
          command.expectedRevision !== draft.revision
        )
          throw new CommunityConflictError("draft_changed");
        return removal;
      },
    });
    const { base, signIn } = await start({ port: fake.port });
    const token = await signIn();
    const url = `${base}/v1/community/publishing/drafts/${draftId}`;

    const stale = { requestId: randomUUID(), expectedRevision: 1 };
    await expectApiError(
      await fetch(url, json(token, stale, "DELETE")),
      409,
      "CONFLICT",
      "draft_changed",
    );
    const current = { requestId: randomUUID(), expectedRevision: 2 };
    const deleted = await fetch(url, json(token, current, "DELETE"));
    expect(deleted.status).toBe(200);
    expect(
      publishingDraftDeletionResultSchema.parse(await deleted.json()),
    ).toEqual(removal.result);
    const unconditional = { requestId: randomUUID() };
    expect(
      (await fetch(url, json(token, unconditional, "DELETE"))).status,
    ).toBe(200);
    expect(fake.named("deleteDraft").map((call) => call.args)).toEqual([
      [actor, draftId, stale, now],
      [actor, draftId, current, now],
      [actor, draftId, unconditional, now],
    ]);

    fake.calls.length = 0;
    for (const body of [
      { requestId: randomUUID(), expectedRevision: 0 },
      { requestId: randomUUID(), expectedRevision: 1.5 },
      { requestId: randomUUID(), expectedRevision: "2" },
      { requestId: randomUUID(), expectedRevision: null },
      { requestId: randomUUID(), expectedRevision: 2, extra: true },
      { expectedRevision: 2 },
    ])
      await expectApiError(
        await fetch(url, json(token, body, "DELETE")),
        422,
        "INVALID_INPUT",
        "Invalid community input",
      );
    expect(fake.calls).toHaveLength(0);
  });

  it("answers an explicit readiness check for a draft or session holder from the port's item states", async () => {
    const sessionId = `publishing-session-${"7".repeat(32)}`;
    const editKey = "0123456789abcdef0123456789abcdef";
    const readinessContent = {
      ...content,
      items: [
        {
          key: "pending",
          itemId: null,
          kind: "static",
          qualityMode: "standard",
          edit: { rotation: 0, crop: null },
          pendingLabel: "photo",
        },
        {
          key: "rotated",
          itemId: `media-item-${"a".repeat(32)}`,
          kind: "static",
          qualityMode: "standard",
          edit: { rotation: 90, crop: null },
        },
        {
          key: "plain",
          itemId: `media-item-${"b".repeat(32)}`,
          kind: "static",
          qualityMode: "standard",
          edit: { rotation: 0, crop: null },
        },
        {
          key: "broken",
          itemId: `media-item-${"c".repeat(32)}`,
          kind: "static",
          qualityMode: "standard",
          edit: { rotation: 0, crop: null },
        },
        {
          key: "gone",
          itemId: `media-item-${"d".repeat(32)}`,
          kind: "static",
          qualityMode: "standard",
          edit: { rotation: 0, crop: null },
        },
      ],
      coverKey: "rotated",
    } as const;
    const answers: unknown[] = [];
    const fake = fakePort({
      ensureEditDerivatives: () => {
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    const { base, signIn } = await start({ port: fake.port });
    const token = await signIn();
    const check = (path: string, account: string | null = actor) =>
      fetch(
        `${base}/v1/community/publishing/${path}/readiness`,
        json(token, { content: readinessContent }, "POST", account),
      );
    const itemOf = (
      key: string,
      state: string,
      itemEditKey: string | null = null,
    ) => ({
      key,
      itemId:
        readinessContent.items.find((item) => item.key === key)?.itemId ?? null,
      state,
      editKey: itemEditKey,
    });

    // Pending: placeholders, uploads, processing and derivations still wait.
    answers.push({
      ready: false,
      items: [
        itemOf("pending", "pending"),
        itemOf("rotated", "deriving"),
        itemOf("plain", "uploading"),
        itemOf("broken", "processing"),
        itemOf("gone", "ready", "base"),
      ],
    });
    const pending = await check(`drafts/${draftId}`);
    expect(pending.status).toBe(200);
    expect(pending.headers.get("cache-control")).toBe("private, no-store");
    expect(publishingReadinessSchema.parse(await pending.json())).toEqual({
      ready: false,
      pendingItemKeys: ["pending", "rotated", "plain", "broken"],
      failedItemKeys: [],
      editKeys: {},
    });
    expect(
      fake.named("ensureEditDerivatives").map((call) => call.args),
    ).toEqual([[actor, readinessContent, now, { holder: { draftId } }]]);

    // Ready: only edited items name their thumb key; base keys are implied.
    answers.push({
      ready: true,
      items: [
        itemOf("rotated", "ready", editKey),
        itemOf("plain", "ready", "base"),
      ],
    });
    const ready = await check(`sessions/${sessionId}`);
    expect(publishingReadinessSchema.parse(await ready.json())).toEqual({
      ready: true,
      pendingItemKeys: [],
      failedItemKeys: [],
      editKeys: { rotated: editKey },
    });
    expect(fake.named("ensureEditDerivatives")[1]?.args).toEqual([
      actor,
      readinessContent,
      now,
      { holder: { sessionId } },
    ]);

    // Failed: failed items and derivations, and items that are not usable.
    answers.push({
      ready: false,
      items: [
        itemOf("rotated", "failed"),
        itemOf("plain", "ready", "base"),
        itemOf("gone", "unavailable"),
      ],
    });
    expect(
      publishingReadinessSchema.parse(
        await (await check(`drafts/${draftId}`)).json(),
      ),
    ).toEqual({
      ready: false,
      pendingItemKeys: [],
      failedItemKeys: ["rotated", "gone"],
      editKeys: {},
    });

    // A foreign or deleted holder is unavailable; an ended one conflicts.
    answers.push(new CommunityNotFoundError());
    await expectApiError(
      await check(`drafts/${draftId}`),
      404,
      "ITEM_NOT_FOUND",
    );
    answers.push(new CommunityConflictError("The session has ended"));
    await expectApiError(
      await check(`sessions/${sessionId}`),
      409,
      "CONFLICT",
      "The session has ended",
    );
    expect(fake.named("ensureEditDerivatives")).toHaveLength(5);

    // The account assertion, the body and the holder id are checked first.
    await expectApiError(
      await check(`drafts/${draftId}`, other),
      401,
      "UNAUTHENTICATED",
    );
    await expectApiError(
      await fetch(
        `${base}/v1/community/publishing/drafts/${draftId}/readiness`,
        json(token, { content: readinessContent, extra: 1 }),
      ),
      422,
      "INVALID_INPUT",
    );
    await expectApiError(
      await fetch(
        `${base}/v1/community/publishing/drafts/${draftId}/readiness?x=1`,
        json(token, { content: readinessContent }),
      ),
      422,
      "INVALID_INPUT",
    );
    await expectApiError(
      await check("drafts/work-draft-short"),
      404,
      "ITEM_NOT_FOUND",
    );
    expect(
      (
        await fetch(
          `${base}/v1/community/publishing/drafts/${draftId}/readiness`,
          { headers: { authorization: `Bearer ${token}` } },
        )
      ).status,
    ).toBe(404);
    expect(fake.named("ensureEditDerivatives")).toHaveLength(5);
  });

  it("ensures derivatives only for a not_ready answer and never for a refused submission", async () => {
    const receipt = {
      state: "confirmed",
      requestId: randomUUID(),
      workId,
      revisionId: `work-revision-${"6".repeat(32)}`,
      visibility: "public",
      submittedAt: iso,
    } as const;
    const notReady = { state: "not_ready", itemKeys: ["item-1"] } as const;
    const answers: unknown[] = [];
    let ready = true;
    const fake = fakePort({
      submit: () => {
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      },
      ensureEditDerivatives: () => ({ ready, items: [] }),
    });
    const { base, signIn } = await start({ port: fake.port });
    const token = await signIn();
    const command = {
      requestId: receipt.requestId,
      holder: { draftId },
      content,
      baseRevisionId: null,
    };
    const submit = () =>
      fetch(
        `${base}/v1/community/publishing/submissions`,
        json(token, command),
      );

    // Derivatives that just became ready: ensured, then submitted again.
    answers.push(notReady, receipt);
    const confirmed = await submit();
    expect(await confirmed.json()).toEqual(receipt);
    expect(fake.calls.map((call) => call.name)).toEqual([
      "submit",
      "ensureEditDerivatives",
      "submit",
    ]);
    expect(fake.named("ensureEditDerivatives")[0]?.args).toEqual([
      actor,
      command.content,
      now,
    ]);

    // Still deriving: the first not_ready answer stands.
    fake.calls.length = 0;
    ready = false;
    answers.push(notReady);
    const pending = await submit();
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual(notReady);
    expect(fake.calls.map((call) => call.name)).toEqual([
      "submit",
      "ensureEditDerivatives",
    ]);

    // A refused submission queues nothing.
    fake.calls.length = 0;
    answers.push(new CommunityConflictError("The work changed"));
    await expectApiError(await submit(), 409, "CONFLICT");
    answers.push(new CommunityInputError("items_limit"));
    await expectApiError(await submit(), 422, "INVALID_INPUT", "items_limit");
    expect(fake.calls.map((call) => call.name)).toEqual(["submit", "submit"]);
  });

  it("answers 404 for late writes to a deleted draft, 409 for a submitted one and keeps unsupported_type for real type failures", async () => {
    const deleted = new Set<string>();
    const submitted = new Set<string>();
    const submittedDraft = `work-draft-${"5".repeat(32)}`;
    submitted.add(submittedDraft);
    /** The adapter's draft lock: a removed draft is gone, a submitted one moved on. */
    const lockDraft = (id: string) => {
      if (deleted.has(id)) throw new CommunityNotFoundError();
      if (submitted.has(id))
        throw new CommunityConflictError("The draft is no longer active");
    };
    const fake = fakePort({
      deleteDraft: (_actor: string, id: string) => {
        lockDraft(id);
        deleted.add(id);
        return {
          result: {
            deleted: true,
            snapshots: 0,
            conflictCopies: 0,
            mediaItems: 0,
          },
          cancelledComponentIds: [],
        };
      },
      saveDraft: (_actor: string, id: string) => {
        lockDraft(id);
        return { status: "saved", draft };
      },
      snapshotDraft: (_actor: string, id: string) => {
        lockDraft(id);
        return { status: "saved", draft };
      },
      restoreSnapshot: (_actor: string, id: string) => {
        lockDraft(id);
        return draft;
      },
      resolveConflict: (_actor: string, id: string) => {
        lockDraft(id);
        return draft;
      },
      registerItem: (
        _actor: string,
        command: { holder: { draftId: string } },
      ) => {
        lockDraft(command.holder.draftId);
        return mediaItem(1024);
      },
      submit: (_actor: string, command: { holder: { draftId: string } }) => {
        lockDraft(command.holder.draftId);
        throw new Error("only late submissions reach this port");
      },
    });
    const { base, signIn } = await start({
      port: fake.port,
      store: new MemoryMediaStore(),
    });
    const token = await signIn();
    const publishing = `${base}/v1/community/publishing`;
    const save = { baseRevision: 2, content, deviceClass: "desktop" };
    const register = (holder: string) => ({
      requestId: randomUUID(),
      holder: { draftId: holder },
      kind: "static",
      qualityMode: "standard",
      components: [
        {
          role: "still",
          byteSize: 1024,
          contentType: "image/webp",
          standardOutcome: "optimized",
        },
      ],
      processingProfile: "standard-image-v1",
    });
    const submission = (holder: string) => ({
      requestId: randomUUID(),
      holder: { draftId: holder },
      content,
      baseRevisionId: null,
    });

    expect(
      (
        await fetch(
          `${publishing}/drafts/${draftId}`,
          json(token, { requestId: randomUUID() }, "DELETE"),
        )
      ).status,
    ).toBe(200);
    const lateWrites: [string, unknown][] = [
      [`drafts/${draftId}/save`, save],
      [`drafts/${draftId}/snapshot`, save],
      [
        `drafts/${draftId}/restore`,
        {
          requestId: randomUUID(),
          snapshotId: `work-snapshot-${"6".repeat(32)}`,
        },
      ],
      [
        `drafts/${draftId}/resolve`,
        {
          requestId: randomUUID(),
          conflictId: `work-draft-${"8".repeat(32)}`,
          choice: "device",
        },
      ],
      ["items", register(draftId)],
      ["submissions", submission(draftId)],
    ];
    for (const [path, body] of lateWrites) {
      const answer = await fetch(`${publishing}/${path}`, json(token, body));
      expect([path, answer.status]).toEqual([path, 404]);
      expect(apiErrorSchema.parse(await answer.json()).error.code).toBe(
        "ITEM_NOT_FOUND",
      );
    }
    expect(
      (
        await fetch(
          `${publishing}/drafts/${draftId}`,
          json(token, { requestId: randomUUID() }, "DELETE"),
        )
      ).status,
    ).toBe(404);
    for (const [path, body] of [
      [`drafts/${submittedDraft}/save`, save],
      ["submissions", submission(submittedDraft)],
    ] as const)
      await expectApiError(
        await fetch(`${publishing}/${path}`, json(token, body)),
        409,
        "CONFLICT",
      );

    // `unsupported_type` is left for real type failures of media (here a
    // video declared as a still); it never reaches the port.
    const active = `work-draft-${"7".repeat(32)}`;
    fake.calls.length = 0;
    const mistyped = register(active);
    await expectApiError(
      await fetch(
        `${publishing}/items`,
        json(token, {
          ...mistyped,
          components: [{ ...mistyped.components[0], contentType: "video/mp4" }],
        }),
      ),
      422,
      "INVALID_INPUT",
      "unsupported_type",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["test", "production"] as const)(
    "mounts the supplied publishing service without a Development sign-in fallback in %s",
    async (nodeEnv) => {
      const fake = fakePort({ readSettings: () => settings });
      const { base, signIn } = await start({ port: fake.port, nodeEnv });
      expect(
        (await fetch(`${base}/v1/community/publishing/limits`)).status,
      ).toBe(401);
      const token = await signIn();
      const limits = await fetch(`${base}/v1/community/publishing/limits`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(limits.status).toBe(200);
      expect(publishingLimitsSchema.parse(await limits.json()).maxItems).toBe(
        settings.maxItemsPerWork,
      );
      expect(fake.named("readSettings")).toHaveLength(1);
      expect(
        (await fetch(`${base}/v1/development/sign-in`, { method: "POST" }))
          .status,
      ).toBe(404);
      expect(
        (
          await fetch(`${base}/internal/community/publishing/settings`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);
    },
  );
});

describe("work publishing session expiry through the shared upload registry", () => {
  const sessionId = `publishing-session-${"8".repeat(32)}`;
  const expiryClaim: PublishingWorkerJobClaim = {
    id: `publishing-job-${"9".repeat(32)}`,
    kind: "expire_session",
    subjectId: sessionId,
    payload: null,
    attempts: 1,
    maxAttempts: 5,
    leaseOwner: "worker-test.1",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  };
  /** The worker's handlers as the Development composition builds them. */
  const workerHandlers = (
    port: WorkPublishingPort,
    stop: (componentIds: readonly string[]) => void,
  ) =>
    createPublishingJobHandlers({
      port,
      store: {
        remove: async () => undefined,
        listBlobs: async () => ({ entries: [], nextAfter: null }),
        sweepStaging: async () => ({ removed: 0 }),
      },
      processor: {
        process: async () => {
          throw new Error("session expiry never processes media");
        },
      },
      clock: () => now,
      onUploadsCancelled: stop,
    });
  /**
   * The adapter's answers around expiry. It expires a lapsed session (and
   * names its components) only once no upload of it began within one session
   * lease period, so the open stream here stands for one that began before
   * that period. After expiry the session's items are cancelled, so a commit
   * presented afterwards is refused as `cancelled`.
   */
  const expiringPort = (declared: number) => {
    const state = { expired: false };
    const { component, ...fence } = componentFence(declared);
    const fake = fakePort({
      ...fence,
      expireSession: () => {
        state.expired = true;
        return { status: "expired", cancelledComponentIds: [componentId] };
      },
      commitComponentUpload: (
        upload: PublishingUploadFence,
        blob: PublishingMediaWriteResult,
      ) => {
        if (state.expired) return { status: "cancelled" };
        return fence.commitComponentUpload(upload, blob);
      },
    });
    return { ...fake, component, state };
  };

  it("stops a stream older than the lease period of a session the worker expires and never commits it", async () => {
    const store = new MemoryMediaStore();
    const declared = 1024 * KiB;
    const transfers = createPublishingTransferRegistry();
    const fake = expiringPort(declared);
    const { base, signIn } = await start({ port: fake.port, store, transfers });
    const token = await signIn();
    const upload = rawUpload(base, uploadHeaders(token, declared));
    upload.client.write(randomBytes(64 * KiB));
    await until(() => store.received > 0, "first bytes");
    expect(transfers.isActive(componentId)).toBe(true);

    const handlers = workerHandlers(fake.port, (ids) => {
      transfers.stop(ids);
    });
    expect(
      await handlers.run(expiryClaim, new AbortController().signal),
    ).toEqual({ status: "completed" });
    expect(fake.named("expireSession")[0]?.args).toEqual([sessionId, now]);

    const answer = await upload.answer;
    expect(answer.status).toBe(409);
    expect(apiErrorSchema.parse(JSON.parse(answer.text)).error.code).toBe(
      "CONFLICT",
    );
    upload.client.destroy();
    await until(() => fake.named("abortComponentUpload").length === 1, "abort");
    expect(fake.named("commitComponentUpload")).toHaveLength(0);
    expect(store.blobs.size).toBe(0);
    await until(() => transfers.size === 0, "released transfer");
  });

  it("refuses the commit of a stream the expiry could not stop in this process", async () => {
    const store = new MemoryMediaStore();
    const declared = 256 * KiB;
    const transfers = createPublishingTransferRegistry();
    const fake = expiringPort(declared);
    const { base, signIn } = await start({ port: fake.port, store, transfers });
    const token = await signIn();
    const upload = rawUpload(base, uploadHeaders(token, declared));
    upload.client.write(randomBytes(64 * KiB));
    await until(() => store.received > 0, "first bytes");

    // A worker in another process holds another registry: nothing stops here.
    const elsewhere = createPublishingTransferRegistry();
    const handlers = workerHandlers(fake.port, (ids) => {
      elsewhere.stop(ids);
    });
    await handlers.run(expiryClaim, new AbortController().signal);
    expect(fake.state.expired).toBe(true);
    expect(transfers.isActive(componentId)).toBe(true);

    upload.client.end(randomBytes(declared - 64 * KiB));
    const answer = await upload.answer;
    expect(answer.status).toBe(409);
    expect(fake.named("commitComponentUpload")).toHaveLength(1);
    expect(store.blobs.size).toBe(0);
    expect(store.removed).toHaveLength(1);
    await until(() => transfers.size === 0, "released transfer");
  });
});

describe("work publishing transfers in the service", () => {
  const bodyOf = (bytes: Buffer): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  });
  const transferOf = (bytes: Buffer, onStopped?: () => void) => ({
    attempt: randomUUID(),
    contentLength: bytes.byteLength,
    source: bodyOf(bytes),
    signal: new AbortController().signal,
    ...(onStopped === undefined ? {} : { onStopped }),
  });

  it("stops only transfers streaming before a command's mark and never unopened ones", () => {
    const registry = new PublishingTransferRegistry();
    const stopped: string[] = [];
    const opened = registry.claim(componentId, () => stopped.push("opened"));
    const unopened = registry.claim(componentId, () =>
      stopped.push("unopened"),
    );
    opened.markStreaming();
    const before = registry.mark();
    const later = registry.claim(componentId, () => stopped.push("later"));
    later.markStreaming();

    expect(unopened.othersStreaming()).toBe(true);
    expect(registry.stop([componentId, componentId], { before })).toBe(1);
    expect(stopped).toEqual(["opened"]);
    expect(registry.isActive(componentId)).toBe(true);
    expect(later.othersStreaming()).toBe(false);
    opened.release();
    expect(registry.size).toBe(2);

    expect(registry.stop([componentId])).toBe(1);
    expect(stopped).toEqual(["opened", "later"]);
    unopened.release();
    later.release();
    expect(registry.size).toBe(0);
    expect(registry.isActive(componentId)).toBe(false);
  });

  it("removes the blob and commits nothing when a cancel lands between write and commit", async () => {
    const declared = 32 * KiB;
    const transfers = new PublishingTransferRegistry();
    class StoppingStore extends MemoryMediaStore {
      override async writeStream(
        ...args: Parameters<MemoryMediaStore["writeStream"]>
      ) {
        const written = await super.writeStream(...args);
        transfers.stop([componentId]);
        return written;
      }
    }
    const store = new StoppingStore();
    const fake = uploadPort(declared);
    const service = new WorkPublishingService(fake.port, {
      store,
      processor,
      transfers,
      clock: () => now,
    });
    let stops = 0;
    const outcome = await service.uploadComponent(
      actor,
      componentId,
      transferOf(randomBytes(declared), () => {
        stops += 1;
      }),
    );
    expect(outcome).toEqual({ status: "cancelled" });
    expect(stops).toBe(1);
    expect(store.blobs.size).toBe(0);
    expect(store.removed).toHaveLength(1);
    expect(fake.named("commitComponentUpload")).toHaveLength(0);
    expect(fake.named("abortComponentUpload")).toHaveLength(1);
    expect(transfers.size).toBe(0);
  });

  it("keeps the blob when the commit outcome is unknown", async () => {
    const declared = 32 * KiB;
    const store = new MemoryMediaStore();
    const fake = uploadPort(declared, {
      commitComponentUpload: () => {
        throw new Error("connection lost after commit");
      },
    });
    const service = new WorkPublishingService(fake.port, {
      store,
      processor,
      clock: () => now,
    });
    await expect(
      service.uploadComponent(
        actor,
        componentId,
        transferOf(randomBytes(declared)),
      ),
    ).rejects.toThrow("connection lost after commit");
    expect(store.blobs.size).toBe(1);
    expect(store.removed).toHaveLength(0);
    expect(fake.named("abortComponentUpload")).toHaveLength(1);
    expect(service.transfers.size).toBe(0);
  });

  it("reads size codes only from media store errors", async () => {
    const declared = 32 * KiB;
    const foreign = Object.assign(new Error("not a store error"), {
      code: "size_limit_exceeded",
    });
    const store = new MemoryMediaStore();
    store.writeStream = async () => {
      throw foreign;
    };
    const fake = uploadPort(declared);
    const service = new WorkPublishingService(fake.port, {
      store,
      processor,
      clock: () => now,
    });
    await expect(
      service.uploadComponent(
        actor,
        componentId,
        transferOf(randomBytes(declared)),
      ),
    ).rejects.toBe(foreign);
    store.writeStream = async () => {
      throw storeFailure("size_limit_exceeded");
    };
    expect(
      await service.uploadComponent(
        actor,
        componentId,
        transferOf(randomBytes(declared)),
      ),
    ).toEqual({ status: "too_large" });
    expect(
      () =>
        new WorkPublishingService(fake.port, {
          transferPolicy: { idleTimeoutMs: 0 },
        }),
    ).toThrow("idleTimeoutMs");
  });
});
