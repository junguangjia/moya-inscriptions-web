-- Increment 2: private publication state. No grant to the Public or CMS roles.
-- Every object is registered before I/O; old generation keys are never reused.
CREATE TABLE community.media_public_assets (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  item_id text UNIQUE REFERENCES community.media_items(id),
  catalog_asset_id text UNIQUE REFERENCES community.catalog_media_assets(id),
  next_generation bigint NOT NULL DEFAULT 1 CHECK (next_generation > 0),
  desired_seq bigint NOT NULL DEFAULT 1 CHECK (desired_seq > 0),
  synced_seq bigint NOT NULL DEFAULT 0 CHECK (synced_seq >= 0 AND synced_seq <= desired_seq),
  desired_at timestamptz NOT NULL,
  lease_job_id text,
  lease_job_owner text,
  lease_sequence bigint,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((item_id IS NULL) <> (catalog_asset_id IS NULL)),
  CHECK ((lease_job_id IS NULL AND lease_job_owner IS NULL AND lease_sequence IS NULL AND lease_expires_at IS NULL)
    OR (lease_job_id IS NOT NULL AND lease_job_owner IS NOT NULL AND lease_sequence IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TABLE community.media_publications (
  id text PRIMARY KEY CHECK (id ~ '^media-publication-[0-9a-f]{32}$'),
  public_asset_id text NOT NULL REFERENCES community.media_public_assets(id),
  -- Byte identity survives retained source cleanup; eligibility always rejoins current renditions.
  rendition_id text,
  generation_token text NOT NULL CHECK (generation_token ~ '^[0-9a-f]{32}$'),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^v1/[0-9a-f]{32}/[0-9a-f]{32}/(base|[0-9a-f]{32})/(thumb|cover|display|viewer|full|motion)\.r[1-9][0-9]*\.(webp|jpg|mp4)$'),
  storage_key text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/webp','image/jpeg','video/mp4')),
  purpose text NOT NULL CHECK (purpose IN ('derivative','catalog_derivative')),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 9007199254740991),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  role text NOT NULL,
  edit_key text NOT NULL,
  state text NOT NULL DEFAULT 'publishing' CHECK (state IN ('publishing','published','withdrawing','purge_failed','withdrawn')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  withdraw_requested_at timestamptz,
  origin_deleted_at timestamptz,
  purge_task_ids text[] NOT NULL DEFAULT '{}',
  purge_attempts integer NOT NULL DEFAULT 0 CHECK (purge_attempts BETWEEN 0 AND 3),
  purge_submitted_at timestamptz,
  verified_at timestamptz,
  fallback_ttl_seconds integer CHECK (fallback_ttl_seconds IS NULL OR fallback_ttl_seconds = 3600),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  swept_at timestamptz,
  sweep_started_at timestamptz,
  sweep_task_ids text[] NOT NULL DEFAULT '{}',
  sweep_attempts integer NOT NULL DEFAULT 0 CHECK (sweep_attempts BETWEEN 0 AND 3),
  CHECK (rendition_id IS NOT NULL OR state IN ('withdrawing','purge_failed','withdrawn')),
  CHECK (state <> 'published' OR published_at IS NOT NULL),
  CHECK (state NOT IN ('withdrawing','purge_failed','withdrawn') OR withdraw_requested_at IS NOT NULL),
  CHECK (state <> 'withdrawn' OR (origin_deleted_at IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX media_publications_live_rendition ON community.media_publications(rendition_id)
  WHERE state IN ('publishing','published');
CREATE INDEX media_publications_asset_state ON community.media_publications(public_asset_id,state);
CREATE INDEX media_publications_sweep ON community.media_publications(swept_at) WHERE state='withdrawn';
CREATE TABLE community.media_item_holds (
  item_id text NOT NULL REFERENCES community.media_items(id) ON DELETE CASCADE,
  work_id text NOT NULL REFERENCES community.works(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY(item_id,work_id),
  CHECK (released_at IS NULL OR released_at >= created_at)
);
CREATE INDEX media_item_holds_active ON community.media_item_holds(item_id) WHERE released_at IS NULL;
CREATE TABLE community.media_request_usage (
  id text PRIMARY KEY CHECK (id='published-media'),
  month_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  requests bigint NOT NULL CHECK (requests >= 0 AND requests <= 9007199254740991),
  warning boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  CHECK (period_end >= month_start)
);
CREATE FUNCTION community.enforce_media_publication_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,community AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM community.media_renditions r
    JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
    JOIN community.media_public_assets a ON a.id=NEW.public_asset_id
    WHERE r.id=NEW.rendition_id AND r.state='ready'
      AND b.purpose IN ('derivative','catalog_derivative')
      AND r.content_type IN ('image/webp','image/jpeg','video/mp4')
      AND r.content_type=NEW.content_type AND b.content_type=r.content_type AND b.purpose=NEW.purpose
      AND b.storage_key=NEW.storage_key AND b.byte_size=NEW.byte_size AND b.sha256=NEW.sha256
      AND r.role=NEW.role AND r.edit_key=NEW.edit_key
      AND ((a.item_id IS NOT NULL AND r.item_id=a.item_id)
        OR (a.catalog_asset_id IS NOT NULL AND r.catalog_asset_id=a.catalog_asset_id))
      AND NEW.object_key='v1/'||a.id||'/'||NEW.generation_token||'/'||r.edit_key||'/'||r.role||'.r'||r.recipe_version||'.'||
        CASE r.content_type WHEN 'image/webp' THEN 'webp' WHEN 'image/jpeg' THEN 'jpg' ELSE 'mp4' END
  ) THEN
    RAISE EXCEPTION 'Only ready rendition bytes may be published' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_publication_insert BEFORE INSERT ON community.media_publications
  FOR EACH ROW EXECUTE FUNCTION community.enforce_media_publication_insert();
CREATE FUNCTION community.enforce_media_publication_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,community AS $$
BEGIN
  IF ROW(NEW.id,NEW.public_asset_id,NEW.generation_token,NEW.object_key,NEW.storage_key,NEW.content_type,
      NEW.purpose,NEW.byte_size,NEW.sha256,NEW.role,NEW.edit_key,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.public_asset_id,OLD.generation_token,OLD.object_key,OLD.storage_key,OLD.content_type,
      OLD.purpose,OLD.byte_size,OLD.sha256,OLD.role,OLD.edit_key,OLD.created_at)
    OR (NEW.rendition_id IS DISTINCT FROM OLD.rendition_id AND NOT
      (NEW.rendition_id IS NULL AND NEW.state IN ('withdrawing','purge_failed','withdrawn'))) THEN
    RAISE EXCEPTION 'Publication byte identity is immutable' USING ERRCODE='23000';
  END IF;
  IF NOT (OLD.state=NEW.state OR (OLD.state='publishing' AND NEW.state IN ('published','withdrawing'))
    OR (OLD.state='published' AND NEW.state='withdrawing')
    OR (OLD.state='withdrawing' AND NEW.state IN ('purge_failed','withdrawn'))
    OR (OLD.state='purge_failed' AND NEW.state IN ('withdrawing','withdrawn'))) THEN
    RAISE EXCEPTION 'Invalid publication transition' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_publication_transition BEFORE UPDATE ON community.media_publications
  FOR EACH ROW EXECUTE FUNCTION community.enforce_media_publication_transition();
ALTER TABLE community.publishing_jobs DROP CONSTRAINT publishing_jobs_kind_valid;
ALTER TABLE community.publishing_jobs ADD CONSTRAINT publishing_jobs_kind_valid CHECK (kind IN (
  'process_item','derive_edit','purge_item','purge_blob','expire_session','purge_trashed_work',
  'sweep_staging','reconcile_capacity','catalog_render','publish_media','withdraw_media',
  'verify_withdrawal','reconcile_publication','sweep_published'));
REVOKE ALL ON community.media_public_assets,community.media_publications,community.media_item_holds,
  community.media_request_usage FROM PUBLIC;
