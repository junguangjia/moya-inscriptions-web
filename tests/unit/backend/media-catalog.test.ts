import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CatalogSourceError,
  CosCatalogSourceReader,
  LocalCatalogSourceReader,
  catalogKeySha256,
  isApprovedCatalogObjectKey,
  parseCatalogSourceConfig,
} from "@moya/backend-production/internal/catalog-source";
import {
  CATALOG_SYNC_MAX_SOURCES,
  catalogSyncIdentities,
  createCatalogRenderer,
  createCatalogSync,
  listPublishedCatalogSources,
} from "@moya/backend-production/internal/publishing-catalog";
import {
  FilesystemPublishingMediaStore,
  PublishingCosResponseError,
} from "@moya/backend-production/internal/publishing-media-store";
import { currentRecipe } from "@moya/backend-production/internal/publishing-processing";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inProcessSandbox } from "./publishing-sandbox-fixture.js";

import type { CatalogWorkerRenderPlan } from "@moya/backend-production/internal/publishing-catalog";
import type { PublishingCosTransport } from "@moya/backend-production/internal/publishing-media-store";

/*
 * Catalog processing in the media worker: source reads with the Catalog read
 * identity (ranged, ETag-bound, size-capped, hash-verified) or from the local
 * Payload media directory in Development; rendering in the same sandbox as
 * works with the Catalog plan; and the sync that hands the complete published
 * list to the store.
 */

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const MEDIA_HASH = "a".repeat(64);
const CATALOG_HASH = "b".repeat(64);
const editorialKey = (bytes: Buffer, extension = "jpg") =>
  `editorial/${CATALOG_HASH}/${MEDIA_HASH}-${sha256(bytes)}.${extension}`;
const displayKey = (bytes: Buffer) =>
  `display/v1/media_${"c".repeat(32)}/${sha256(bytes)}.webp`;

let base: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "media-catalog-")));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogSourceError);
    return (error as CatalogSourceError).code;
  }
  throw new Error("expected a Catalog source error");
};

/** A COS GetObject seam over one object with ranged responses. */
const cosObject = (
  bytes: Buffer,
  options: { failAt?: number; status?: number } = {},
) => {
  const calls: Record<string, unknown>[] = [];
  const transport: PublishingCosTransport = {
    async request(method, input) {
      expect(method).toBe("getObject");
      calls.push(input);
      if (options.status !== undefined && calls.length >= (options.failAt ?? 1))
        throw new PublishingCosResponseError(options.status);
      const match = /^bytes=(\d+)-(\d+)$/.exec(String(input.Range));
      const start = Number(match![1]);
      const end = Math.min(Number(match![2]), bytes.byteLength - 1);
      return {
        statusCode: 206,
        headers: {
          "content-range": `bytes ${start}-${end}/${bytes.byteLength}`,
          etag: '"synthetic-etag"',
        },
        rawBody: bytes.subarray(start, end + 1),
      } as never;
    },
  };
  return { transport, calls };
};

const reader = (transport: PublishingCosTransport) =>
  new CosCatalogSourceReader(
    { bucket: "synthetic-catalog-1250000000", region: "ap-guangzhou" },
    transport,
  );

