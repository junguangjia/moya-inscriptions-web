-- Private processing pins are not public Catalog references or copy permission.
-- This App role is shared application persistence; this migration does not
-- pretend to introduce a worker-only identity, queue, or cross-database FK.
CREATE TABLE community.catalog_delivery_prepares (
  intent_id uuid PRIMARY KEY,
  cms_document_id integer NOT NULL CHECK (cms_document_id > 0),
  catalog_id text NOT NULL CHECK (length(catalog_id) BETWEEN 1 AND 128),
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  draft_fingerprint char(64) NOT NULL CHECK (draft_fingerprint ~ '^[a-f0-9]{64}$'),
  manifest_sha256 char(64) NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  recipe_manifest_sha256 char(64) NOT NULL CHECK (recipe_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  media_count integer NOT NULL CHECK (media_count BETWEEN 0 AND 2000),
  source_state varchar NOT NULL CHECK (source_state IN
    ('prepared', 'release_requested', 'released', 'cancelled', 'superseded', 'expired', 'withdrawn')),
  source_state_version integer NOT NULL CHECK (source_state_version > 0),
  expires_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  observed_live boolean NOT NULL DEFAULT true,
  ended_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (source_state NOT IN ('cancelled', 'superseded', 'expired', 'withdrawn') OR ended_at IS NOT NULL)
);
CREATE INDEX catalog_delivery_prepares_active ON community.catalog_delivery_prepares(expires_at)
  WHERE ended_at IS NULL;

CREATE TABLE community.catalog_delivery_media_refs (
  intent_id uuid NOT NULL REFERENCES community.catalog_delivery_prepares(intent_id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 2000),
  media_id text NOT NULL CHECK (length(media_id) BETWEEN 1 AND 128 AND media_id !~ '\s'),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 65535),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 65535),
  asset_id text GENERATED ALWAYS AS ('catalog-asset-' || md5(media_id || ':' || object_key)) STORED,
  PRIMARY KEY (intent_id, ordinal),
  UNIQUE (intent_id, media_id),
  UNIQUE (intent_id, object_key)
);
CREATE INDEX catalog_delivery_media_refs_asset ON community.catalog_delivery_media_refs(asset_id);

CREATE TABLE community.catalog_delivery_rendition_pins (
  intent_id uuid NOT NULL,
  ordinal integer NOT NULL,
  role text NOT NULL CHECK (role IN ('thumb', 'cover', 'display', 'viewer')),
  rendition_id text NOT NULL REFERENCES community.media_renditions(id) ON DELETE RESTRICT,
  recipe_version integer NOT NULL CHECK (recipe_version > 0),
  recipe_digest char(16) NOT NULL CHECK (recipe_digest ~ '^[a-f0-9]{16}$'),
  public_generation_id text REFERENCES community.media_publications(id) ON DELETE RESTRICT,
  public_generation_version bigint CHECK (public_generation_version > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (intent_id, ordinal, role),
  FOREIGN KEY (intent_id, ordinal) REFERENCES community.catalog_delivery_media_refs(intent_id, ordinal) ON DELETE RESTRICT,
  CHECK ((public_generation_id IS NULL) = (public_generation_version IS NULL))
);
CREATE INDEX catalog_delivery_rendition_pins_rendition ON community.catalog_delivery_rendition_pins(rendition_id);

CREATE TABLE community.catalog_delivery_snapshot_watermark (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  observed_at timestamptz NOT NULL
);
