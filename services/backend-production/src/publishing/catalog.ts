import { createHash } from "node:crypto";
import { chmod, open } from "node:fs/promises";

import {
  CATALOG_SOURCE_REJECTIONS,
  CatalogSourceError,
} from "../storage/catalog-source.js";
import { PublishingMediaStoreError } from "../storage/publishing-media-store.js";
import {
  MediaProcessingInputError,
  MediaProcessingUnavailableError,
  MediaRejectedError,
  systemErrorCode,
} from "./processing/errors.js";
import {
  logSandboxFailure,
  outputRecipe,
  plannedStillRequests,
  probeSandboxOutputs,
  storeOutputFile,
  validateSandboxManifest,
} from "./processing/media-processor.js";
import { MediaToolError } from "./processing/media-tools.js";
import { openFileByteReader } from "./processing/byte-reader.js";
import { probeJpegBlock } from "./processing/output-probe.js";
import {
  CATALOG_SOURCE_MAX_BYTES,
  SANDBOX_TIMEOUTS_MS,
} from "./processing/profiles.js";
import {
  BLOCK_RECIPE_DIGEST_V1,
  BLOCK_RECIPE_V1,
  blockCellOf,
  blockCellRegion,
  blockRole,
  currentRecipe,
  isProfileRole,
} from "./processing/recipes.js";
import {
  SANDBOX_PROTOCOL_VERSION,
  SandboxProtocolError,
  itemOutput,
  itemRejection,
} from "./sandbox/protocol.js";
import { SANDBOX_JOB_LIMITS, sandboxNonce } from "./sandbox/sandbox-runner.js";

import type { createPostgresPool } from "@moya/catalog-postgres";
import type { CatalogSourceReader } from "../storage/catalog-source.js";
import type { ProcessorLogger } from "./processing/media-processor.js";
import type { SandboxJob, SandboxManifest } from "./sandbox/protocol.js";
import type {
  SandboxJobDirectory,
  SandboxRunner,
} from "./sandbox/sandbox-runner.js";

/*
 * Catalog processing in the media worker (unified media pipeline, increment
 * 1). The sync hands the complete published Catalog media list to the store
 * on the maintenance cadence; a `catalog_render` job reads one approved
 * source object with the Catalog read identity, renders it in the same
 * sandbox as works (complete framing, no edit, no `full`), validates every
 * output and writes the renditions to the publishing store as owner-less
 * Catalog derivatives. The types below are structural mirrors of
 * `CatalogMediaAssetPort` in `@moya/api`; nothing here logs keys, ids or
 * media metadata.
 */

export type CatalogWorkerRole = "thumb" | "cover" | "display" | "viewer";

/** Mirror of `CatalogMediaSource`. */
export interface CatalogWorkerSource {
  readonly mediaId: string;
  readonly objectKey: string;
  readonly width: number | null;
  readonly height: number | null;
}

/** Mirror of `CatalogRenderPlan`. */
export interface CatalogWorkerRenderPlan {
  readonly assetId: string;
  readonly mediaId: string;
  readonly sourceObjectKey: string;
  readonly sourceSha256: string;
  readonly sourceContentType: "image/jpeg" | "image/png" | "image/webp";
  readonly sourceWidth: number | null;
  readonly sourceHeight: number | null;
  readonly masterSha256?: string | null;
  readonly masterWidth?: number | null;
  readonly masterHeight?: number | null;
  readonly state: "pending" | "ready";
  readonly referenced: boolean;
  readonly ready: readonly {
    readonly role: CatalogWorkerRole;
    readonly version: number;
    readonly digest: string;
    readonly width: number;
    readonly height: number;
  }[];
}

/** Mirror of `CatalogRenderOutcome`. */
export interface CatalogWorkerRenderOutcome {
  readonly masterSha256: string;
  readonly masterWidth: number;
  readonly masterHeight: number;
  readonly placeholderColor: string | null;
  readonly renditions: readonly {
    readonly storageKey: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly role: CatalogWorkerRole;
    readonly recipeVersion: number;
    readonly recipeDigest: string;
    readonly contentType: "image/webp";
    readonly width: number;
    readonly height: number;
  }[];
}

export type CatalogRenderResult =
  | {
      readonly status: "rendered";
      readonly outcome: CatalogWorkerRenderOutcome;
    }
  | { readonly status: "rejected"; readonly failureCode: string };

