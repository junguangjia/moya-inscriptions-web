import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import type {
  MediaComponentRole,
  MediaFailureCode,
  PublishingHolder,
  PublishingMediaItem,
  RegisterMediaItemCommand,
} from "@moya/contracts";
import {
  PUBLISHING_MEDIA_PATH_PREFIX,
  publishingMediaItemSchema,
} from "@moya/contracts/schemas";
import type {
  OperatorAccountCapacity,
  WorkPublishingSettings,
} from "@moya/contracts/internal/community-operator";
import type {
  PublishingBlobContentType,
  PublishingCommandIdentity,
  PublishingDerivativeCommit,
  PublishingDerivativeRecord,
  PublishingDerivativeVariant,
  PublishingDerivedOutcome,
  PublishingEditItemState,
  PublishingEditReadiness,
  PublishingEditReadinessOptions,
  PublishingEditTarget,
  PublishingItemChange,
  PublishingJobClaim,
  PublishingMediaEdit,
  PublishingNormalizedCrop,
  PublishingProcessedOutcome,
  PublishingProcessingInput,
} from "@moya/api";
import type { Pool } from "pg";

import {
  actorTransaction,
  authorCommand,
  capacityDto,
  lockCapacity,
  nowParam,
  opaqueId,
  publishingAuthorActions,
  readTransaction,
  safeInteger,
  selectCapacity,
  selectSettings,
  writeTransaction,
  type PublishingDb,
} from "./db.js";
import { adjustCapacity, insertJob, releaseReservations } from "./jobs.js";
import {
  recordRenditionRows,
  unrecordedKeys,
  type RenditionRecordInput,
} from "./renditions.js";

/*
 * Settings and capacity reads, media items (registration with reservation and
 * item-count enforcement, cancel, component reset), processing results and
 * edit derivative readiness. Owner: B1a. Each exported port function
 * implements the same-named WorkPublishingPort method (see its JSDoc in
 * @moya/api); `pool` is the adapter's pool. Shared helpers: ./db.ts. The
 * exported helpers below are shared with drafts.ts, sessions.ts and uploads.ts.
 */

const MEBIBYTE = 1024 * 1024;
const DERIVATIVE_ALLOWANCE_CAP = 64 * MEBIBYTE;
const DERIVATIVE_ALLOWANCE_BASE = 4 * MEBIBYTE;
const variantOrder: readonly PublishingDerivativeVariant[] = [
  "thumb",
  "display",
  "full",
  "motion",
  "cover",
];
const roleOrder: Record<MediaComponentRole, number> = {
  still: 0,
  motion: 1,
  package: 2,
};

/**
 * Reservation for one registered item (design §2.2): the declared bytes plus
 * a derivative allowance of min(declared / 2, 64 MiB) + 4 MiB.
 */
export const derivativeAllowance = (declaredTotal: number): number =>
  Math.min(Math.floor(declaredTotal / 2), DERIVATIVE_ALLOWANCE_CAP) +
  DERIVATIVE_ALLOWANCE_BASE;

/**
 * SQL for the derivative edit key of an edit (`{rotation, crop}` jsonb) and an
 * optional cover crop (jsonb or SQL NULL). The one definition is the SQL
 * function `community.media_edit_key` (migration 20260914093000); keys are
 * never computed outside PostgreSQL.
 */
export const mediaEditKeySql = (edit: string, coverCrop: string): string =>
  `community.media_edit_key(${edit}, ${coverCrop})`;

// ---------------------------------------------------------------------------
// Item DTOs

interface ItemDtoRow {
  id: string;
  kind: "static" | "live";
  quality_mode: "standard" | "original" | "legacy";
  state: PublishingMediaItem["state"];
  failure_code: MediaFailureCode | null;
  presentation: Record<string, unknown> | null;
  legacy_media_id: string | null;
  components: {
    id: string;
    role: MediaComponentRole;
    state: PublishingMediaItem["components"][number]["state"];
    byteSize: number;
    receivedBytes: number;
  }[];
  has_full: boolean;
}

const itemDtoSelect = `SELECT i.id,i.kind,i.quality_mode,i.state,i.failure_code,i.presentation,i.legacy_media_id,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'role',c.role,'state',c.state,'byteSize',c.declared_bytes,'receivedBytes',c.received_bytes))
    FROM community.media_components c WHERE c.item_id=i.id), '[]'::jsonb) AS components,
  EXISTS (SELECT 1 FROM community.media_renditions d WHERE d.item_id=i.id AND d.role='full' AND d.edit_key='base' AND d.state='ready') AS has_full
  FROM community.media_items i`;

/** The public presentation fields only (private facts never leave the row). */
const publicPresentation = (
  kind: "static" | "live",
  stored: Record<string, unknown> | null,
): PublishingMediaItem["presentation"] => {
  if (stored === null) return null;
  const width = stored.width;
  const height = stored.height;
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (kind === "static") return { width, height };
  return {
    width,
    height,
    ...(typeof stored.durationMs === "number"
      ? { durationMs: stored.durationMs }
      : {}),
    ...(typeof stored.hasAudio === "boolean"
      ? { hasAudio: stored.hasAudio }
      : {}),
  };
};

/** The same-origin derivative path of one item, variant and edit key. */
export const publishingMediaSrc = (
  itemId: string,
  variant: PublishingDerivativeVariant,
  editKey: string,
): string => `${PUBLISHING_MEDIA_PATH_PREFIX}${itemId}/${variant}/${editKey}`;

/** The Phase 4 user media path that still serves a legacy item's unedited PNG. */
export const legacyMediaSrc = (legacyMediaId: string): string =>
  `/api/community/media/${legacyMediaId}`;

const itemDto = (row: ItemDtoRow): PublishingMediaItem => {
  const ready = row.state === "ready";
  const media = !ready
    ? null
    : row.legacy_media_id !== null
      ? {
          thumbSrc: legacyMediaSrc(row.legacy_media_id),
          displaySrc: legacyMediaSrc(row.legacy_media_id),
        }
      : {
          thumbSrc: publishingMediaSrc(row.id, "thumb", "base"),
          displaySrc: publishingMediaSrc(row.id, "display", "base"),
          ...(row.has_full
            ? { fullSrc: publishingMediaSrc(row.id, "full", "base") }
            : {}),
          ...(row.kind === "live"
            ? { motionSrc: publishingMediaSrc(row.id, "motion", "base") }
            : {}),
        };
  return publishingMediaItemSchema.parse({
    id: row.id,
    kind: row.kind,
    qualityMode: row.quality_mode,
    state: row.state,
    failureCode: row.state === "failed" ? row.failure_code : null,
    components: [...row.components].sort(
      (left, right) => roleOrder[left.role] - roleOrder[right.role],
    ),
    presentation: publicPresentation(row.kind, row.presentation),
    media,
  });
};

