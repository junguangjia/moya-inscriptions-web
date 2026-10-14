import type {
  ProfileMediaFamily,
  ProfileMediaRenditionRole,
} from "@moya/contracts";

import type { PublishingMediaWriteResult } from "./publishing-media-store-port.js";
import type { PublishingDerivativeCommit } from "./work-publishing-port.js";

/*
 * Profile image renditions (unified media pipeline, increment 3a): the
 * private WebP renditions of avatars and profile backgrounds
 * (`community.user_media`, keyed by the unchanged public user-media id). A
 * paced worker sweep, driven by the current `public_users` pointers, queues
 * `profile_render` jobs; the media worker renders a whole family in its
 * sandbox and records it in one transaction. Profile renditions are
 * owner-less blobs in the publishing store: never counted toward any
 * account, kept by the store reconciler because they are recorded, never
 * published to the edge. Every value here is content-free.
 */

/**
 * The current recipe identity of a family's anchor (`avatar-128`,
 * `background-960`). A family is rendered while its anchor is not ready on
 * a committed blob at this version or a later one, whatever its digest (the
 * recording rule replaces a ready rendition only with a higher version, so
 * the plan, the sweep and the recording agree); the other role of a family
 * is rendered with it, never alone. A version bump of a non-anchor role
 * alone is therefore never rendered: it needs an anchor version bump or an
 * extension of the plan and the sweep.
 */
export interface ProfileRenditionIdentity {
  readonly role: ProfileMediaRenditionRole;
  /** Integer >= 1. */
  readonly version: number;
  /** 16 lowercase hex. */
  readonly digest: string;
}

/**
 * What one `profile_render` job needs. `null` from `readProfileRenderPlan`:
 * an unknown or erased profile image (the job completes without work).
 */
export interface ProfileRenderPlan {
  readonly userMediaId: string;
  /** SHA-256 the stored PNG bytes must have. */
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  /** Length of the stored PNG bytes. */
  readonly byteSize: number;
  /**
   * Families to render, in the order `avatar`, `background`: those a
   * current pointer of the active owner selects whose anchor is not ready
   * (see `ProfileRenditionIdentity`). Empty: nothing to do.
   */
  readonly families: readonly ProfileMediaFamily[];
}

/** One rendition already written to the publishing store. */
export interface ProfileRenditionRecord extends PublishingMediaWriteResult {
  readonly role: ProfileMediaRenditionRole;
  readonly recipeVersion: number;
  readonly recipeDigest: string;
  readonly contentType: "image/webp";
  readonly width: number;
  readonly height: number;
}

/** The renditions of one successful `profile_render`. */
export interface ProfileRenderOutcome {
  /** SHA-256 of the rendered source bytes; must equal the stored image's. */
  readonly sourceSha256: string;
  /**
   * Every rendered role of each planned family, each role at most once and
   * each family with its anchor.
   */
  readonly renditions: readonly ProfileRenditionRecord[];
}

export interface ProfileRenderSweepOptions {
  /** 1..10 jobs queued (new or again) per pass. */
  readonly limit: number;
  /** 1..10: no job is queued while this many `profile_render` jobs are open. */
  readonly maxOpen: number;
  /** The current identity of both anchors, one each. */
  readonly anchors: readonly ProfileRenditionIdentity[];
}

/** Counts of one sweep pass (content-free; for logs). */
export interface ProfileRenderSweepCounts {
  /** Selected profile images whose anchor is not ready. */
  readonly missing: number;
  /** Of those, images without an open job whose job failed or was abandoned. */
  readonly blocked: number;
  /** New `profile_render` jobs. */
  readonly enqueued: number;
  /** Failed jobs queued again after the retry delay. */
  readonly requeued: number;
  /**
   * True when the pass queued nothing because other media work is queued or
   * running, or because `maxOpen` jobs are open.
   */
  readonly paused: boolean;
}

export interface ProfileMediaAssetPort {
  /**
   * The plan of one `profile_render` (see `ProfileRenderPlan`). Never reads
   * the image bytes. A malformed id or anchor list is refused (TypeError).
   */
  readProfileRenderPlan(
    userMediaId: string,
    anchors: readonly ProfileRenditionIdentity[],
  ): Promise<ProfileRenderPlan | null>;
  /** The stored PNG bytes of a profile image that is not erased, or `null`. */
  readProfileMediaBytes(userMediaId: string): Promise<Uint8Array | null>;
  /**
   * One transaction under the image row's share lock (erasure takes the
   * update lock first, so recording and erasure serialize): records each
   * rendition blob (owner-less, purpose `profile_derivative`) and row, and
   * releases a ready rendition of an older recipe version for the purge.
   * Same contract as `recordDerivatives`: `discarded` lists keys the caller
   * removes from the store (duplicates, or every unrecorded key when the
   * image is unknown or erased); a full replay reads as `recorded`. A source
   * hash other than the image's, or a malformed outcome, records nothing
   * (TypeError).
   */
  recordProfileRenditions(
    userMediaId: string,
    outcome: ProfileRenderOutcome,
    now: Date,
  ): Promise<PublishingDerivativeCommit>;
  /**
   * One paced sweep pass, also the backfill: the profile images the current
   * avatar and background pointers of active owners select, not erased,
   * whose family anchor is not ready (see `ProfileRenditionIdentity`), get a
   * `profile_render` job. Nothing is queued while a `process_item`,
   * `derive_edit` or `catalog_render` job is queued or running, or while
   * `maxOpen` `profile_render` jobs are open; otherwise at most
   * `min(limit, maxOpen - open)` per pass, owners with the most recent
   * public work first. An owner has at most one open `profile_render` job:
   * an owner with a queued or running one gets none, and a pass queues at
   * most one image per owner. A failed or abandoned job waits for the
   * operator, except that the latest failed job of a still-missing image
   * whose code is not a content rejection is queued again, with fresh
   * attempts, once 24 hours passed since it failed, under the same per-owner
   * rule; an abandoned job always waits. Never reads the image bytes.
   * Passes serialize.
   */
  enqueueProfileRenders(
    now: Date,
    options: ProfileRenderSweepOptions,
  ): Promise<ProfileRenderSweepCounts>;
}