/** Renders one Catalog asset (implemented by {@link createCatalogRenderer}). */
export interface CatalogRenderer {
  render(
    plan: CatalogWorkerRenderPlan,
    signal?: AbortSignal,
  ): Promise<CatalogRenderResult>;
}

/** Owner label the publishing store sees for Catalog writes (never recorded). */
export const CATALOG_STORE_OWNER = "catalog";

/**
 * Roles every Catalog asset receives; `viewer` follows `display` whenever it
 * differs from `display` (the Catalog plan has no `full`).
 */
export const CATALOG_ALWAYS_RENDERED_ROLES = [
  "thumb",
  "cover",
  "display",
] as const;

export interface CatalogRendererOptions {
  /** The publishing store (the UGC store in Production). */
  readonly store: {
    writeStream(
      ownerId: string,
      purpose: "derivative",
      contentType: "image/webp",
      maxBytes: number,
      source: AsyncIterable<Uint8Array>,
      options?: {
        readonly signal?: AbortSignal;
        readonly requireExactSize?: boolean;
      },
    ): Promise<{ storageKey: string; byteSize: number; sha256: string }>;
    remove(storageKey: string): Promise<void>;
  };
  readonly sandbox: Pick<SandboxRunner, "createJob" | "run">;
  readonly source: CatalogSourceReader;
  readonly logger?: ProcessorLogger;
}

const withSignal = (signal: AbortSignal | undefined) =>
  signal ? { signal } : {};

export function createCatalogRenderer(
  options: CatalogRendererOptions,
): CatalogRenderer {
  const { store, sandbox, source } = options;
  const logger = options.logger ?? console;
  return {
    async render(plan, signal) {
      const written: string[] = [];
      let job: SandboxJobDirectory | undefined;
      try {
        job = await sandbox.createJob();
        const staged = await source.read(
          plan.sourceObjectKey,
          job.inputPath("still"),
          {
            expectedSha256: plan.sourceSha256,
            maxBytes: CATALOG_SOURCE_MAX_BYTES,
            ...withSignal(signal),
          },
        );
        const request: SandboxJob = {
          protocol: SANDBOX_PROTOCOL_VERSION,
          nonce: sandboxNonce(),
          operation: "derive",
          item: {
            kind: "static",
            qualityMode: "standard",
            inputs: [
              {
                role: "still",
                declaredType: plan.sourceContentType,
                byteSize: staged.byteSize,
                sha256: staged.sha256,
              },
            ],
            clientPairing: null,
            edit: { rotation: 0, crop: null },
            coverCrop: null,
            // No `full`: a viewer that differs from `display` is the largest.
            plan: "catalog",
            renditions: plannedStillRequests([
              ...CATALOG_ALWAYS_RENDERED_ROLES,
            ]),
            motion: false,
            placeholder: true,
          },
          limits: SANDBOX_JOB_LIMITS,
        };
        const result = await sandbox.run(job, request, {
          timeoutMs: SANDBOX_TIMEOUTS_MS.static,
          ...withSignal(signal),
        });
        const manifest = result.manifest;
        if (manifest.status === "rejected") {
          throw itemRejection(manifest.failureCode);
        }
        validateSandboxManifest(manifest, request);
        await probeSandboxOutputs(result);
        const renditions: CatalogWorkerRenderOutcome["renditions"][number][] =
          [];
        for (const output of manifest.outputs.map(itemOutput)) {
          if (
            output.contentType !== "image/webp" ||
            output.role === "full" ||
            output.role === "motion" ||
            isProfileRole(output.role)
          ) {
            throw new SandboxProtocolError("outputs_mismatch");
          }
          const file = result.files.get(output.name)!;
          const stored = await storeOutputFile(
            (body) =>
              store.writeStream(
                CATALOG_STORE_OWNER,
                "derivative",
                "image/webp",
                output.bytes,
                body,
                { requireExactSize: true, ...withSignal(signal) },
              ),
            file.path,
            output.bytes,
          );
          written.push(stored.storageKey);
          if (stored.sha256 !== output.sha256) {
            throw new SandboxProtocolError("hash_mismatch");
          }
          const recipe = outputRecipe(output);
          renditions.push({
            ...stored,
            role: output.role,
            recipeVersion: recipe.version,
            recipeDigest: recipe.digest,
            contentType: "image/webp",
            width: output.width,
            height: output.height,
          });
        }
        return {
          status: "rendered",
          outcome: {
            masterSha256: staged.sha256,
            masterWidth: manifest.inspection!.width,
            masterHeight: manifest.inspection!.height,
            placeholderColor: manifest.placeholderColor,
            renditions,
          },
        };
      } catch (error) {
        await Promise.all(
          written.map((key) => store.remove(key).catch(() => undefined)),
        );
        if (signal?.aborted) throw new MediaToolError("aborted");
        if (error instanceof CatalogSourceError) {
          if (CATALOG_SOURCE_REJECTIONS.has(error.code)) {
            return { status: "rejected", failureCode: error.code };
          }
          throw new MediaProcessingUnavailableError(null);
        }
        if (error instanceof MediaRejectedError) {
          // A timeout is retried like an edit derivation, never a rejection.
          if (error.failureCode === "processing_timeout") {
            throw new MediaToolError("timeout");
          }
          return { status: "rejected", failureCode: error.failureCode };
        }
        if (error instanceof SandboxProtocolError) {
          logSandboxFailure(logger, error);
          return { status: "rejected", failureCode: "processing_failed" };
        }
        if (
          error instanceof MediaToolError ||
          error instanceof PublishingMediaStoreError ||
          error instanceof MediaProcessingInputError ||
          error instanceof MediaProcessingUnavailableError
        ) {
          throw error;
        }
        throw new MediaProcessingUnavailableError(systemErrorCode(error));
      } finally {
        await job?.dispose().catch(() => undefined);
      }
    },
  };
}

