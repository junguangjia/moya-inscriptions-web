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
import {
  currentRecipe,
  plannedStillSize,
  stillOutputSize,
} from "@moya/backend-production/internal/publishing-processing";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inProcessSandbox } from "./publishing-sandbox-fixture.js";
import {
  currentCatalogRecipePolicy,
  catalogExpectedRenditions,
  parseCatalogPrepareDatabaseConfig,
} from "@moya/backend-production/internal/catalog-delivery";
import { readCatalogDeliveryProjection } from "@moya/community-postgres";
import {
  catalogRecipeManifestSchema,
  catalogRecipePolicySchema,
} from "@moya/contracts/internal/editorial";

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

describe("live Catalog delivery locator identity", () => {
  const pair = (id: string) => ({
    mediaId: `synthetic-${id}`,
    objectKey: `editorial/synthetic/${id}.png`,
  });
  const plan = catalogExpectedRenditions(640, 480);
  const sourceSha256 = "d".repeat(64);
  const mockProjectionPool = () => {
    const query = vi.fn(async (_sql: string, values: readonly string[]) => {
      const inputs = JSON.parse(values[0]!) as ReturnType<typeof pair>[];
      // jsonb_to_recordset expands once per input row, including duplicates.
      return {
        rows: inputs.flatMap((source) =>
          plan.map((rendition) => ({
            media_id: source.mediaId,
            source_object_key: source.objectKey,
            master_sha256: sourceSha256,
            source_sha256: sourceSha256,
            master_width: 640,
            master_height: 480,
            rendition_id: `${source.mediaId}:${source.objectKey}:${rendition.role}`,
            role: rendition.role,
            recipe_version: rendition.version,
            recipe_digest: rendition.digest,
            width: rendition.width,
            height: rendition.height,
            content_type: "image/webp",
            approved_intent: null,
          })),
        ),
      };
    });
    return {
      pool: { query } as unknown as Parameters<
        typeof readCatalogDeliveryProjection
      >[0],
      query,
    };
  };

  it("keeps a complete family when detail repeats its representative locator", async () => {
    const source = pair("representative");
    const { pool, query } = mockProjectionPool();
    const result = await readCatalogDeliveryProjection(
      pool,
      [source, source],
      catalogExpectedRenditions,
    );
    expect(JSON.parse(query.mock.calls[0]![1][0]!)).toEqual([source]);
    expect(result.size).toBe(1);
    const family = result.get(
      JSON.stringify([source.mediaId, source.objectKey]),
    )!.renditions!;
    expect(family).toHaveLength(plan.length);
    expect(family.filter(({ level }) => level === "display")).toHaveLength(1);
    expect(family.map(({ key }) => key)).toEqual(
      plan.map(({ role }) => `${source.mediaId}:${source.objectKey}:${role}`),
    );
  });

  it("preserves two logical media with identical source bytes and separate families", async () => {
    const first = pair("first");
    const second = pair("second");
    const { pool, query } = mockProjectionPool();
    const result = await readCatalogDeliveryProjection(
      pool,
      [first, second, first],
      catalogExpectedRenditions,
    );
    expect(JSON.parse(query.mock.calls[0]![1][0]!)).toEqual([first, second]);
    expect(result.size).toBe(2);
    for (const source of [first, second]) {
      const family = result.get(
        JSON.stringify([source.mediaId, source.objectKey]),
      )!.renditions!;
      expect(family).toHaveLength(plan.length);
      expect(family.filter(({ level }) => level === "display")).toHaveLength(1);
      expect(
        family.every(({ key }) =>
          key.startsWith(`${source.mediaId}:${source.objectKey}:`),
        ),
      ).toBe(true);
    }
  });

  it("preserves a changed object key under the same logical media id", async () => {
    const first = pair("same-id");
    const second = { ...first, objectKey: "editorial/synthetic/revision.png" };
    const { pool, query } = mockProjectionPool();
    const result = await readCatalogDeliveryProjection(
      pool,
      [first, second, first],
      catalogExpectedRenditions,
    );
    expect(JSON.parse(query.mock.calls[0]![1][0]!)).toEqual([first, second]);
    expect(result.size).toBe(2);
    const families = [first, second].map(
      (source) =>
        result.get(JSON.stringify([source.mediaId, source.objectKey]))!
          .renditions!,
    );
    expect(families.every((family) => family.length === plan.length)).toBe(
      true,
    );
    expect(
      new Set(families.flatMap((family) => family.map(({ key }) => key))).size,
    ).toBe(plan.length * 2);
  });

  it("retains the input bound before deduplicating repeated locators", async () => {
    const { pool, query } = mockProjectionPool();
    await expect(
      readCatalogDeliveryProjection(
        pool,
        Array.from({ length: 10001 }, () => pair("repeated")),
        catalogExpectedRenditions,
      ),
    ).rejects.toThrow("Catalog delivery batch too large");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("actual Catalog recipe policy and private database authority", () => {
  it("pins full registry parameters plus the actual conditional viewer geometry and excludes full outputs", () => {
    const policy = currentCatalogRecipePolicy();
    expect(policy).toEqual(currentCatalogRecipePolicy());
    expect(policy.recipeManifestSha256).toBe(
      sha256(Buffer.from(policy.canonicalManifest)),
    );
    const manifest = catalogRecipeManifestSchema.parse(
      JSON.parse(policy.canonicalManifest),
    );
    expect(manifest.roles.map(({ role }) => role)).toEqual([
      "thumb",
      "cover",
      "display",
      "viewer",
    ]);
    expect(
      manifest.roles.map(({ role, version, digest }) => ({
        role,
        version,
        digest,
      })),
    ).toEqual(
      ["thumb", "cover", "display", "viewer"].map((role) =>
        currentRecipe(role as "thumb" | "cover" | "display" | "viewer"),
      ),
    );
    expect(manifest.excludedRoles).toEqual(["full", "motion"]);
    expect(manifest.geometry.plannedStillSizeSha256).toBe(
      sha256(Buffer.from(plannedStillSize.toString())),
    );
    expect(manifest.geometry.stillOutputSizeSha256).toBe(
      sha256(Buffer.from(stillOutputSize.toString())),
    );
    expect(
      plannedStillSize("viewer", { width: 100, height: 100 }, "catalog"),
    ).toBeNull();
    expect(
      plannedStillSize("viewer", { width: 5000, height: 10000 }, "catalog"),
    ).not.toBeNull();
    const incomplete = { ...manifest, roles: manifest.roles.slice(0, 3) };
    expect(
      catalogRecipePolicySchema.safeParse({
        ...policy,
        canonicalManifest: JSON.stringify(incomplete),
      }).success,
    ).toBe(false);
    const altered = JSON.parse(policy.canonicalManifest);
    altered.geometry.viewer = "always-render";
    expect(
      catalogRecipePolicySchema.safeParse({
        ...policy,
        canonicalManifest: JSON.stringify(altered),
      }).success,
    ).toBe(false);
  });

  it("never borrows public/App settings and requires an explicit separate reader on the same CMS target", () => {
    const publicUrl =
      "postgresql://synthetic_public@127.0.0.1:1/synthetic_cms?sslmode=disable";
    const privateUrl =
      "postgresql://synthetic_prepare@127.0.0.1:1/synthetic_cms?sslmode=disable";
    expect(
      parseCatalogPrepareDatabaseConfig({
        DATABASE_URL: publicUrl,
        APP_DATABASE_URL: privateUrl,
      }),
    ).toBeNull();
    expect(
      parseCatalogPrepareDatabaseConfig({
        DATABASE_URL: publicUrl,
        CATALOG_PREPARE_DATABASE_URL: privateUrl,
      }),
    ).toMatchObject({ max: 1, connectionTimeoutMillis: 5000 });
    for (const patch of [
      { CATALOG_PREPARE_DATABASE_SSL_CA_FILE: "REPLACE_ME_CA" },
      { CATALOG_PREPARE_DATABASE_URL: "" },
      { CATALOG_PREPARE_DATABASE_URL: publicUrl },
      {
        CATALOG_PREPARE_DATABASE_URL: privateUrl.replace(
          "synthetic_cms",
          "another_cms",
        ),
      },
      { CATALOG_PREPARE_DATABASE_URL: privateUrl.replace(":1/", ":2/") },
    ])
      expect(() =>
        parseCatalogPrepareDatabaseConfig({
          DATABASE_URL: publicUrl,
          ...patch,
        }),
      ).toThrow();
  });
});

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

const sourceEnvironment = {
  CATALOG_SOURCE_COS_BUCKET: "synthetic-catalog-1250000000",
  CATALOG_SOURCE_COS_REGION: "ap-guangzhou",
  CATALOG_SOURCE_COS_SECRET_ID: "synthetic-source-id",
  CATALOG_SOURCE_COS_SECRET_KEY: "synthetic-source-secret",
} as const;

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

  it("never borrows public signer or UGC credentials for source reads", async () => {
    const otherIdentities = {
      COS_BUCKET: "synthetic-public-1250000000",
      COS_REGION: "ap-beijing",
      COS_SECRET_ID: "synthetic-public-id",
      COS_SECRET_KEY: "synthetic-public-secret",
      COS_REQUEST_TIMEOUT_MS: "invalid-legacy-setting",
      WORK_MEDIA_COS_BUCKET: "synthetic-ugc-1250000000",
      WORK_MEDIA_COS_REGION: "ap-shanghai",
      WORK_MEDIA_COS_SECRET_ID: "synthetic-ugc-id",
      WORK_MEDIA_COS_SECRET_KEY: "synthetic-ugc-secret",
    };
    expect(parseCatalogSourceConfig({})).toBeNull();
    expect(parseCatalogSourceConfig(otherIdentities)).toBeNull();
    const parsed = parseCatalogSourceConfig({
      ...otherIdentities,
      ...sourceEnvironment,
    });
    expect(parsed).toMatchObject({
      bucket: sourceEnvironment.CATALOG_SOURCE_COS_BUCKET,
      region: sourceEnvironment.CATALOG_SOURCE_COS_REGION,
      requestTimeoutMs: 30_000,
    });
    await expect(parsed!.credentials()).resolves.toEqual({
      secretId: sourceEnvironment.CATALOG_SOURCE_COS_SECRET_ID,
      secretKey: sourceEnvironment.CATALOG_SOURCE_COS_SECRET_KEY,
    });
  });

  it.each(Object.keys(sourceEnvironment))(
    "refuses missing or empty %s without echoing source values",
    (key) => {
      for (const value of [undefined, ""]) {
        expect(() =>
          parseCatalogSourceConfig({ ...sourceEnvironment, [key]: value }),
        ).toThrow(`Catalog source configuration missing or invalid: ${key}`);
      }
    },
  );

  it.each([
    ["CATALOG_SOURCE_COS_BUCKET", "Invalid_Bucket"],
    ["CATALOG_SOURCE_COS_REGION", "AP-Guangzhou"],
    ["CATALOG_SOURCE_COS_SECRET_ID", "synthetic/invalid-id"],
    ["CATALOG_SOURCE_COS_SECRET_KEY", " synthetic-secret"],
    ["CATALOG_SOURCE_COS_SECRET_KEY", "synthetic\nsecret"],
    ["CATALOG_SOURCE_COS_REQUEST_TIMEOUT_MS", "0"],
    ["CATALOG_SOURCE_COS_REQUEST_TIMEOUT_MS", "1.5"],
    ["CATALOG_SOURCE_COS_REQUEST_TIMEOUT_MS", "9007199254740992"],
    ["CATALOG_SOURCE_COS_REQUEST_TIMEOUT_MS", "120001"],
  ])("refuses invalid source %s", (key, value) => {
    expect(() =>
      parseCatalogSourceConfig({ ...sourceEnvironment, [key]: value }),
    ).toThrow(new RegExp(`^Catalog source configuration .*: ${key}$`));
  });

  it("does not treat an orphan optional setting as disabled source processing", () => {
    for (const key of [
      "CATALOG_SOURCE_COS_SECURITY_TOKEN",
      "CATALOG_SOURCE_COS_CREDENTIAL_EXPIRES_AT",
      "CATALOG_SOURCE_COS_REQUEST_TIMEOUT_MS",
    ])
      expect(() => parseCatalogSourceConfig({ [key]: "" })).toThrow(
        /^Catalog source configuration missing or invalid: CATALOG_SOURCE_COS_BUCKET$/,
      );
  });

  it("requires paired, sufficiently valid source STS fields and bounds its timeout", async () => {
    const now = Math.floor(Date.now() / 1000);
    const temporary = {
      ...sourceEnvironment,
      CATALOG_SOURCE_COS_SECURITY_TOKEN: "synthetic-source-session",
      CATALOG_SOURCE_COS_CREDENTIAL_EXPIRES_AT: String(now + 3600),
      CATALOG_SOURCE_COS_REQUEST_TIMEOUT_MS: "120000",
    };
    const parsed = parseCatalogSourceConfig(temporary)!;
    expect(parsed.requestTimeoutMs).toBe(120_000);
    await expect(parsed.credentials()).resolves.toEqual({
      secretId: sourceEnvironment.CATALOG_SOURCE_COS_SECRET_ID,
      secretKey: sourceEnvironment.CATALOG_SOURCE_COS_SECRET_KEY,
      securityToken: temporary.CATALOG_SOURCE_COS_SECURITY_TOKEN,
      expiresAt: now + 3600,
    });
    for (const [key, value] of [
      ["CATALOG_SOURCE_COS_SECURITY_TOKEN", undefined],
      ["CATALOG_SOURCE_COS_SECURITY_TOKEN", ""],
      ["CATALOG_SOURCE_COS_CREDENTIAL_EXPIRES_AT", undefined],
      ["CATALOG_SOURCE_COS_CREDENTIAL_EXPIRES_AT", "invalid-synthetic-expiry"],
      ["CATALOG_SOURCE_COS_CREDENTIAL_EXPIRES_AT", String(now + 30)],
    ])
      expect(() =>
        parseCatalogSourceConfig({ ...temporary, [key!]: value }),
      ).toThrow(new RegExp(`^Catalog source configuration .*: ${key}$`));
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
    // Identity edit, complete framing, the placeholder from the thumb, and the
    // Catalog plan: no full, so the viewer (as large as the full a work item
    // of this size would have, and not rendered for one) is the largest image.
    expect(sandbox.jobs[0]!.item).toMatchObject({
      kind: "static",
      edit: { rotation: 0, crop: null },
      coverCrop: null,
      plan: "catalog",
      placeholder: true,
      motion: false,
    });
    expect(
      sandbox.jobs[0]!.item!.renditions.map((request) => request.role),
    ).toEqual(["thumb", "cover", "display", "viewer"]);
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
