import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LocalCatalogSourceReader } from "@moya/backend-production/internal/catalog-source";
import { createCatalogRenderer } from "@moya/backend-production/internal/publishing-catalog";
import { createPublishingJobHandlers } from "@moya/backend-production/internal/publishing-job-handlers";
import {
  cosFixture,
  cosOptions,
} from "../../unit/backend/publishing-cos-fixture.js";
import { inProcessSandbox } from "../../unit/backend/publishing-sandbox-fixture.js";

import {
  CosPublishingMediaStore,
  FilesystemPublishingMediaStore,
} from "@moya/backend-production/internal/publishing-media-store";
import {
  MediaToolError,
  createPublishingMediaProcessor,
} from "@moya/backend-production/internal/publishing-processing";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import { PublishingWorker } from "@moya/backend-production/internal/publishing-worker";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresWorkPublishingAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type {
  PublishingJobHandlers,
  PublishingWorkerJobClaim,
  PublishingWorkerJobKind,
  PublishingWorkerPort,
} from "@moya/backend-production/internal/publishing-job-handlers";
import type {
  ProcessorInput,
  ProcessorOutcome,
} from "@moya/backend-production/internal/publishing-processing";
import type { PublishingWorkerOptions } from "@moya/backend-production/internal/publishing-worker";
import type { PublishingMediaItem } from "@moya/contracts";

/*
 * The publishing worker against the real PostgreSQL adapter and filesystem
 * store: leases and renewals, attempt-neutral shutdown release, store
 * reconciliation, process_item commit, discard and permanent failure, and a
 * legacy user media edit derived from its PNG.
 *
 * The job queue is shared with the community suite, which may run in
 * parallel. Two rules keep both suites apart: every time here comes from a
 * virtual clock a century ahead (so no other suite's claim, lease requeue or
 * cleanup pass reaches these jobs, sessions or items), and the worker leases
 * only the job ids this suite created (so it never claims another suite's
 * jobs). The adapter's own claim SQL is covered by the community suite.
 */

const testDatabaseUrl = requireSyntheticTestDatabaseUrl();

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDirectory = path.join(
  repositoryRoot,
  "database",
  "community-migrations",
);
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
const adapter = new PostgresWorkPublishingAdapter(pool);
const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const CENTURY_MS = 100 * 365 * DAY_MS;
const clock = () => new Date(Date.now() + CENTURY_MS);
const hex = () => randomBytes(16).toString("hex");

const suiteJobIds = new Set<string>();
const suiteUsers: string[] = [];
const suiteAssets: string[] = [];
let base: string;
let workBase: string;
let store: FilesystemPublishingMediaStore | CosPublishingMediaStore;
let cos: ReturnType<typeof cosFixture> | undefined;

interface JobRow {
  kind: string;
  state: string;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  run_after: Date;
  finished_at: Date | null;
}

const readJob = async (id: string): Promise<JobRow> => {
  const { rows } = await pool.query<JobRow>(
    "SELECT kind, state, attempts, lease_owner, lease_expires_at, last_error_code, run_after, finished_at FROM community.publishing_jobs WHERE id = $1",
    [id],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

const enqueue = async (kind: PublishingWorkerJobKind, subjectId: string) => {
  const job = await adapter.enqueueJob({ kind, subjectId }, clock());
  // A reused job would belong to someone else.
  expect(job.created).toBe(true);
  suiteJobIds.add(job.id);
  return job.id;
};

/**
 * The adapter's claim rules (`queued`, due, oldest first, attempts + 1, lease
 * until now + leaseMs), confined to this suite's job ids.
 */
const suitePort = (): PublishingWorkerPort => {
  const claimJobs: PublishingWorkerPort["claimJobs"] = async (options, now) => {
    const { rows } = await pool.query<{
      id: string;
      kind: PublishingWorkerJobKind;
      subject_id: string;
      payload: PublishingWorkerJobClaim["payload"];
      attempts: number;
      max_attempts: number;
      lease_owner: string;
      lease_expires_at: Date;
    }>(
      `WITH next AS (
         SELECT id FROM community.publishing_jobs
         WHERE id = ANY($1::text[]) AND state = 'queued' AND run_after <= $2::timestamptz
           AND ($5::text[] IS NULL OR kind = ANY($5::text[]))
         ORDER BY run_after, id
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       UPDATE community.publishing_jobs j
       SET state = 'running', attempts = j.attempts + 1, lease_owner = $4,
           lease_expires_at = $2::timestamptz + $6::double precision * interval '1 millisecond',
           updated_at = $2::timestamptz, finished_at = NULL
       FROM next WHERE j.id = next.id
       RETURNING j.id, j.kind, j.subject_id, j.payload, j.attempts, j.max_attempts, j.lease_owner, j.lease_expires_at`,
      [
        [...suiteJobIds],
        now.toISOString(),
        options.limit,
        options.owner,
        options.kinds ? [...options.kinds] : null,
        options.leaseMs,
      ],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      subjectId: row.subject_id,
      payload: row.payload,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
    }));
  };
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "claimJobs") return claimJobs;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const silent = { info: () => undefined, error: () => undefined };

