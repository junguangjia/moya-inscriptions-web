/*
 * Catalog display masters and blocks (catalog-deep-zoom-v1, unified media
 * pipeline increment 4 slice). A display master is the private, byte-exact
 * 8-bit JPEG or PNG behind one exact approved Catalog image, attached by the
 * Owner with the server-side `catalog-master` command. Its frame (the
 * master scaled to min(master, the Owner's limit, 8192 px long edge)) is cut
 * into one level of 1024 px JPEG blocks, recorded as ordinary Catalog
 * renditions `block-NN`. Masters are owner-less, retention-held blobs; they
 * are never published and never reach a public DTO. Every value here is
 * content-free: ids, sizes, hashes and codes, never a key, path or title.
 */

/** Payload of a block job: a `catalog_render` variant (no new job kind). */
export interface CatalogBlockJobPayload {
  readonly variant: "blocks";
  /** `catalog-master-<32 hex>`. */
  readonly masterId: string;
  /** Inclusive row-major cell range, at most 16 cells. */
  readonly cells: readonly [number, number];
}

/**
 * A Catalog block the Development Catalog relay may stream: a JPEG of the
 * published-blocks view. Deliberately not a `PublishingMediaReadTarget`, so
 * every user-media relay stays WebP/MP4.
 */
export interface CatalogBlockReadTarget {
  readonly kind: "catalog_block";
  readonly storageKey: string;
  readonly contentType: "image/jpeg";
  readonly byteSize: number;
  /** Lowercase hex SHA-256 of the stored bytes. */
  readonly sha256: string;
}

export type CatalogMasterDerivation = "submitted" | "edited-export";
export type CatalogMasterEndReason =
  "detached" | "limit_changed" | "reattached";

/** One published image of a Catalog record, for the approval document. */
export interface CatalogMasterCandidate {
  readonly mediaId: string;
  /** SHA-256 the approved key names (the approved image's bytes). */
  readonly approvedSha256: string | null;
  /** Published dimensions of the approved image. */
  readonly width: number;
  readonly height: number;
  readonly assetState: "pending" | "ready" | "failed" | "missing";
  /** Long edge of the ready `viewer` (or `display` when no viewer), or null. */
  readonly viewerLongEdge: number | null;
  readonly activeMasterId: string | null;
}

/** The oriented size of a master file as its header states it. */
export interface CatalogMasterHeader {
  readonly contentType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
}

/** The two storage bounds checked live at every attach (D4). */
export interface CatalogMasterStorage {
  /** Every byte #206 created, measured now (private and published). */
  readonly taskBytes: number;
  /** Masters plus blocks, private and published. */
  readonly sliceBytes: number;
  /** This attach: the master (0 on a re-attach) plus its projected blocks. */
  readonly attachBytes: number;
  readonly sliceCap: number;
  readonly taskCap: number;
}

export type CatalogMasterRefusal =
  | "not_published"
  | "asset_not_ready"
  | "approved_too_large"
  | "approved_mismatch"
  | "master_mismatch"
  | "aspect_mismatch"
  | "gain_too_small"
  | "base_too_small"
  | "already_attached"
  | "no_active_master"
  | "master_not_found"
  | "master_active"
  | "master_not_held"
  | "blocks_published"
  | "content_failure"
  | "set_open"
  | "sets_busy"
  | "set_complete"
  | "storage_slice_cap"
  | "storage_task_cap";

export type CatalogMasterResult<T> =
  | ({ readonly status: "done" } & T)
  | {
      readonly status: "refused";
      readonly code: CatalogMasterRefusal;
      readonly storage?: CatalogMasterStorage;
    };

/** One attach: a new master upload, or a re-attach of a held master blob. */
export interface CatalogMasterAttach {
  readonly mediaId: string;
  /** The approval document's SHA-256 of the approved image. */
  readonly approvedSha256: string;
  readonly masterSha256: string;
  readonly header: CatalogMasterHeader;
  readonly derivation: CatalogMasterDerivation;
  /** 1..8192; 8192 when the approval document names none. */
  readonly maxLongEdge: number;
  readonly note: string | null;
  /** `^[a-z0-9][a-z0-9._-]{0,63}$`. */
  readonly operator: string;
  /** The uploaded blob (a new attach) or the master to re-attach. */
  readonly source:
    | {
        readonly kind: "upload";
        readonly storageKey: string;
        readonly byteSize: number;
      }
    /** A re-attach; `dryRun` runs every check and writes nothing. */
    | {
        readonly kind: "existing";
        readonly masterId: string;
        readonly dryRun?: boolean;
      }
    /** `--dry-run`: every check, no write. */
    | { readonly kind: "dry_run"; readonly byteSize: number };
}

