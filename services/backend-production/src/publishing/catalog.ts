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

import {
  CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS,
  CATALOG_SNAPSHOT_MAX_SOURCES,
  catalogMembershipBuckets,
  catalogMembershipChanged,
  catalogMembershipHashSql,
  catalogMembershipTotal,
  differingCatalogMembershipBuckets,
  nearCatalogSnapshotCeiling,
  readCatalogSnapshotCursor,
} from "@moya/community-postgres";

import type { createPostgresPool } from "@moya/catalog-postgres";
import type {
  CatalogMembershipBuckets,
  CatalogMembershipIntent,
  CatalogMembershipMarks,
  CatalogMembershipObservation,
  CatalogMembershipSide,
  CatalogMembershipState,
} from "@moya/community-postgres";
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
    /** Decoded intents whose identity the snapshot contradicts while they are
     * still live; skipped and left untouched (present only then). One that is
     * over (terminal in the snapshot or the stored row, or a stored lease
     * whose earlier of the stored and snapshot expiry passed) is refused
     * instead. */
    readonly mismatchedIntentIds?: readonly string[];
  }>;
}

/** New assets and queued jobs per sync pass. */
export const CATALOG_SYNC_BATCH = 100;
/** Sync cadence in the worker maintenance (spec: every 5 minutes). */
export const CATALOG_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * One Catalog sync step for the worker maintenance: reads the complete
 * published list (`null` above the snapshot ceiling, so nothing is marked
 * unreferenced from a partial list) and hands it to the store. From 80% of a
 * ceiling (`@moya/community-postgres` CATALOG_SNAPSHOT_*) each pass logs the
 * counts, so the Catalog's growth is seen long before a pass is skipped.
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
    const privateRows = snapshot?.privateRows ?? 0;
    if (
      nearCatalogSnapshotCeiling(
        sources.length,
        CATALOG_SNAPSHOT_MAX_SOURCES,
      ) ||
      nearCatalogSnapshotCeiling(privateRows, CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS)
    )
      logger.error(
        `[media-worker] catalog sync near ceiling sources=${sources.length}/${CATALOG_SNAPSHOT_MAX_SOURCES} private_rows=${privateRows}/${CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS}`,
      );
    const counts = await options.port.syncCatalogAssets(sources, now, {
      limit,
      renditions: catalogSyncIdentities(),
      ...(snapshot ? { snapshot } : {}),
    });
    // A late release, a state regression, or an identity drift of an intent
    // that is over (terminal, or a stored lease past the earlier of both
    // expiries): the mirror (its approved and retention pins) is tombstoned,
    // which an operator must see.
    if (counts.refusedIntentIds?.length)
      logger.error(
        `[media-worker] catalog sync tombstoned intents=${counts.refusedIntentIds.length} ids=${counts.refusedIntentIds.slice(0, 5).join(",")}`,
      );
    // Identity drift of an intent that is still live: its snapshot is not
    // applied and its mirror is left as it was, while every other intent
    // still syncs.
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

/** Membership fingerprint cadence (Owner decision D2: once a minute). */
export const CATALOG_MEMBERSHIP_INTERVAL_MS = 60 * 1000;

/**
 * The published membership by bucket (catalog-scale-v1 W8), through the
 * public read role: each distinct pair once (a pair two records show is one
 * asset), hashed by the md5 of `media_id:object_key`, which is the App asset
 * id's digest, so the App's record of the same set hashes alike. One
 * aggregate of the view, with no listing, order or row transfer: a scan of
 * the published list and an md5 per row each minute (about 30 ms at 25k).
 * A row without a media id or object key (both nullable in the CMS; only
 * Payload requires them) is no pair and never an App asset, as the sync
 * skips it; counted, its NULL hash would fail every observation.
 */
export const catalogPublicMembershipBucketsSql = `
  SELECT substr(m.h, 1, 2) AS bucket, count(*)::integer AS count,
    sum(${catalogMembershipHashSql("m.h", 3)})::text AS sum
  FROM (SELECT DISTINCT md5(media_id || ':' || object_key) AS h FROM catalog_media
    WHERE media_id IS NOT NULL AND object_key IS NOT NULL) m
  GROUP BY 1`;

/** The published pairs of the given buckets (only after a change). */
export const catalogPublicMembershipMembersSql = `
  SELECT DISTINCT media_id, object_key FROM catalog_media
  WHERE media_id IS NOT NULL AND object_key IS NOT NULL
    AND substr(md5(media_id || ':' || object_key), 1, 2) = ANY($1::text[])`;

/**
 * The live private projection's intents by bucket, through the prepare
 * reader: one row per intent (its first member, or its header row), hashed
 * with its state (a lapsed lease reads as expired) and state version, as
 * the App mirror records them.
 */
