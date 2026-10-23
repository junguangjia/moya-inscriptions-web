import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  catalogDeliveryReadinessSchema,
  catalogProcessingIntentSchema,
  type CatalogProcessingIntent,
} from "@moya/contracts/internal/editorial";

import { writeTransaction, nowParam, type PublishingDb } from "./db.js";
import { CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS } from "./catalog-snapshot-ceiling.js";

const terminal = (state: string) =>
  ["cancelled", "superseded", "expired", "withdrawn"].includes(state);

/** Private processing/reference pins never modify Catalog public references.
 * Call only with a complete CMS snapshot, in the same App transaction as the
 * one A∪B asset sync. A missing or truncated source must never call this method.
 *
 * One intent never fails the snapshot of every other intent and the asset sync:
 * - an intent the snapshot holds but cannot decode (`undecodableIntentIds`, or
 *   one that fails the schema here) is unknown, not absent: its local row is
 *   left as it is, so a decoder/view skew that breaks every intent loses no
 *   mirror state and recovers once it decodes again. It is granted nothing
 *   meanwhile (plans and fences read only decoded intents);
 * - a decoded intent whose snapshot disagrees with its immutable identity
 *   (document, revision, fingerprint, manifests, media, expires_at) and that
 *   is still live is mismatched: none of it is applied and its local row is
 *   left as it is, neither ended nor revived, as before for that intent
 *   alone. One that is over is refused instead (below): the snapshot says
 *   withdrawn, cancelled, superseded or expired, the stored row is already
 *   ended, or the stored row is prepared or release_requested and the
 *   earlier of the stored and the snapshot expiry has passed. The lease is
 *   read from the stored row, never from the contradicted snapshot's label,
 *   so a drift never keeps an ended mirror live and never ends a released
 *   one;
 * - a decoded intent that would revive or regress its local monotonic state
 *   (a release committed after this mirror already expired it, a
 *   state_version regression) is refused too: none of it is applied and its
 *   local row keeps or becomes a tombstone, exactly like an absent intent.
 * All three lists are returned for the caller's log.
 *
 * Only the mirror rows a pass can change are read: each snapshot intent's
 * row (a tombstone included, so it is never revived) and each row still
 * observed live (absence ends it). The stored members of every snapshot
 * intent are read in one query. Only the rows that change (a new or advanced
 * state, a new intent, an absent live one) are locked, by the one statement
 * of each kind that writes them, so a pass that changes nothing writes only
 * the watermark and blocks no readiness or release inspection
 * (catalog-scale-v1 W4). The bounds are the snapshot ceiling's (W3).
 */
