import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  createCatalogBlockRenderer,
  createCatalogSync,
} from "@moya/backend-production/internal/publishing-catalog";
import {
  MEDIA_CATALOG_ZOOM_BLOCKS_RENDER,
  parseCatalogZoomSwitch,
} from "@moya/backend-production/internal/publishing-config";
import { createPublishingJobHandlers } from "@moya/backend-production/internal/publishing-job-handlers";
import { FilesystemPublishingMediaStore } from "@moya/backend-production/internal/publishing-media-store";
import {
  BLOCK_RECIPE_DIGEST_V1,
  blockCellRegion,
} from "@moya/backend-production/internal/publishing-processing";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inProcessSandbox } from "./publishing-sandbox-fixture.js";

import type {
  CatalogWorkerBlockOutcome,
  CatalogWorkerBlockPlan,
} from "@moya/backend-production/internal/publishing-catalog";
import type { InProcessSandboxOptions } from "./publishing-sandbox-fixture.js";

/*
 * catalog-deep-zoom-v1 (Issue #295) PR B, coordinator side: the block
 * renderer stages the held master and the asset's `display` rendition from
 * the private store (hash-verified), runs the `blocks` operation through the
 * real sandbox runner (in-process renderer, real sharp), validates and
 * probes every block, writes them as owner-less derivatives and reports one
 * content-free timing line; the job handler records them, fails content
 * failures without retry and leaves block jobs queued on a worker without the
 * switch; the switch parses strictly; the sync runs the block step only when
 * given one.
 */

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
let base: string;
beforeEach(async () => {
  base = await realpath(
    await mkdtemp(path.join(tmpdir(), "catalog-block-worker-")),
  );
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const texture = (width: number, height: number) => {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      data[offset] = (x * 255) / width;
      data[offset + 1] = (y * 255) / height;
      data[offset + 2] = 128 + 100 * Math.sin(x / 19) * Math.cos(y / 27);
    }
  return sharp(data, { raw: { width, height, channels: 3 } });
};

const writeObject = async (
  store: FilesystemPublishingMediaStore,
  bytes: Buffer,
  contentType: "image/jpeg" | "image/webp",
) =>
  store.writeStream(
    "catalog",
    "original",
    contentType,
    bytes.byteLength,
    Readable.from([bytes]),
    {
      requireExactSize: true,
    },
  );

const setup = async (sandboxOptions: InProcessSandboxOptions = {}) => {
  const root = await mkdtemp(path.join(base, "setup-"));
  const storeDirectory = path.join(root, "store");
  const work = path.join(root, "work");
  for (const directory of [storeDirectory, work]) {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const store = await FilesystemPublishingMediaStore.open(storeDirectory, {
    temporaryRoots: [],
  });
  const sandbox = inProcessSandbox(sandboxOptions);
  const logger = { info: vi.fn(), error: vi.fn() };
  const renderer = createCatalogBlockRenderer({
    store,
    sandbox: await createSandboxRunner({
      image: "yoyi-work-publishing-media-tools:v2",
      workDirectory: work,
      appDist: defaultSandboxAppDist().appDist,
      spawn: sandbox.spawn,
      temporaryRoots: [],
      environment: {},
    }),
    logger,
  });
  const master = await texture(2600, 1700).jpeg({ quality: 95 }).toBuffer();
  const reference = await sharp(master)
    .resize({ width: 2048, height: 2048, fit: "inside", kernel: "lanczos3" })
    .webp({ quality: 86, effort: 4, smartSubsample: false })
    .toBuffer({ resolveWithObject: true });
  const storedMaster = await writeObject(store, master, "image/jpeg");
  const storedReference = await writeObject(
    store,
    reference.data,
    "image/webp",
  );
  const plan: CatalogWorkerBlockPlan = {
    assetId: `catalog-asset-${"a".repeat(32)}`,
    masterId: `catalog-master-${"b".repeat(32)}`,
    master: {
      ...storedMaster,
      contentType: "image/jpeg",
      width: 2600,
      height: 1700,
    },
    frame: { width: 2600, height: 1700 },
    reference: {
      ...storedReference,
      width: reference.info.width,
      height: reference.info.height,
    },
    cells: [1, 4],
  };
  return { store, renderer, plan, logger, sandbox };
};

describe("the Catalog block renderer (coordinator)", () => {
  it("stages, renders, validates and stores exactly the job's cells; logs one content-free line", async () => {
    const { store, renderer, plan, logger } = await setup();
    const result = await renderer.render(plan);
    expect(result.status).toBe("rendered");
    const outcome = (result as { outcome: CatalogWorkerBlockOutcome }).outcome;
    expect(outcome.masterId).toBe(plan.masterId);
    expect(outcome.blocks.map((block) => block.cell)).toEqual([1, 2, 3, 4]);
    for (const block of outcome.blocks) {
      const region = blockCellRegion(2600, 1700, block.cell);
      expect([block.width, block.height]).toEqual([
        region.width,
        region.height,
      ]);
      expect(block).toMatchObject({
        contentType: "image/jpeg",
        recipeVersion: 1,
        recipeDigest: BLOCK_RECIPE_DIGEST_V1,
      });
      const read = await store.openRead(block.storageKey);
      expect(read?.status).toBe("ok");
      if (read?.status === "ok") await read.close();
    }
    const lines = logger.info.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[media-worker\] catalog blocks stage_ms=\d+ render_ms=\d+ cells=4 outcome=rendered$/u,
    );
  });

  it("refuses a staged object whose bytes differ from the recorded hash, writing nothing", async () => {
    const { renderer, plan } = await setup();
    await expect(
      renderer.render({
        ...plan,
        master: { ...plan.master, sha256: sha(Buffer.from("other")) },
      }),
    ).rejects.toThrow();
  });

  it("returns content failures as rejections and removes nothing it did not write", async () => {
    const { renderer, plan, logger } = await setup();
    const result = await renderer.render({
      ...plan,
      master: { ...plan.master, width: 2601 },
    });
    expect(result).toEqual({
      status: "rejected",
      failureCode: "master_mismatch",
    });
    expect(String(logger.info.mock.calls.at(-1)?.[0])).toMatch(
      /outcome=master_mismatch$/u,
    );
  });

  it("treats outputs that do not match the job as a sandbox violation", async () => {
    const { renderer, plan } = await setup({
      tamper: (manifest) => ({
        ...manifest,
        outputs: manifest.outputs.slice(1),
      }),
    });
    expect(await renderer.render(plan)).toEqual({
      status: "rejected",
      failureCode: "processing_failed",
    });
  });
});

describe("the block job handler", () => {
  const claim = (payload: unknown) => ({
    id: `publishing-job-${"c".repeat(32)}`,
    kind: "catalog_render" as const,
    subjectId: `catalog-asset-${"a".repeat(32)}`,
    payload: payload as never,
    attempts: 1,
    maxAttempts: 3,
    leaseOwner: "test",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const payload = {
    variant: "blocks",
    masterId: `catalog-master-${"b".repeat(32)}`,
    cells: [0, 3],
  };
  const handlers = (blocks?: {
    port: Record<string, unknown>;
    renderer: Record<string, unknown>;
  }) =>
    createPublishingJobHandlers({
      port: {} as never,
      store: { remove: vi.fn(async () => undefined) } as never,
      catalog: {
        port: {
          readCatalogRenderPlan: vi.fn(async () => {
            throw new Error("a block job is never a base render");
          }),
        } as never,
        renderer: { render: vi.fn() } as never,
        ...(blocks ? { blocks: blocks as never } : {}),
      },
    });
  const signal = new AbortController().signal;

  it("leaves a block job queued on a worker without the block switch", async () => {
    expect(await handlers().run(claim(payload), signal)).toEqual({
      status: "deferred",
      delayMs: 300_000,
    });
  });

  it("completes without work when the master ended, fails content failures without retry, and records blocks", async () => {
    const readCatalogBlockPlan = vi.fn(async () => null);
    const recordCatalogBlocks = vi.fn(async () => ({
      status: "recorded" as const,
    }));
    const render = vi.fn();
    const run = handlers({
      port: { readCatalogBlockPlan, recordCatalogBlocks },
      renderer: { render },
    });
    expect(await run.run(claim(payload), signal)).toEqual({
      status: "completed",
    });
    expect(render).not.toHaveBeenCalled();
    const plan = {
      assetId: claim(payload).subjectId,
    } as CatalogWorkerBlockPlan;
    readCatalogBlockPlan.mockResolvedValue(plan as never);
    render.mockResolvedValueOnce({
      status: "rejected",
      failureCode: "zoom_blocks_alpha",
    });
    expect(await run.run(claim(payload), signal)).toEqual({
      status: "failed",
      errorCode: "zoom_blocks_alpha",
      retryable: false,
    });
    const outcome = {
      masterId: payload.masterId,
      blocks: [{ storageKey: "blobs/00/00/" + "d".repeat(32) }],
    };
    render.mockResolvedValueOnce({ status: "rendered", outcome });
    expect(await run.run(claim(payload), signal)).toEqual({
      status: "completed",
    });
    expect(recordCatalogBlocks).toHaveBeenCalledWith(
      plan.assetId,
      outcome,
      expect.any(Date),
    );
  });
});

describe("the block render switch and sync step", () => {
  it("accepts only on or off; missing means on in Development and off in Production", () => {
    expect(MEDIA_CATALOG_ZOOM_BLOCKS_RENDER).toBe(
      "MEDIA_CATALOG_ZOOM_BLOCKS_RENDER",
    );
    expect(
      parseCatalogZoomSwitch(
        {},
        MEDIA_CATALOG_ZOOM_BLOCKS_RENDER,
        "development",
      ),
    ).toBe(true);
    expect(
      parseCatalogZoomSwitch(
        {},
        MEDIA_CATALOG_ZOOM_BLOCKS_RENDER,
        "production",
      ),
    ).toBe(false);
    expect(
      parseCatalogZoomSwitch(
        { MEDIA_CATALOG_ZOOM_BLOCKS_RENDER: "on" },
        MEDIA_CATALOG_ZOOM_BLOCKS_RENDER,
        "production",
      ),
    ).toBe(true);
    expect(() =>
      parseCatalogZoomSwitch(
        { MEDIA_CATALOG_ZOOM_BLOCKS_RENDER: "yes" },
        MEDIA_CATALOG_ZOOM_BLOCKS_RENDER,
        "production",
      ),
    ).toThrow(/MEDIA_CATALOG_ZOOM_BLOCKS_RENDER must be on or off/u);
  });

  it("runs the block step after the asset sync only when given one", async () => {
    const counts = {
      referenced: 0,
      skipped: 0,
      created: 0,
      unreferenced: 0,
      enqueued: 0,
    };
    const port = { syncCatalogAssets: vi.fn(async () => counts) };
    const blocks = {
      enqueueCatalogBlockSets: vi.fn(async () => ({ enqueued: 3 })),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    await createCatalogSync({ listSources: async () => [], port, logger }).run(
      new Date(),
    );
    expect(blocks.enqueueCatalogBlockSets).not.toHaveBeenCalled();
    await createCatalogSync({
      listSources: async () => [],
      port,
      blocks,
      logger,
    }).run(new Date());
    expect(blocks.enqueueCatalogBlockSets).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "[media-worker] catalog block sync enqueued=3",
    );
  });
});
