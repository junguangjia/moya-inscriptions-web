-- #358: canonical plain text plus ordered managed-image offsets; existing rows stay text-only.
ALTER TABLE community.catalog_comments ADD COLUMN image_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE community.catalog_comment_replies ADD COLUMN image_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE community.catalog_comments DROP CONSTRAINT catalog_comments_text_bounded;
ALTER TABLE community.catalog_comment_replies DROP CONSTRAINT catalog_comment_replies_text_bounded;
ALTER TABLE community.catalog_comments ADD CONSTRAINT catalog_comments_text_bounded CHECK (
  char_length(text)<=1000 AND text=btrim(text) AND (char_length(text)>0 OR jsonb_array_length(image_refs)>0)
);
ALTER TABLE community.catalog_comment_replies ADD CONSTRAINT catalog_comment_replies_text_bounded CHECK (
  char_length(text)<=1000 AND text=btrim(text) AND (char_length(text)>0 OR jsonb_array_length(image_refs)>0)
);
ALTER TABLE community.catalog_comments ADD CONSTRAINT catalog_comments_images_bounded CHECK (jsonb_typeof(image_refs)='array' AND jsonb_array_length(image_refs)<=6);
ALTER TABLE community.catalog_comment_replies ADD CONSTRAINT catalog_comment_replies_images_bounded CHECK (jsonb_typeof(image_refs)='array' AND jsonb_array_length(image_refs)<=6);
ALTER TABLE community.media_items DROP CONSTRAINT media_items_purpose_valid;
ALTER TABLE community.media_items ADD CONSTRAINT media_items_purpose_valid CHECK (
  purpose IN ('content','feedback','comment') AND (purpose='content' OR (kind='static' AND source='upload' AND declared_total_bytes<=10485760))
);
ALTER TABLE community.media_item_refs DROP CONSTRAINT media_item_refs_holder_valid;
ALTER TABLE community.media_item_refs ADD CONSTRAINT media_item_refs_holder_valid CHECK (
  (holder_kind='draft' AND holder_id ~ '^work-draft-[0-9a-f]{32}$')
  OR (holder_kind='revision' AND holder_id ~ '^work-revision-[0-9a-f]{32}$')
  OR (holder_kind='snapshot' AND holder_id ~ '^work-snapshot-[0-9a-f]{32}$')
  OR (holder_kind='session' AND holder_id ~ '^publishing-session-[0-9a-f]{32}$')
  OR (holder_kind='article_draft' AND holder_id ~ '^article-[0-9a-f]{32}$')
  OR (holder_kind='article_revision' AND holder_id ~ '^article-revision-[0-9a-f]{32}$')
  OR (holder_kind='feedback' AND holder_id ~ '^feedback-[0-9a-f]{32}$')
  OR (holder_kind='comment' AND holder_id ~ '^comment-[0-9a-f]{32}$')
);
