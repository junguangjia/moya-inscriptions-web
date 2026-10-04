-- unified-media-pipeline-v1, increment 1 (Owner instruction: unified media
-- pipeline, 2026-10-04): one rendition table for media items and Catalog
-- assets, the Catalog asset identity, the placeholder colour asset fact, the
-- task retention hold on blobs and the Catalog rendition job kind.
-- Forward-only: earlier files and their ledger rows stay untouched.
--
-- Every community.media_derivatives row is copied into
-- community.media_renditions with the same item, variant (now role), edit
-- key, blob, dimensions, duration, content type and creation time, and is
-- adopted as its role's recipe version 1: the stored bytes are exactly what
-- recipe version 1 produces, so nothing is re-rendered. The literal digests
-- below equal RECIPE_DIGESTS_V1 of the one recipe registry,
-- services/backend-production/src/publishing/processing/recipes.ts, which a
-- unit test recomputes and compares with this file. The old
-- table and its grants stay unchanged; no code reads or writes it any more,
-- and it is retained until the recorded D7 follow-up. Nothing is deleted.
--
-- Deploy order: stop the Backend and the media worker, take and verify the
-- database backup, apply this migration, re-apply the runtime grants, then
-- start the build that reads community.media_renditions.

-- Every ALTER below needs ACCESS EXCLUSIVE; take it at once, never upgraded,
-- so a writer left running waits here instead of deadlocking midway.
-- The old table only has to stop changing while it is copied.
LOCK TABLE community.media_items, community.media_blobs, community.publishing_jobs
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE community.media_derivatives IN SHARE MODE;

-- Catalog renditions are recorded blobs without an account owner in the same
-- private store namespace, so the store reconciler keeps them and no capacity
-- ever counts them. retention_hold marks pre-task bytes that a task-initiated
-- change (a superseded rendition) would otherwise let the purge delete
-- before the D7 follow-up: a held blob stays committed and recorded, and no
-- garbage-collection purge removes it from the store (an author's own item
-- purge still does, as before this task).
ALTER TABLE community.media_blobs
  ALTER COLUMN owner_id DROP NOT NULL,
  ADD COLUMN retention_hold TEXT,
  DROP CONSTRAINT media_blobs_purpose_valid,
  ADD CONSTRAINT media_blobs_purpose_valid CHECK (
    purpose IN ('original', 'standard_master', 'derivative', 'catalog_derivative')
  ),
  ADD CONSTRAINT media_blobs_owner_matches_purpose CHECK (
    (purpose = 'catalog_derivative') = (owner_id IS NULL)
  ),
  ADD CONSTRAINT media_blobs_retention_hold_valid CHECK (
    retention_hold IS NULL OR retention_hold IN ('d7_pre_task')
  ),
  ADD CONSTRAINT media_blobs_retention_hold_committed CHECK (
    retention_hold IS NULL OR state = 'committed'
  );

-- Mean colour of the base-edit thumb, NULL when the image is not opaque.
ALTER TABLE community.media_items
  ADD COLUMN placeholder_color TEXT,
  ADD CONSTRAINT media_items_placeholder_color_valid CHECK (
    placeholder_color IS NULL OR placeholder_color ~ '^#[0-9a-f]{6}$'
  );