const newWorker = (
  port: PublishingWorkerPort,
  handlers: PublishingJobHandlers,
  options: Partial<PublishingWorkerOptions> = {},
) =>
  new PublishingWorker({
    port,
    handlers,
    owner: `publishing-worker-it-${randomBytes(6).toString("hex")}`,
    maintenance: false,
    concurrency: 1,
    pollIntervalMs: 50,
    clock,
    logger: silent,
    ...options,
  });

const settled = async (jobId: string, state: string, timeout = 15_000) =>
  vi.waitFor(
    async () => {
      const job = await readJob(jobId);
      expect(job.state).toBe(state);
      return job;
    },
    { timeout, interval: 50 },
  );

const writeDerivative = async (ownerId: string, bytes = 8) => {
  const written = await store.writeStream(
    ownerId,
    "derivative",
    "image/webp",
    bytes,
    (async function* () {
      yield new Uint8Array(bytes).fill(7);
    })(),
    { requireExactSize: true },
  );
  return written;
};

const storeHas = async (storageKey: string) => {
  const read = await store.openRead(storageKey);
  if (read?.status === "ok") await read.close();
  return read?.status === "ok";
};

/** A processor that writes real derivative blobs, gated by the test. */
const storeProcessor = (gate: Promise<void> = Promise.resolve()) => {
  const produced: string[] = [];
  return {
    produced,
    process: vi.fn(async (input: ProcessorInput): Promise<ProcessorOutcome> => {
      const derivatives = [];
      for (const variant of input.variants) {
        const blob = await writeDerivative(input.ownerId);
        produced.push(blob.storageKey);
        derivatives.push({
          ...blob,
          variant,
          editKey: input.editKey,
          contentType: "image/webp" as const,
          width: 400,
          height: 300,
          durationMs: null,
          recipeVersion: 1,
          recipeDigest: "0".repeat(16),
        });
      }
      await gate;
      return {
        status: "processed",
        detectedTypes: [{ role: "still", contentType: "image/jpeg" }],
        presentation: { width: 4000, height: 3000 },
        pairing: null,
        stillExifOrientation: null,
        placeholderColor: null,
        derivatives,
      };
    }),
  };
};

