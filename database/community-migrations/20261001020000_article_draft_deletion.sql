-- special-article-editor-v1 r5: delete only the private editable lifetime.
-- Immutable submitted/public revisions and published pointers remain intact.
ALTER TABLE community.article_documents ADD COLUMN deleted_at TIMESTAMPTZ;

CREATE FUNCTION community.reject_deleted_article_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,community AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Deleted Article drafts cannot be changed' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deleted_article_draft_terminal BEFORE UPDATE ON community.article_documents
  FOR EACH ROW EXECUTE FUNCTION community.reject_deleted_article_update();