/** Mirror of `CatalogBlockPlan` (catalog-deep-zoom-v1). */
export interface CatalogWorkerBlockPlan {
  readonly assetId: string;
  readonly masterId: string;
  readonly master: {
    readonly storageKey: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly contentType: "image/jpeg" | "image/png";
    readonly width: number;
    readonly height: number;
  };
  readonly frame: { readonly width: number; readonly height: number };
  readonly reference: {
    readonly storageKey: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
  };
  readonly cells: readonly [number, number];
}

/** Mirror of `CatalogBlockOutcome`. */
export interface CatalogWorkerBlockOutcome {
  readonly masterId: string;
  readonly blocks: readonly {
    readonly storageKey: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly cell: number;
    readonly recipeVersion: number;
    readonly recipeDigest: string;
    readonly contentType: "image/jpeg";
    readonly width: number;
    readonly height: number;
  }[];
}

export type CatalogBlockRenderResult =
  | { readonly status: "rendered"; readonly outcome: CatalogWorkerBlockOutcome }
  | { readonly status: "rejected"; readonly failureCode: string };

/** Cuts the cells of one block job (implemented by {@link createCatalogBlockRenderer}). */
export interface CatalogBlockRenderer {
  render(
    plan: CatalogWorkerBlockPlan,
    signal?: AbortSignal,
  ): Promise<CatalogBlockRenderResult>;
}

export interface CatalogBlockRendererOptions {
  /** The private publishing store (the UGC store in Production). */
  readonly store: {
    openRead(storageKey: string): Promise<
      | {
          readonly status: "ok";
          readonly byteSize: number;
          readonly body: AsyncIterable<Uint8Array>;
          close(): Promise<void>;
        }
      | { readonly status: "range_not_satisfiable"; readonly byteSize: number }
      | null
    >;
    writeStream(
      ownerId: string,
      purpose: "derivative",
      contentType: "image/jpeg",
      maxBytes: number,
      source: AsyncIterable<Uint8Array>,
      options?: {
        readonly signal?: AbortSignal;
        readonly requireExactSize?: boolean;
      },
    ): Promise<{ storageKey: string; byteSize: number; sha256: string }>;
    remove(storageKey: string): Promise<void>;
  };
  readonly sandbox: Pick<SandboxRunner, "createJob" | "run">;
  readonly logger?: ProcessorLogger & { info(message: string): void };
  readonly clock?: () => number;
}

/** Copies one private object into the job input, verifying size and hash. */
async function stageStoredInput(
  store: CatalogBlockRendererOptions["store"],
  job: SandboxJobDirectory,
  name: "master" | "reference",
  object: {
    readonly storageKey: string;
    readonly byteSize: number;
    readonly sha256: string;
  },
  signal: AbortSignal | undefined,
): Promise<void> {
  const read = await store.openRead(object.storageKey);
  if (read?.status !== "ok") throw new MediaProcessingUnavailableError(null);
  const target = job.inputPath(name);
  const handle = await open(target, "wx", 0o644);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    if (read.byteSize !== object.byteSize)
      throw new MediaProcessingUnavailableError(null);
    for await (const chunk of read.body) {
      if (signal?.aborted) throw new MediaToolError("aborted");
      bytes += chunk.byteLength;
      if (bytes > object.byteSize)
        throw new MediaProcessingUnavailableError(null);
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await read.close();
    await handle.close().catch(() => undefined);
  }
  await chmod(target, 0o644);
  if (bytes !== object.byteSize || hash.digest("hex") !== object.sha256)
    throw new MediaProcessingUnavailableError(null);
}