export const synchronizeCatalogDeliveryIntents = async (
  db: PublishingDb,
  intents: readonly CatalogProcessingIntent[] | undefined,
  now: Date,
  undecodableIntentIds: readonly string[] = [],
): Promise<{
  readonly refused: readonly string[];
  readonly mismatched: readonly string[];
  readonly undecodable: readonly string[];
}> => {
  if (
    intents !== undefined &&
    (!Array.isArray(intents) ||
      intents.length > CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS)
  )
    throw new TypeError("Catalog intent snapshot exceeds its bound");
  if (
    !Array.isArray(undecodableIntentIds) ||
    undecodableIntentIds.length > CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS ||
    undecodableIntentIds.some((id) => typeof id !== "string")
  )
    throw new TypeError("Catalog undecodable intent list invalid");
  const rejected: string[] = [];
  const mismatched: string[] = [];
  const undecodable = new Set(undecodableIntentIds);
  const parsed = (intents ?? []).flatMap((intent) => {
    const result = catalogProcessingIntentSchema.safeParse(intent);
    if (result.success) return [result.data];
    const id = (intent as { intentId?: unknown } | null)?.intentId;
    if (typeof id === "string") undecodable.add(id);
    return [];
  });
  if (new Set(parsed.map(({ intentId }) => intentId)).size !== parsed.length)
    throw new TypeError("Catalog intent snapshot repeats an identity");
  const at = nowParam(now);
  // Serialize complete snapshots before taking any asset locks. Native/COS
  // publication authority is always checked live elsewhere, never from this
  // mirror or its observation time.
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('catalog-delivery-sync',0))",
  );
  const watermark = (
    await db.query<{ observed_at: Date }>(
      "SELECT observed_at FROM community.catalog_delivery_snapshot_watermark WHERE id=true FOR UPDATE",
    )
  ).rows[0];
  if (watermark && watermark.observed_at.getTime() >= now.getTime())
    throw new TypeError(
      "Catalog complete snapshot is not newer than the applied watermark",
    );
  await db.query(
    "INSERT INTO community.catalog_delivery_snapshot_watermark(id,observed_at) VALUES(true,$1::timestamptz) ON CONFLICT(id) DO UPDATE SET observed_at=EXCLUDED.observed_at",
    [at],
  );
  // Unconfigured/incomplete private source is not an authoritative empty set.
  if (intents === undefined)
    return { refused: [], mismatched: [], undecodable: [] };
  type Members = {
    ordinal: number;
    media_id: string;
    object_key: string;
    source_sha256: string;
    width: number;
    height: number;
  }[];
  // The observed-live rows and the snapshot's own intents, as two disjoint
  // reads (observed_live is NOT NULL): the first through A1's partial index,
  // the second by primary key, so neither reads the tombstones on either
  // PostgreSQL major. One `observed_live OR intent_id=ANY(…)` scan read the
  // whole history on PG16 (catalog-scale-v1 W6/W7).
  const existing = new Map(
    (
      await db.query<{
        intent_id: string;
        cms_document_id: number;
        catalog_id: string;
        draft_revision: number;
        draft_fingerprint: string;
        manifest_sha256: string;
        recipe_manifest_sha256: string;
        media_count: number;
        source_state: string;
        source_state_version: number;
        observed_live: boolean;
        expires_at: Date;
        observed_at: Date;
        ended_at: Date | null;
      }>(
        "SELECT * FROM community.catalog_delivery_prepares WHERE observed_live UNION ALL SELECT * FROM community.catalog_delivery_prepares WHERE intent_id=ANY($1::uuid[]) AND NOT observed_live ORDER BY intent_id",
        [parsed.map(({ intentId }) => intentId)],
      )
    ).rows.map((row) => [row.intent_id, row]),
  );
  const storedMembers = new Map<string, Members>();
  const withMembers = parsed
    .filter((intent) => existing.has(intent.intentId) && intent.media.length)
    .map(({ intentId }) => intentId);
  if (withMembers.length)
    for (const row of (
      await db.query<Members[number] & { intent_id: string }>(
        "SELECT intent_id,ordinal,media_id,object_key,source_sha256,width,height FROM community.catalog_delivery_media_refs WHERE intent_id=ANY($1::uuid[]) ORDER BY intent_id,ordinal",
        [withMembers],
      )
    ).rows) {
      const list = storedMembers.get(row.intent_id) ?? [];
      list.push({
        ordinal: row.ordinal,
        media_id: row.media_id,
        object_key: row.object_key,
        source_sha256: row.source_sha256,
        width: row.width,
        height: row.height,
      });
      storedMembers.set(row.intent_id, list);
    }
  const accepted: string[] = [];
  const advanced: { intentId: string; state: string; version: number }[] = [];
  const added: { intent: CatalogProcessingIntent; state: string }[] = [];
  const addedMembers: { intentId: string; members: Members }[] = [];
  for (const intent of [...parsed].sort((a, b) =>
    a.intentId.localeCompare(b.intentId),
  )) {
    const previous = existing.get(intent.intentId);
    const state =
      ["prepared", "release_requested"].includes(intent.state) &&
      new Date(intent.expiresAt).getTime() <= now.getTime()
        ? "expired"
        : intent.state;
    const members: Members = intent.media.map((item) => ({
      ordinal: item.ordinal,
      media_id: item.mediaId,
      object_key: item.objectKey,
      source_sha256: item.sourceSha256,
      width: item.width,
      height: item.height,
    }));
    const stored =
      previous && intent.media.length
        ? (storedMembers.get(intent.intentId) ?? [])
        : [];
    // A prepared identity (header and stored media) is immutable. A snapshot
    // that disagrees with it is skipped alone, before any lifecycle check:
    // none of it is applied. While the intent is live its local row is left
    // exactly as it is, like an undecodable intent's. Once it is over it is
    // refused and tombstoned like an absent intent: ending grants nothing.
    // Over: the snapshot says terminal, the stored row is ended, or the
    // stored row still holds a lease (prepared or release_requested) and
    // the earlier of both expiries has passed. The lease comes from the
    // stored row, so a contradicted `released` label never extends it and a
    // contradicted live label never ends a released mirror.
    if (
      previous &&
      (previous.cms_document_id !== intent.documentId ||
        previous.catalog_id !== intent.catalogId ||
        previous.draft_revision !== intent.revision ||
        previous.draft_fingerprint !== intent.fingerprint ||
        previous.manifest_sha256 !== intent.manifestSha256 ||
        previous.recipe_manifest_sha256 !== intent.recipeManifestSha256 ||
        previous.media_count !== intent.mediaCount ||
        previous.expires_at.toISOString() !== intent.expiresAt ||
        (stored.length > 0 &&
          JSON.stringify(stored) !== JSON.stringify(members)))
    ) {
      const over =
        terminal(intent.state) ||
        terminal(previous.source_state) ||
        (["prepared", "release_requested"].includes(previous.source_state) &&
          Math.min(
            previous.expires_at.getTime(),
            new Date(intent.expiresAt).getTime(),
          ) <= now.getTime());
      (over ? rejected : mismatched).push(intent.intentId);
      continue;
    }
    // A local tombstone is never revived or regressed. Such an intent is
    // refused alone: none of its snapshot is applied, and below it is
    // tombstoned like an absent intent.
    if (
      previous &&
      (intent.stateVersion < previous.source_state_version ||
        previous.observed_at.getTime() > now.getTime() ||
        ((!previous.observed_live || terminal(previous.source_state)) &&
          !terminal(state)) ||
        (intent.stateVersion === previous.source_state_version &&
          state !== previous.source_state &&
          !(
            state === "expired" &&
            ["prepared", "release_requested"].includes(previous.source_state)
          )))
    ) {
      rejected.push(intent.intentId);
      continue;
    }
    // An unchanged row (same state and version, and ended once terminal) is
    // neither locked nor written: only what changes is.
    if (
      previous &&
      (state !== previous.source_state ||
        intent.stateVersion !== previous.source_state_version ||
        (terminal(state) && !previous.ended_at))
    )
      advanced.push({
        intentId: intent.intentId,
        state,
        version: intent.stateVersion,
      });
    if (!previous) added.push({ intent, state });
    if (intent.media.length && !stored.length)
      addedMembers.push({ intentId: intent.intentId, members });
    accepted.push(intent.intentId);
  }
  // Each statement below locks only the rows it changes; the sync is the
  // only writer of these rows, and the advisory lock above serializes it.
  if (advanced.length)
    await db.query(
      `UPDATE community.catalog_delivery_prepares p
      SET source_state=c.state,source_state_version=c.version,observed_at=$5::timestamptz,
        ended_at=CASE WHEN c.ended THEN COALESCE(p.ended_at,$5::timestamptz) ELSE p.ended_at END,
        updated_at=$5::timestamptz
      FROM unnest($1::uuid[],$2::text[],$3::integer[],$4::boolean[]) AS c(intent_id,state,version,ended)
      WHERE p.intent_id=c.intent_id`,
      [
        advanced.map(({ intentId }) => intentId),
        advanced.map(({ state }) => state),
        advanced.map(({ version }) => version),
        advanced.map(({ state }) => terminal(state)),
        at,
      ],
    );
  if (added.length)
    await db.query(
      `INSERT INTO community.catalog_delivery_prepares
      (intent_id,cms_document_id,catalog_id,draft_revision,draft_fingerprint,manifest_sha256,
       recipe_manifest_sha256,media_count,source_state,source_state_version,expires_at,observed_at,
       ended_at,created_at,updated_at)
      SELECT c.intent_id,c.document_id,c.catalog_id,c.revision,c.fingerprint,c.manifest,
        c.recipe,c.media_count,c.state,c.version,c.expires_at,$13::timestamptz,
        CASE WHEN c.ended THEN $13::timestamptz ELSE NULL END,$13::timestamptz,$13::timestamptz
      FROM unnest($1::uuid[],$2::integer[],$3::text[],$4::integer[],$5::text[],$6::text[],
        $7::text[],$8::integer[],$9::text[],$10::integer[],$11::timestamptz[],$12::boolean[])
        AS c(intent_id,document_id,catalog_id,revision,fingerprint,manifest,recipe,media_count,
          state,version,expires_at,ended)`,
      [
        added.map(({ intent }) => intent.intentId),
        added.map(({ intent }) => intent.documentId),
        added.map(({ intent }) => intent.catalogId),
        added.map(({ intent }) => intent.revision),
        added.map(({ intent }) => intent.fingerprint),
        added.map(({ intent }) => intent.manifestSha256),
        added.map(({ intent }) => intent.recipeManifestSha256),
        added.map(({ intent }) => intent.mediaCount),
        added.map(({ state }) => state),
        added.map(({ intent }) => intent.stateVersion),
        added.map(({ intent }) => intent.expiresAt),
        added.map(({ state }) => terminal(state)),
        at,
      ],
    );
  if (addedMembers.length) {
    const rows = addedMembers.flatMap(({ intentId, members }) =>
      members.map((member) => ({ intentId, ...member })),
    );
    await db.query(
      `INSERT INTO community.catalog_delivery_media_refs
      (intent_id,ordinal,media_id,object_key,source_sha256,width,height)
      SELECT * FROM unnest($1::uuid[],$2::integer[],$3::text[],$4::text[],$5::text[],
        $6::integer[],$7::integer[])`,
      [
        rows.map((row) => row.intentId),
        rows.map((row) => row.ordinal),
        rows.map((row) => row.media_id),
        rows.map((row) => row.object_key),
        rows.map((row) => row.source_sha256),
        rows.map((row) => row.width),
        rows.map((row) => row.height),
      ],
    );
  }
  // Absence from a complete authoritative snapshot is a local monotonic
  // tombstone, not a fabricated CMS state or permission with a freshness TTL.
  // A refused intent is treated exactly as absent (fail closed); a mismatched
  // one is present, and an undecodable one is present but unknown, so their
  // rows are left untouched (undecodable compared as text: its ID itself was
  // never decoded).
  await db.query(
    `UPDATE community.catalog_delivery_prepares
    SET observed_live=false,observed_at=$2::timestamptz,ended_at=COALESCE(ended_at,$2::timestamptz),updated_at=$2::timestamptz
    WHERE observed_live AND observed_at <= $2::timestamptz AND NOT(intent_id=ANY($1::uuid[]))
      AND NOT(intent_id::text=ANY($3::text[]))`,
    [
      [...accepted, ...mismatched],
      at,
      [...undecodable].map((id) => id.toLowerCase()),
    ],
  );
  return {
    refused: rejected.sort(),
    mismatched: mismatched.sort(),
    undecodable: [...undecodable].sort(),
  };
};