describe("Catalog source readers", () => {
  it("accepts only the two approved key forms and their embedded hashes", () => {
    const bytes = Buffer.from("x");
    expect(isApprovedCatalogObjectKey(editorialKey(bytes))).toBe(true);
    expect(isApprovedCatalogObjectKey(displayKey(bytes))).toBe(true);
    expect(catalogKeySha256(editorialKey(bytes))).toBe(sha256(bytes));
    expect(catalogKeySha256(displayKey(bytes))).toBe(sha256(bytes));
    for (const key of [
      "editorial/x/y.jpg",
      `display/v1/media_${"c".repeat(32)}/${sha256(bytes)}.png`,
      `../${editorialKey(bytes)}`,
    ])
      expect(isApprovedCatalogObjectKey(key)).toBe(false);
  });

  it("reads a COS source in ETag-bound ranges into the job and verifies it", async () => {
    const bytes = Buffer.alloc(2.5 * 1024 * 1024 + 7, 0x5a);
    const { transport, calls } = cosObject(bytes);
    const target = path.join(base, "still");
    expect(
      await reader(transport).read(displayKey(bytes), target, {
        expectedSha256: sha256(bytes),
        maxBytes: 128 * 1024 * 1024,
      }),
    ).toEqual({ byteSize: bytes.byteLength, sha256: sha256(bytes) });
    expect((await readFile(target)).equals(bytes)).toBe(true);
    expect(calls.map((call) => [call.Range, call.IfMatch ?? null])).toEqual([
      ["bytes=0-1048575", null],
      ["bytes=1048576-2097151", '"synthetic-etag"'],
      [`bytes=2097152-${bytes.byteLength - 1}`, '"synthetic-etag"'],
    ]);
    expect(calls[0]).toMatchObject({
      Bucket: "synthetic-catalog-1250000000",
      Region: "ap-guangzhou",
      Key: displayKey(bytes),
    });
  });

  it("classifies unreadable, oversized, changed and mismatching sources", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 1);
    const read = (
      transport: PublishingCosTransport,
      key = displayKey(bytes),
      expected = sha256(bytes),
      maxBytes = 128 * 1024 * 1024,
    ) =>
      reader(transport).read(key, path.join(base, `t-${Math.random()}`), {
        expectedSha256: expected,
        maxBytes,
      });
    for (const status of [403, 404])
      expect(
        await codeOf(() => read(cosObject(bytes, { status }).transport)),
      ).toBe("source_unreadable");
    expect(
      await codeOf(() =>
        read(cosObject(bytes, { status: 412, failAt: 2 }).transport),
      ),
    ).toBe("unavailable");
    expect(
      await codeOf(() => read(cosObject(bytes, { status: 503 }).transport)),
    ).toBe("unavailable");
    const large = cosObject(bytes);
    expect(
      await codeOf(() =>
        read(large.transport, displayKey(bytes), sha256(bytes), 1024 * 1024),
      ),
    ).toBe("source_too_large");
    expect(large.calls).toHaveLength(1);
    // The key names other bytes than the object holds.
    const other = Buffer.from("other");
    expect(
      await codeOf(() =>
        read(cosObject(bytes).transport, displayKey(other), sha256(other)),
      ),
    ).toBe("source_hash_mismatch");
    // A plan whose hash is not the key's is refused before any request.
    const untouched = cosObject(bytes);
    expect(
      await codeOf(() =>
        read(untouched.transport, displayKey(bytes), sha256(other)),
      ),
    ).toBe("source_unreadable");
    expect(untouched.calls).toHaveLength(0);
  });

  it("reads Development sources from the local media directory without following links", async () => {
    const media = path.join(base, "media");
    await mkdir(media);
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#ffffff" },
    })
      .jpeg()
      .toBuffer();
    const key = editorialKey(bytes);
    await writeFile(path.join(media, key.split("/").pop()!), bytes);
    const local = new LocalCatalogSourceReader(media);
    const options = { expectedSha256: sha256(bytes), maxBytes: 1024 * 1024 };
    expect(await local.read(key, path.join(base, "a"), options)).toEqual({
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
    });
    expect(
      await codeOf(() =>
        local.read(displayKey(bytes), path.join(base, "b"), options),
      ),
    ).toBe("source_unreadable");
    const linked = Buffer.from("linked");
    const linkedKey = editorialKey(linked);
    await symlink(
      path.join(media, key.split("/").pop()!),
      path.join(media, linkedKey.split("/").pop()!),
    );
    expect(
      await codeOf(() =>
        local.read(linkedKey, path.join(base, "c"), {
          ...options,
          expectedSha256: sha256(linked),
        }),
      ),
    ).toBe("source_unreadable");
    expect(
      await codeOf(() =>
        local.read(key, path.join(base, "d"), { ...options, maxBytes: 10 }),
      ),
    ).toBe("source_too_large");
    expect(() => new LocalCatalogSourceReader("relative")).toThrow();
  });

  it("parses the Catalog read identity all-or-nothing without echoing values", () => {
    expect(parseCatalogSourceConfig({})).toBeNull();
    const environment = {
      COS_BUCKET: "synthetic-catalog-1250000000",
      COS_REGION: "ap-guangzhou",
      COS_SECRET_ID: "synthetic-id",
      COS_SECRET_KEY: "synthetic-secret",
    };
    expect(parseCatalogSourceConfig(environment)).toMatchObject({
      bucket: environment.COS_BUCKET,
      region: environment.COS_REGION,
      requestTimeoutMs: 30_000,
    });
    expect(() =>
      parseCatalogSourceConfig({ ...environment, COS_SECRET_KEY: undefined }),
    ).toThrow(
      /^Catalog source configuration missing or invalid: COS_SECRET_KEY$/,
    );
    expect(() =>
      parseCatalogSourceConfig({
        ...environment,
        COS_REQUEST_TIMEOUT_MS: "999999",
      }),
    ).toThrow("COS_REQUEST_TIMEOUT_MS");
  });
});

