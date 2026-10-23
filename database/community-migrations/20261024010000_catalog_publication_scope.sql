-- catalog-scale-v1 (Issue #323) 1B, W6: App migration A1, the state of the
-- scoped Catalog publication reconcile. Two new tables, three partial indexes
-- and one plain index; no existing row or column is rewritten. The reconcile
-- plans only a bounded scope of Catalog assets per pass (in-flight
-- publications, dirty assets in FIFO order, membership fingerprint
-- differences, time-driven entries and a keyset sweep) instead of the whole
-- Catalog.
--
-- Forward-only, like every migration of this family: the runner has no down
-- path and an applied file never changes (README). Nothing needs undoing for
-- a rollback: an earlier Backend or worker never names these relations, and
-- its ledger check reads only the migration IDs it knows.
--
-- Deploy order: apply this migration with the migration role, re-apply
-- infra/development/work-publishing/grant-runtime.sql (the App role reads and
-- writes both tables through named columns only, never DELETE), then start a
-- worker or Backend of this release; their startup refuses until both are
-- done. The index builds briefly block writes to the mirror and the
-- publication table, so lock_timeout makes a busy run fail (55P03, nothing
-- applied) and be re-run instead of queueing those writes.
SET LOCAL lock_timeout = '5s';

-- Catalog assets the reconcile must plan again, oldest mark first. A mark
-- raises mark_seq (inserting the row at 1 the first time); a pass that planned
-- the asset completely sets cleared_seq to the mark_seq it read, in the same
-- transaction as its publication writes, so a mark made meanwhile keeps the
-- row pending. Rows are never deleted (the App role holds no DELETE), so the
-- table is bounded by the number of Catalog assets. marked_at is the time the
-- row last became pending; the reason is the latest mark's, content-free.
-- There is no foreign key to catalog_media_assets on purpose: a mark must
-- never take a lock on the asset row that the Catalog sync locks FOR UPDATE.
CREATE TABLE community.catalog_publication_dirty (
  asset_id text PRIMARY KEY CHECK (asset_id ~ '^catalog-asset-[0-9a-f]{32}$'),
  mark_seq bigint NOT NULL CHECK (mark_seq > 0),
  cleared_seq bigint NOT NULL DEFAULT 0 CHECK (cleared_seq >= 0 AND cleared_seq <= mark_seq),
  reason text NOT NULL CHECK (reason IN
    ('reference', 'intent', 'rendition', 'publication', 'public_membership', 'private_membership')),
  marked_at timestamptz NOT NULL
);
-- The FIFO read of pending marks; cleared rows leave the index.
CREATE INDEX catalog_publication_dirty_pending
  ON community.catalog_publication_dirty (marked_at, asset_id)
  WHERE mark_seq > cleared_seq;

-- The reconcile's own position, one row created here (the App role never
-- inserts or deletes it): the keyset sweep over catalog_media_assets.id (NULL
-- starts a round) and the recipe policy it runs under, the last public and
-- private membership fingerprints (a count and a sum of row hashes, each
-- with the time it was read; NULL before the first), and the per-tier render
-- backlog with its time.
CREATE TABLE community.catalog_reconcile_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  sweep_cursor text CHECK (sweep_cursor ~ '^catalog-asset-[0-9a-f]{32}$'),
  policy_digest char(64) CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  public_count bigint CHECK (public_count >= 0),
  public_sum numeric,
  public_observed_at timestamptz,
  private_count bigint CHECK (private_count >= 0),
  private_sum numeric,
  private_observed_at timestamptz,
  render_backlog jsonb CHECK (jsonb_typeof(render_backlog) = 'object'),
  render_backlog_at timestamptz,
  updated_at timestamptz NOT NULL,
  CHECK ((public_count IS NULL) = (public_sum IS NULL)
    AND (public_count IS NULL) = (public_observed_at IS NULL)),
  CHECK ((private_count IS NULL) = (private_sum IS NULL)
    AND (private_count IS NULL) = (private_observed_at IS NULL)),
  CHECK ((render_backlog IS NULL) = (render_backlog_at IS NULL))
);
INSERT INTO community.catalog_reconcile_state (id, updated_at) VALUES (true, now());

-- The mirror rows a Catalog sync can change: it reads the observed-live rows
-- (and the snapshot's own intents by primary key) and tombstones the live ones
-- the snapshot no longer lists. Tombstones, which grow with every intent ever
-- ended, leave the index, so neither statement reads them once history
-- outgrows the live set.
CREATE INDEX catalog_delivery_prepares_observed_live
  ON community.catalog_delivery_prepares (intent_id)
  WHERE observed_live;

-- Publications still in flight, which the reconcile scope always includes.
-- The existing (public_asset_id, state) index serves one asset; this one
-- lists every in-flight asset without reading the published history.
CREATE INDEX media_publications_in_flight
  ON community.media_publications (public_asset_id)
  WHERE state IN ('publishing', 'withdrawing', 'purge_failed');

-- Every publication of one rendition, history included. A job's acquire
-- inspects each pinned rendition's publications by rendition_id alone (it
-- locks them FOR SHARE and keeps the published one), once per pinned role;
-- media_publications_live_rendition holds only the publishing and published
-- rows, so that read scanned every publication ever made.
CREATE INDEX media_publications_rendition
  ON community.media_publications (rendition_id);