/** SQL aliases are fixed by repository callers, never HTTP input. */
export const catalogPrivateProcessingReferenceSql = (
  asset: string,
  at = "now()",
) => `EXISTS (
  SELECT 1 FROM community.catalog_delivery_media_refs pr
  JOIN community.catalog_delivery_prepares pi ON pi.intent_id=pr.intent_id
  WHERE pr.asset_id=${asset} AND pi.observed_live AND pi.ended_at IS NULL
    AND pi.source_state IN ('prepared','release_requested') AND pi.expires_at>${at}
)`;

/** Retain exact prepared bytes independently of rendition replacement. */
export const catalogPreparedBlobPinSql = (
  blob: string,
  at = "now()",
) => `EXISTS (
  SELECT 1 FROM community.catalog_delivery_rendition_pins pp
  JOIN community.catalog_delivery_prepares pi ON pi.intent_id=pp.intent_id
  JOIN community.media_renditions rr ON rr.id=pp.rendition_id
  WHERE rr.blob_id=${blob} AND pi.observed_live AND pi.ended_at IS NULL
    AND (pi.source_state='released' OR (pi.source_state IN ('prepared','release_requested') AND pi.expires_at>${at}))
)`;

/** Decode the complete least-privilege CMS projection. A terminal header is
 * retained with no members; it must not be confused with missing/truncated rows.
 * With `rejected`, an intent whose own rows do not decode is listed there and
 * left out instead of failing the call.
 */