/** The block outputs a job must return: exactly its cells, in order. */
const validateBlockManifest = (
  manifest: SandboxManifest,
  plan: CatalogWorkerBlockPlan,
): void => {
  const [from, to] = plan.cells;
  if (
    manifest.status !== "blocks" ||
    manifest.inspection === null ||
    manifest.inspection.width !== plan.master.width ||
    manifest.inspection.height !== plan.master.height ||
    manifest.detectedTypes !== null ||
    manifest.pairing !== null ||
    manifest.presentation !== null ||
    manifest.placeholderColor !== null ||
    manifest.outputs.length !== to - from + 1
  )
    throw new SandboxProtocolError("status_mismatch");
  manifest.outputs.forEach((output, index) => {
    const cell = from + index;
    const region = blockCellRegion(plan.frame.width, plan.frame.height, cell);
    if (
      output.role !== blockRole(cell) ||
      output.name !== `${blockRole(cell)}.jpg` ||
      output.contentType !== "image/jpeg"
    )
      throw new SandboxProtocolError("outputs_mismatch");
    if (output.width !== region.width || output.height !== region.height)
      throw new SandboxProtocolError("dimensions_mismatch");
  });
};

/**
 * The block coordinator of one `catalog_render` block job: stages the held
 * master and the asset's `display` rendition from the private store (hash
 * verified), runs the `blocks` operation in the same sandbox, validates and
 * header-probes every block, and writes them as owner-less Catalog
 * derivatives. One content-free line per job reports its staging and render
 * time and outcome.
 */
