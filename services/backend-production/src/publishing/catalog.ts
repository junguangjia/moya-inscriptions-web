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
import {
  CATALOG_SOURCE_MAX_BYTES,
  SANDBOX_TIMEOUTS_MS,
} from "./processing/profiles.js";
import { currentRecipe } from "./processing/recipes.js";
import {
  SANDBOX_PROTOCOL_VERSION,
  SandboxProtocolError,
} from "./sandbox/protocol.js";
import { SANDBOX_JOB_LIMITS, sandboxNonce } from "./sandbox/sandbox-runner.js";

import type { createPostgresPool } from "@moya/catalog-postgres";
import type { CatalogSourceReader } from "../storage/catalog-source.js";
import type { ProcessorLogger } from "./processing/media-processor.js";
import type { SandboxJob } from "./sandbox/protocol.js";
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

/** Roles every Catalog asset receives; `viewer` follows `display` when not skipped. */
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
          throw new MediaRejectedError(manifest.failureCode!);
        }
        validateSandboxManifest(manifest, request);
        await probeSandboxOutputs(result);
        const renditions: CatalogWorkerRenderOutcome["renditions"][number][] =
          [];
        for (const output of manifest.outputs) {
          if (
            output.contentType !== "image/webp" ||
            output.role === "full" ||
            output.role === "motion"
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
  }>;
}

/** Largest published list one sync accepts (the store's bound). */
export const CATALOG_SYNC_MAX_SOURCES = 10_000;
/** New assets and new jobs per sync pass. */
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
  readonly limit?: number;
  readonly logger?: {
    info(message: string): void;
    error(message: string): void;
  };
}): { run(now: Date): Promise<void> } {
  const logger = options.logger ?? console;
  const limit = options.limit ?? CATALOG_SYNC_BATCH;
  return {
    async run(now) {
      const sources = await options.listSources();
      if (sources === null) {
        logger.error("[media-worker] catalog sync skipped: list too large");
        return;
      }
      const counts = await options.port.syncCatalogAssets(sources, now, {
        limit,
        renditions: catalogSyncIdentities(),
      });
      if (counts.created + counts.unreferenced + counts.enqueued > 0) {
        logger.info(
          `[media-worker] catalog sync referenced=${counts.referenced} skipped=${counts.skipped} created=${counts.created} unreferenced=${counts.unreferenced} enqueued=${counts.enqueued}`,
        );
      }
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
