-- special-article-editor-v1: additive public-user Article storage.
-- Staff Articles remain Payload-owned. No write grant on any Payload table.
-- This file is applied only by the explicit setup role against a task-owned DB.

CREATE TABLE community.article_documents (
  id TEXT PRIMARY KEY CHECK (id ~ '^article-[0-9a-f]{32}$'),
  owner_id TEXT NOT NULL REFERENCES community.public_users(id),
  owner_kind TEXT NOT NULL DEFAULT 'public_user' CHECK (owner_kind = 'public_user'),
  version INTEGER NOT NULL CHECK (version >= 1),
  title TEXT NOT NULL CHECK (char_length(title) <= 120),
  cover_ref_id TEXT,
  document JSONB NOT NULL CHECK (
    jsonb_typeof(document) = 'object'
    AND document->>'format' = 'blocknote'
    AND document->>'version' = '1'
    -- Coarse DB ceiling; shared validator enforces 1 MiB minified UTF-8 JSON.
    AND octet_length(document::text) <= 2097152
  ),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','published','withdrawn')),
  published_version INTEGER,
  pending_version INTEGER,
  first_published_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, owner_id),
  CHECK (published_version IS NULL OR published_version < version),
  CHECK (pending_version IS NULL OR pending_version < version),
  CHECK (status <> 'pending' OR pending_version IS NOT NULL),
  CHECK (status <> 'published' OR published_version IS NOT NULL),
  CHECK (status <> 'withdrawn' OR (published_version IS NULL AND pending_version IS NULL))
);
CREATE INDEX article_documents_owner_cursor ON community.article_documents(owner_id,updated_at DESC,id DESC);
CREATE INDEX article_documents_published_cursor ON community.article_documents(published_at DESC,id DESC) WHERE published_version IS NOT NULL;