const decodeCatalogPrepareRows = (
  rows: readonly Record<string, unknown>[],
  rejected: string[] | null,
): CatalogProcessingIntent[] => {
  if (rows.length > CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS)
    throw new TypeError("Catalog private source exceeds its bound");
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    if (typeof row.intent_id !== "string")
      throw new TypeError("Catalog private source identity invalid");
    const list = groups.get(row.intent_id) ?? [];
    list.push(row);
    groups.set(row.intent_id, list);
  }
  const decode = (group: Record<string, unknown>[]) => {
    const first = group[0]!;
    const identity = (r: Record<string, unknown>) => [
      r.intent_id,
      r.catalog_document_id,
      r.catalog_id,
      r.draft_revision,
      r.draft_fingerprint,
      r.media_manifest_sha256,
      r.recipe_manifest_sha256,
      r.state,
      r.state_version,
      r.media_count,
      String(r.expires_at),
    ];
    if (
      group.some(
        (r) => JSON.stringify(identity(r)) !== JSON.stringify(identity(first)),
      )
    )
      throw new TypeError("Catalog private source has inconsistent headers");
    const media = group
      .filter((r) => r.media_ordinal !== null)
      .map((r) => ({
        ordinal: r.media_ordinal,
        mediaId: r.media_id,
        objectKey: r.object_key,
        sourceSha256: r.source_sha256,
        width: r.width,
        height: r.height,
      }));
    if (
      !media.length &&
      (group.length !== 1 ||
        ["media_id", "object_key", "source_sha256", "width", "height"].some(
          (key) => first[key] !== null,
        ))
    )
      throw new TypeError("Catalog private source empty header is incomplete");
    return catalogProcessingIntentSchema.parse({
      intentId: first.intent_id,
      documentId: first.catalog_document_id,
      catalogId: first.catalog_id,
      revision: first.draft_revision,
      fingerprint: first.draft_fingerprint,
      manifestSha256: first.media_manifest_sha256,
      recipeManifestSha256: first.recipe_manifest_sha256,
      state: first.state,
      stateVersion: first.state_version,
      mediaCount: first.media_count,
      media,
      expiresAt: new Date(first.expires_at as string).toISOString(),
    });
  };
  const intents: CatalogProcessingIntent[] = [];
  for (const [intentId, group] of groups)
    if (!rejected) intents.push(decode(group));
    else
      try {
        intents.push(decode(group));
      } catch {
        rejected.push(intentId);
      }
  return intents;
};

