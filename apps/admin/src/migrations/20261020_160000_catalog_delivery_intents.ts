import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE catalog_delivery_intents (
      id uuid PRIMARY KEY,
      catalog_document_id integer NOT NULL REFERENCES catalogs(id) ON DELETE RESTRICT,
      catalog_id varchar NOT NULL,
      actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      draft_revision integer NOT NULL CHECK (draft_revision > 0),
      draft_fingerprint char(64) NOT NULL CHECK (draft_fingerprint ~ '^[a-f0-9]{64}$'),
      draft_snapshot jsonb NOT NULL CHECK (jsonb_typeof(draft_snapshot) = 'object'),
      base_revision integer NOT NULL CHECK (base_revision >= 0),
      base_status varchar NOT NULL CHECK (base_status IN ('draft', 'published')),
      base_fingerprint char(64) NOT NULL CHECK (base_fingerprint ~ '^[a-f0-9]{64}$'),
      media_manifest jsonb NOT NULL CHECK (jsonb_typeof(media_manifest) = 'array'),
      media_manifest_sha256 char(64) NOT NULL CHECK (media_manifest_sha256 ~ '^[a-f0-9]{64}$'),
      recipe_manifest jsonb,
      recipe_manifest_sha256 char(64) CHECK (recipe_manifest_sha256 ~ '^[a-f0-9]{64}$'),
      state varchar NOT NULL DEFAULT 'prepared' CHECK (state IN
        ('prepared', 'release_requested', 'released', 'cancelled', 'superseded', 'expired', 'withdrawn')),
      state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
      release_requested_by integer REFERENCES users(id) ON DELETE RESTRICT,
      release_requested_at timestamptz,
      release_proof_sha256 char(64) CHECK(release_proof_sha256 ~ '^[a-f0-9]{64}$'),
      ended_at timestamptz,
      end_reason varchar,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((recipe_manifest IS NULL) = (recipe_manifest_sha256 IS NULL)),
      CHECK (state NOT IN ('release_requested', 'released') OR
        (recipe_manifest_sha256 IS NOT NULL AND release_requested_at IS NOT NULL AND release_requested_by IS NOT NULL)),
      CHECK (state NOT IN ('cancelled', 'superseded', 'expired', 'withdrawn') OR ended_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX catalog_delivery_intents_one_active
      ON catalog_delivery_intents (catalog_document_id)
      WHERE state IN ('prepared', 'release_requested');
    CREATE INDEX catalog_delivery_intents_expiry
      ON catalog_delivery_intents (expires_at)
      WHERE state IN ('prepared', 'release_requested');
    CREATE TABLE catalog_delivery_receipts (
      deduplication_key char(64) PRIMARY KEY,
      actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
      operation varchar NOT NULL CHECK (operation IN ('prepare', 'request-release', 'release', 'cancel')),
      intent_id uuid NOT NULL REFERENCES catalog_delivery_intents(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- A separate, non-updatable private projection. It is deliberately absent
    -- from catalog_media and all public views. No reader role is granted here.
    CREATE VIEW catalog_delivery_prepare_media AS
      SELECT i.id AS intent_id, i.catalog_document_id, i.catalog_id, i.draft_revision,
        i.draft_fingerprint, i.media_manifest_sha256,
        i.recipe_manifest_sha256, i.state_version,
        CASE WHEN i.state IN ('prepared', 'release_requested') AND i.expires_at <= now()
          THEN 'expired' ELSE i.state END AS state,
        jsonb_array_length(i.media_manifest)::integer AS media_count,
        i.expires_at, m.ordinal::integer AS media_ordinal,
        m.value->>'mediaId' AS media_id, m.value->>'objectKey' AS object_key,
        m.value->>'sourceSha256' AS source_sha256,
        (m.value->>'width')::integer AS width, (m.value->>'height')::integer AS height
      FROM catalog_delivery_intents i
      LEFT JOIN LATERAL jsonb_array_elements(CASE
        WHEN i.state = 'released' OR (i.state IN ('prepared', 'release_requested') AND i.expires_at > now())
        THEN i.media_manifest ELSE '[]'::jsonb END) WITH ORDINALITY AS m(value, ordinal) ON true
      WHERE i.recipe_manifest_sha256 IS NOT NULL
      OFFSET 0;
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP VIEW catalog_delivery_prepare_media;
    DROP TABLE catalog_delivery_receipts;
    DROP TABLE catalog_delivery_intents;
  `);
}
