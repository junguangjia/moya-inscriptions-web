-- Static previews are usable before high-resolution background processing.
-- Function signatures and grants stay unchanged; no existing rows are rewritten.
CREATE OR REPLACE FUNCTION community.media_required_derivatives(kind TEXT, edit JSONB, is_cover BOOLEAN, cover_crop JSONB)
RETURNS TABLE (variant TEXT, edit_key TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT v.name, CASE WHEN is_cover AND v.name IN ('thumb','cover')
    THEN community.media_edit_key(edit,cover_crop) ELSE community.media_edit_key(edit,NULL) END
  FROM unnest(ARRAY['thumb','display']
    || CASE WHEN kind='live' THEN ARRAY['full','motion'] ELSE ARRAY[]::text[] END
    || CASE WHEN is_cover THEN ARRAY['cover'] ELSE ARRAY[]::text[] END) AS v(name)
$$;

-- Full and viewer remain wanted and retained even though static submission
-- no longer waits for them. This also preserves existing edited HD rows.
CREATE OR REPLACE FUNCTION community.media_wanted_renditions(kind TEXT, edit JSONB, is_cover BOOLEAN, cover_crop JSONB)
RETURNS TABLE (role TEXT, edit_key TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT r.variant,r.edit_key FROM community.media_required_derivatives(kind,edit,is_cover,cover_crop) r
  UNION SELECT 'full',community.media_edit_key(edit,NULL)
  UNION SELECT 'viewer',community.media_edit_key(edit,NULL)
$$;