/** Strict: any intent that does not decode fails the call (one exact intent). */
export const parseCatalogPrepareRows = (
  rows: readonly Record<string, unknown>[],
): CatalogProcessingIntent[] => decodeCatalogPrepareRows(rows, null);

/** For a complete snapshot of every intent: an intent whose own rows do not
 * decode (for example a source edge beyond the 65,535 px snapshot bound) is
 * returned by ID and left out, instead of failing the sync, every plan and
 * reconcile for all other intents. It is granted nothing, and its App mirror
 * row is left untouched rather than tombstoned (see
 * synchronizeCatalogDeliveryIntents). A malformed or oversized result as a
 * whole still throws.
 */
export const partitionCatalogPrepareRows = (
  rows: readonly Record<string, unknown>[],
) => {
  const undecodableIntentIds: string[] = [];
  const intents = decodeCatalogPrepareRows(rows, undecodableIntentIds);
  return { intents, undecodableIntentIds };
};

/** Pin only real committed rows, after checking the full conditional plan.
 * Reads/status never download originals or manufacture ready facts. The only
 * writes are immutable exact rendition pins and one-way generation pins.
 */
export const inspectCatalogDelivery = async (
  pool: Pool,
  intent: CatalogProcessingIntent,
  policySha: string,
  expected: (
    width: number,
    height: number,
  ) => readonly {
    role: string;
    version: number;
    digest: string;
    width: number;
    height: number;
  }[],
) => {
  if (intent.recipeManifestSha256 !== policySha)
    throw new TypeError("Catalog prepared recipe is no longer current");
  return writeTransaction(pool, async (db) => {
    const header = (
      await db.query(
        "SELECT * FROM community.catalog_delivery_prepares WHERE intent_id=$1 FOR SHARE",
        [intent.intentId],
      )
    ).rows[0];
    const live =
      ["prepared", "release_requested", "released"].includes(intent.state) &&
      (intent.state === "released" ||
        new Date(intent.expiresAt).getTime() > Date.now());
    let privateReady =
      live &&
      !!header &&
      header.manifest_sha256 === intent.manifestSha256 &&
      header.recipe_manifest_sha256 === policySha &&
      header.media_count === intent.mediaCount &&
      header.observed_live &&
      header.ended_at === null;
    let publicReady =
      privateReady && ["release_requested", "released"].includes(intent.state);
    if (!privateReady)
      return catalogDeliveryReadinessSchema.parse({
        intentId: intent.intentId,
        manifestSha256: intent.manifestSha256,
        recipeManifestSha256: policySha,
        stateVersion: intent.stateVersion,
        mediaCount: intent.mediaCount,
        privateReady: false,
        publicReady: false,
        proofSha256: createHash("sha256")
          .update(
            JSON.stringify([
              intent.intentId,
              intent.manifestSha256,
              policySha,
              "PENDING",
            ]),
          )
          .digest("hex"),
      });
    const proof: unknown[] = [];
    // Same sorted asset lock order as render recording. Rows cannot be
    // replaced between checking ready facts and inserting their immutable pin.
    await db.query(
      `SELECT a.id FROM community.catalog_media_assets a
      JOIN jsonb_to_recordset($1::jsonb) m("mediaId" text,"objectKey" text)
      ON a.media_id=m."mediaId" AND a.source_object_key=m."objectKey"
      ORDER BY a.id FOR SHARE OF a`,
      [JSON.stringify(intent.media)],
    );
    for (const media of intent.media) {
      const asset = (
        await db.query(
          "SELECT * FROM community.catalog_media_assets WHERE media_id=$1 AND source_object_key=$2",
          [media.mediaId, media.objectKey],
        )
      ).rows[0];
      if (
        !asset ||
        asset.state !== "ready" ||
        asset.master_sha256 !== media.sourceSha256 ||
        !asset.master_width ||
        !asset.master_height
      ) {
        privateReady = false;
        publicReady = false;
        continue;
      }
      const plan = expected(asset.master_width, asset.master_height);
      if (!plan.length) {
        privateReady = false;
        publicReady = false;
        continue;
      }
      const actual = (
        await db.query(
          `SELECT r.id,r.role,r.recipe_version,r.recipe_digest,r.width,r.height,b.id AS blob_id,b.sha256,b.byte_size,b.storage_key
        FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
        WHERE r.catalog_asset_id=$1 AND r.state='ready' AND r.edit_key='base' AND r.content_type='image/webp'
        ORDER BY r.id FOR SHARE OF r,b`,
          [asset.id],
        )
      ).rows;
      for (const want of plan) {
        const rows = actual.filter(
          (r) =>
            r.role === want.role &&
            r.recipe_version === want.version &&
            r.recipe_digest === want.digest &&
            r.width === want.width &&
            r.height === want.height,
        );
        if (rows.length !== 1) {
          privateReady = false;
          publicReady = false;
          continue;
        }
        const row = rows[0]!;
        const generations = (
          await db.query(
            `SELECT p.* FROM community.media_publications p WHERE p.rendition_id=$1 ORDER BY p.id FOR SHARE`,
            [row.id],
          )
        ).rows.filter(
          (p) =>
            p.state === "published" &&
            p.sha256 === row.sha256 &&
            String(p.byte_size) === String(row.byte_size) &&
            p.storage_key === row.storage_key &&
            p.content_type === "image/webp" &&
            p.purpose === "catalog_derivative",
        );
        const generation =
          generations.length === 1 ? generations[0] : undefined;
        row.generation_id = generation?.id ?? null;
        row.generation_version = generation ? String(generation.version) : null;
        await db.query(
          `INSERT INTO community.catalog_delivery_rendition_pins(intent_id,ordinal,role,rendition_id,recipe_version,recipe_digest,created_at)
          VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(intent_id,ordinal,role) DO NOTHING`,
          [
            intent.intentId,
            media.ordinal,
            want.role,
            row.id,
            want.version,
            want.digest,
          ],
        );
        const pin = (
          await db.query(
            "SELECT * FROM community.catalog_delivery_rendition_pins WHERE intent_id=$1 AND ordinal=$2 AND role=$3",
            [intent.intentId, media.ordinal, want.role],
          )
        ).rows[0]!;
        if (
          pin.rendition_id !== row.id ||
          pin.recipe_version !== want.version ||
          pin.recipe_digest !== want.digest
        ) {
          privateReady = false;
          publicReady = false;
          continue;
        }
        if (!row.generation_id) publicReady = false;
        else {
          await db.query(
            `UPDATE community.catalog_delivery_rendition_pins SET public_generation_id=$4,public_generation_version=$5::bigint
            WHERE intent_id=$1 AND ordinal=$2 AND role=$3 AND public_generation_id IS NULL`,
            [
              intent.intentId,
              media.ordinal,
              want.role,
              row.generation_id,
              row.generation_version,
            ],
          );
          if (
            pin.public_generation_id &&
            (pin.public_generation_id !== row.generation_id ||
              String(pin.public_generation_version) !== row.generation_version)
          )
            publicReady = false;
        }
        proof.push([
          media.ordinal,
          media.mediaId,
          media.objectKey,
          media.sourceSha256,
          want,
          row.id,
          row.blob_id,
          row.sha256,
          String(row.byte_size),
          row.generation_id,
          row.generation_version,
        ]);
      }
    }
    // Empty manifests are a genuine complete set, not a missing header.
    if (intent.media.length !== intent.mediaCount) {
      privateReady = false;
      publicReady = false;
    }
    const proofSha256 = createHash("sha256")
      .update(
        JSON.stringify([
          intent.intentId,
          intent.manifestSha256,
          policySha,
          proof,
        ]),
      )
      .digest("hex");
    return catalogDeliveryReadinessSchema.parse({
      intentId: intent.intentId,
      manifestSha256: intent.manifestSha256,
      recipeManifestSha256: policySha,
      stateVersion: intent.stateVersion,
      mediaCount: intent.mediaCount,
      privateReady,
      publicReady: privateReady && publicReady,
      proofSha256,
    });
  });
};