export function createCatalogBlockRenderer(
  options: CatalogBlockRendererOptions,
): CatalogBlockRenderer {
  const { store, sandbox } = options;
  const logger = options.logger ?? console;
  const clock = options.clock ?? Date.now;
  return {
    async render(plan, signal) {
      const written: string[] = [];
      let job: SandboxJobDirectory | undefined;
      const started = clock();
      // Unset while staging runs: a staging failure reports its time as stage_ms.
      let staged: number | undefined;
      let outcome = "rendered";
      const cells = plan.cells[1] - plan.cells[0] + 1;
      try {
        job = await sandbox.createJob();
        await stageStoredInput(store, job, "master", plan.master, signal);
        await stageStoredInput(store, job, "reference", plan.reference, signal);
        staged = clock();
        const request: SandboxJob = {
          protocol: SANDBOX_PROTOCOL_VERSION,
          nonce: sandboxNonce(),
          operation: "blocks",
          item: null,
          blocks: {
            inputs: [
              {
                role: "master",
                declaredType: plan.master.contentType,
                byteSize: plan.master.byteSize,
                sha256: plan.master.sha256,
              },
              {
                role: "reference",
                declaredType: "image/webp",
                byteSize: plan.reference.byteSize,
                sha256: plan.reference.sha256,
              },
            ],
            master: { width: plan.master.width, height: plan.master.height },
            frame: plan.frame,
            reference: {
              width: plan.reference.width,
              height: plan.reference.height,
            },
            cells: plan.cells,
            recipe: {
              version: BLOCK_RECIPE_V1.version,
              digest: BLOCK_RECIPE_DIGEST_V1,
            },
          },
          limits: SANDBOX_JOB_LIMITS,
        };
        const result = await sandbox.run(job, request, {
          timeoutMs: SANDBOX_TIMEOUTS_MS.static,
          ...withSignal(signal),
        });
        const manifest = result.manifest;
        if (manifest.status === "rejected") {
          const code = manifest.failureCode ?? "processing_failed";
          // A timeout is retried, never a content failure of the master.
          if (code === "processing_timeout")
            throw new MediaToolError("timeout");
          outcome = code;
          return { status: "rejected", failureCode: code };
        }
        validateBlockManifest(manifest, plan);
        const blocks: CatalogWorkerBlockOutcome["blocks"][number][] = [];
        for (const output of manifest.outputs) {
          const file = result.files.get(output.name);
          if (file === undefined || file.bytes !== output.bytes)
            throw new SandboxProtocolError("stream_incomplete");
          const reader = await openFileByteReader(file.path);
          let probe;
          try {
            probe = await probeJpegBlock(reader);
          } finally {
            await reader.close();
          }
          if (probe?.width !== output.width || probe.height !== output.height)
            throw new SandboxProtocolError("output_invalid");
          const stored = await storeOutputFile(
            (body) =>
              store.writeStream(
                CATALOG_STORE_OWNER,
                "derivative",
                "image/jpeg",
                output.bytes,
                body,
                { requireExactSize: true, ...withSignal(signal) },
              ),
            file.path,
            output.bytes,
          );
          written.push(stored.storageKey);
          if (stored.sha256 !== output.sha256)
            throw new SandboxProtocolError("hash_mismatch");
          blocks.push({
            ...stored,
            cell: blockCellOf(output.role)!,
            recipeVersion: BLOCK_RECIPE_V1.version,
            recipeDigest: BLOCK_RECIPE_DIGEST_V1,
            contentType: "image/jpeg",
            width: output.width,
            height: output.height,
          });
        }
        return {
          status: "rendered",
          outcome: { masterId: plan.masterId, blocks },
        };
      } catch (error) {
        await Promise.all(
          written.map((key) => store.remove(key).catch(() => undefined)),
        );
        outcome =
          error instanceof MediaToolError && error.code === "timeout"
            ? "timeout"
            : "error";
        if (signal?.aborted) throw new MediaToolError("aborted");
        if (error instanceof SandboxProtocolError) {
          logSandboxFailure(logger, error);
          outcome = "processing_failed";
          return { status: "rejected", failureCode: "processing_failed" };
        }
        if (
          error instanceof MediaToolError ||
          error instanceof PublishingMediaStoreError ||
          error instanceof MediaProcessingInputError ||
          error instanceof MediaProcessingUnavailableError
        )
          throw error;
        throw new MediaProcessingUnavailableError(systemErrorCode(error));
      } finally {
        await job?.dispose().catch(() => undefined);
        const ended = clock();
        const stageEnd = staged ?? ended;
        logger.info(
          `[media-worker] catalog blocks stage_ms=${stageEnd - started} render_ms=${ended - stageEnd} cells=${cells} outcome=${outcome}`,
        );
      }
    },
  };
}

/** The identities a ready Catalog asset must hold (the sync re-renders otherwise). */
export const catalogSyncIdentities = () =>
  CATALOG_ALWAYS_RENDERED_ROLES.map((role) => {
    const recipe = currentRecipe(role);
    return { role, version: recipe.version, digest: recipe.digest };
  });

/** Mirror of `CatalogMediaAssetPort.syncCatalogAssets`. */
export interface CatalogSyncPort {
  syncCatalogAssets(
    sources: readonly CatalogWorkerSource[],
    now: Date,
    options: {
      readonly limit: number;
      readonly snapshot?: Parameters<
        import("@moya/community-postgres").PostgresWorkPublishingAdapter["syncCatalogAssets"]
      >[2]["snapshot"];
      readonly renditions: readonly {
        readonly role: CatalogWorkerRole;
        readonly version: number;
        readonly digest: string;
      }[];
    },
  ): Promise<{
    readonly referenced: number;
    readonly skipped: number;
    readonly created: number;
    readonly unreferenced: number;
    readonly enqueued: number;
    /** Decoded intents the pass refused and tombstoned (present only then). */
    readonly refusedIntentIds?: readonly string[];
    /** Decoded live intents whose identity the snapshot contradicts; skipped
     * and left untouched (present only then). A terminal one is refused. */
    readonly mismatchedIntentIds?: readonly string[];
  }>;
}

/** Largest published list one sync accepts (the store's bound). */
export const CATALOG_SYNC_MAX_SOURCES = 10_000;
/** New assets and queued jobs per sync pass. */
export const CATALOG_SYNC_BATCH = 100;
/** Sync cadence in the worker maintenance (spec: every 5 minutes). */
export const CATALOG_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * One Catalog sync step for the worker maintenance: reads the complete
 * published list (`null` when it exceeds the bound, so nothing is marked
 * unreferenced from a partial list) and hands it to the store.
 */