-- An immutable exact-candidate submission/publication snapshot, never a second
-- editable master. Draft autosave updates only article_documents.
CREATE TABLE community.article_revisions (
  article_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) <= 120),
  cover_ref_id TEXT,
  document JSONB NOT NULL CHECK (
    jsonb_typeof(document) = 'object'
    AND document->>'format' = 'blocknote'
    AND document->>'version' = '1'
    -- Coarse DB ceiling; shared validator enforces 1 MiB minified UTF-8 JSON.
    AND octet_length(document::text) <= 2097152
  ),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  submitted_policy TEXT NOT NULL CHECK (submitted_policy IN ('PRE_MODERATION','DIRECT_PUBLICATION')),
  submitted_by_source TEXT NOT NULL CHECK (submitted_by_source IN ('human','delegated')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (article_id,version),
  FOREIGN KEY (article_id,owner_id) REFERENCES community.article_documents(id,owner_id)
);
ALTER TABLE community.article_documents ADD CONSTRAINT article_documents_published_revision
  FOREIGN KEY (id,published_version) REFERENCES community.article_revisions(article_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE community.article_documents ADD CONSTRAINT article_documents_pending_revision
  FOREIGN KEY (id,pending_version) REFERENCES community.article_revisions(article_id,version) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION community.enforce_article_document_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, community AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.owner_kind <> OLD.owner_kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Article identity and ownership are immutable' USING ERRCODE='23000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Article version must advance once' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER article_document_identity BEFORE UPDATE ON community.article_documents
  FOR EACH ROW EXECUTE FUNCTION community.enforce_article_document_identity();

CREATE FUNCTION community.reject_article_revision_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, community AS $$
BEGIN
  RAISE EXCEPTION 'Article revision snapshots are immutable' USING ERRCODE='23000';
END $$;
CREATE TRIGGER article_revision_immutable BEFORE UPDATE OR DELETE ON community.article_revisions
  FOR EACH ROW EXECUTE FUNCTION community.reject_article_revision_mutation();

-- Existing media accounting and cleanup remain the single asset system.
-- A snapshot holder id is opaque and derived from article id/version; it
-- carries no title, body or credential. A block removal drops only draft refs.
ALTER TABLE community.media_item_refs DROP CONSTRAINT media_item_refs_holder_valid;
ALTER TABLE community.media_item_refs ADD CONSTRAINT media_item_refs_holder_valid CHECK (
  (holder_kind='draft' AND holder_id ~ '^work-draft-[0-9a-f]{32}$')
  OR (holder_kind='revision' AND holder_id ~ '^work-revision-[0-9a-f]{32}$')
  OR (holder_kind='snapshot' AND holder_id ~ '^work-snapshot-[0-9a-f]{32}$')
  OR (holder_kind='session' AND holder_id ~ '^publishing-session-[0-9a-f]{32}$')
  OR (holder_kind='article_draft' AND holder_id ~ '^article-[0-9a-f]{32}$')
  OR (holder_kind='article_revision' AND holder_id ~ '^article-revision-[0-9a-f]{32}$')
);

-- Bounded boolean admission only, with published parent and selected media
-- rows locked in the CALLER'S transaction. It never returns CMS metadata,
-- accepts SQL, publishes, or changes a Catalog. Payload withdrawal/update must
-- wait until this transaction commits. The runtime role gets EXECUTE only.
-- Underlying primary tables are verified in apps/admin/src/published/views.ts.
CREATE FUNCTION community.article_catalog_references_published(
  catalog_ids TEXT[], media_catalog_ids TEXT[], media_ids TEXT[]
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  locked RECORD;
  expected INTEGER;
  found_count INTEGER := 0;
  media_count INTEGER := 0;
BEGIN
  IF catalog_ids IS NULL OR media_catalog_ids IS NULL OR media_ids IS NULL
     OR cardinality(catalog_ids)>30 OR cardinality(media_ids)>60
     OR cardinality(media_catalog_ids)<>cardinality(media_ids)
     OR EXISTS (SELECT 1 FROM unnest(catalog_ids) v WHERE v IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(media_catalog_ids) v WHERE v IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(media_ids) v WHERE v IS NULL) THEN
    RETURN FALSE;
  END IF;
  SELECT count(DISTINCT v) INTO expected FROM unnest(catalog_ids) v;
  IF expected=0 AND cardinality(media_ids)=0 THEN RETURN TRUE; END IF;
  FOR locked IN
    SELECT c.id FROM public.catalogs c
    WHERE c.catalog_id=ANY(catalog_ids) AND c._status::text='published'
    ORDER BY c.id FOR SHARE
  LOOP found_count := found_count+1; END LOOP;
  IF found_count<>expected THEN RETURN FALSE; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(media_catalog_ids) v WHERE NOT (v=ANY(catalog_ids))
  ) THEN RETURN FALSE; END IF;
  -- Require each exact (CatalogId,MediaId) pair, then lock the matched primary
  -- media rows as well. No object key or private source crosses this helper.
  FOR locked IN
    SELECT m.id FROM public.catalogs_media m
    JOIN public.catalogs c ON c.id=m._parent_id
    JOIN (SELECT DISTINCT c,m FROM unnest(media_catalog_ids,media_ids) pairs(c,m)) wanted(catalog_id,media_id)
      ON wanted.catalog_id=c.catalog_id AND wanted.media_id=m.media_id
    WHERE c._status::text='published'
    ORDER BY m.id FOR SHARE OF m
  LOOP
    media_count := media_count+1;
  END LOOP;
  RETURN media_count=(SELECT count(*) FROM (SELECT DISTINCT c,m FROM unnest(media_catalog_ids,media_ids) pairs(c,m)) unique_pairs);
END $$;
REVOKE ALL ON FUNCTION community.article_catalog_references_published(TEXT[],TEXT[],TEXT[]) FROM PUBLIC;

-- Append to the approved Article forward migration, not a second document store.
-- Views are owned by the setup role; the public read role cannot select drafts.
CREATE VIEW community.published_authored_articles WITH (security_barrier=true) AS
SELECT r.article_id, r.owner_id, r.version, r.title, r.cover_ref_id,
  r.document, r.document->'references'->r.cover_ref_id AS cover_reference,
  r.fingerprint, u.display_name AS byline,
  a.first_published_at, a.published_at, a.published_at AS updated_at
FROM community.article_documents a
JOIN community.article_revisions r ON r.article_id=a.id AND r.version=a.published_version
JOIN community.public_users u ON u.id=a.owner_id AND u.status='active'
WHERE a.published_version IS NOT NULL AND a.status<>'withdrawn';
REVOKE ALL ON community.published_authored_articles FROM PUBLIC;