describe("Catalog rendering in the media sandbox", () => {
  const setup = async (
    sandboxOptions: Parameters<typeof inProcessSandbox>[0] = {},
  ) => {
    const root = await mkdtemp(path.join(base, "setup-"));
    const store = path.join(root, "store");
    const work = path.join(root, "work");
    const media = path.join(root, "media");
    for (const directory of [store, work, media]) {
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const publishingStore = await FilesystemPublishingMediaStore.open(store, {
      temporaryRoots: [],
    });
    const sandbox = inProcessSandbox(sandboxOptions);
    const renderer = createCatalogRenderer({
      store: publishingStore,
      sandbox: await createSandboxRunner({
        image: "yoyi-work-publishing-media-tools:v2",
        workDirectory: work,
        appDist: defaultSandboxAppDist().appDist,
        spawn: sandbox.spawn,
        temporaryRoots: [],
        environment: {},
      }),
      source: new LocalCatalogSourceReader(media),
      logger: { error: () => undefined },
    });
    const publish = async (bytes: Buffer, extension = "jpg") => {
      const key = editorialKey(bytes, extension);
      await writeFile(path.join(media, key.split("/").pop()!), bytes);
      return key;
    };
    const plan = (
      key: string,
      contentType: CatalogWorkerRenderPlan["sourceContentType"] = "image/jpeg",
    ): CatalogWorkerRenderPlan => ({
      assetId: `catalog-asset-${"d".repeat(32)}`,
      mediaId: "media-catalog-1",
      sourceObjectKey: key,
      sourceSha256: catalogKeySha256(key)!,
      sourceContentType: contentType,
      sourceWidth: null,
      sourceHeight: null,
      state: "pending",
      referenced: true,
      ready: [],
    });
    return { renderer, publish, plan, publishingStore, sandbox };
  };

  it("renders thumb, cover, display and the bounded viewer without full", async () => {
    const { renderer, publish, plan, publishingStore, sandbox } = await setup();
    const bytes = await sharp({
      create: { width: 2600, height: 1800, channels: 3, background: "#6699cc" },
    })
      .withIccProfile("p3")
      .jpeg({ quality: 70 })
      .toBuffer();
    const result = await renderer.render(plan(await publish(bytes)));
    if (result.status !== "rendered") throw new Error(JSON.stringify(result));
    const { outcome } = result;
    expect([
      outcome.masterSha256,
      outcome.masterWidth,
      outcome.masterHeight,
    ]).toEqual([sha256(bytes), 2600, 1800]);
    expect(outcome.placeholderColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(
      outcome.renditions.map((rendition) => [
        rendition.role,
        rendition.width,
        rendition.height,
        rendition.recipeVersion,
        rendition.recipeDigest,
      ]),
    ).toEqual(
      (
        [
          ["thumb", 480, 332],
          ["cover", 1080, 748],
          ["display", 2048, 1418],
          ["viewer", 2600, 1800],
        ] as const
      ).map(([role, width, height]) => [
        role,
        width,
        height,
        1,
        currentRecipe(role).digest,
      ]),
    );
    // Identity edit, complete framing, the placeholder from the thumb.
    expect(sandbox.jobs[0]!.item).toMatchObject({
      kind: "static",
      edit: { rotation: 0, crop: null },
      coverCrop: null,
      placeholder: true,
      motion: false,
    });
    expect(
      (await publishingStore.listBlobs({ limit: 10 })).entries,
    ).toHaveLength(4);
  });

  it("rejects unreadable and undecodable sources and retries sandbox outages", async () => {
    const { renderer, publish, plan, publishingStore } = await setup();
    const missing = Buffer.from("never published");
    expect(await renderer.render(plan(editorialKey(missing)))).toEqual({
      status: "rejected",
      failureCode: "source_unreadable",
    });
    const corrupt = Buffer.from("not a jpeg at all");
    expect(await renderer.render(plan(await publish(corrupt)))).toEqual({
      status: "rejected",
      failureCode: "unsupported_type",
    });
    expect(
      (await publishingStore.listBlobs({ limit: 10 })).entries,
    ).toHaveLength(0);
    const outage = await setup({
      exitCode: 125,
      stream: async () => Buffer.alloc(0),
    });
    const image = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#000000" },
    })
      .jpeg()
      .toBuffer();
    await expect(
      outage.renderer.render(outage.plan(await outage.publish(image))),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
  });
});

describe("Catalog sync", () => {
  it("hands the complete published list to the store with the always-rendered identities", async () => {
    const port = {
      syncCatalogAssets: vi.fn(async () => ({
        referenced: 2,
        skipped: 1,
        created: 2,
        unreferenced: 0,
        enqueued: 2,
      })),
    };
    const lines: string[] = [];
    const sources = [
      { mediaId: "m1", objectKey: "display/v1/x", width: 10, height: 10 },
    ];
    const sync = createCatalogSync({
      listSources: async () => sources,
      port,
      logger: {
        info: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    });
    const now = new Date("2026-10-04T12:00:00.000Z");
    await sync.run(now);
    expect(port.syncCatalogAssets).toHaveBeenCalledWith(sources, now, {
      limit: 100,
      renditions: catalogSyncIdentities(),
    });
    expect(catalogSyncIdentities().map((identity) => identity.role)).toEqual([
      "thumb",
      "cover",
      "display",
    ]);
    expect(lines).toEqual([
      "[media-worker] catalog sync referenced=2 skipped=1 created=2 unreferenced=0 enqueued=2",
    ]);
    const skipping = createCatalogSync({
      listSources: async () => null,
      port,
      logger: {
        info: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    });
    await skipping.run(now);
    expect(port.syncCatalogAssets).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toBe(
      "[media-worker] catalog sync skipped: list too large",
    );
  });

  it("reads the published projection, refusing a list beyond the bound", async () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        media_id: `m${index}`,
        object_key: `k${index}`,
        width: 1,
        height: null,
      }));
    const pool = (count: number) => ({
      query: vi.fn(async () => ({ rows: rows(count) })),
    });
    const small = pool(2);
    expect(await listPublishedCatalogSources(small as never)).toEqual([
      { mediaId: "m0", objectKey: "k0", width: 1, height: null },
      { mediaId: "m1", objectKey: "k1", width: 1, height: null },
    ]);
    expect(String((small.query.mock.calls[0] as unknown[])[0])).toMatch(
      /FROM catalog_media\s+ORDER BY media_id ASC, object_key ASC\s+LIMIT 10001/,
    );
    expect(
      await listPublishedCatalogSources(
        pool(CATALOG_SYNC_MAX_SOURCES + 1) as never,
      ),
    ).toBeNull();
  });
});