/** The owner's item DTOs by id (unknown or foreign ids are absent). */
export const selectMediaItems = async (
  db: PublishingDb,
  ownerId: string,
  itemIds: readonly string[],
): Promise<Map<string, PublishingMediaItem>> => {
  const unique = [...new Set(itemIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.query<ItemDtoRow>(
    `${itemDtoSelect} WHERE i.owner_id=$1 AND i.id=ANY($2::text[])`,
    [ownerId, unique],
  );
  return new Map(rows.rows.map((row) => [row.id, itemDto(row)]));
};

const selectMediaItem = async (
  db: PublishingDb,
  ownerId: string,
  itemId: string,
): Promise<PublishingMediaItem> => {
  const item = (await selectMediaItems(db, ownerId, [itemId])).get(itemId);
  if (item === undefined) throw new CommunityNotFoundError();
  return item;
};

// ---------------------------------------------------------------------------
// Content item references (drafts, conflict copies, snapshots)

/** Every item id named by draft content, in content order. */
export const contentItemIds = (content: {
  readonly items: readonly { readonly itemId: string | null }[];
}): string[] =>
  content.items.flatMap((item) => (item.itemId === null ? [] : [item.itemId]));

/** Every named item must belong to the actor (any state); otherwise not found. */
export const assertOwnedItems = async (
  db: PublishingDb,
  ownerId: string,
  itemIds: readonly string[],
): Promise<void> => {
  const unique = [...new Set(itemIds)];
  if (unique.length === 0) return;
  const owned = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM community.media_items WHERE owner_id=$1 AND id=ANY($2::text[])",
    [ownerId, unique],
  );
  if (safeInteger(owned.rows[0]?.count ?? 0) !== unique.length)
    throw new CommunityNotFoundError();
};

export type RefHolderKind = "draft" | "snapshot" | "session";

/** The refs one holder group lets go of (only of `itemIds` when given). */
export interface RefRelease {
  readonly holderKind:
    RefHolderKind | "revision" | "article_draft" | "article_revision";
  readonly holderIds: readonly string[];
  readonly itemIds?: readonly string[];
}

const refFilter = (release: RefRelease) =>
  `holder_kind=$1 AND holder_id=ANY($2::text[])${release.itemIds === undefined ? "" : " AND item_id=ANY($3::text[])"}`;

const refParams = (release: RefRelease) =>
  release.itemIds === undefined
    ? [release.holderKind, [...release.holderIds]]
    : [release.holderKind, [...release.holderIds], [...release.itemIds]];

/**
 * Removes the refs of several holder groups and marks each released live
 * item's last change at `now` (never earlier than it was), so an item that
 * lost its last ref waits the whole orphan grace from this moment before
 * `purge_item` may take it (T02, T05). Every item the groups release, plus
 * `lockAlso` (items the caller changes next in the same transaction, such as
 * cancellations), is locked once, in id order, before any ref goes; later
 * item locks of the caller on that set are already held, so one transaction
 * never takes item locks out of order across its steps. Returns the released
 * item ids in id order.
 */
export const releaseHolderRefs = async (
  db: PublishingDb,
  releases: readonly RefRelease[],
  now: Date,
  lockAlso: readonly string[] = [],
): Promise<string[]> => {
  const active = releases.filter(
    (release) => release.holderIds.length > 0 && release.itemIds?.length !== 0,
  );
  const held = new Set(lockAlso);
  for (const release of active)
    for (const row of (
      await db.query<{ item_id: string }>(
        `SELECT item_id FROM community.media_item_refs WHERE ${refFilter(release)}`,
        refParams(release),
      )
    ).rows)
      held.add(row.item_id);
  if (held.size === 0) return [];
  await db.query(
    "SELECT id FROM community.media_items WHERE id=ANY($1::text[]) AND state<>'purged' ORDER BY id FOR UPDATE",
    [[...held]],
  );
  const released = new Set<string>();
  for (const release of active)
    for (const row of (
      await db.query<{ item_id: string }>(
        `DELETE FROM community.media_item_refs WHERE ${refFilter(release)} RETURNING item_id`,
        refParams(release),
      )
    ).rows)
      released.add(row.item_id);
  const ids = [...released].sort();
  if (ids.length > 0)
    await db.query(
      `UPDATE community.media_items i
       SET updated_at=GREATEST(i.updated_at, $2::timestamptz)
       FROM (
         SELECT id FROM community.media_items
         WHERE id=ANY($1::text[]) AND state NOT IN ('cancelled','purged')
         ORDER BY id FOR UPDATE
       ) live
       WHERE i.id=live.id`,
      [ids, nowParam(now)],
    );
  return ids;
};

/** `releaseHolderRefs` for one holder group. */
export const releaseRefs = async (
  db: PublishingDb,
  holderKind: RefHolderKind | "revision",
  holderIds: readonly string[],
  now: Date,
  itemIds?: readonly string[],
): Promise<string[]> =>
  releaseHolderRefs(
    db,
    [
      itemIds === undefined
        ? { holderKind, holderIds }
        : { holderKind, holderIds, itemIds },
    ],
    now,
  );

/**
 * Adds refs from one holder to the owner's live items (not cancelled or
 * purged). `FOR KEY SHARE` makes a concurrent purge wait and re-check refs.
 */
export const attachItems = async (
  db: PublishingDb,
  ownerId: string,
  holderKind: RefHolderKind,
  holderId: string,
  itemIds: readonly string[],
): Promise<void> => {
  const unique = [...new Set(itemIds)];
  if (unique.length === 0) return;
  await db.query(
    `WITH live AS (
       SELECT id FROM community.media_items
       WHERE owner_id=$1 AND id=ANY($2::text[]) AND state NOT IN ('cancelled','purged')
       ORDER BY id FOR KEY SHARE
     )
     INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id)
     SELECT id,$3,$4 FROM live
     ON CONFLICT DO NOTHING`,
    [ownerId, unique, holderKind, holderId],
  );
};

/**
 * Cancels items and schedules their purge: components cancelled, reservations
 * released, draft and session refs removed, `purge_item` enqueued at `now`.
 * With `onlyUnreferenced`, items that still have any ref after locking are
 * skipped. Returns the handled item ids and the components whose transfers
 * must stop.
 */
export const cancelItems = async (
  db: PublishingDb,
  itemIds: readonly string[],
  now: Date,
  options: { readonly onlyUnreferenced?: boolean } = {},
): Promise<{
  readonly itemIds: readonly string[];
  readonly cancelledComponentIds: readonly string[];
}> => {
  const unique = [...new Set(itemIds)].sort();
  if (unique.length === 0) return { itemIds: [], cancelledComponentIds: [] };
  const at = nowParam(now);
  await db.query(
    "SELECT id FROM community.media_items WHERE id=ANY($1::text[]) AND state <> 'purged' ORDER BY id FOR UPDATE",
    [unique],
  );
  const targets = (
    await db.query<{ id: string }>(
      `SELECT i.id FROM community.media_items i
       WHERE i.id=ANY($1::text[]) AND i.state <> 'purged'
       AND NOT EXISTS (SELECT 1 FROM community.media_item_refs r WHERE r.item_id=i.id AND r.holder_kind='article_revision')
       ${options.onlyUnreferenced === true ? "AND NOT EXISTS (SELECT 1 FROM community.media_item_refs r WHERE r.item_id=i.id)" : ""}
       ORDER BY i.id`,
      [unique],
    )
  ).rows.map((row) => row.id);
  if (targets.length === 0) return { itemIds: [], cancelledComponentIds: [] };
  const receiving = await db.query<{ id: string }>(
    "SELECT id FROM community.media_components WHERE item_id=ANY($1::text[]) AND state='receiving' ORDER BY id FOR UPDATE",
    [targets],
  );
  await db.query(
    "UPDATE community.media_components SET state='cancelled', upload_attempt=NULL, updated_at=$2::timestamptz WHERE item_id=ANY($1::text[]) AND state <> 'cancelled'",
    [targets, at],
  );
  await db.query(
    "UPDATE community.media_items SET state='cancelled', cancelled_at=COALESCE(cancelled_at,$2::timestamptz), updated_at=$2::timestamptz, version=version+1 WHERE id=ANY($1::text[]) AND state <> 'cancelled'",
    [targets, at],
  );
  await releaseReservations(db, targets, now);
  await db.query(
    "DELETE FROM community.media_item_refs WHERE item_id=ANY($1::text[]) AND holder_kind IN ('draft','session')",
    [targets],
  );
  for (const itemId of targets) {
    const job = await insertJob(
      db,
      { kind: "purge_item", subjectId: itemId },
      now,
    );
    // A prior orphan-grace job must not defer an explicit permanent deletion.
    if (!job.created)
      await db.query(
        "UPDATE community.publishing_jobs SET run_after=LEAST(run_after,$2::timestamptz),updated_at=$2::timestamptz WHERE id=$1 AND state='queued'",
        [job.id, at],
      );
  }
  return {
    itemIds: targets,
    cancelledComponentIds: receiving.rows.map((row) => row.id),
  };
};

// ---------------------------------------------------------------------------
// Edit derivative readiness

interface ReadinessJob {
  editKey: string;
  state: "queued" | "running" | "failed" | "abandoned";
  variants: PublishingDerivativeVariant[];
}

interface ReadinessRow {
  ord: number;
  edit_key: string;
  cover_key: string;
  item_id: string | null;
  state: PublishingMediaItem["state"] | null;
  kind: "static" | "live" | null;
  quality_mode: "standard" | "original" | "legacy" | null;
  /** `variant@editKey` of every required derivative not yet recorded. */
  missing: string[];
  /** This item's derive jobs for the row's edit keys that did not succeed. */
  jobs: ReadinessJob[];
}

const normalizedEdit = (edit: {
  readonly rotation: 0 | 90 | 180 | 270;
  readonly crop: PublishingNormalizedCrop | null;
}): PublishingMediaEdit => ({ rotation: edit.rotation, crop: edit.crop });

/**
 * SQL (item alias, required-derivative alias) that is false only for the
 * `base` derivatives of a legacy item: its unedited form is the Phase 4 user
 * media PNG, so only its edited derivatives are rendered and required.
 */
export const legacyNeedsSql = (item: string, required: string): string =>
  `(${item}.quality_mode <> 'legacy' OR ${required}.edit_key <> 'base')`;

/**
 * How long a `derive_edit` job enqueued by a draft change waits before a
 * worker may claim it. Rotations and crops still being adjusted replace such
 * jobs (see `ensureContentDerivatives`) instead of each value running.
 */
export const DERIVE_SETTLE_MS = 30_000;

export interface ContentDerivativeOptions {
  /**
   * A draft change: new jobs wait `DERIVE_SETTLE_MS`, and still settling
   * (never claimed) jobs of these items (the content's items and the ones it
   * dropped) for edit keys the content no longer needs are removed. Without
   * it (explicit readiness before a submission) new jobs run at `now` and
   * settling jobs the content needs are moved up to `now`.
   */
  readonly settle?: { readonly itemIds: readonly string[] };
}

/**
 * Computes readiness of content items for their edits and cover crop and
 * enqueues `derive_edit` for ready items whose derivatives are missing (one
 * active job per item, edit key and variant set; variants an active job does
 * not cover get their own job). A variant whose derive job for that edit key
 * failed or was abandoned is reported as `failed` and never re-enqueued here
 * (operator retry decides).
 */
export const ensureContentDerivatives = async (
  db: PublishingDb,
  ownerId: string,
  content: PublishingEditTarget,
  now: Date,
  options: ContentDerivativeOptions = {},
): Promise<PublishingEditReadiness> => {
  const inputs = content.items.flatMap((item, ord) =>
    item.itemId === null
      ? []
      : [
          {
            ord,
            item_id: item.itemId,
            edit: normalizedEdit(item.edit),
            is_cover: item.key === content.coverKey,
            cover_crop:
              item.key === content.coverKey ? content.coverCrop : null,
          },
        ],
  );
  const rows = new Map<number, ReadinessRow>();
  if (inputs.length > 0) {
    const result = await db.query<ReadinessRow>(
      `WITH input AS (
         SELECT e.ord, e.item_id, e.edit, e.is_cover, e.cover_crop,
           ${mediaEditKeySql("e.edit", "NULL::jsonb")} AS edit_key,
           ${mediaEditKeySql("e.edit", "e.cover_crop")} AS cover_key
         FROM jsonb_to_recordset($1::jsonb) AS e(ord integer, item_id text, edit jsonb, is_cover boolean, cover_crop jsonb)
       )
       SELECT e.ord, e.edit_key, e.cover_key, i.id AS item_id, i.state, i.kind, i.quality_mode,
         COALESCE((SELECT array_agg(rd.variant || '@' || rd.edit_key)
                   FROM community.media_required_derivatives(i.kind, e.edit, e.is_cover, e.cover_crop) rd
                   WHERE ${legacyNeedsSql("i", "rd")} AND NOT EXISTS (
                     SELECT 1 FROM community.media_renditions d
                     WHERE d.item_id=i.id AND d.role=rd.variant AND d.edit_key=rd.edit_key AND d.state='ready')), '{}'::text[]) AS missing,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('editKey', j.payload->>'editKey', 'state', j.state, 'variants', j.payload->'variants') ORDER BY j.created_at, j.id)
                   FROM community.publishing_jobs j
                   WHERE j.kind='derive_edit' AND j.subject_id=i.id AND j.state <> 'succeeded'
                     AND j.payload->>'editKey' IN (e.edit_key, e.cover_key)), '[]'::jsonb) AS jobs
       FROM input e
       LEFT JOIN community.media_items i ON i.id=e.item_id AND i.owner_id=$2
       ORDER BY e.ord`,
      [JSON.stringify(inputs), ownerId],
    );
    for (const row of result.rows) rows.set(row.ord, row);
  }
  const runAfter =
    options.settle === undefined
      ? now
      : new Date(now.getTime() + DERIVE_SETTLE_MS);
  const items: {
    key: string;
    itemId: string | null;
    state: PublishingEditItemState;
    editKey: string | null;
  }[] = [];
  for (const [ord, item] of content.items.entries()) {
    if (item.itemId === null) {
      items.push({
        key: item.key,
        itemId: null,
        state: "pending",
        editKey: null,
      });
      continue;
    }
    const row = rows.get(ord);
    const isCover = item.key === content.coverKey;
    const state = await itemReadiness(
      db,
      row,
      item.edit,
      isCover,
      content.coverCrop,
      now,
      runAfter,
    );
    // The thumb and cover of the cover item carry its cover crop in their key.
    const editKey =
      state === "ready" && row !== undefined
        ? isCover
          ? row.cover_key
          : row.edit_key
        : null;
    items.push({ key: item.key, itemId: item.itemId, state, editKey });
  }
  // The (item, edit key) pairs this content needs.
  const wanted = [...rows.values()].flatMap((row) =>
    row.item_id === null
      ? []
      : [`${row.item_id}@${row.edit_key}`, `${row.item_id}@${row.cover_key}`],
  );
  const at = nowParam(now);
  if (options.settle !== undefined) {
    const touched = [
      ...new Set([...options.settle.itemIds, ...contentItemIds(content)]),
    ];
    if (touched.length > 0)
      await db.query(
        `DELETE FROM community.publishing_jobs
         WHERE kind='derive_edit' AND state='queued' AND attempts=0 AND run_after > $1::timestamptz
           AND subject_id=ANY($2::text[])
           AND NOT ((subject_id || '@' || (payload->>'editKey')) = ANY($3::text[]))`,
        [at, touched, wanted],
      );
  } else if (wanted.length > 0) {
    await db.query(
      `UPDATE community.publishing_jobs SET run_after=$1::timestamptz, updated_at=$1::timestamptz
       WHERE kind='derive_edit' AND state='queued' AND run_after > $1::timestamptz
         AND (subject_id || '@' || (payload->>'editKey')) = ANY($2::text[])`,
      [at, wanted],
    );
  }
  return { ready: items.every((item) => item.state === "ready"), items };
};

const itemReadiness = async (
  db: PublishingDb,
  row: ReadinessRow | undefined,
  edit: PublishingMediaEdit,
  isCover: boolean,
  coverCrop: PublishingNormalizedCrop | null,
  now: Date,
  runAfter: Date,
): Promise<PublishingEditItemState> => {
  if (row === undefined || row.item_id === null || row.state === null)
    return "unavailable";
  switch (row.state) {
    case "cancelled":
    case "purged":
      return "unavailable";
    case "awaiting_upload":
      return "uploading";
    case "processing":
      return "processing";
    case "failed":
      return "failed";
    case "ready":
      break;
  }
  // Required derivatives come from community.media_required_derivatives; a
  // legacy item's `base` ones are its user media PNG and never missing, its
  // edited ones derive from the user media bytes like any other item.
  const missingByKey = new Map<string, Set<string>>();
  for (const slot of row.missing) {
    const at = slot.indexOf("@");
    const key = slot.slice(at + 1);
    const variants = missingByKey.get(key) ?? new Set<string>();
    variants.add(slot.slice(0, at));
    missingByKey.set(key, variants);
  }
  let failed = false;
  let deriving = false;
  for (const [key, variants] of missingByKey) {
    const missing = variantOrder.filter((variant) => variants.has(variant));
    const jobs = row.jobs.filter((job) => job.editKey === key);
    const covered = new Set(
      jobs
        .filter((job) => job.state === "queued" || job.state === "running")
        .flatMap((job) => job.variants),
    );
    const ended = new Set(
      jobs
        .filter((job) => job.state === "failed" || job.state === "abandoned")
        .flatMap((job) => job.variants),
    );
    if (missing.some((variant) => covered.has(variant))) deriving = true;
    const uncovered = missing.filter((variant) => !covered.has(variant));
    if (uncovered.some((variant) => ended.has(variant))) {
      failed = true;
      continue;
    }
    if (uncovered.length === 0) continue;
    await insertJob(
      db,
      {
        kind: "derive_edit",
        subjectId: row.item_id,
        payload: {
          editKey: key,
          edit: normalizedEdit(edit),
          coverCrop:
            isCover && key === row.cover_key && key !== row.edit_key
              ? coverCrop
              : null,
          variants: uncovered,
        },
        runAfter,
      },
      now,
    );
    deriving = true;
  }
  return failed ? "failed" : deriving ? "deriving" : "ready";
};

// ---------------------------------------------------------------------------
// Settings and capacity

/** WorkPublishingPort.readSettings */
export const readSettings = async (
  pool: Pool,
): Promise<WorkPublishingSettings> =>
  readTransaction(pool, (db) => selectSettings(db));

/** WorkPublishingPort.readCapacity */
export const readCapacity = async (
  pool: Pool,
  accountId: string,
): Promise<OperatorAccountCapacity> =>
  readTransaction(pool, async (db) =>
    capacityDto(await selectCapacity(db, accountId)),
  );

/** WorkPublishingPort.reconcileCapacity */
export const reconcileCapacity = async (
  pool: Pool,
  accountId: string,
  now: Date,
): Promise<OperatorAccountCapacity> =>
  writeTransaction(pool, async (db) => {
    // Items past upload and processing hold no reservation. Components are
    // locked before the capacity row, as every other transition does.
    await db.query(
      `UPDATE community.media_components c SET reserved_bytes=0, updated_at=$2::timestamptz
       FROM (
         SELECT c.id FROM community.media_components c
         JOIN community.media_items i ON i.id=c.item_id
         WHERE c.owner_id=$1 AND c.reserved_bytes > 0
           AND i.state NOT IN ('awaiting_upload','processing')
         ORDER BY c.id FOR UPDATE OF c
       ) settled
       WHERE c.id=settled.id`,
      [accountId, nowParam(now)],
    );
    await lockCapacity(db, accountId, now);
    await db.query(
      `UPDATE community.account_publishing_capacity SET
         committed_bytes=(SELECT COALESCE(sum(byte_size),0) FROM community.media_blobs WHERE owner_id=$1 AND state IN ('committed','tombstoned')),
         reserved_bytes=(SELECT COALESCE(sum(reserved_bytes),0) FROM community.media_components WHERE owner_id=$1)
       WHERE account_id=$1`,
      [accountId],
    );
    return capacityDto(await selectCapacity(db, accountId));
  });

/** WorkPublishingPort.unrecordedStorageKeys */
export const unrecordedStorageKeys = async (
  pool: Pool,
  storageKeys: readonly string[],
): Promise<readonly string[]> => {
  const unique = [...new Set(storageKeys)];
  if (unique.length === 0) return [];
  const recorded = await readTransaction(pool, (db) =>
    db.query<{ storage_key: string }>(
      "SELECT storage_key FROM community.media_blobs WHERE storage_key=ANY($1::text[])",
      [unique],
    ),
  );
  const known = new Set(recorded.rows.map((row) => row.storage_key));
  return unique.filter((key) => !known.has(key));
};

// ---------------------------------------------------------------------------
// Registration, reads, cancel and component reset

interface LockedHolder {
  readonly kind: "draft" | "session";
  readonly id: string;
}

/**
 * Locks the actor's active holder: a primary draft in state `active`, or an
 * active session whose lease has not passed. Unknown, foreign or lapsed:
 * not found; submitted, discarded or deleted: conflict.
 */
const lockHolder = async (
  db: PublishingDb,
  actorId: string,
  holder: PublishingHolder,
  now: Date,
): Promise<LockedHolder> => {
  if ("draftId" in holder) {
    const draft = (
      await db.query<{ state: string }>(
        "SELECT state FROM community.work_drafts WHERE id=$1 AND owner_id=$2 AND conflict_of IS NULL FOR UPDATE",
        [holder.draftId, actorId],
      )
    ).rows[0];
    if (draft === undefined) throw new CommunityNotFoundError();
    if (draft.state !== "active")
      throw new CommunityConflictError("The draft is no longer active");
    return { kind: "draft", id: holder.draftId };
  }
  const session = (
    await db.query<{ state: string; lease_expires_at: Date }>(
      "SELECT state,lease_expires_at FROM community.publishing_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [holder.sessionId, actorId],
    )
  ).rows[0];
  if (session === undefined) throw new CommunityNotFoundError();
  if (session.state !== "active")
    throw new CommunityConflictError("The session has ended");
  if (session.lease_expires_at.getTime() < now.getTime())
    throw new CommunityNotFoundError();
  return { kind: "session", id: holder.sessionId };
};

/** WorkPublishingPort.registerItem */
export const registerItem = async (
  pool: Pool,
  actorId: string,
  command: RegisterMediaItemCommand,
  now: Date,
): Promise<PublishingMediaItem> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.registerItem,
      subjectId:
        "draftId" in command.holder
          ? command.holder.draftId
          : command.holder.sessionId,
      input: command,
      now,
    },
    async (db) => {
      const at = nowParam(now);
      const holder = await lockHolder(db, actorId, command.holder, now);
      const settings = await selectSettings(db, "share");
      const held = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM community.media_item_refs r
         JOIN community.media_items i ON i.id=r.item_id
         WHERE r.holder_kind=$1 AND r.holder_id=$2 AND i.state NOT IN ('cancelled','purged')`,
        [holder.kind, holder.id],
      );
      if (safeInteger(held.rows[0]?.count ?? 0) >= settings.maxItemsPerWork)
        throw new CommunityInputError("items_limit");
      const declaredTotal = command.components.reduce(
        (total, component) => total + component.byteSize,
        0,
      );
      if (
        command.qualityMode === "original" &&
        declaredTotal > settings.originalItemMaxBytes
      )
        throw new CommunityInputError("original_item_too_large");
      if (
        command.qualityMode === "standard" &&
        command.components.some(
          (component) =>
            component.byteSize > settings.standardComponentMaxBytes,
        )
      )
        throw new CommunityInputError("component_too_large");
      const allowance = derivativeAllowance(declaredTotal);
      const reservation = declaredTotal + allowance;
      const capacity = await lockCapacity(db, actorId, now);
      if (
        capacity.committedBytes + capacity.reservedBytes + reservation >
        capacity.capacityBytes
      )
        throw new CommunityInputError("capacity_exceeded");
      await adjustCapacity(db, actorId, { reserved: reservation }, now);
      const itemId = opaqueId("media-item");
      const pairing =
        command.clientPairing === undefined
          ? null
          : {
              method: command.clientPairing.method,
              verifiedBy: "client",
              identifierSha256: command.clientPairing.identifierSha256 ?? null,
              ...(command.clientPairing.stillTimeMs === undefined
                ? {}
                : { stillTimeMs: command.clientPairing.stillTimeMs }),
            };
      // Standard provenance per component (Q03): optimized or retained input.
      const standardOutcomes = Object.fromEntries(
        command.components.flatMap((component) =>
          component.standardOutcome === undefined
            ? []
            : [[component.role, component.standardOutcome]],
        ),
      );
      const privateMetadata =
        command.metadata === undefined &&
        Object.keys(standardOutcomes).length === 0
          ? null
          : {
              ...(command.metadata ?? {}),
              ...(Object.keys(standardOutcomes).length === 0
                ? {}
                : { standardOutcomes }),
            };
      await db.query(
        `INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,declared_total_bytes,pairing,private_metadata,processing_profile,created_at,updated_at)
         VALUES($1,$2,$3,$4,'upload','awaiting_upload',$5,$6::jsonb,$7::jsonb,$8,$9::timestamptz,$9::timestamptz)`,
        [
          itemId,
          actorId,
          command.kind,
          command.qualityMode,
          declaredTotal,
          pairing === null ? null : JSON.stringify(pairing),
          privateMetadata === null ? null : JSON.stringify(privateMetadata),
          command.processingProfile ?? null,
          at,
        ],
      );
      const components = [...command.components].sort(
        (left, right) => roleOrder[left.role] - roleOrder[right.role],
      );
      for (const [index, component] of components.entries())
        await db.query(
          `INSERT INTO community.media_components(id,item_id,owner_id,role,declared_bytes,declared_type,state,reserved_bytes,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,'awaiting',$7,$8::timestamptz,$8::timestamptz)`,
          [
            opaqueId("media-component"),
            itemId,
            actorId,
            component.role,
            component.byteSize,
            component.contentType,
            // The still (or package) component also carries the derivative allowance.
            component.byteSize + (index === 0 ? allowance : 0),
            at,
          ],
        );
      await db.query(
        "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,$2,$3)",
        [itemId, holder.kind, holder.id],
      );
      return selectMediaItem(db, actorId, itemId);
    },
    { auditSubject: (item) => item.id },
  );

/** Reads answer an inactive or unknown actor as not found, like writes do. */
export const requireActiveActor = async (
  db: PublishingDb,
  actorId: string,
): Promise<void> => {
  const active = await db.query(
    "SELECT 1 FROM community.public_users WHERE id=$1 AND status='active'",
    [actorId],
  );
  if (active.rowCount !== 1) throw new CommunityNotFoundError();
};

/** WorkPublishingPort.readItem */
export const readItem = async (
  pool: Pool,
  actorId: string,
  itemId: string,
): Promise<PublishingMediaItem> =>
  readTransaction(pool, async (db) => {
    await requireActiveActor(db, actorId);
    return selectMediaItem(db, actorId, itemId);
  });

interface LockedItem {
  id: string;
  state: PublishingMediaItem["state"];
  declared_total_bytes: string;
  received_total_bytes: string;
}

const lockOwnedItem = async (
  db: PublishingDb,
  ownerId: string,
  itemId: string,
): Promise<LockedItem> => {
  const item = (
    await db.query<LockedItem>(
      "SELECT id,state,declared_total_bytes,received_total_bytes FROM community.media_items WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [itemId, ownerId],
    )
  ).rows[0];
  if (item === undefined) throw new CommunityNotFoundError();
  return item;
};

/** WorkPublishingPort.cancelItem */
export const cancelItem = async (
  pool: Pool,
  actorId: string,
  itemId: string,
  command: PublishingCommandIdentity,
  now: Date,
): Promise<PublishingItemChange> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.cancelItem,
      subjectId: itemId,
      input: command,
      now,
    },
    async (db) => {
      const item = await lockOwnedItem(db, actorId, itemId);
      let cancelledComponentIds: readonly string[] = [];
      if (
        item.state === "awaiting_upload" ||
        item.state === "processing" ||
        item.state === "failed"
      ) {
        // A snapshot naming the item keeps its ref (restoring reads it as
        // unavailable) and holds the purge back until it is evicted; the
        // explicit cancel still stops the transfer (U07).
        const kept = await db.query(
          "SELECT 1 FROM community.media_item_refs WHERE item_id=$1 AND holder_kind IN ('revision','article_revision') LIMIT 1",
          [itemId],
        );
        if ((kept.rowCount ?? 0) === 0)
          ({ cancelledComponentIds } = await cancelItems(db, [itemId], now));
      }
      return {
        item: await selectMediaItem(db, actorId, itemId),
        cancelledComponentIds,
      };
    },
  );

/** WorkPublishingPort.resetComponent */
export const resetComponent = async (
  pool: Pool,
  actorId: string,
  itemId: string,
  role: MediaComponentRole,
  command: PublishingCommandIdentity,
  now: Date,
): Promise<PublishingItemChange> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.resetComponent,
      subjectId: itemId,
      input: { role, ...command },
      now,
    },
    async (db) => {
      const at = nowParam(now);
      const item = await lockOwnedItem(db, actorId, itemId);
      if (item.state !== "awaiting_upload" && item.state !== "failed")
        throw new CommunityConflictError(
          "Only an item that is not processing or ready can retry a component",
        );
      const component = (
        await db.query<{
          id: string;
          state: string;
          declared_bytes: string;
          received_bytes: string;
          reserved_bytes: string;
          blob_id: string | null;
        }>(
          "SELECT id,state,declared_bytes,received_bytes,reserved_bytes,blob_id FROM community.media_components WHERE item_id=$1 AND role=$2 FOR UPDATE",
          [itemId, role],
        )
      ).rows[0];
      if (component === undefined) throw new CommunityNotFoundError();
      const failed = item.state === "failed";
      if (component.state === "awaiting" && !failed)
        return {
          item: await selectMediaItem(db, actorId, itemId),
          cancelledComponentIds: [],
        };
      const declared = safeInteger(component.declared_bytes);
      // Declared bytes return to the reservation once they left it at commit;
      // a failed item also takes its derivative allowance again.
      const hadBlob = component.blob_id !== null;
      const reserve =
        (hadBlob ? declared : 0) +
        (failed
          ? derivativeAllowance(safeInteger(item.declared_total_bytes))
          : 0);
      if (reserve > 0) {
        const capacity = await lockCapacity(db, actorId, now);
        if (
          capacity.committedBytes + capacity.reservedBytes + reserve >
          capacity.capacityBytes
        )
          throw new CommunityInputError("capacity_exceeded");
      }
      await db.query(
        `UPDATE community.media_components
         SET state='awaiting', upload_attempt=NULL, received_bytes=0, sha256=NULL, detected_type=NULL,
             blob_id=NULL, reserved_bytes=reserved_bytes + $2::bigint, updated_at=$3::timestamptz
         WHERE id=$1`,
        [component.id, reserve, at],
      );
      await adjustCapacity(db, actorId, { reserved: reserve }, now);
      await db.query(
        `UPDATE community.media_items
         SET received_total_bytes=GREATEST(received_total_bytes - $2::bigint, 0),
             state='awaiting_upload', failure_code=NULL, updated_at=$3::timestamptz, version=version+1
         WHERE id=$1`,
        [itemId, safeInteger(component.received_bytes), at],
      );
      if (component.blob_id !== null)
        await insertJob(
          db,
          { kind: "purge_blob", subjectId: component.blob_id },
          now,
        );
      return {
        item: await selectMediaItem(db, actorId, itemId),
        cancelledComponentIds:
          component.state === "receiving" ? [component.id] : [],
      };
    },
  );

// ---------------------------------------------------------------------------
// Worker: processing input and results

const allVariants = (
  kind: "static" | "live",
): readonly PublishingDerivativeVariant[] =>
  kind === "live"
    ? ["thumb", "display", "full", "motion", "cover"]
    : ["thumb", "display", "full", "cover"];

/** WorkPublishingPort.readProcessing */
export const readProcessing = async (
  pool: Pool,
  job: Pick<PublishingJobClaim, "kind" | "subjectId" | "payload">,
): Promise<PublishingProcessingInput | null> => {
  if (job.kind !== "process_item" && job.kind !== "derive_edit") return null;
  return readTransaction(pool, async (db) => {
    const item = (
      await db.query<{
        id: string;
        owner_id: string;
        kind: "static" | "live";
        quality_mode: "standard" | "original" | "legacy";
        state: string;
        pairing: {
          method:
            "apple-content-identifier" | "motion-photo-container" | "none";
          identifierSha256?: string | null;
          stillTimeMs?: number;
        } | null;
        legacy_media_id: string | null;
        legacy_bytes: number | null;
      }>(
        `SELECT i.id,i.owner_id,i.kind,i.quality_mode,i.state,i.pairing,um.id AS legacy_media_id,octet_length(um.bytes) AS legacy_bytes
         FROM community.media_items i
         LEFT JOIN community.user_media um ON i.source='legacy_user_media' AND um.id=i.legacy_media_id AND um.owner_id=i.owner_id
         WHERE i.id=$1`,
        [job.subjectId],
      )
    ).rows[0];
    if (item === undefined) return null;
    const processing = job.kind === "process_item";
    if (processing ? item.state !== "processing" : item.state !== "ready")
      return null;
    if (!processing && job.payload === null) return null;
    if (item.quality_mode === "legacy") {
      // A Phase 4 PNG is only derived for an edit: its unedited form is the
      // user media route, and its bytes stay in user media.
      const payload = job.payload;
      if (
        processing ||
        payload === null ||
        payload.editKey === "base" ||
        item.legacy_media_id === null ||
        item.legacy_bytes === null ||
        item.legacy_bytes <= 0
      )
        return null;
      return {
        mode: "derive",
        itemId: item.id,
        ownerId: item.owner_id,
        kind: "static",
        qualityMode: "standard",
        components: [],
        clientPairing: null,
        editKey: payload.editKey,
        edit: normalizedEdit(payload.edit),
        coverCrop: payload.coverCrop,
        variants: payload.variants.filter((variant) => variant !== "motion"),
        source: {
          kind: "legacy_user_media",
          legacyMediaId: item.legacy_media_id,
          byteSize: item.legacy_bytes,
          contentType: "image/png",
        },
      };
    }
    const components = await db.query<{
      role: MediaComponentRole;
      state: string;
      storage_key: string | null;
      byte_size: string | null;
      sha256: string | null;
      declared_type: PublishingBlobContentType;
    }>(
      `SELECT c.role,c.state,b.storage_key,b.byte_size,b.sha256,c.declared_type
       FROM community.media_components c
       LEFT JOIN community.media_blobs b ON b.id=c.blob_id AND b.state='committed'
       WHERE c.item_id=$1`,
      [item.id],
    );
    const usable = components.rows.filter(
      (row) =>
        (row.state === "received" || row.state === "verified") &&
        row.storage_key !== null &&
        row.byte_size !== null &&
        row.sha256 !== null,
    );
    if (processing && usable.length !== components.rows.length) return null;
    const pairing =
      item.pairing === null
        ? null
        : {
            method: item.pairing.method,
            identifierSha256: item.pairing.identifierSha256 ?? null,
            ...(typeof item.pairing.stillTimeMs === "number"
              ? { stillTimeMs: item.pairing.stillTimeMs }
              : {}),
          };
    const payload = job.payload;
    return {
      mode: processing ? "process" : "derive",
      itemId: item.id,
      ownerId: item.owner_id,
      kind: item.kind,
      qualityMode: item.quality_mode,
      source: { kind: "upload" },
      components: usable
        .sort((left, right) => roleOrder[left.role] - roleOrder[right.role])
        .map((row) => ({
          role: row.role,
          storageKey: row.storage_key ?? "",
          byteSize: safeInteger(row.byte_size ?? 0),
          sha256: row.sha256 ?? "",
          declaredType: row.declared_type,
        })),
      clientPairing: pairing,
      editKey: processing || payload === null ? "base" : payload.editKey,
      edit:
        processing || payload === null
          ? { rotation: 0, crop: null }
          : normalizedEdit(payload.edit),
      coverCrop: processing || payload === null ? null : payload.coverCrop,
      variants:
        processing || payload === null
          ? allVariants(item.kind)
          : [...payload.variants],
    };
  });
};

/** WorkPublishingPort.readLegacyMediaBytes */
export const readLegacyMediaBytes = async (
  pool: Pool,
  itemId: string,
): Promise<Uint8Array | null> =>
  readTransaction(pool, async (db) => {
    const row = (
      await db.query<{ bytes: Buffer }>(
        `SELECT um.bytes FROM community.media_items i
         JOIN community.user_media um ON um.id=i.legacy_media_id AND um.owner_id=i.owner_id
         WHERE i.id=$1 AND i.source='legacy_user_media' AND i.state<>'purged'`,
        [itemId],
      )
    ).rows[0];
    return row === undefined
      ? null
      : new Uint8Array(
          row.bytes.buffer,
          row.bytes.byteOffset,
          row.bytes.length,
        );
  });

const PLACEHOLDER_COLOR = /^#[0-9a-f]{6}$/u;

/** Processor records as rendition inputs (the variant is the role). */
const renditionInputs = (
  records: readonly PublishingDerivativeRecord[],
): RenditionRecordInput[] =>
  records.map((record) => ({
    storageKey: record.storageKey,
    byteSize: record.byteSize,
    sha256: record.sha256,
    role: record.variant,
    editKey: record.editKey,
    contentType: record.contentType,
    width: record.width,
    height: record.height,
    durationMs: record.durationMs,
    recipeVersion: record.recipeVersion,
    recipeDigest: record.recipeDigest,
  }));

/** A placeholder colour to store: `undefined` keeps the stored value. */
const placeholderOf = (
  value: string | null | undefined,
): string | null | undefined => {
  if (value === undefined || value === null) return value;
  if (!PLACEHOLDER_COLOR.test(value))
    throw new TypeError("A placeholder colour is #rrggbb in lowercase hex");
  return value;
};

/** Records rendition blobs and rows of a locked item (see `recordRenditionRows`). */
const recordItemRenditions = (
  db: PublishingDb,
  item: { readonly id: string; readonly ownerId: string },
  records: readonly PublishingDerivativeRecord[],
  now: Date,
) =>
  recordRenditionRows(
    db,
    { kind: "item", id: item.id, ownerId: item.ownerId },
    renditionInputs(records),
    now,
  );

/** Ensures derivative jobs for the edits of every active draft that holds the item. */
const ensureHolderDerivatives = async (
  db: PublishingDb,
  itemId: string,
  now: Date,
): Promise<void> => {
  const drafts = await db.query<{
    owner_id: string;
    content: PublishingEditTarget;
  }>(
    `SELECT d.owner_id, d.content FROM community.media_item_refs r
     JOIN community.work_drafts d ON d.id=r.holder_id
     WHERE r.item_id=$1 AND r.holder_kind='draft' AND d.state='active' AND d.resolved_at IS NULL
     ORDER BY d.id`,
    [itemId],
  );
  for (const draft of drafts.rows)
    await ensureContentDerivatives(
      db,
      draft.owner_id,
      {
        items: draft.content.items.filter((item) => item.itemId === itemId),
        coverKey: draft.content.coverKey,
        coverCrop: draft.content.coverCrop,
      },
      now,
    );
};

const lockItemForWorker = async (
  db: PublishingDb,
  itemId: string,
): Promise<
  | {
      id: string;
      owner_id: string;
      kind: "static" | "live";
      state: string;
    }
  | undefined
> =>
  (
    await db.query<{
      id: string;
      owner_id: string;
      kind: "static" | "live";
      state: string;
    }>(
      "SELECT id,owner_id,kind,state FROM community.media_items WHERE id=$1 FOR UPDATE",
      [itemId],
    )
  ).rows[0];

/**
 * The outcome for a result the item can no longer take. Keys already
 * recorded are never handed back for removal, so a replayed result (a lost
 * response) cannot delete stored derivatives; a full replay onto an item in
 * `replayState` reads as recorded.
 */
const discardedUnlessReplayed = async (
  db: PublishingDb,
  item: { readonly state: string } | undefined,
  replayState: string | null,
  records: readonly PublishingDerivativeRecord[],
): Promise<PublishingDerivativeCommit> => {
  const storageKeys = await unrecordedKeys(db, records);
  return item !== undefined &&
    item.state === replayState &&
    storageKeys.length === 0
    ? { status: "recorded" }
    : { status: "discarded", storageKeys };
};

/** WorkPublishingPort.markItemReady */
export const markItemReady = async (
  pool: Pool,
  itemId: string,
  outcome: PublishingProcessedOutcome,
  now: Date,
): Promise<PublishingDerivativeCommit> => {
  const at = nowParam(now);
  return writeTransaction(pool, async (db) => {
    const item = await lockItemForWorker(db, itemId);
    if (item === undefined || item.state !== "processing")
      return discardedUnlessReplayed(db, item, "ready", outcome.derivatives);
    const placeholder = placeholderOf(outcome.placeholderColor);
    const { recordedBytes, duplicates } = await recordItemRenditions(
      db,
      { id: item.id, ownerId: item.owner_id },
      outcome.derivatives,
      now,
    );
    for (const detected of outcome.detectedTypes)
      await db.query(
        "UPDATE community.media_components SET detected_type=$3 WHERE item_id=$1 AND role=$2",
        [item.id, detected.role, detected.contentType],
      );
    await db.query(
      "UPDATE community.media_components SET state='verified', updated_at=$2::timestamptz WHERE item_id=$1 AND state='received'",
      [item.id, at],
    );
    const presentation = outcome.presentation;
    const publicFacts = {
      width: presentation.width,
      height: presentation.height,
      ...(item.kind === "live" && presentation.durationMs !== undefined
        ? { durationMs: presentation.durationMs }
        : {}),
      ...(item.kind === "live" && presentation.hasAudio !== undefined
        ? { hasAudio: presentation.hasAudio }
        : {}),
    };
    const serverFacts = {
      stillExifOrientation: outcome.stillExifOrientation,
      displayRotation: presentation.displayRotation ?? null,
    };
    await db.query(
      `UPDATE community.media_items
       SET state='ready', failure_code=NULL, ready_at=$2::timestamptz, updated_at=$2::timestamptz, version=version+1,
           presentation=$3::jsonb, pairing=$4::jsonb,
           private_metadata=COALESCE(private_metadata,'{}'::jsonb) || jsonb_build_object('server', $5::jsonb),
           placeholder_color=CASE WHEN $6::boolean THEN $7::text ELSE placeholder_color END
       WHERE id=$1`,
      [
        item.id,
        at,
        JSON.stringify(publicFacts),
        outcome.pairing === null ? null : JSON.stringify(outcome.pairing),
        JSON.stringify(serverFacts),
        placeholder !== undefined,
        placeholder ?? null,
      ],
    );
    await releaseReservations(db, [item.id], now);
    await adjustCapacity(db, item.owner_id, { committed: recordedBytes }, now);
    await ensureHolderDerivatives(db, item.id, now);
    return duplicates.length === 0
      ? { status: "recorded" }
      : { status: "discarded", storageKeys: duplicates };
  });
};

/** WorkPublishingPort.recordDerivatives */
export const recordDerivatives = async (
  pool: Pool,
  itemId: string,
  outcome: PublishingDerivedOutcome,
  now: Date,
): Promise<PublishingDerivativeCommit> =>
  writeTransaction(pool, async (db) => {
    const placeholder = placeholderOf(outcome.placeholderColor);
    if (
      placeholder !== undefined &&
      outcome.derivatives.some((record) => record.editKey !== "base")
    )
      throw new TypeError("A placeholder colour comes from the base edit only");
    const item = await lockItemForWorker(db, itemId);
    if (item === undefined || item.state !== "ready")
      return discardedUnlessReplayed(db, item, null, outcome.derivatives);
    const { recordedBytes, duplicates } = await recordItemRenditions(
      db,
      { id: item.id, ownerId: item.owner_id },
      outcome.derivatives,
      now,
    );
    if (placeholder !== undefined)
      await db.query(
        "UPDATE community.media_items SET placeholder_color=$2 WHERE id=$1",
        [item.id, placeholder],
      );
    await adjustCapacity(db, item.owner_id, { committed: recordedBytes }, now);
    return duplicates.length === 0
      ? { status: "recorded" }
      : { status: "discarded", storageKeys: duplicates };
  });

/** WorkPublishingPort.markItemFailed */
export const markItemFailed = async (
  pool: Pool,
  itemId: string,
  failureCode: MediaFailureCode,
  now: Date,
): Promise<void> => {
  const at = nowParam(now);
  await writeTransaction(pool, async (db) => {
    const item = await lockItemForWorker(db, itemId);
    if (item === undefined || item.state !== "processing") return;
    await db.query(
      "UPDATE community.media_items SET state='failed', failure_code=$2, updated_at=$3::timestamptz, version=version+1 WHERE id=$1",
      [item.id, failureCode, at],
    );
    await releaseReservations(db, [item.id], now);
  });
};

/** WorkPublishingPort.ensureEditDerivatives */
export const ensureEditDerivatives = async (
  pool: Pool,
  actorId: string,
  content: PublishingEditTarget,
  now: Date,
  options: PublishingEditReadinessOptions = {},
): Promise<PublishingEditReadiness> =>
  actorTransaction(pool, actorId, async (db) => {
    // An explicit readiness route names its holder: verified like an item
    // registration, before anything is enqueued.
    if (options.holder !== undefined)
      await lockHolder(db, actorId, options.holder, now);
    return ensureContentDerivatives(db, actorId, content, now);
  });
