-- settings-feedback-v1 r2: private images reuse the managed media pipeline.
ALTER TABLE community.media_items ADD COLUMN purpose text NOT NULL DEFAULT 'content';
ALTER TABLE community.media_items ADD CONSTRAINT media_items_purpose_valid CHECK (
  purpose IN ('content','feedback') AND (purpose<>'feedback' OR (kind='static' AND source='upload' AND declared_total_bytes<=10485760))
);
CREATE FUNCTION community.keep_media_item_purpose() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,community AS $$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'Media purpose is immutable' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_item_purpose_immutable BEFORE UPDATE OF purpose ON community.media_items
FOR EACH ROW EXECUTE FUNCTION community.keep_media_item_purpose();
ALTER TABLE community.media_item_refs DROP CONSTRAINT media_item_refs_holder_valid;
ALTER TABLE community.media_item_refs ADD CONSTRAINT media_item_refs_holder_valid CHECK (
  (holder_kind='draft' AND holder_id ~ '^work-draft-[0-9a-f]{32}$')
  OR (holder_kind='revision' AND holder_id ~ '^work-revision-[0-9a-f]{32}$')
  OR (holder_kind='snapshot' AND holder_id ~ '^work-snapshot-[0-9a-f]{32}$')
  OR (holder_kind='session' AND holder_id ~ '^publishing-session-[0-9a-f]{32}$')
  OR (holder_kind='article_draft' AND holder_id ~ '^article-[0-9a-f]{32}$')
  OR (holder_kind='article_revision' AND holder_id ~ '^article-revision-[0-9a-f]{32}$')
  OR (holder_kind='feedback' AND holder_id ~ '^feedback-[0-9a-f]{32}$')
);
CREATE TABLE community.feedback_images (
  feedback_id text NOT NULL REFERENCES community.feedback(id),
  item_id text NOT NULL REFERENCES community.media_items(id),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 2),
  PRIMARY KEY (feedback_id,position), UNIQUE(feedback_id,item_id)
);
CREATE INDEX feedback_images_item ON community.feedback_images(item_id);
REVOKE ALL ON TABLE community.feedback_images FROM PUBLIC;