export const catalogPrivateMembershipBucketsSql = `
  SELECT substr(v.intent_id::text, 1, 2) AS bucket, count(*)::integer AS count,
    sum(${catalogMembershipHashSql("md5(v.intent_id::text || ':' || v.state || ':' || v.state_version)", 1)})::text AS sum
  FROM public.catalog_delivery_live_prepare_media v
  WHERE v.media_ordinal IS NULL OR v.media_ordinal = 1
  GROUP BY 1`;

/** The live projection's intents of the given buckets (only after a change). */
export const catalogPrivateMembershipMembersSql = `
  SELECT v.intent_id::text AS intent_id, v.state, v.state_version
  FROM public.catalog_delivery_live_prepare_media v
  WHERE (v.media_ordinal IS NULL OR v.media_ordinal = 1)
    AND substr(v.intent_id::text, 1, 2) = ANY($1::text[])`;

/** `catalog-asset-` + md5(media id ':' key), as the App derives an asset id. */
const catalogAssetIdOf = (mediaId: string, objectKey: string) =>
  `catalog-asset-${createHash("md5").update(`${mediaId}:${objectKey}`, "utf8").digest("hex")}`;

/** The App side of the membership step (community-postgres
 * catalog-publication-dirty, bound to the App pool). */
export interface CatalogMembershipPort {
  readCatalogMembershipState(): Promise<CatalogMembershipState>;
  readCatalogMembershipAppBuckets(
    side: "public" | "private",
  ): Promise<CatalogMembershipBuckets>;
  applyCatalogMembership(
    observation: CatalogMembershipObservation,
    now: Date,
  ): Promise<CatalogMembershipMarks>;
}

const connectCatalog = (
  pool: Pick<ReturnType<typeof createPostgresPool>, "connect">,
) => pool.connect();
type CatalogClient = Awaited<ReturnType<typeof connectCatalog>>;

/**
 * The per-minute membership step of the scoped reconcile (catalog-scale-v1
 * W8). In one CMS snapshot (the public read role's REPEATABLE READ
 * transaction, its snapshot exported to the prepare reader, as the complete
 * snapshot reads both), it reads one aggregate of each membership: the
 * published pairs and, with a prepare reader, the live private intents, each
 * as a count and a sum of element hashes in 256 buckets. A side whose total
 * equals the stored one is done. Otherwise only the buckets that changed are
 * listed on both sides, and the assets whose membership differs there are
 * marked dirty with the new fingerprints in one App transaction, so a
 * takedown of any size is queued as a whole, and the reconcile reacts within
 * a minute or two at any Catalog size. The same transaction marks the
 * intents whose lease or render grace passed since the last observation. A
 * minute without a change reads two aggregates and writes the state row.
 *
 * The buckets that changed are those that differ from this step's last
 * committed observation of the side, kept in memory while the stored
 * fingerprint is still that observation's (its count, sum and time). A
 * difference that lasts (an asset served while a requested intent holds it,
 * a published one that cannot be copied yet, a refused intent) is then
 * marked again only when the CMS changes one of its buckets, not on every
 * minute in which the CMS changes at all. Without such an observation (the
 * first after a start, or once another process, or a commit this step could
 * not confirm, advanced the stored row) the CMS buckets are compared with
 * the App's own record of the side, aggregated the same way, which marks
 * every lasting difference once. Within the listed buckets the marks are the
 * same either way: a bucket in which the App's record matches the CMS holds
 * nothing to mark. Above a snapshot ceiling the step writes nothing, as the
 * sync does. Any read error throws, and nothing is written or kept. Logs
 * are content-free counts.
 */