export function createCatalogSync(options: {
  readonly listSources: () => Promise<readonly CatalogWorkerSource[] | null>;
  readonly port: CatalogSyncPort;
  readonly readSnapshot?: () => Promise<
    Awaited<
      ReturnType<
        typeof import("./catalog-delivery-intents.js").readCatalogSourceSnapshot
      >
    >
  >;
  /**
   * The block step (catalog-deep-zoom-v1), present only while
   * `MEDIA_CATALOG_ZOOM_BLOCKS_RENDER` is on: after the asset sync, queue the
   * missing cells of incomplete sets of active masters (two open sets at most).
   */
  readonly blocks?: {
    enqueueCatalogBlockSets(
      now: Date,
      limit: number,
    ): Promise<{ readonly enqueued: number }>;
  };
  readonly limit?: number;
  readonly logger?: {
    info(message: string): void;
    error(message: string): void;
  };
}): { run(now: Date): Promise<void> } {
  const logger = options.logger ?? console;
  const limit = options.limit ?? CATALOG_SYNC_BATCH;
  let active: Promise<void> | undefined;
  const run = async (now: Date) => {
    const snapshot = options.readSnapshot
      ? await options.readSnapshot()
      : undefined;
    if (snapshot === null) {
      logger.error("[media-worker] catalog sync skipped: incomplete snapshot");
      return;
    }
    // Each is granted nothing and its App mirror is left as it is, while
    // every other intent still syncs.
    if (snapshot?.undecodableIntentIds?.length)
      logger.error(
        `[media-worker] catalog sync undecodable intents=${snapshot.undecodableIntentIds.length} ids=${snapshot.undecodableIntentIds.slice(0, 5).join(",")}`,
      );
    const sources = snapshot?.sources ?? (await options.listSources());
    if (sources === null) {
      logger.error("[media-worker] catalog sync skipped: list too large");
      return;
    }
    const counts = await options.port.syncCatalogAssets(sources, now, {
      limit,
      renditions: catalogSyncIdentities(),
      ...(snapshot ? { snapshot } : {}),
    });
    // A late release, a state regression or a terminal state whose identity
    // drifted: the mirror (its approved and retention pins) is tombstoned,
    // which an operator must see.
    if (counts.refusedIntentIds?.length)
      logger.error(
        `[media-worker] catalog sync tombstoned intents=${counts.refusedIntentIds.length} ids=${counts.refusedIntentIds.slice(0, 5).join(",")}`,
      );
    // Identity drift of a live intent: its snapshot is not applied and its
    // mirror is left as it was, while every other intent still syncs.
    if (counts.mismatchedIntentIds?.length)
      logger.error(
        `[media-worker] catalog sync mismatched intents=${counts.mismatchedIntentIds.length} ids=${counts.mismatchedIntentIds.slice(0, 5).join(",")}`,
      );
    if (counts.created + counts.unreferenced + counts.enqueued > 0) {
      logger.info(
        `[media-worker] catalog sync referenced=${counts.referenced} skipped=${counts.skipped} created=${counts.created} unreferenced=${counts.unreferenced} enqueued=${counts.enqueued}`,
      );
    }
    if (options.blocks !== undefined) {
      const blocks = await options.blocks.enqueueCatalogBlockSets(now, limit);
      if (blocks.enqueued > 0)
        logger.info(
          `[media-worker] catalog block sync enqueued=${blocks.enqueued}`,
        );
    }
  };
  return {
    run(now) {
      if (active) return active;
      active = run(now).finally(() => {
        active = undefined;
      });
      return active;
    },
  };
}

/**
 * Reads the published Catalog media list through the read-only Catalog
 * connection (the public read role). At most one row more than the bound is
 * read, so an oversized list is detected without loading it.
 */
export const listPublishedCatalogSourcesSql = `
  SELECT media_id, object_key, width, height
  FROM catalog_media
  ORDER BY media_id ASC, object_key ASC
  LIMIT ${CATALOG_SYNC_MAX_SOURCES + 1}
`;

export async function listPublishedCatalogSources(
  pool: Pick<ReturnType<typeof createPostgresPool>, "query">,
): Promise<readonly CatalogWorkerSource[] | null> {
  const result = await pool.query<{
    media_id: string;
    object_key: string;
    width: number | null;
    height: number | null;
  }>(listPublishedCatalogSourcesSql);
  if (result.rows.length > CATALOG_SYNC_MAX_SOURCES) return null;
  return result.rows.map((row) => ({
    mediaId: row.media_id,
    objectKey: row.object_key,
    width: row.width,
    height: row.height,
  }));
}
