-- catalog-deep-zoom-v1 (unified-media-pipeline increment 4 slice, Owner
-- decisions 2026-10-19, Issue #295): private Catalog display masters, one
-- level of 1024 px JPEG blocks recorded as ordinary Catalog renditions, the
-- published-blocks view and the day-to-date usage columns of the breaker.
-- Forward-only and additive: no row is rewritten and no byte is moved. This
-- is the expand release: its code handles block rows in every state and
-- never renders a block.
--
-- Deploy order: stop the media worker and the Backend, take and verify the
-- database backup, apply this migration, re-apply the named runtime grants
-- (grant-runtime.sql and the Catalog public read grant), then start the
-- release. The previous release starts with this applied: it reads no new
-- column, and the new usage columns are nullable.

-- Every lock is taken at once, before any ALTER, never upgraded midway: the
-- new foreign keys need SHARE ROW EXCLUSIVE on catalog_media_assets (its
-- readers keep reading); every ALTER below needs ACCESS EXCLUSIVE.
SET LOCAL lock_timeout = '5s';
LOCK TABLE community.catalog_media_assets IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE community.media_blobs, community.media_renditions,
  community.media_publications, community.media_request_usage
  IN ACCESS EXCLUSIVE MODE;

-- A display master is the private, byte-exact original behind one approved
-- Catalog image: owner-less (no account capacity), never published, and held
-- by the retention hold 'catalog_master' while committed, so no purge path
-- removes it. Erasing a master tombstones it and clears the hold in one
-- statement; the existing purge then deletes it. Only masters carry that hold.
ALTER TABLE community.media_blobs
  DROP CONSTRAINT media_blobs_purpose_valid,
  ADD CONSTRAINT media_blobs_purpose_valid CHECK (
    purpose IN (
      'original', 'standard_master', 'derivative', 'catalog_derivative',
      'profile_derivative', 'catalog_master'
    )
  ),
  DROP CONSTRAINT media_blobs_owner_matches_purpose,
  ADD CONSTRAINT media_blobs_owner_matches_purpose CHECK (
    (purpose IN ('catalog_derivative', 'profile_derivative', 'catalog_master'))
      = (owner_id IS NULL)
  ),
  DROP CONSTRAINT media_blobs_retention_hold_valid,
  ADD CONSTRAINT media_blobs_retention_hold_valid CHECK (
    retention_hold IS NULL OR retention_hold IN ('d7_pre_task', 'catalog_master')
  ),
  ADD CONSTRAINT media_blobs_catalog_master_held CHECK (
    purpose <> 'catalog_master' OR state <> 'committed'
    OR retention_hold IS NOT DISTINCT FROM 'catalog_master'
  ),
  ADD CONSTRAINT media_blobs_catalog_master_hold_purpose CHECK (
    retention_hold IS DISTINCT FROM 'catalog_master' OR purpose = 'catalog_master'
  ),
  ADD CONSTRAINT media_blobs_catalog_master_type CHECK (
    purpose <> 'catalog_master' OR content_type IN ('image/jpeg', 'image/png')
  );

-- One attachment of a master to one Catalog asset. At most one active row
-- per asset and per blob; a row is only ever ended (once), never rewritten.
-- The frame is the oriented master scaled to the long edge
-- min(master, max_long_edge, 8192): never upscaled, at most 8192 px on the
-- long edge for every aspect (no long-scroll exception), and the short edge
-- rounded to within half a pixel. A frame is cut into one level of
-- 1024 px cells, 2..100 of them.
CREATE TABLE community.catalog_display_masters (
  id TEXT PRIMARY KEY,
  catalog_asset_id TEXT NOT NULL REFERENCES community.catalog_media_assets (id),
  blob_id TEXT NOT NULL REFERENCES community.media_blobs (id),
  master_sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  master_width INTEGER NOT NULL,
  master_height INTEGER NOT NULL,
  derivation TEXT NOT NULL,
  max_long_edge INTEGER NOT NULL,
  frame_width INTEGER NOT NULL,
  frame_height INTEGER NOT NULL,
  note TEXT,
  operator TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  CONSTRAINT catalog_display_masters_id_opaque CHECK (
    id ~ '^catalog-master-[0-9a-f]{32}$'
  ),
  CONSTRAINT catalog_display_masters_id_asset_unique UNIQUE (id, catalog_asset_id),
  CONSTRAINT catalog_display_masters_sha256_valid CHECK (
    master_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT catalog_display_masters_type_valid CHECK (
    content_type IN ('image/jpeg', 'image/png')
  ),
  CONSTRAINT catalog_display_masters_size_bounded CHECK (
    master_width BETWEEN 1 AND 65535 AND master_height BETWEEN 1 AND 65535
  ),
  CONSTRAINT catalog_display_masters_derivation_valid CHECK (
    derivation IN ('submitted', 'edited-export')
  ),
  CONSTRAINT catalog_display_masters_limit_bounded CHECK (
    max_long_edge BETWEEN 1 AND 8192
  ),
  CONSTRAINT catalog_display_masters_frame_long_edge CHECK (
    GREATEST(frame_width, frame_height)
      = LEAST(GREATEST(master_width, master_height), max_long_edge, 8192)
  ),
  CONSTRAINT catalog_display_masters_frame_not_upscaled CHECK (
    frame_width BETWEEN 1 AND master_width AND frame_height BETWEEN 1 AND master_height
  ),
  CONSTRAINT catalog_display_masters_frame_aspect CHECK (
    2 * abs(frame_width::bigint * master_height - frame_height::bigint * master_width)
      <= GREATEST(master_width, master_height)
  ),
  CONSTRAINT catalog_display_masters_frame_cells CHECK (
    ((frame_width + 1023) / 1024) * ((frame_height + 1023) / 1024) BETWEEN 2 AND 100
  ),
  CONSTRAINT catalog_display_masters_note_bounded CHECK (
    note IS NULL OR (char_length(note) BETWEEN 1 AND 500 AND note = btrim(note))
  ),
  CONSTRAINT catalog_display_masters_operator_bounded CHECK (
    operator ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT catalog_display_masters_end_valid CHECK (
    (ended_at IS NULL) = (end_reason IS NULL)
    AND (end_reason IS NULL OR end_reason IN ('detached', 'limit_changed', 'reattached'))
    AND (ended_at IS NULL OR ended_at >= created_at)
  )
);

CREATE UNIQUE INDEX catalog_display_masters_active_asset
  ON community.catalog_display_masters (catalog_asset_id)
  WHERE ended_at IS NULL;
CREATE UNIQUE INDEX catalog_display_masters_active_blob
  ON community.catalog_display_masters (blob_id)
  WHERE ended_at IS NULL;
CREATE INDEX catalog_display_masters_blob_idx
  ON community.catalog_display_masters (blob_id);

-- A new row names a committed, held master blob with the same hash and type.
CREATE FUNCTION community.enforce_catalog_display_master_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, community AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM community.media_blobs b
    WHERE b.id = NEW.blob_id AND b.state = 'committed'
      AND b.purpose = 'catalog_master' AND b.retention_hold = 'catalog_master'
      AND b.sha256 = NEW.master_sha256 AND b.content_type = NEW.content_type
  ) THEN
    RAISE EXCEPTION 'A display master names a committed, held master blob'
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_display_master_insert
  BEFORE INSERT ON community.catalog_display_masters
  FOR EACH ROW EXECUTE FUNCTION community.enforce_catalog_display_master_insert();

-- Only ended_at and end_reason change, from NULL, exactly once.
CREATE FUNCTION community.enforce_catalog_display_master_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, community AS $$
BEGIN
  IF ROW(NEW.id, NEW.catalog_asset_id, NEW.blob_id, NEW.master_sha256,
      NEW.content_type, NEW.master_width, NEW.master_height, NEW.derivation,
      NEW.max_long_edge, NEW.frame_width, NEW.frame_height, NEW.note,
      NEW.operator, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.catalog_asset_id, OLD.blob_id,
      OLD.master_sha256, OLD.content_type, OLD.master_width, OLD.master_height,
      OLD.derivation, OLD.max_long_edge, OLD.frame_width, OLD.frame_height,
      OLD.note, OLD.operator, OLD.created_at)
    OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'A display master row is only ended, once'
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_display_master_update
  BEFORE UPDATE ON community.catalog_display_masters
  FOR EACH ROW EXECUTE FUNCTION community.enforce_catalog_display_master_update();

-- A block is one cell `block-NN` (row-major) of one master's frame: an
-- unedited JPEG of a Catalog asset, at most 1024 px plus a 2 px overlap on the
-- right and bottom, named by the master it was cut from (same asset). No
-- other rendition names a master.
ALTER TABLE community.media_renditions
  ADD COLUMN catalog_master_id TEXT,
  ADD CONSTRAINT media_renditions_catalog_master_fkey
    FOREIGN KEY (catalog_master_id, catalog_asset_id)
    REFERENCES community.catalog_display_masters (id, catalog_asset_id),
  DROP CONSTRAINT media_renditions_role_valid,
  ADD CONSTRAINT media_renditions_role_valid CHECK (
    role IN (
      'thumb', 'cover', 'display', 'viewer', 'full', 'motion',
      'avatar-128', 'avatar-512', 'background-960', 'background-1600'
    )
    OR role ~ '^block-[0-9]{2}$'
  ),
  ADD CONSTRAINT media_renditions_block_master CHECK (
    (role ~ '^block-') = (catalog_master_id IS NOT NULL)
  ),
  ADD CONSTRAINT media_renditions_block_shape CHECK (
    catalog_master_id IS NULL OR (
      catalog_asset_id IS NOT NULL AND edit_key = 'base'
      AND content_type = 'image/jpeg' AND duration_ms IS NULL
      AND width BETWEEN 1 AND 1026 AND height BETWEEN 1 AND 1026
    )
  );
CREATE INDEX media_renditions_catalog_master_idx
  ON community.media_renditions (catalog_master_id)
  WHERE catalog_master_id IS NOT NULL;

-- Published block keys follow the existing grammar; a deferred block
-- withdrawal records the forced edge TTL it waits for (at most 24 hours).
ALTER TABLE community.media_publications
  DROP CONSTRAINT media_publications_object_key_check,
  ADD CONSTRAINT media_publications_object_key_check CHECK (
    object_key ~ '^v1/[0-9a-f]{32}/[0-9a-f]{32}/(base|[0-9a-f]{32})/(thumb|cover|display|viewer|full|motion|block-[0-9]{2})\.r[1-9][0-9]*\.(webp|jpg|mp4)$'
  ),
  DROP CONSTRAINT media_publications_fallback_ttl_seconds_check,
  ADD CONSTRAINT media_publications_fallback_ttl_seconds_check CHECK (
    fallback_ttl_seconds IS NULL OR fallback_ttl_seconds BETWEEN 60 AND 86400
  );
-- The daily block purge budget counts block URLs submitted since the quota's
-- day started.
CREATE INDEX media_publications_block_purge
  ON community.media_publications (purge_submitted_at)
  WHERE role ~ '^block-' AND purge_submitted_at IS NOT NULL;

-- The breaker's day-to-date reading of the image host (the cap's day): all
-- or nothing except the byte total, which is absent when only requests are
-- readable. Nullable, so the previous release still inserts the singleton.
ALTER TABLE community.media_request_usage
  ADD COLUMN day_start TIMESTAMPTZ,
  ADD COLUMN day_requests BIGINT,
  ADD COLUMN day_bytes BIGINT,
  ADD COLUMN day_observed_at TIMESTAMPTZ,
  ADD CONSTRAINT media_request_usage_day_complete CHECK (
    (day_start IS NULL) = (day_requests IS NULL)
    AND (day_start IS NULL) = (day_observed_at IS NULL)
    AND (day_bytes IS NULL OR day_start IS NOT NULL)
  ),
  ADD CONSTRAINT media_request_usage_day_bounded CHECK (
    (day_requests IS NULL OR day_requests BETWEEN 0 AND 9007199254740991)
    AND (day_bytes IS NULL OR day_bytes BETWEEN 0 AND 9007199254740991)
  );

-- The one read seam for blocks: one row per ready block, on a committed blob,
-- of the active master (on a committed, held master blob) of a ready Catalog
-- asset that the published projection named at the last sync, with the
-- block's exact cell geometry inside the frame. Readers join it on
-- (media_id, object_key) to the published projection, exactly like
-- community.catalog_media_delivery. It projects the frame, the cell count and
-- the block's opaque delivery key, never a master fact, blob or key.
-- Privileges come only from the named grant files (amendment entry 8).
CREATE VIEW community.catalog_media_zoom_blocks WITH (security_barrier = true) AS
SELECT
  a.media_id,
  a.source_object_key AS object_key,
  m.frame_width,
  m.frame_height,
  g.columns * g.rows AS cells,
  c.cell,
  r.id AS delivery_key,
  r.width,
  r.height,
  r.content_type
FROM community.catalog_media_assets a
JOIN community.catalog_display_masters m
  ON m.catalog_asset_id = a.id AND m.ended_at IS NULL
JOIN community.media_blobs mb
  ON mb.id = m.blob_id AND mb.state = 'committed' AND mb.retention_hold = 'catalog_master'
CROSS JOIN LATERAL (
  SELECT (m.frame_width + 1023) / 1024 AS columns, (m.frame_height + 1023) / 1024 AS rows
) g
JOIN community.media_renditions r
  ON r.catalog_master_id = m.id AND r.catalog_asset_id = a.id
JOIN community.media_blobs b ON b.id = r.blob_id AND b.state = 'committed'
CROSS JOIN LATERAL (
  SELECT CASE WHEN r.role ~ '^block-[0-9]{2}$' THEN substring(r.role FROM 7)::integer END AS cell
) c
WHERE a.state = 'ready'
  AND a.unreferenced_since IS NULL
  AND r.state = 'ready'
  AND r.edit_key = 'base'
  AND r.content_type = 'image/jpeg'
  AND c.cell < g.columns * g.rows
  AND r.width = LEAST(1026, m.frame_width - (c.cell % g.columns) * 1024)
  AND r.height = LEAST(1026, m.frame_height - (c.cell / g.columns) * 1024);

REVOKE ALL ON community.catalog_media_zoom_blocks, community.catalog_display_masters FROM PUBLIC;