/** Join App facts for exact live-CMS pairs; no CMS tables are presumed to
 * exist in App. Editorial images require the complete real published set: the
 * approved pinned set, else the current recipe's set. Until the current
 * recipe's set is complete and published (a recipe version bump re-renders at
 * a bounded rate, and recording the new set releases the old rows before the
 * new ones are copied), the previous published set keeps serving for every
 * role, never the image disappearing nor a mix of both sets; all roles switch
 * together, and the publication reconcile retires the previous set only after
 * its replacement is published (createCatalogPublicationAuthority plans).
 */
export const readCatalogDeliveryProjection = async (
  pool: Pool,
  pairs: readonly { mediaId: string; objectKey: string }[],
  expected: (
    width: number,
    height: number,
  ) => readonly {
    role: string;
    version: number;
    digest: string;
    width: number;
    height: number;
  }[],
) => {
  if (pairs.length > 10000)
    throw new TypeError("Catalog delivery batch too large");
  // A detail read includes both its gallery and its representative image.
  // Query each logical source once so a repeated locator cannot multiply a
  // complete rendition family and fail its per-role uniqueness checks.
  const sources = [
    ...new Map(
      pairs.map((pair) => [
        JSON.stringify([pair.mediaId, pair.objectKey]),
        pair,
      ]),
    ).values(),
  ];
  const rows = (
    await pool.query(
      `SELECT a.*,r.id AS rendition_id,r.state AS rendition_state,r.created_at AS rendition_created_at,COALESCE(r.superseded_at,r.released_at) AS rendition_replaced_at,r.role,r.recipe_version,r.recipe_digest,r.width,r.height,r.content_type,
    b.id AS blob_id,p.id AS generation_id,approved.intent_id AS approved_intent,approved.draft_revision AS approved_revision,approved.source_state AS approved_state FROM jsonb_to_recordset($1::jsonb) AS pair("mediaId" text,"objectKey" text)
    JOIN community.catalog_media_assets a ON a.media_id=pair."mediaId" AND a.source_object_key=pair."objectKey" AND a.state='ready'
    JOIN community.media_renditions r ON r.catalog_asset_id=a.id AND r.edit_key='base'
    JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed' AND b.content_type=r.content_type
    JOIN community.media_publications p ON p.rendition_id=r.id AND p.state='published' AND p.sha256=b.sha256
      AND p.byte_size=b.byte_size AND p.storage_key=b.storage_key AND p.content_type=r.content_type AND p.purpose='catalog_derivative'
    LEFT JOIN LATERAL (SELECT pi.intent_id,pi.draft_revision,pi.source_state FROM community.catalog_delivery_rendition_pins pp JOIN community.catalog_delivery_prepares pi ON pi.intent_id=pp.intent_id WHERE pp.rendition_id=r.id AND pp.public_generation_id=p.id AND pp.public_generation_version=p.version AND pi.observed_live AND pi.ended_at IS NULL AND pi.source_state IN ('release_requested','released') ORDER BY (pi.source_state='released') DESC,pi.draft_revision DESC LIMIT 1) approved ON true
    WHERE r.state='ready' OR approved.intent_id IS NOT NULL
      OR (a.source_object_key LIKE 'editorial/%' AND r.role IN ('thumb','cover','display','viewer'))
    ORDER BY a.media_id,a.source_object_key,r.width,r.height`,
      [JSON.stringify(sources)],
    )
  ).rows;
  const result = new Map<
    string,
    Pick<
      import("@moya/api").CatalogMediaProjection,
      "renditions" | "placeholderColor"
    >
  >();
  for (const pair of sources) {
    const matches = rows.filter(
      (row) =>
        row.media_id === pair.mediaId &&
        row.source_object_key === pair.objectKey,
    );
    if (!matches.length) continue;
    const asset = matches[0]!;
    // Ready or approved-pinned rows; a released or superseded editorial row
    // that is still published only ever serves the last published set below.
    const recorded = matches.filter(
      (row) => row.rendition_state === "ready" || row.approved_intent,
    );
    let ready = recorded;
    if (pair.objectKey.startsWith("editorial/")) {
      if (
        asset.master_sha256 !== asset.source_sha256 ||
        !asset.master_width ||
        !asset.master_height
      )
        continue;
      const approvals = recorded
        .filter((row) => row.approved_intent)
        .sort(
          (a, b) =>
            Number(b.approved_state === "released") -
              Number(a.approved_state === "released") ||
            Number(b.approved_revision) - Number(a.approved_revision),
        );
      const approved = approvals[0]
        ? approvals.filter(
            (row) => row.approved_intent === approvals[0]!.approved_intent,
          )
        : [];
      const approvedRoles = new Set(approved.map((row) => row.role));
      if (
        approved.length === approvedRoles.size &&
        approved.length >= 3 &&
        approved.length <= 4 &&
        ["thumb", "cover", "display"].every((role) =>
          approvedRoles.has(role),
        ) &&
        approved.every((row) =>
          ["thumb", "cover", "display", "viewer"].includes(row.role),
        )
      )
        ready = approved;
      else {
        const plan = expected(asset.master_width, asset.master_height);
        if (!plan.length) continue;
        if (
          plan.every(
            (want) =>
              recorded.filter(
                (row) =>
                  row.role === want.role &&
                  row.recipe_version === want.version &&
                  row.recipe_digest === want.digest &&
                  row.width === want.width &&
                  row.height === want.height,
              ).length === 1,
          )
        )
          ready = recorded.filter((row) =>
            plan.some(
              (want) =>
                row.role === want.role &&
                row.recipe_version === want.version &&
                row.recipe_digest === want.digest &&
                row.width === want.width &&
                row.height === want.height,
            ),
          );
        else {
          // The previous complete published set, for every role at once:
          // each slot's rendition as it stood just before the earliest
          // replacement that is still published. Recording a re-render
          // releases a slot's ready rendition and inserts its successor in one
          // transaction (same instant), and reconcile keeps every replaced
          // rendition published until the current set is. A successor, even
          // one reconcile already published, is never served beside it; all
          // roles switch together above. With no replacement live, it is each
          // slot's ready rendition. Thumb, cover and display, viewer when it
          // has one.
          const time = (value: unknown) =>
            new Date(value as string | Date).getTime();
          const roles = ["thumb", "cover", "display", "viewer"];
          const replaced = matches
            .filter(
              (row) =>
                row.rendition_state !== "ready" && roles.includes(row.role),
            )
            .map((row) => time(row.rendition_replaced_at));
          const before = replaced.length ? Math.min(...replaced) : Infinity;
          const previous: typeof matches = [];
          for (const role of roles) {
            // At most one per slot at any instant (the ready-slot unique
            // index). Should two qualify, the earlier recorded one is kept,
            // deterministically, instead of dropping the image.
            const [chosen] = matches
              .filter(
                (row) =>
                  row.role === role &&
                  time(row.rendition_created_at) < before &&
                  (row.rendition_state === "ready" ||
                    time(row.rendition_replaced_at) >= before),
              )
              .sort(
                (a, b) =>
                  time(a.rendition_created_at) - time(b.rendition_created_at) ||
                  Number(a.recipe_version) - Number(b.recipe_version) ||
                  String(a.rendition_id).localeCompare(String(b.rendition_id)),
              );
            if (chosen) previous.push(chosen);
          }
          if (
            !["thumb", "cover", "display"].every((role) =>
              previous.some((row) => row.role === role),
            )
          )
            continue;
          ready = previous;
        }
      }
    }
    const renditions = ready
      .filter(
        (row) =>
          ["thumb", "cover", "display", "viewer", "full"].includes(row.role) &&
          row.content_type === "image/webp",
      )
      .map((row) => ({
        key: row.rendition_id as string,
        width: row.width as number,
        height: row.height as number,
        contentType: "image/webp" as const,
        level:
          row.role === "display"
            ? ("display" as const)
            : ["viewer", "full"].includes(row.role)
              ? ("zoom" as const)
              : ("card" as const),
      }));
    result.set(JSON.stringify([pair.mediaId, pair.objectKey]), {
      renditions,
      ...(asset.placeholder_color
        ? { placeholderColor: asset.placeholder_color as string }
        : {}),
    });
  }
  return result;
};
