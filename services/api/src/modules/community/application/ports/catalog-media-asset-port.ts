import type { PublishingMediaWriteResult } from "./publishing-media-store-port.js";
import type { PublishingDerivativeCommit } from "./work-publishing-port.js";

/*
 * Catalog media assets (unified media pipeline, increment 1): the private
 * rendition state of published Catalog images. The media worker reads the
 * published Catalog projection with its read-only Catalog connection, hands
 * the complete list to `syncCatalogAssets`, renders `catalog_render` jobs and
 * records the results. Catalog renditions are owner-less blobs in the
 * publishing store: never counted toward any account, never listed as
 * account media, kept by the store reconciler because they are recorded.
 * Every value here is content-free (no alt text, titles or file names).
 */

/** Roles a Catalog asset may have (no `full` and no `motion` in increment 1). */
export type CatalogRenditionRole = "thumb" | "cover" | "display" | "viewer";

/** One row of the published Catalog projection (`public.catalog_media`). */
export interface CatalogMediaSource {
  /** Payload media id: 1..128 non-whitespace characters, stored verbatim. */
  readonly mediaId: string;
  /**
   * The approved object key the projection names. Only the two approved
   * forms (`display/v1/media_<32 hex>/<64 hex>.webp` and
   * `editorial/<64 hex>/<64 hex>-<64 hex>.(jpg|png|webp)`) become assets;
   * any other key is skipped and counted, and keeps its existing delivery.
   */
  readonly objectKey: string;
  /** Published dimensions, both or neither. */
  readonly width: number | null;
  readonly height: number | null;
}

/** The recipe identity a ready asset must hold for one role. */
export interface CatalogRenditionIdentity {
  readonly role: CatalogRenditionRole;
  /** Integer >= 1. */
  readonly version: number;
  /** 16 lowercase hex. */
  readonly digest: string;
}

export interface CatalogAssetSyncOptions {
  /** 1..1000 new assets and 1..1000 new jobs per call. */
  readonly limit: number;
  /**
   * The current identity of every role each asset always receives. A ready
   * asset missing a ready rendition of one of these, on a committed blob, is
   * rendered again (a re-render also restores a planned `viewer`). Roles a
   * plan may skip (`viewer` when it would equal `display`) are not listed.
   */
  readonly renditions: readonly CatalogRenditionIdentity[];
}

/** Counts of one sync pass (content-free; for logs). */
export interface CatalogAssetSyncCounts {
  /** Approved source pairs named by the list. */
  readonly referenced: number;
  /** Sources outside both approved key forms. */
  readonly skipped: number;
  /** New asset rows. */
  readonly created: number;
  /** Assets newly marked unreferenced (no longer named by the list). */
  readonly unreferenced: number;
  /** New `catalog_render` jobs. */
  readonly enqueued: number;
}

/** A ready rendition an asset already has. */
export interface CatalogReadyRendition extends CatalogRenditionIdentity {
  readonly width: number;
  readonly height: number;
}

/**
 * What one `catalog_render` job needs. `null` from `readCatalogRenderPlan`:
 * unknown or failed asset (the job completes without work).
 */
export interface CatalogRenderPlan {
  readonly assetId: string;
  readonly mediaId: string;
  readonly sourceObjectKey: string;
  /** SHA-256 the source bytes must have (embedded in the approved key). */
  readonly sourceSha256: string;
  readonly sourceContentType: "image/jpeg" | "image/png" | "image/webp";
  readonly sourceWidth: number | null;
  readonly sourceHeight: number | null;
  readonly state: "pending" | "ready";
  /** False while the published projection no longer names the asset. */
  readonly referenced: boolean;
  /** Ready renditions whose blob is still committed. */
  readonly ready: readonly CatalogReadyRendition[];
}

/** One rendition already written to the publishing store. */
export interface CatalogRenditionRecord extends PublishingMediaWriteResult {
  readonly role: CatalogRenditionRole;
  readonly recipeVersion: number;
  readonly recipeDigest: string;
  readonly contentType: "image/webp";
  readonly width: number;
  readonly height: number;
}

/** The facts and renditions of one successful `catalog_render`. */
export interface CatalogRenderOutcome {
  /** SHA-256 of the decoded source bytes; must equal the plan's. */
  readonly masterSha256: string;
  /** Oriented dimensions of the decoded source. */
  readonly masterWidth: number;
  readonly masterHeight: number;
  /** Mean colour of the `thumb` (`#rrggbb`), `null` when not opaque. */
  readonly placeholderColor: string | null;
  readonly renditions: readonly CatalogRenditionRecord[];
}

export interface CatalogMediaAssetPort {
  /**
   * One bounded pass over the COMPLETE published list: creates missing
   * assets (`pending`), clears `unreferencedSince` of named assets, marks
   * every other asset unreferenced, returns a named asset that failed with
   * `source_unreadable` more than 24 hours ago to `pending`, and enqueues one
   * `catalog_render` per named asset that is pending, or ready but missing a
   * listed identity on a committed blob. Enqueueing is idempotent (one queued
   * or running job per asset); an asset whose job failed or was abandoned
   * waits for the operator. Nothing is deleted. A list longer than 10,000
   * entries is refused (TypeError).
   */
  syncCatalogAssets(
    sources: readonly CatalogMediaSource[],
    now: Date,
    options: CatalogAssetSyncOptions,
  ): Promise<CatalogAssetSyncCounts>;
  readCatalogRenderPlan(assetId: string): Promise<CatalogRenderPlan | null>;
  /**
   * One transaction under the asset row lock: records each rendition blob
   * (owner-less, purpose `catalog_derivative`) and row, replaces a ready
   * rendition of an older recipe version (released for the purge: Catalog
   * renditions are never pre-task bytes), and sets the
   * master facts, placeholder colour and state `ready`. Same contract as
   * `recordDerivatives`: `discarded` lists keys the caller removes from the
   * store (duplicates, or every unrecorded key when the asset is unknown or
   * failed); a full replay reads as `recorded`.
   */
  recordCatalogRenditions(
    assetId: string,
    outcome: CatalogRenderOutcome,
    now: Date,
  ): Promise<PublishingDerivativeCommit>;
  /**
   * A content rejection (content-free code `^[a-z][a-z0-9_]{0,63}$`, for
   * example `source_hash_mismatch`, or `source_unreadable` once the job's
   * attempts are used up): a pending asset becomes `failed`; a ready asset
   * keeps its renditions and state. Only `source_unreadable` is retried
   * later (see `syncCatalogAssets`).
   */
  failCatalogAsset(
    assetId: string,
    failureCode: string,
    now: Date,
  ): Promise<void>;
}