export interface CatalogMasterAttached {
  readonly masterId: string | null;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly cells: number;
  readonly storage: CatalogMasterStorage;
}

/** One active master, or one held master blob without an active row. */
export interface CatalogMasterStatusRow {
  readonly mediaId: string;
  readonly masterId: string;
  readonly active: boolean;
  /** The asset is still named by the published projection. */
  readonly referenced: boolean;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly cells: number;
  readonly blocksReady: number;
  readonly blocksPublished: number;
  readonly complete: boolean;
  readonly openJobs: number;
  readonly paused: boolean;
  readonly lastFailureCode: string | null;
  readonly endReason: CatalogMasterEndReason | null;
}

export interface CatalogMasterStatus {
  readonly masters: readonly CatalogMasterStatusRow[];
  /** Held master blobs that no active row uses (re-attach or erase). */
  readonly heldWithoutActive: readonly {
    readonly masterId: string;
    readonly byteSize: number;
    readonly endReason: CatalogMasterEndReason;
  }[];
  readonly storage: Omit<CatalogMasterStorage, "attachBytes">;
}

/** The rollback-floor guard: block rows in any state (release toolkit R5). */
export interface CatalogBlockGuardCounts {
  readonly blockPublications: number;
  readonly blockRenditions: number;
  readonly blockJobs: number;
}

/**
 * Store of the `catalog-master` command. Every write is one transaction that
 * re-checks its preconditions under the asset row lock.
 */
export interface CatalogDisplayMasterPort {
  listCandidates(catalogId: string): Promise<readonly CatalogMasterCandidate[]>;
  attach(
    input: CatalogMasterAttach,
    now: Date,
  ): Promise<CatalogMasterResult<CatalogMasterAttached>>;
  /** Ends the active row and inserts one with the new limit. */
  setLimit(
    mediaId: string,
    maxLongEdge: number,
    operator: string,
    now: Date,
  ): Promise<CatalogMasterResult<CatalogMasterAttached>>;
  /** Ends the active row of one image, or of every image. */
  detach(
    target: { readonly mediaId: string } | { readonly all: true },
    now: Date,
  ): Promise<CatalogMasterResult<{ readonly ended: number }>>;
  /** Tombstones a held master blob that no active row uses. */
  erase(
    masterId: string,
    now: Date,
  ): Promise<CatalogMasterResult<{ readonly byteSize: number }>>;
  /** Enqueues the missing cells of a paused set (never after a content failure). */
  requeue(
    mediaId: string,
    now: Date,
  ): Promise<CatalogMasterResult<{ readonly jobs: number }>>;
  status(catalogId: string | null): Promise<CatalogMasterStatus>;
  guardCounts(): Promise<CatalogBlockGuardCounts>;
}

/**
 * What one block job needs (catalog-deep-zoom-v1): the held master blob and
 * its oriented size, the frame, the asset's ready `display` rendition (the
 * alignment reference) and the cells to cut. `null` from
 * `readCatalogBlockPlan`: the master is no longer active, the asset is not
 * ready or no longer referenced, or the job's cells lie outside the frame
 * (the job completes without work).
 */
export interface CatalogBlockPlan {
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

/** One block written to the private store. */
export interface CatalogBlockRecord {
  readonly storageKey: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly cell: number;
  readonly recipeVersion: number;
  readonly recipeDigest: string;
  readonly contentType: "image/jpeg";
  readonly width: number;
  readonly height: number;
}

/** The blocks of one successful block job. */
export interface CatalogBlockOutcome {
  readonly masterId: string;
  readonly blocks: readonly CatalogBlockRecord[];
}

/** The block store a media worker with the block render switch on uses. */
export interface CatalogBlockPort {
  readCatalogBlockPlan(
    assetId: string,
    payload: unknown,
  ): Promise<CatalogBlockPlan | null>;
  /**
   * One transaction under the asset row lock: when the master is still the
   * asset's active one, releases ready blocks of any other master and records
   * each block blob (owner-less `catalog_derivative`) and row with its
   * master; otherwise every unrecorded key is returned for removal.
   */
  recordCatalogBlocks(
    assetId: string,
    outcome: CatalogBlockOutcome,
    now: Date,
  ): Promise<
    | { readonly status: "recorded" }
    | { readonly status: "discarded"; readonly storageKeys: readonly string[] }
  >;
  /**
   * The Catalog sync's block step: queues the missing cells of incomplete
   * sets of active masters on ready, referenced assets, in runs of at most 16
   * cells, never for a paused set or after a content failure, and never with
   * more than two sets open.
   */
  enqueueCatalogBlockSets(
    now: Date,
    limit: number,
  ): Promise<{ readonly enqueued: number }>;
}