/** A user with a draft holding one uploaded Standard still that is processing. */
const processingItem = async (): Promise<{
  actor: string;
  item: PublishingMediaItem;
  jobId: string;
}> => {
  const actor = `user-${hex()}`;
  await pool.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'发布测试')",
    [actor, `wp-${actor.slice(-24)}`],
  );
  suiteUsers.push(actor);
  const now = clock();
  const draft = await adapter.createDraft(
    actor,
    {
      requestId: randomUUID(),
      content: {
        title: "",
        body: "草稿",
        authorship: { kind: "original" },
        visibility: "public",
        items: [],
        coverKey: null,
        coverCrop: null,
      },
      deviceClass: "desktop",
    },
    now,
  );
  const item = await adapter.registerItem(
    actor,
    {
      requestId: randomUUID(),
      holder: { draftId: draft.id },
      kind: "static",
      qualityMode: "standard",
      processingProfile: "standard-image-v1",
      components: [
        {
          role: "still",
          byteSize: MiB,
          contentType: "image/jpeg",
          standardOutcome: "optimized",
        },
      ],
    },
    now,
  );
  for (const component of item.components) {
    const fence = await adapter.beginComponentUpload(
      actor,
      component.id,
      {
        attempt: randomUUID(),
        contentLength: component.byteSize,
        supersede: false,
      },
      now,
    );
    const key = hex();
    // Components are never read by the stand-in processor: no bytes needed.
    await adapter.commitComponentUpload(
      fence,
      {
        storageKey: `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
        byteSize: component.byteSize,
        sha256: createHash("sha256").update(key).digest("hex"),
      },
      now,
    );
  }
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM community.publishing_jobs WHERE subject_id = $1 AND kind = 'process_item' AND state = 'queued'",
    [item.id],
  );
  expect(rows).toHaveLength(1);
  suiteJobIds.add(rows[0]!.id);
  return { actor, item, jobId: rows[0]!.id };
};

const itemRow = async (itemId: string) =>
  (
    await pool.query<{ state: string; failure_code: string | null }>(
      "SELECT state, failure_code FROM community.media_items WHERE id = $1",
      [itemId],
    )
  ).rows[0];

const recordedKeys = async (keys: readonly string[]) =>
  (
    await pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM community.media_blobs WHERE storage_key = ANY($1::text[]) ORDER BY storage_key",
      [keys],
    )
  ).rows.map((row) => row.storage_key);

beforeAll(async () => {
  // Idempotent, advisory-locked and manifest-checked, exactly as in the
  // community suite: an applied migration that differs from its file fails
  // here instead of being changed.
  await runCommunityMigrations(pool, migrationsDirectory);
  base = await realpath(
    await mkdtemp(path.join(tmpdir(), "publishing-worker-it-")),
  );
  await chmod(base, 0o700);
  workBase = await realpath(
    await mkdtemp(path.join(tmpdir(), "publishing-worker-it-tools-")),
  );
  await chmod(workBase, 0o700);
  store = await FilesystemPublishingMediaStore.open(base, {
    temporaryRoots: [],
  });
});

afterAll(async () => {
  try {
    await pool.query(
      `WITH removed AS (
         DELETE FROM community.media_renditions WHERE catalog_asset_id = ANY($1::text[])
         RETURNING blob_id)
       DELETE FROM community.media_blobs WHERE id IN (SELECT blob_id FROM removed)`,
      [suiteAssets],
    );
    await pool.query(
      "DELETE FROM community.catalog_media_assets WHERE id = ANY($1::text[])",
      [suiteAssets],
    );
    await pool.query(
      `DELETE FROM community.publishing_jobs WHERE id = ANY($2::text[]) OR subject_id IN (
         SELECT id FROM community.media_items WHERE owner_id = ANY($1::text[])
         UNION SELECT id FROM community.media_blobs WHERE owner_id = ANY($1::text[]))`,
      [suiteUsers, [...suiteJobIds]],
    );
    for (const statement of [
      "DELETE FROM community.media_item_refs WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id = ANY($1::text[]))",
      "DELETE FROM community.publishing_sessions WHERE owner_id = ANY($1::text[])",
      "DELETE FROM community.work_draft_snapshots WHERE owner_id = ANY($1::text[])",
      "DELETE FROM community.work_drafts WHERE owner_id = ANY($1::text[])",
      "DELETE FROM community.media_renditions WHERE item_id IN (SELECT id FROM community.media_items WHERE owner_id = ANY($1::text[]))",
      "DELETE FROM community.media_components WHERE owner_id = ANY($1::text[])",
      "DELETE FROM community.media_blobs WHERE owner_id = ANY($1::text[])",
      "DELETE FROM community.media_items WHERE owner_id = ANY($1::text[])",
      "DELETE FROM community.user_media WHERE owner_id = ANY($1::text[])",
      "DELETE FROM community.account_publishing_capacity WHERE account_id = ANY($1::text[])",
      "DELETE FROM community.author_command_receipts WHERE actor_id = ANY($1::text[])",
      "DELETE FROM community.author_events WHERE actor_id = ANY($1::text[])",
      "DELETE FROM community.public_users WHERE id = ANY($1::text[])",
    ])
      await pool.query(statement, [suiteUsers]);
  } finally {
    await pool.end();
    if (base) await rm(base, { recursive: true, force: true });
    if (workBase) await rm(workBase, { recursive: true, force: true });
  }
});

const workerCases = () => {
  it(
    "leases, renews and completes a store reconciliation job that removes only old unrecorded blobs",
    { timeout: 20_000 },
    async () => {
      const owner = `user-${hex()}`;
      // File ages are compared with the handler clock: date them on it.
      const touch = async (storageKey: string, at: Date) => {
        if (cos) cos.objects.get(cosOptions.prefix + storageKey)!.modified = at;
        else await utimes(path.join(base, storageKey), at, at);
      };
      const oldOrphan = (await writeDerivative(owner)).storageKey;
      await touch(oldOrphan, new Date(clock().getTime() - 200 * DAY_MS));
      const freshOrphan = (await writeDerivative(owner)).storageKey;
      await touch(freshOrphan, clock());
      const jobId = await enqueue("reconcile_capacity", "media-store");
      const port = suitePort();
      const renew = vi.spyOn(port, "renewJobLease");
      const lines: string[] = [];
      const inner = createPublishingJobHandlers({
        port,
        store,
        processor: {
          process: () => Promise.reject(new Error("not used by this job")),
        },
        clock,
        logger: {
          info: (line) => lines.push(line),
          error: (line) => lines.push(line),
        },
      });
      const worker = newWorker(
        port,
        {
          // Hold the lease long enough for renewals before doing the work.
          async run(claim, signal) {
            await vi.waitFor(
              () => expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2),
              { timeout: 5_000, interval: 20 },
            );
            return inner.run(claim, signal);
          },
        },
        { kinds: ["reconcile_capacity"], leaseMs: 2_000, renewIntervalMs: 100 },
      );
      worker.start();
      await settled(jobId, "succeeded");
      await worker.stop();

      const job = await readJob(jobId);
      expect(job).toMatchObject({
        state: "succeeded",
        attempts: 1,
        lease_expires_at: null,
        last_error_code: null,
      });
      expect(job.lease_owner).toMatch(
        /^publishing-worker-it-[0-9a-f]{12}\.[0-9a-z]+$/,
      );
      expect(job.finished_at).toBeInstanceOf(Date);
      await expect(
        Promise.all(renew.mock.results.map((result) => result.value)),
      ).resolves.toEqual(renew.mock.results.map(() => true));
      renew.mockRestore();
      expect(await storeHas(oldOrphan)).toBe(false);
      expect(await storeHas(freshOrphan)).toBe(true);
      expect(lines).toEqual([
        "[publishing-worker] media store reconciliation unrecorded=2 removed=1",
      ]);
    },
  );

  it(
    "gives the lease of an unfinished job back at shutdown",
    { timeout: 20_000 },
    async () => {
      const jobId = await enqueue("sweep_staging", "staging");
      const worker = newWorker(
        suitePort(),
        {
          // Never finishes on its own; ends only when shutdown aborts it.
          run: (_claim, signal) =>
            new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        },
        {
          kinds: ["sweep_staging"],
          leaseMs: 60_000,
          shutdownGraceMs: 200,
          abortGraceMs: 2_000,
        },
      );
      worker.start();
      const running = await settled(jobId, "running", 10_000);
      expect(running.attempts).toBe(1);
      const stopping = clock().getTime();
      await worker.stop();

      // Attempt-neutral release: queued again at once, no error recorded.
      const job = await readJob(jobId);
      expect(job).toMatchObject({
        state: "queued",
        attempts: 0,
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: null,
      });
      expect(job.run_after.getTime()).toBeGreaterThanOrEqual(stopping);
      expect(job.run_after.getTime()).toBeLessThanOrEqual(clock().getTime());
      const restarted = newWorker(
        suitePort(),
        { run: async () => ({ status: "completed" }) },
        { kinds: ["sweep_staging"] },
      );
      restarted.start();
      await settled(jobId, "succeeded");
      await restarted.stop();
    },
  );

  it(
    "processes an item into ready with its derivative blobs recorded",
    { timeout: 20_000 },
    async () => {
      const { item, jobId } = await processingItem();
      expect((await itemRow(item.id))?.state).toBe("processing");
      const port = suitePort();
      const processor = storeProcessor();
      const worker = newWorker(
        port,
        createPublishingJobHandlers({
          port,
          store,
          processor,
          clock,
          logger: silent,
        }),
        { kinds: ["process_item"] },
      );
      worker.start();
      await settled(jobId, "succeeded");
      await worker.stop();

      expect(processor.process).toHaveBeenCalledTimes(1);
      expect(processor.process.mock.calls[0]![0]).toMatchObject({
        mode: "process",
        itemId: item.id,
        editKey: "base",
      });
      expect(await itemRow(item.id)).toEqual({
        state: "ready",
        failure_code: null,
      });
      expect(processor.produced).toHaveLength(4);
      expect(await recordedKeys(processor.produced)).toEqual(
        [...processor.produced].sort(),
      );
      for (const key of processor.produced)
        expect(await storeHas(key)).toBe(true);
    },
  );

  it(
    "removes the produced blobs when the item is cancelled right before the commit",
    { timeout: 20_000 },
    async () => {
      const { actor, item, jobId } = await processingItem();
      const port = suitePort();
      let open: () => void = () => undefined;
      const processor = storeProcessor(
        new Promise<void>((resolve) => {
          open = resolve;
        }),
      );
      const worker = newWorker(
        port,
        createPublishingJobHandlers({
          port,
          store,
          processor,
          clock,
          logger: silent,
          // Leave the cancellation to the commit's own recheck.
          cancellationCheckMs: 60_000,
        }),
        { kinds: ["process_item"] },
      );
      worker.start();
      await vi.waitFor(() => expect(processor.produced).toHaveLength(4), {
        timeout: 10_000,
        interval: 20,
      });
      await adapter.cancelItem(
        actor,
        item.id,
        { requestId: randomUUID() },
        clock(),
      );
      open();
      await settled(jobId, "succeeded");
      await worker.stop();

      expect((await itemRow(item.id))?.state).toBe("cancelled");
      expect(await recordedKeys(processor.produced)).toEqual([]);
      for (const key of processor.produced)
        expect(await storeHas(key)).toBe(false);
    },
  );

  it(
    "derives an edit of a legacy user media PNG without writing user media or source blobs",
    { timeout: 20_000 },
    async () => {
      const actor = `user-${hex()}`;
      await pool.query(
        "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'旧作测试')",
        [actor, `wp-${actor.slice(-24)}`],
      );
      suiteUsers.push(actor);
      const png = await sharp({
        create: {
          width: 60,
          height: 30,
          channels: 4,
          background: { r: 20, g: 40, b: 60, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer();
      const pngSha256 = createHash("sha256").update(png).digest("hex");
      const legacyMediaId = `user-media-${hex()}`;
      await pool.query(
        "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes) VALUES($1,$2,'image/png',60,30,$3,$4)",
        [legacyMediaId, actor, pngSha256, png],
      );
      const itemId = `media-item-${hex()}`;
      const at = clock();
      await pool.query(
        `INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,legacy_media_id,state,declared_total_bytes,received_total_bytes,presentation,created_at,updated_at,ready_at)
         VALUES($1,$2,'static','legacy','legacy_user_media',$3,'ready',$4,$4,'{"width":60,"height":30}'::jsonb,$5,$5,$5)`,
        [itemId, actor, legacyMediaId, png.byteLength, at.toISOString()],
      );
      const edit = { rotation: 90 as const, crop: null };
      const { rows: keys } = await pool.query<{ key: string }>(
        "SELECT community.media_edit_key($1::jsonb, NULL) AS key",
        [JSON.stringify(edit)],
      );
      const editKey = keys[0]!.key;
      expect(editKey).toMatch(/^[0-9a-f]{32}$/);
      const job = await adapter.enqueueJob(
        {
          kind: "derive_edit",
          subjectId: itemId,
          payload: {
            editKey,
            edit,
            coverCrop: null,
            variants: ["display", "full"],
          },
        },
        at,
      );
      expect(job.created).toBe(true);
      suiteJobIds.add(job.id);

      const port = suitePort();
      const readBytes = vi.spyOn(port, "readLegacyMediaBytes");
      // The real renderer runs in-process in place of the sandbox container
      // (real sharp, the real framed stream); a PNG edit runs no media tool.
      const sandbox = inProcessSandbox();
      const runner = await createSandboxRunner({
        image: "yoyi-work-publishing-media-tools:v2",
        workDirectory: workBase,
        appDist: defaultSandboxAppDist().appDist,
        temporaryRoots: [],
        spawn: sandbox.spawn,
      });
      const processor = createPublishingMediaProcessor({
        store,
        sandbox: runner,
        logger: silent,
      });
      const process = vi.spyOn(processor, "process");
      const worker = newWorker(
        port,
        createPublishingJobHandlers({
          port,
          store,
          processor,
          toolJobs: runner,
          clock,
          logger: silent,
        }),
        { kinds: ["derive_edit"] },
      );
      worker.start();
      await settled(job.id, "succeeded");
      await worker.stop();

      expect(readBytes).toHaveBeenCalledWith(itemId);
      readBytes.mockRestore();
      expect(process.mock.calls[0]![0]).toMatchObject({
        mode: "derive",
        itemId,
        kind: "static",
        components: [],
        source: {
          kind: "legacy_user_media",
          legacyMediaId,
          byteSize: png.byteLength,
          contentType: "image/png",
        },
        editKey,
      });
      const { rows: derivatives } = await pool.query<{
        variant: string;
        width: number;
        height: number;
        content_type: string;
        purpose: string;
        storage_key: string;
      }>(
        `SELECT d.role AS variant, d.width, d.height, d.content_type, b.purpose, b.storage_key
         FROM community.media_renditions d JOIN community.media_blobs b ON b.id = d.blob_id
         WHERE d.item_id = $1 AND d.edit_key = $2 AND d.state = 'ready' ORDER BY d.role`,
        [itemId, editKey],
      );
      expect(
        derivatives.map((row) => [
          row.variant,
          row.width,
          row.height,
          row.content_type,
          row.purpose,
        ]),
      ).toEqual([
        ["display", 30, 60, "image/webp", "derivative"],
        ["full", 30, 60, "image/webp", "derivative"],
      ]);
      for (const row of derivatives)
        expect(await storeHas(row.storage_key)).toBe(true);
      // Only derivative blobs exist for the owner; user media is unchanged.
      const { rows: blobs } = await pool.query<{ purpose: string }>(
        "SELECT purpose FROM community.media_blobs WHERE owner_id = $1",
        [actor],
      );
      expect(blobs.map((row) => row.purpose)).toEqual([
        "derivative",
        "derivative",
      ]);
      const { rows: components } = await pool.query(
        "SELECT 1 FROM community.media_components WHERE item_id = $1",
        [itemId],
      );
      expect(components).toHaveLength(0);
      const { rows: media } = await pool.query<{ sha: string; state: string }>(
        `SELECT encode(sha256(um.bytes), 'hex') AS sha, i.state
         FROM community.user_media um JOIN community.media_items i ON i.legacy_media_id = um.id
         WHERE um.id = $1`,
        [legacyMediaId],
      );
      expect(media).toEqual([{ sha: pngSha256, state: "ready" }]);
    },
  );

  it(
    "renders a Catalog asset in the sandbox and records owner-less renditions and facts",
    { timeout: 30_000 },
    async () => {
      const media = await realpath(
        await mkdtemp(path.join(tmpdir(), "publishing-worker-it-media-")),
      );
      try {
        const bytes = await sharp({
          create: {
            width: 2400,
            height: 1600,
            channels: 3,
            background: { r: randomBytes(1)[0]!, g: 120, b: 60 },
          },
        })
          .jpeg({ quality: 80 })
          .toBuffer();
        const sourceSha = createHash("sha256").update(bytes).digest("hex");
        const name = `${hex()}${hex()}-${sourceSha}.jpg`;
        const key = `editorial/${hex()}${hex()}/${name}`;
        await writeFile(path.join(media, name), bytes);
        const mediaId = `media-it-${hex()}`;
        const assetId = `catalog-asset-${createHash("md5").update(`${mediaId}:${key}`).digest("hex")}`;
        const at = clock();
        await pool.query(
          `INSERT INTO community.catalog_media_assets(id, media_id, source_object_key, source_sha256,
             source_content_type, state, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'image/jpeg', 'pending', $5, $5)`,
          [assetId, mediaId, key, sourceSha, at.toISOString()],
        );
        suiteAssets.push(assetId);
        const jobId = await enqueue("catalog_render", assetId);
        const sandbox = inProcessSandbox();
        const runner = await createSandboxRunner({
          image: "yoyi-work-publishing-media-tools:v2",
          workDirectory: workBase,
          appDist: defaultSandboxAppDist().appDist,
          temporaryRoots: [],
          spawn: sandbox.spawn,
        });
        const port = suitePort();
        const worker = newWorker(
          port,
          createPublishingJobHandlers({
            port,
            store,
            catalog: {
              port: adapter,
              renderer: createCatalogRenderer({
                store,
                sandbox: runner,
                source: new LocalCatalogSourceReader(media),
                logger: silent,
              }),
            },
            clock,
            logger: silent,
          }),
          { kinds: ["catalog_render"] },
        );
        worker.start();
        await settled(jobId, "succeeded", 25_000);
        await worker.stop();

        const { rows } = await pool.query<{
          role: string;
          width: number;
          height: number;
          recipe_version: number;
          state: string;
          owner_id: string | null;
          purpose: string;
          storage_key: string;
        }>(
          `SELECT r.role, r.width, r.height, r.recipe_version, r.state, b.owner_id, b.purpose, b.storage_key
           FROM community.media_renditions r JOIN community.media_blobs b ON b.id = r.blob_id
           WHERE r.catalog_asset_id = $1 ORDER BY r.role`,
          [assetId],
        );
        expect(
          rows.map((row) => [
            row.role,
            row.width,
            row.height,
            row.recipe_version,
            row.state,
            row.owner_id,
            row.purpose,
          ]),
        ).toEqual([
          ["cover", 1080, 720, 1, "ready", null, "catalog_derivative"],
          ["display", 2048, 1365, 1, "ready", null, "catalog_derivative"],
          ["thumb", 480, 320, 1, "ready", null, "catalog_derivative"],
          ["viewer", 2400, 1600, 1, "ready", null, "catalog_derivative"],
        ]);
        for (const row of rows)
          expect(await storeHas(row.storage_key)).toBe(true);
        const asset = (
          await pool.query<{
            state: string;
            master_sha256: string;
            master_width: number;
            master_height: number;
            placeholder_color: string;
          }>(
            "SELECT state, master_sha256, master_width, master_height, placeholder_color FROM community.catalog_media_assets WHERE id = $1",
            [assetId],
          )
        ).rows[0]!;
        expect(asset).toMatchObject({
          state: "ready",
          master_sha256: sourceSha,
          master_width: 2400,
          master_height: 1600,
        });
        expect(asset.placeholder_color).toMatch(/^#[0-9a-f]{6}$/);
        // Recorded: store reconciliation keeps them.
        expect(
          await adapter.unrecordedStorageKeys(
            rows.map((row) => row.storage_key),
          ),
        ).toEqual([]);
      } finally {
        await rm(media, { recursive: true, force: true });
      }
    },
  );

  it(
    "fails the item and releases its reservation when the processing job fails for good",
    { timeout: 20_000 },
    async () => {
      const { actor, item, jobId } = await processingItem();
      await pool.query(
        "UPDATE community.publishing_jobs SET max_attempts = 1 WHERE id = $1",
        [jobId],
      );
      const port = suitePort();
      const worker = newWorker(
        port,
        createPublishingJobHandlers({
          port,
          store,
          processor: {
            process: () =>
              Promise.reject(new MediaToolError("sandbox_unavailable")),
          },
          clock,
          logger: silent,
        }),
        { kinds: ["process_item"] },
      );
      worker.start();
      const job = await settled(jobId, "failed");
      await vi.waitFor(
        async () => expect((await itemRow(item.id))?.state).toBe("failed"),
        { timeout: 5_000, interval: 50 },
      );
      await worker.stop();

      expect(job).toMatchObject({
        attempts: 1,
        last_error_code: "media_tool_sandbox_unavailable",
      });
      expect(await itemRow(item.id)).toEqual({
        state: "failed",
        failure_code: "processing_failed",
      });
      const readable = await adapter.readItem(actor, item.id);
      expect(readable).toMatchObject({
        state: "failed",
        failureCode: "processing_failed",
      });
      const capacity = await pool.query<{ reserved_bytes: string }>(
        "SELECT reserved_bytes::text FROM community.account_publishing_capacity WHERE account_id = $1",
        [actor],
      );
      expect(capacity.rows[0]?.reserved_bytes).toBe("0");
    },
  );
};

describe.each(["filesystem", "cos"] as const)(
  "publishing worker on PostgreSQL (%s)",
  (kind) => {
    beforeAll(async () => {
      cos = kind === "cos" ? cosFixture() : undefined;
      store =
        cos?.store ??
        (await FilesystemPublishingMediaStore.open(base, {
          temporaryRoots: [],
        }));
    });
    workerCases();
  },
);