-- One published Catalog source identity: the Payload media id and the exact
-- approved object key the published projection names. Both approved key
-- forms embed the SHA-256 of the object bytes, which the worker verifies.
-- Keys are never renamed, written or deleted by the pipeline; a new key is a
-- new asset. No owner and no capacity. unreferenced_since is set while the
-- published projection no longer names the pair.
CREATE TABLE community.catalog_media_assets (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  source_object_key TEXT NOT NULL,
  source_sha256 TEXT,
  source_width INTEGER,
  source_height INTEGER,
  source_content_type TEXT,
  master_sha256 TEXT,
  master_width INTEGER,
  master_height INTEGER,
  placeholder_color TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  failure_code TEXT,
  unreferenced_since TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT catalog_media_assets_id_derived CHECK (
    id = 'catalog-asset-' || md5(media_id || ':' || source_object_key)
  ),
  CONSTRAINT catalog_media_assets_identity_unique UNIQUE (media_id, source_object_key),
  CONSTRAINT catalog_media_assets_media_id_bounded CHECK (
    char_length(media_id) BETWEEN 1 AND 128 AND media_id !~ '[[:space:]]'
  ),
  CONSTRAINT catalog_media_assets_source_key_approved CHECK (
    source_object_key ~ '^display/v1/media_[a-f0-9]{32}/[a-f0-9]{64}\.webp$'
    OR source_object_key ~ '^editorial/[a-f0-9]{64}/[a-f0-9]{64}-[a-f0-9]{64}\.(jpg|png|webp)$'
  ),
  -- The byte hash both approved key forms embed.
  CONSTRAINT catalog_media_assets_source_sha256_bound CHECK (
    source_sha256 IS NULL
    OR source_sha256 = COALESCE(
      substring(source_object_key FROM '^display/v1/media_[a-f0-9]{32}/([a-f0-9]{64})\.webp$'),
      substring(source_object_key FROM '^editorial/[a-f0-9]{64}/[a-f0-9]{64}-([a-f0-9]{64})\.(?:jpg|png|webp)$')
    )
  ),
  CONSTRAINT catalog_media_assets_source_dimensions_bounded CHECK (
    (source_width IS NULL) = (source_height IS NULL)
    AND (source_width IS NULL OR (
      source_width BETWEEN 1 AND 65535 AND source_height BETWEEN 1 AND 65535
    ))
  ),
  CONSTRAINT catalog_media_assets_source_type_valid CHECK (
    source_content_type IS NULL
    OR source_content_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  CONSTRAINT catalog_media_assets_master_sha256_valid CHECK (
    master_sha256 IS NULL OR master_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT catalog_media_assets_master_dimensions_bounded CHECK (
    (master_width IS NULL) = (master_height IS NULL)
    AND (master_width IS NULL OR (
      master_width BETWEEN 1 AND 65535 AND master_height BETWEEN 1 AND 65535
    ))
  ),
  CONSTRAINT catalog_media_assets_placeholder_color_valid CHECK (
    placeholder_color IS NULL OR placeholder_color ~ '^#[0-9a-f]{6}$'
  ),
  CONSTRAINT catalog_media_assets_state_valid CHECK (
    state IN ('pending', 'ready', 'failed')
  ),
  CONSTRAINT catalog_media_assets_ready_facts CHECK (
    state <> 'ready' OR (master_sha256 IS NOT NULL AND master_width IS NOT NULL)
  ),
  -- Content-free code only; never a message, key or path.
  CONSTRAINT catalog_media_assets_failure_code_valid CHECK (
    (state = 'failed') = (failure_code IS NOT NULL)
    AND (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{0,63}$')
  )
);

-- One stored, versioned transformation of one subject: a media item for one
-- edit key, or a Catalog asset (always unedited). A rendition is never
-- overwritten: 'ready' rows are the current rendition of their slot,
-- 'superseded' rows were replaced by a newer recipe version and keep their
-- pre-task bytes held (never served), 'released' rows are no longer needed
-- (a replaced task-created rendition is released at once).
CREATE TABLE community.media_renditions (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES community.media_items (id),
  catalog_asset_id TEXT REFERENCES community.catalog_media_assets (id),
  edit_key TEXT NOT NULL,
  role TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  recipe_digest TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES community.media_blobs (id),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  duration_ms INTEGER,
  content_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  CONSTRAINT media_renditions_id_opaque CHECK (
    id ~ '^media-rendition-[0-9a-f]{32}$'
  ),
  CONSTRAINT media_renditions_one_subject CHECK (
    num_nonnulls(item_id, catalog_asset_id) = 1
  ),
  CONSTRAINT media_renditions_edit_key_valid CHECK (
    edit_key = 'base' OR edit_key ~ '^[0-9a-f]{32}$'
  ),
  CONSTRAINT media_renditions_catalog_unedited CHECK (
    catalog_asset_id IS NULL OR edit_key = 'base'
  ),
  CONSTRAINT media_renditions_role_valid CHECK (
    role IN ('thumb', 'cover', 'display', 'viewer', 'full', 'motion')
  ),
  CONSTRAINT media_renditions_motion_item_only CHECK (
    role <> 'motion' OR item_id IS NOT NULL
  ),
  CONSTRAINT media_renditions_recipe_version_positive CHECK (recipe_version >= 1),
  CONSTRAINT media_renditions_recipe_digest_valid CHECK (
    recipe_digest ~ '^[0-9a-f]{16}$'
  ),
  -- A blob holds the bytes of exactly one rendition.
  CONSTRAINT media_renditions_blob_unique UNIQUE (blob_id),
  -- WebP's format limit; every recipe bound stays at or below 16,000.
  CONSTRAINT media_renditions_dimensions_bounded CHECK (
    width BETWEEN 1 AND 16383 AND height BETWEEN 1 AND 16383
  ),
  CONSTRAINT media_renditions_duration_positive CHECK (
    duration_ms IS NULL OR duration_ms > 0
  ),
  CONSTRAINT media_renditions_content_type_bounded CHECK (
    content_type ~ '^[a-z]+/[a-z0-9.+-]{1,64}$'
  ),
  CONSTRAINT media_renditions_state_valid CHECK (
    state IN ('ready', 'superseded', 'released')
  ),
  -- A released row keeps superseded_at when it was superseded first.
  CONSTRAINT media_renditions_state_times CHECK (
    (state = 'ready' AND superseded_at IS NULL AND released_at IS NULL)
    OR (state = 'superseded' AND superseded_at IS NOT NULL AND released_at IS NULL)
    OR (state = 'released' AND released_at IS NOT NULL)
  )
);

-- Current slot: at most one ready row per item, edit key and role (the former
-- media_derivatives primary key), and per Catalog asset and role.
CREATE UNIQUE INDEX media_renditions_item_ready_unique
  ON community.media_renditions (item_id, edit_key, role)
  WHERE state = 'ready' AND item_id IS NOT NULL;
CREATE UNIQUE INDEX media_renditions_catalog_ready_unique
  ON community.media_renditions (catalog_asset_id, role)
  WHERE state = 'ready' AND catalog_asset_id IS NOT NULL;
CREATE INDEX media_renditions_item_edit_idx
  ON community.media_renditions (item_id, edit_key);
CREATE INDEX media_renditions_catalog_asset_idx
  ON community.media_renditions (catalog_asset_id);

-- Row-for-row copy, adopted as recipe version 1 of each role. The id is the
-- md5 of the old primary key, so a rollback can name every adopted row.
INSERT INTO community.media_renditions (
  id, item_id, edit_key, role, recipe_version, recipe_digest, blob_id,
  width, height, duration_ms, content_type, state, created_at
)
SELECT
  'media-rendition-' || md5('media-derivative:' || d.item_id || ':' || d.variant || ':' || d.edit_key),
  d.item_id,
  d.edit_key,
  d.variant,
  1,
  CASE d.variant
    WHEN 'thumb' THEN '02deba84f648b4c8'
    WHEN 'cover' THEN '6eca59397e187bee'
    WHEN 'display' THEN 'fa0cc28bb9865f16'
    WHEN 'full' THEN 'acb3027f6e2affec'
    WHEN 'motion' THEN '61403d6585d07f92'
  END,
  d.blob_id,
  d.width,
  d.height,
  d.duration_ms,
  d.content_type,
  'ready',
  d.created_at
FROM community.media_derivatives d;

-- The transaction aborts unless the copy reproduces the old table exactly:
-- equal row counts per variant and no derivative row missing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT variant AS role, count(*) AS rows
      FROM community.media_derivatives GROUP BY variant
    ) d
    FULL JOIN (
      SELECT role, count(*) AS rows
      FROM community.media_renditions GROUP BY role
    ) r USING (role)
    WHERE d.rows IS DISTINCT FROM r.rows
  ) OR EXISTS (
    SELECT d.item_id, d.variant, d.edit_key, d.blob_id, d.width, d.height,
      d.duration_ms, d.content_type, d.created_at
    FROM community.media_derivatives d
    EXCEPT
    SELECT r.item_id, r.role, r.edit_key, r.blob_id, r.width, r.height,
      r.duration_ms, r.content_type, r.created_at
    FROM community.media_renditions r
  ) THEN
    RAISE EXCEPTION 'media_renditions does not reproduce media_derivatives';
  END IF;
END
$$;

COMMENT ON TABLE community.media_derivatives IS
  'Superseded by community.media_renditions (unified media pipeline, increment 1). No longer read or written; retained until the recorded D7 follow-up.';

-- Every rendition the system keeps for one holder edit: the required set
-- (unchanged; readiness and submissions use only that) plus the optional
-- bounded viewer image of the complete framing, which never blocks readiness
-- but is not released while a holder keeps the edit.
CREATE FUNCTION community.media_wanted_renditions(
  kind TEXT,
  edit JSONB,
  is_cover BOOLEAN,
  cover_crop JSONB
)
RETURNS TABLE (role TEXT, edit_key TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT r.variant, r.edit_key
  FROM community.media_required_derivatives(kind, edit, is_cover, cover_crop) r
  UNION ALL
  SELECT 'viewer', community.media_edit_key(edit, NULL)
$$;

-- The legacy baseline of one work, exactly as in 20260914094000 except that
-- a revived item's renditions whose blob is no longer committed are released
-- instead of deleting rows from the retained derivative table.
CREATE OR REPLACE FUNCTION community.ensure_legacy_work_revision(
  target_work_id TEXT
)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  target community.works%ROWTYPE;
  legacy_revision TEXT;
  legacy_items JSONB;
  legacy_cover TEXT;
  published TIMESTAMPTZ;
  next_sequence INTEGER;
BEGIN
  SELECT * INTO target
  FROM community.works
  WHERE id = target_work_id
  FOR UPDATE;
  IF NOT FOUND OR target.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF target.public_revision_id IS NOT NULL THEN
    RETURN target.public_revision_id;
  END IF;
  IF target.author_revision_id IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(target.media_ids) AS m(media_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM community.user_media um
      WHERE um.id = m.media_id AND um.owner_id = target.author_id
    )
  ) THEN
    RAISE EXCEPTION 'legacy work media is not owned by the work author';
  END IF;

  INSERT INTO community.media_items (
    id, owner_id, kind, quality_mode, source, legacy_media_id, state,
    declared_total_bytes, received_total_bytes, presentation,
    created_at, updated_at, ready_at
  )
  SELECT DISTINCT
    'media-item-' || md5('legacy-media:' || um.id),
    um.owner_id,
    'static',
    'legacy',
    'legacy_user_media',
    um.id,
    'ready',
    octet_length(um.bytes),
    octet_length(um.bytes),
    jsonb_build_object('width', um.width, 'height', um.height),
    um.created_at,
    um.created_at,
    um.created_at
  FROM unnest(target.media_ids) AS m(media_id)
  JOIN community.user_media um
    ON um.id = m.media_id AND um.owner_id = target.author_id
  ON CONFLICT (id) DO UPDATE SET
    state = 'ready',
    failure_code = NULL,
    cancelled_at = NULL,
    purged_at = NULL,
    ready_at = COALESCE(community.media_items.ready_at, EXCLUDED.ready_at),
    updated_at = CURRENT_TIMESTAMP,
    version = community.media_items.version + 1
  WHERE community.media_items.state IN ('cancelled', 'purged');

  -- A revived item keeps only renditions whose blob is still committed (a
  -- purge tombstoned the others); live items never have any other rows.
  UPDATE community.media_renditions r
  SET state = 'released', released_at = CURRENT_TIMESTAMP
  FROM community.media_blobs b
  WHERE b.id = r.blob_id
    AND b.state <> 'committed'
    AND r.state <> 'released'
    AND r.item_id IN (
      SELECT 'media-item-' || md5('legacy-media:' || m.media_id)
      FROM unnest(target.media_ids) AS m(media_id)
    );

  SELECT
    jsonb_agg(
      jsonb_build_object(
        'itemId', ordered.item_id,
        'edit', '{"rotation":0,"crop":null}'::jsonb
      )
      ORDER BY ordered.position
    ),
    (array_agg(ordered.item_id ORDER BY ordered.position))[1]
  INTO legacy_items, legacy_cover
  FROM (
    SELECT
      'media-item-' || md5('legacy-media:' || m.media_id) AS item_id,
      row_number() OVER (ORDER BY min(m.ordinal)) AS position
    FROM unnest(target.media_ids) WITH ORDINALITY AS m(media_id, ordinal)
    GROUP BY m.media_id
  ) AS ordered;

  legacy_revision := 'work-revision-' || md5('legacy-revision:' || target.id);
  published := COALESCE(target.first_published_at, target.updated_at);
  SELECT COALESCE(max(r.sequence), 0) + 1 INTO next_sequence
  FROM community.work_revisions r
  WHERE r.work_id = target.id;

  INSERT INTO community.work_revisions (
    id, work_id, author_id, sequence, origin, title, body, authorship_kind,
    requested_visibility, cover_item_id, content_sha256, disposition,
    submitted_at, decided_at
  )
  VALUES (
    legacy_revision,
    target.id,
    target.author_id,
    next_sequence,
    'legacy',
    target.title,
    target.text,
    NULL,
    'public',
    legacy_cover,
    community.work_content_sha256(
      target.title, target.text, NULL, NULL, NULL, NULL,
      COALESCE(legacy_items, '[]'::jsonb), legacy_cover, NULL
    ),
    'approved',
    published,
    published
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO community.work_revision_items (revision_id, position, item_id, edit)
  SELECT
    legacy_revision,
    row_number() OVER (ORDER BY min(m.ordinal)),
    'media-item-' || md5('legacy-media:' || m.media_id),
    '{"rotation":0,"crop":null}'::jsonb
  FROM unnest(target.media_ids) WITH ORDINALITY AS m(media_id, ordinal)
  GROUP BY m.media_id
  ON CONFLICT DO NOTHING;

  INSERT INTO community.media_item_refs (item_id, holder_kind, holder_id)
  SELECT i.item_id, 'revision', legacy_revision
  FROM community.work_revision_items i
  WHERE i.revision_id = legacy_revision
  ON CONFLICT DO NOTHING;

  -- version and updated_at stay unchanged: the insert is the only change.
  UPDATE community.works
  SET
    public_revision_id = legacy_revision,
    author_revision_id = legacy_revision,
    first_published_at = COALESCE(first_published_at, published),
    first_submitted_at = COALESCE(first_submitted_at, published)
  WHERE id = target.id;

  RETURN legacy_revision;
END
$$;

-- The complete job kind list (publishingJobKindSchema is its one TypeScript
-- definition; an integration test compares both) with Catalog rendering.
ALTER TABLE community.publishing_jobs
  DROP CONSTRAINT publishing_jobs_kind_valid,
  ADD CONSTRAINT publishing_jobs_kind_valid CHECK (
    kind IN (
      'process_item', 'derive_edit', 'purge_item', 'purge_blob',
      'expire_session', 'purge_trashed_work', 'sweep_staging',
      'reconcile_capacity', 'catalog_render'
    )
  );