export function createCatalogMembershipWatch(options: {
  readonly published: Pick<ReturnType<typeof createPostgresPool>, "connect">;
  readonly prepare: Pick<
    ReturnType<typeof createPostgresPool>,
    "connect"
  > | null;
  readonly port: CatalogMembershipPort;
  readonly logger?: {
    info(message: string): void;
    error(message: string): void;
  };
}): { run(now: Date): Promise<void> } {
  const logger = options.logger ?? console;
  /** This step's last committed observation, by side: its CMS buckets and
   * the time it was read at, which the stored fingerprint then carries. */
  const committed = new Map<
    "public" | "private",
    { readonly at: number; readonly buckets: CatalogMembershipBuckets }
  >();
  const buckets = async (client: CatalogClient, sql: string) =>
    catalogMembershipBuckets(
      (await client.query<{ bucket: string; count: number; sum: string }>(sql))
        .rows,
    );
  /** One side: its total and, when that differs from the stored one, the CMS
   * members of the buckets that changed since this step's committed
   * observation while it is the stored one, or else of the buckets in which
   * the CMS differs from the App's record. */
  const side = async <Member>(
    observed: CatalogMembershipBuckets,
    stored: CatalogMembershipState["public"],
    kind: "public" | "private",
    members: (buckets: readonly string[]) => Promise<readonly Member[]>,
  ): Promise<CatalogMembershipSide<Member>> => {
    const total = catalogMembershipTotal(observed);
    if (!catalogMembershipChanged(stored, total))
      return { ...total, diff: null };
    const own = committed.get(kind);
    const stillStored =
      own !== undefined &&
      stored !== null &&
      own.at === stored.observedAt.getTime() &&
      !catalogMembershipChanged(stored, catalogMembershipTotal(own.buckets));
    const differing = differingCatalogMembershipBuckets(
      observed,
      stillStored
        ? own.buckets
        : await options.port.readCatalogMembershipAppBuckets(kind),
    );
    return {
      ...total,
      diff: {
        buckets: differing,
        members: differing.length ? await members(differing) : [],
      },
    };
  };
  /** One observation, compared with `previous`, with the CMS buckets it
   * read; null above a ceiling. */
  const observe = async (
    previous: CatalogMembershipState,
  ): Promise<{
    readonly observation: CatalogMembershipObservation;
    readonly buckets: ReadonlyMap<
      "public" | "private",
      CatalogMembershipBuckets
    >;
  } | null> => {
    const publicClient = await connectCatalog(options.published);
    let privateClient: CatalogClient | undefined;
    try {
      await publicClient.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const observedAt = (
        await publicClient.query<{ at: Date }>("SELECT clock_timestamp() AS at")
      ).rows[0]!.at;
      const publicBuckets = await buckets(
        publicClient,
        catalogPublicMembershipBucketsSql,
      );
      let privateBuckets: CatalogMembershipBuckets | undefined;
      if (options.prepare) {
        const snapshot = (
          await publicClient.query<{ id: string }>(
            "SELECT pg_export_snapshot() AS id",
          )
        ).rows[0]!.id;
        if (!/^[a-f0-9]+-[a-f0-9]+-[a-f0-9]+$/i.test(snapshot))
          throw new Error("Catalog snapshot identifier invalid");
        privateClient = await connectCatalog(options.prepare);
        await privateClient.query(
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        await privateClient.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
        privateBuckets = await buckets(
          privateClient,
          catalogPrivateMembershipBucketsSql,
        );
      }
      const publicCount = catalogMembershipTotal(publicBuckets).count;
      const privateCount = privateBuckets
        ? catalogMembershipTotal(privateBuckets).count
        : 0;
      if (
        publicCount > CATALOG_SNAPSHOT_MAX_SOURCES ||
        privateCount > CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS
      ) {
        logger.error(
          `[media-worker] catalog membership skipped: above ceiling sources=${publicCount}/${CATALOG_SNAPSHOT_MAX_SOURCES} intents=${privateCount}/${CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS}`,
        );
        return null;
      }
      const publicSide = await side(
        publicBuckets,
        previous.public,
        "public",
        async (list) =>
          (
            await publicClient.query<{ media_id: string; object_key: string }>(
              catalogPublicMembershipMembersSql,
              [list],
            )
          ).rows.map((row) => catalogAssetIdOf(row.media_id, row.object_key)),
      );
      const reader = privateClient;
      const privateSide =
        privateBuckets && reader
          ? await side<CatalogMembershipIntent>(
              privateBuckets,
              previous.private,
              "private",
              async (list) =>
                (
                  await reader.query<{
                    intent_id: string;
                    state: string;
                    state_version: number;
                  }>(catalogPrivateMembershipMembersSql, [list])
                ).rows.map((row) => ({
                  intentId: row.intent_id,
                  state: row.state,
                  stateVersion: row.state_version,
                })),
            )
          : null;
      return {
        observation: {
          observedAt,
          previous,
          public: publicSide,
          private: privateSide,
        },
        buckets: new Map([
          ["public", publicBuckets],
          ...(privateBuckets ? [["private", privateBuckets] as const] : []),
        ]),
      };
    } finally {
      if (privateClient) {
        await privateClient.query("ROLLBACK").catch(() => undefined);
        privateClient.release();
      }
      await publicClient.query("ROLLBACK").catch(() => undefined);
      publicClient.release();
    }
  };
  let active: Promise<void> | undefined;
  const run = async (now: Date) => {
    const observed = await observe(
      await options.port.readCatalogMembershipState(),
    );
    if (observed === null) return;
    const marked = await options.port.applyCatalogMembership(
      observed.observation,
      now,
    );
    // Committed: the stored fingerprints are now this observation's.
    const at = observed.observation.observedAt.getTime();
    for (const [kind, read] of observed.buckets)
      committed.set(kind, { at, buckets: read });
    if (marked.public + marked.private + marked.boundaries > 0)
      logger.info(
        `[media-worker] catalog membership marked public=${marked.public} private=${marked.private} boundaries=${marked.boundaries}`,
      );
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
 * The published Catalog media list, read through the read-only Catalog
 * connection (the public read role) in cursor batches (catalog-scale-v1 W3).
 * No LIMIT: the cursor stops one row past the snapshot ceiling.
 */
export const listPublishedCatalogSourcesSql = `
  SELECT media_id, object_key, width, height
  FROM catalog_media
  ORDER BY media_id ASC, object_key ASC
`;

/**
 * The complete published list inside the caller's open transaction on
 * `client` (the complete snapshot's REPEATABLE READ transaction), or null
 * above CATALOG_SNAPSHOT_MAX_SOURCES rows; at most one row past the ceiling
 * is ever read, and never a partial list is returned.
 */
export async function readPublishedCatalogSources(client: {
  query(sql: string): Promise<{ readonly rows: readonly unknown[] }>;
}): Promise<readonly CatalogWorkerSource[] | null> {
  const rows = await readCatalogSnapshotCursor<{
    media_id: string;
    object_key: string;
    width: number | null;
    height: number | null;
  }>(
    client,
    "catalog_published_sources",
    listPublishedCatalogSourcesSql,
    CATALOG_SNAPSHOT_MAX_SOURCES,
  );
  return (
    rows?.map((row) => ({
      mediaId: row.media_id,
      objectKey: row.object_key,
      width: row.width,
      height: row.height,
    })) ?? null
  );
}

/**
 * The same complete list on its own connection, in its own REPEATABLE READ
 * READ ONLY transaction: the fallback list of the sync and the publication
 * authority's whole-list check.
 */
export async function listPublishedCatalogSources(
  pool: Pick<ReturnType<typeof createPostgresPool>, "connect">,
): Promise<readonly CatalogWorkerSource[] | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await readPublishedCatalogSources(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Largest de-duplicated pair batch one exact check accepts: the bound of one
 * App delivery-projection read (`readCatalogDeliveryProjection`), which is
 * handed the same de-duplicated pairs. A per-request batch bound (one Detail's
 * images at most), not a ceiling on the Catalog. */
export const CATALOG_PUBLISHED_PAIRS_MAX = 10_000;

/**
 * Which requested (media id, object key) pairs the published Catalog
 * projection names now, read through the read-only Catalog connection (the
 * public read role) for a public read (catalog-scale-v1 1A). Both conditions
 * are restrictions on the view, never a join, so once the view is no longer
 * fenced (CMS migration M1) its index on media_id alone
 * (catalogs_media_media_id_lookup_idx) finds the requested media ids' rows
 * and object_key filters those few; until then each check is one filtered
 * scan of the view, with no listing, sort or ceiling. The answer may hold a
 * published cross-product pair nobody asked for; the exact-pair filter drops
 * it. No order, no bound and no community relation (the App is another
 * database).
 */
export const publishedCatalogPairsSql = `
  SELECT DISTINCT media_id, object_key
  FROM catalog_media
  WHERE media_id = ANY($1::text[]) AND object_key = ANY($2::text[])
`;

/**
 * The live published subset of `pairs`, keyed as the delivery facts map is
 * (`JSON.stringify([mediaId, objectKey])`). Read on every call with no cache,
 * so a withdrawn record loses its pairs on the next read. No pair reads
 * nothing; an invalid pair or an oversized batch throws before any query.
 */
export async function publishedCatalogPairs(
  published: Pick<ReturnType<typeof createPostgresPool>, "query">,
  pairs: readonly { readonly mediaId: string; readonly objectKey: string }[],
): Promise<ReadonlySet<string>> {
  const requested = new Map<string, { mediaId: string; objectKey: string }>();
  for (const { mediaId, objectKey } of pairs) {
    if (
      typeof mediaId !== "string" ||
      mediaId.length === 0 ||
      typeof objectKey !== "string" ||
      objectKey.length === 0
    )
      throw new TypeError("Catalog published pair invalid");
    requested.set(JSON.stringify([mediaId, objectKey]), { mediaId, objectKey });
  }
  if (requested.size === 0) return new Set();
  if (requested.size > CATALOG_PUBLISHED_PAIRS_MAX)
    throw new TypeError("Catalog published pair batch too large");
  const result = await published.query<{
    media_id: string;
    object_key: string;
  }>(publishedCatalogPairsSql, [
    [...new Set([...requested.values()].map((pair) => pair.mediaId))],
    [...new Set([...requested.values()].map((pair) => pair.objectKey))],
  ]);
  const live = new Set<string>();
  for (const row of result.rows) {
    const key = JSON.stringify([row.media_id, row.object_key]);
    if (requested.has(key)) live.add(key);
  }
  return live;
}
